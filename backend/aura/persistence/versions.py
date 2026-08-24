"""WorkflowVersionStore — port of workflow/versions.ts (196 lines), byte-parity.

publish() always mints; ensure_version_for_run() reuses the latest when the
graph hash matches; restore() publishes forward with restoredFrom — never
rewinds. graphHash comes from aura.canonical.graph_hash.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..canonical import graph_hash
from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file
from ._alias import CamelAlias


def _now_default() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class WorkflowVersionStore(CamelAlias):
    def __init__(self, clock: Callable[[], str] | None = None,
                 id_gen: Callable[[str], str] | None = None) -> None:
        self._clock = clock or _now_default
        self._id_gen = id_gen or (lambda p: f"{p}-{id(p):x}")
        self._dirs: dict[str, Path] = {}

    def _vdir(self, wid: str) -> Path:
        d = aura_path("workflow-versions", wid)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _vfile(self, wid: str, vid: str) -> Path:
        return self._vdir(wid) / f"{vid}.json"

    def list(self, wid: str) -> list[dict]:
        out: list[dict] = []
        d = self._vdir(wid)
        for f in sorted(d.iterdir()):
            if not f.name.endswith(".json"):
                continue
            v = read_json_file(f, None)
            if not isinstance(v, dict) or not v.get("id"):
                continue
            summary: dict[str, Any] = {
                "id": v["id"], "workflowId": v["workflowId"], "number": v["number"],
                "name": v["name"], "createdAt": v["createdAt"], "createdBy": v["createdBy"],
                "graphHash": v["graphHash"], "nodeCount": len(v.get("nodes") or []),
            }
            if v.get("note") is not None:
                summary["note"] = v["note"]
            if v.get("restoredFrom") is not None:
                summary["restoredFrom"] = v["restoredFrom"]
            out.append(summary)
        return sorted(out, key=lambda s: s["number"], reverse=True)

    def get(self, wid: str, vid: str) -> dict | None:
        return read_json_file(self._vfile(wid, vid), None)

    def latest(self, wid: str) -> dict | None:
        newest = self.list(wid)[:1]
        return self.get(wid, newest[0]["id"]) if newest else None

    def publish(self, wf: dict, created_by: str, note: str | None = None,
                restored_from: str | None = None) -> dict:
        existing = self.list(wf["id"])
        number = max(v["number"] for v in existing) + 1 if existing else 1
        # Key ORDER mirrors the TS object literal (versions.ts:141–156) because
        # these bytes are written verbatim: note sits before graphHash,
        # restoredFrom last. Undefined keys are omitted (JSON.stringify).
        version: dict[str, Any] = {
            "id": self._id_gen("wfv"),
            "workflowId": wf["id"],
            "number": number,
            "name": wf.get("name"),
            "description": wf.get("description"),
            "createdAt": self._clock(),
            "createdBy": created_by,
        }
        if note is not None:
            version["note"] = note
        version["graphHash"] = graph_hash(wf.get("nodes") or [], wf.get("edges") or [])
        # deep copy so later draft edits cannot mutate a published version
        version["nodes"] = _deep_copy(wf.get("nodes") or [])
        version["edges"] = _deep_copy(wf.get("edges") or [])
        if restored_from is not None:
            version["restoredFrom"] = restored_from
        write_json_file(self._vfile(wf["id"], version["id"]), version)
        return version

    def ensure_version_for_run(self, wf: dict, by: str) -> dict:
        latest = self.latest(wf["id"])
        h = graph_hash(wf.get("nodes") or [], wf.get("edges") or [])
        if latest and latest.get("graphHash") == h:
            return latest
        return self.publish(wf, by)

    def restore(self, wf: dict, vid: str, by: str = "user") -> dict | None:
        source = self.get(wf["id"], vid)
        if not source:
            return None
        return self.publish(
            {**wf, "nodes": source["nodes"], "edges": source["edges"]},
            by,
            f"Restored from v{source['number']}",
            source["id"],
        )

    def remove_all(self, wid: str) -> None:
        import shutil

        shutil.rmtree(aura_path("workflow-versions", wid), ignore_errors=True)


def _deep_copy(value: Any) -> Any:
    import json as _json

    return _json.loads(_json.dumps(value))
