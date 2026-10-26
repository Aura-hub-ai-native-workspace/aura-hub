"""Connected-node registry — the ONE catalogue projection at rest.

The composition root builds `presentNodes` / `providedNodeCapabilities`
from this store, so authority preflight and execution routing can never
describe different machines. Entries are local configuration records (the
substitute for a live connector until one lands): id, display name, the
node-capability ids it provides, and whether it is an AURA-internal
subsystem rather than a program on this machine.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import UTC, datetime
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_atomic

_ID_OK = re.compile(r"[^a-zA-Z0-9._-]")

#: One lock for every store instance in this process. Each instance used to
#: have its own lock, so two instances could interleave load → append → save
#: and silently drop one registration.
_REGISTRY_LOCK = threading.RLock()

logger = logging.getLogger(__name__)


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ConnectedNodeStore:
    """One file, many readers and writers.

    The API builds several instances over the same ``connected-nodes.json``
    (the policy host, the environment connect route, the worker handshake).
    Each used to cache the file once at construction, so a node connected
    through one instance was invisible to the policy host until restart,
    and a stale instance could write its old list back over a newer one.
    Every read and mutation therefore re-reads the file first, under a lock,
    so each operation sees the latest committed registry.
    """

    def __init__(self, clock=_now) -> None:
        self._file = aura_path("connected-nodes.json")
        self._items: list[dict[str, Any]] = []
        self._lock = _REGISTRY_LOCK
        self._blocked = False  # set when an unreadable registry could not be moved aside
        self.clock = clock
        self.load()

    # ── persistence ──────────────────────────────────────────────────────

    def load(self) -> None:
        with self._lock:
            if self._file.exists():
                try:
                    raw = json.loads(self._file.read_text(encoding="utf-8"))
                    if not isinstance(raw, dict) or not isinstance(raw.get("nodes", []), list):
                        raise ValueError("not a registry object")
                except (OSError, ValueError) as exc:
                    self._quarantine(exc)
                    raw = {"nodes": []}
            else:
                raw = {"nodes": []}
            self._items = [n for n in (raw.get("nodes") or [])
                           if isinstance(n, dict) and n.get("id")]

    def _quarantine(self, cause: Exception) -> None:
        """A registry that cannot be parsed is moved aside, never overwritten.
        Saving an empty list over it would destroy the connections it held."""
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        aside = self._file.with_name(f"{self._file.name}.corrupt-{stamp}")
        try:
            os.replace(self._file, aside)
            logger.error("connected-nodes registry is unreadable (%s); moved aside to %s",
                         cause, aside)
        except OSError as move_error:
            self._blocked = True
            logger.error("connected-nodes registry is unreadable (%s) and could not be moved aside (%s); "
                         "writes are refused so it is not overwritten", cause, move_error)

    def save(self) -> None:
        with self._lock:
            if self._blocked:
                raise OSError("connected-nodes registry is unreadable and was not moved aside; "
                              "refusing to overwrite it")
            write_json_atomic(self._file, {"nodes": self._items})

    # ── queries ──────────────────────────────────────────────────────────

    def list_nodes(self) -> list[dict]:
        with self._lock:
            self.load()
            return list(self._items)

    def get(self, node_id: str) -> dict | None:
        with self._lock:
            self.load()
            return next((n for n in self._items if n["id"] == node_id), None)

    # ── mutations (connector seam substitute; local configuration only) ──

    def register(self, node_id: str, name: str, capabilities: list[str],
                 *, internal: bool = False, version: str = "") -> dict:
        nid = _ID_OK.sub("-", str(node_id).strip())
        if not nid:
            raise ValueError("node id is required")
        caps = sorted({str(c).strip() for c in capabilities or [] if str(c).strip()})
        with self._lock:
            self.load()
            existing = next((n for n in self._items if n["id"] == nid), None)
            record = {
                "id": nid,
                "name": (name or nid)[:80],
                "capabilities": caps,
                "internal": bool(internal),
                "version": str(version or ""),
                "registeredAt": (existing or {}).get("registeredAt") or self.clock(),
            }
            if existing:
                self._items[self._items.index(existing)] = record
            else:
                self._items.append(record)
            self.save()
            return record

    def register_worker(self, node_id: str, name: str,
                        capabilities: list[str], *, binary: str,
                        version: str = "",
                        readiness: dict | None = None) -> dict:
        """Register a WORKER, with the runtime binding execution needs.

        Separate from :meth:`register` on purpose. ``register`` is the
        wire-reachable configuration seam and must never be able to
        state a binary or a readiness proof — otherwise a client could
        assert that a runtime is drivable and connected without AURA
        ever having driven it. Only the readiness handshake calls this,
        and only with a proof it produced itself.

        A record whose proof did not succeed is still written: the
        registry then carries the honest reason a worker is not
        connected, instead of silently forgetting the attempt.
        """
        bin_name = str(binary or "").strip()
        if bin_name and ("/" in bin_name or "\\" in bin_name
                         or ".." in bin_name):
            raise ValueError("a worker binary must be named, not a path")
        with self._lock:
            record = self.register(node_id, name, capabilities,
                                   internal=False, version=version)
            nid = record["id"]
            proved = bool((readiness or {}).get("proved"))
            record = {
                **record,
                "worker": True,
                # The runtime binding is what makes dispatch possible at
                # all, so it is recorded ONLY alongside a successful proof.
                **({"binary": bin_name} if (bin_name and proved) else {}),
                **({"readiness": dict(readiness)} if readiness else {}),
            }
            self.load()
            self._items[self._items.index(
                next(n for n in self._items if n["id"] == nid))] = record
            self.save()
            return record

    def workers(self) -> list[dict]:
        with self._lock:
            self.load()
            return [n for n in self._items if n.get("worker") is True]

    def remove(self, node_id: str) -> bool:
        with self._lock:
            self.load()
            node = next((n for n in self._items if n["id"] == node_id), None)
            if not node:
                return False
            self._items.remove(node)
            self.save()
            return True
