"""Connected-node registry — the ONE catalogue projection at rest.

The composition root builds `presentNodes` / `providedNodeCapabilities`
from this store, so authority preflight and execution routing can never
describe different machines. Entries are local configuration records (the
substitute for a live connector until one lands): id, display name, the
node-capability ids it provides, and whether it is an AURA-internal
subsystem rather than a program on this machine.
"""
from __future__ import annotations

import re
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_atomic

_ID_OK = re.compile(r"[^a-zA-Z0-9._-]")


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ConnectedNodeStore:
    def __init__(self, clock=_now) -> None:
        self._file = aura_path("connected-nodes.json")
        self._items: list[dict[str, Any]] = []
        self.clock = clock
        self.load()

    # ── persistence ──────────────────────────────────────────────────────

    def load(self) -> None:
        data = read_json_file(self._file, {"nodes": []})
        self._items = [n for n in (data.get("nodes") or [])
                       if isinstance(n, dict) and n.get("id")]

    def save(self) -> None:
        write_json_atomic(self._file, {"nodes": self._items})

    # ── queries ──────────────────────────────────────────────────────────

    def list_nodes(self) -> list[dict]:
        return list(self._items)

    def get(self, node_id: str) -> dict | None:
        return next((n for n in self._items if n["id"] == node_id), None)

    # ── mutations (connector seam substitute; local configuration only) ──

    def register(self, node_id: str, name: str, capabilities: list[str],
                 *, internal: bool = False, version: str = "") -> dict:
        nid = _ID_OK.sub("-", str(node_id).strip())
        if not nid:
            raise ValueError("node id is required")
        caps = sorted({str(c).strip() for c in capabilities or [] if str(c).strip()})
        existing = self.get(nid)
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
        record = self.register(node_id, name, capabilities,
                               internal=False, version=version)
        nid = record["id"]
        bin_name = str(binary or "").strip()
        if bin_name and ("/" in bin_name or "\\" in bin_name
                         or ".." in bin_name):
            raise ValueError("a worker binary must be named, not a path")
        proved = bool((readiness or {}).get("proved"))
        record = {
            **record,
            "worker": True,
            # The runtime binding is what makes dispatch possible at
            # all, so it is recorded ONLY alongside a successful proof.
            **({"binary": bin_name} if (bin_name and proved) else {}),
            **({"readiness": dict(readiness)} if readiness else {}),
        }
        self._items[self._items.index(self.get(nid))] = record
        self.save()
        return record

    def workers(self) -> list[dict]:
        return [n for n in self._items if n.get("worker") is True]

    def remove(self, node_id: str) -> bool:
        node = self.get(node_id)
        if not node:
            return False
        self._items.remove(node)
        self.save()
        return True
