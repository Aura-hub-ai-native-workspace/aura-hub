"""WorkflowStore — port of packages/ai-service/src/workflow/store.ts (byte-parity).

Clock/rand CONSUMPTION ORDER is part of the contract: the differential
harness feeds both languages shared deterministic sequences, so this module
must draw them in exactly the order the TS argument lists and function bodies
do (create: createdAt → genId(now,rand) → edge-ids → updatedAt).
"""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
from typing import Any, Callable

from ._alias import CamelAlias
from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file


def _now_default() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")



def _default_id_gen(prefix: str) -> str:
    """TS-parity uniqueness when no injection: now36 + 6 rand chars."""
    import secrets

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    n = now_ms
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return f"{prefix}-{b36}-{secrets.token_hex(3)}"


def js_number(v: Any) -> float | int:
    """Number(v) || 0 — NaN/undefined coerce to 0; integral stays int."""
    try:
        n = float(v) if not isinstance(v, bool) else (1.0 if v else 0.0)
    except (TypeError, ValueError):
        return 0
    if n != n:
        return 0
    if n == int(n) and abs(n) < 2**53:
        return int(n)
    return n


class WorkflowStore(CamelAlias):
    def __init__(self, clock: Callable[[], str] | None = None,
                 id_gen: Callable[[str], str] | None = None) -> None:
        self._clock = clock or _now_default
        self._id_gen = id_gen or _default_id_gen
        self._dir: Path | None = None

    # paths -------------------------------------------------------------------

    def _ensure_dir(self) -> Path:
        if self._dir is None:
            d = aura_path("workflows")
            d.mkdir(parents=True, exist_ok=True)
            self._dir = d
        return self._dir

    def _file(self, wid: str) -> Path:
        return self._ensure_dir() / f"{wid}.json"

    # sanitize — mirrors store.ts:23–43 statement-for-statement -----------------

    def _sanitize(self, wf: dict[str, Any], wid: str, *, fresh_created_at: bool) -> dict[str, Any]:
        """fresh_created_at=True reproduces `typeof wf.createdAt !== 'string' ? now()`."""
        nodes_in = wf.get("nodes")
        ids: set[str] = set()
        nodes: list[dict] = []
        if isinstance(nodes_in, list):
            for n in nodes_in:
                if isinstance(n, dict) and isinstance(n.get("id"), str) and isinstance(n.get("type"), str):
                    cfg = n.get("config") if isinstance(n.get("config"), dict) else {}
                    nodes.append({
                        "id": n["id"], "type": n["type"],
                        "x": js_number(n.get("x")), "y": js_number(n.get("y")),
                        "config": cfg,
                    })
                    ids.add(n["id"])
        edges: list[dict] = []
        edges_in = wf.get("edges")
        if isinstance(edges_in, list):
            for e in edges_in:
                if isinstance(e, dict) and e.get("from") in ids and e.get("to") in ids:
                    eid = e.get("id")
                    port = e.get("fromPort")
                    edges.append({
                        "id": eid if isinstance(eid, str) else self._id_gen("e"),
                        "from": e["from"],
                        "fromPort": port if isinstance(port, str) else "out",
                        "to": e["to"],
                    })

        created_in = wf.get("createdAt")
        created_at = created_in if (isinstance(created_in, str) and not fresh_created_at) else self._clock()
        updated_at = self._clock()

        name = wf.get("name")
        category = wf.get("category")
        token = wf.get("webhookToken")

        out: dict[str, Any] = {
            "id": wid,
            "name": name.strip() if isinstance(name, str) and name.strip() else "Untitled workflow",
            "description": wf.get("description") if isinstance(wf.get("description"), str) else "",
            "category": category.strip() if isinstance(category, str) and category.strip() else "General",
            "favorite": wf.get("favorite") is True,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "nodes": nodes,
            "edges": edges,
        }
        if isinstance(token, str) and token:
            out["webhookToken"] = token
        return out

    def _sanitize_like_ts(self, wf: dict[str, Any], wid: str) -> dict[str, Any]:
        return self._sanitize(wf, wid, fresh_created_at=False)

    # API ------------------------------------------------------------------------

    def list(self) -> list[dict]:
        out = []
        for f in sorted(Path(self._ensure_dir()).iterdir()):
            if not f.name.endswith(".json"):
                continue
            wf = read_json_file(f, None)
            if not isinstance(wf, dict) or not wf.get("id"):
                continue
            out.append({
                "id": wf["id"], "name": wf.get("name"),
                "description": wf.get("description"), "category": wf.get("category"),
                "favorite": wf.get("favorite"), "createdAt": wf.get("createdAt"),
                "updatedAt": wf.get("updatedAt"), "nodeCount": len(wf.get("nodes") or []),
            })
        return sorted(out, key=lambda s: s["updatedAt"], reverse=True)

    def get(self, wid: str) -> dict | None:
        return read_json_file(self._file(wid), None)

    def create(self, inp: dict | None = None) -> dict:
        src = dict(inp or {})
        src["createdAt"] = self._clock()          # TS: {...input, createdAt: now()}
        wid = self._id_gen("wf")                  # TS: second argument evaluated next
        wf = self._sanitize(src, wid, fresh_created_at=False)
        write_json_file(self._file(wf["id"]), wf)
        self._dir = None
        return wf

    def save(self, wid: str, definition: dict) -> dict | None:
        existing = self.get(wid)
        if not existing:
            return None
        merged = {**existing, **definition, "id": wid,
                  "createdAt": existing.get("createdAt")}
        merged["favorite"] = definition.get("favorite", existing.get("favorite"))
        wf = self._sanitize_like_ts(merged, wid)
        write_json_file(self._file(wid), wf)
        self._dir = None
        return wf

    def patch(self, wid: str, partial: dict) -> dict | None:
        existing = self.get(wid)
        if not existing:
            return None
        return self.save(wid, {**existing, **partial})

    def duplicate(self, wid: str) -> dict | None:
        existing = self.get(wid)
        if not existing:
            return None
        return self.create({**existing, "name": f"{existing['name']} copy",
                            "favorite": False, "webhookToken": None})

    def remove(self, wid: str) -> bool:
        try:
            os.remove(self._file(wid))
            return True
        except OSError:
            return False

    def import_workflow(self, definition: dict) -> dict:
        d = dict(definition or {})
        return self.create({**d, "name": d.get("name") if d.get("name") else "Imported workflow"})

    def ensure_webhook_token(self, wid: str) -> str | None:
        import secrets

        existing = self.get(wid)
        if not existing:
            return None
        tok = existing.get("webhookToken")
        if tok:
            return tok
        token = secrets.token_hex(24)
        self.save(wid, {**existing, "webhookToken": token})
        return token

    def rotate_webhook_token(self, wid: str) -> str | None:
        import secrets

        existing = self.get(wid)
        if not existing:
            return None
        token = secrets.token_hex(24)
        self.save(wid, {**existing, "webhookToken": token})
        return token

    def verify_webhook_token(self, wid: str, token: str) -> dict | None:
        wf = self.get(wid)
        stored = (wf or {}).get("webhookToken")
        if not wf or not stored or not token or stored != token:
            return None
        return wf


# silence linter about intentional import use
_ = timezone
