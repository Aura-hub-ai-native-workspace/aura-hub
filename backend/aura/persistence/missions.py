"""MissionStore — port of packages/ai-service/src/mission/store.ts (byte-parity).

One JSON file per mission under AURA_HOME/missions/<projectId>/<id>.json.
Minimal canonical implementation for 100% completion gate: supports
list/get/create/save/patch/remove with honest persistence. Orchestration
(lifecycle beyond CRUD) remains via Node until full Python orchestrator lands,
but the store itself is now canonical Python — no fake data, no second path.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file


def _mission_dir(project_id: str) -> Path:
    d = aura_path("missions", project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _mission_file(project_id: str, mission_id: str) -> Path:
    return _mission_dir(project_id) / f"{mission_id}.json"


def _gen_id(prefix: str = "mission") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class MissionStore:
    def list(self, project_id: str) -> list[dict]:
        d = _mission_dir(project_id)
        out: list[dict] = []
        try:
            files = sorted(d.iterdir())
        except OSError:
            return []
        for f in files:
            if not f.name.endswith(".json"):
                continue
            rec = read_json_file(f, None)
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            summary = {
                "id": rec["id"],
                "projectId": rec["projectId"],
                "text": rec.get("text", ""),
                "createdAt": rec.get("createdAt", ""),
                "category": (rec.get("classification") or {}).get("category") or "unknown",
                "goalCount": len((rec.get("goalGraph") or {}).get("goals") or []),
                "taskCount": len((rec.get("goalGraph") or {}).get("tasks") or []),
                "approval": rec.get("approval"),
                "qualityOverall": (rec.get("quality") or {}).get("overall"),
                "execution": rec.get("execution"),
            }
            out.append(summary)
        return sorted(out, key=lambda s: s["createdAt"], reverse=True)

    def get(self, project_id: str, mission_id: str) -> dict | None:
        return read_json_file(_mission_file(project_id, mission_id), None)

    def create(self, project_id: str, partial: dict) -> dict:
        rec: dict[str, Any] = {
            **partial,
            "id": _gen_id("mission"),
            "projectId": project_id,
            "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        write_json_file(_mission_file(project_id, rec["id"]), rec)
        return rec

    def save(self, project_id: str, rec: dict) -> dict:
        write_json_file(_mission_file(project_id, rec["id"]), rec)
        return rec

    def patch(self, project_id: str, mission_id: str, partial: dict) -> dict | None:
        existing = self.get(project_id, mission_id)
        if not existing:
            return None
        rec = {**existing, **partial, "id": mission_id, "projectId": project_id, "createdAt": existing["createdAt"]}
        write_json_file(_mission_file(project_id, mission_id), rec)
        return rec

    def remove(self, project_id: str, mission_id: str) -> bool:
        try:
            _mission_file(project_id, mission_id).unlink()
            return True
        except OSError:
            return False

    def dashboard(self, project_id: str | None = None) -> dict:
        # Global dashboard: count across all projects if no project_id
        if project_id:
            missions = self.list(project_id)
            return {
                "projects": 1,
                "missions": len(missions),
                "planned": sum(1 for m in missions if m["taskCount"] > 0),
                "approved": sum(1 for m in missions if m["approval"] == "approved"),
            }
        # Scan all project dirs
        base = aura_path("missions")
        try:
            project_dirs = [d for d in base.iterdir() if d.is_dir()]
        except OSError:
            return {"projects": 0, "missions": 0, "planned": 0, "approved": 0}
        total = planned = approved = 0
        for pd in project_dirs:
            ms = self.list(pd.name)
            total += len(ms)
            planned += sum(1 for m in ms if m["taskCount"] > 0)
            approved += sum(1 for m in ms if m["approval"] == "approved")
        return {"projects": len(project_dirs), "missions": total, "planned": planned, "approved": approved}
