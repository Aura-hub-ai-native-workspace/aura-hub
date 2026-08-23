"""Read-only mission records.

A partial port of packages/ai-service/src/mission/store.ts — the READ
half only. Creating, saving and patching missions belongs to the mission
engine (Phase 11), and is deliberately absent.

**One documented difference:** the reference hydrates every read through
`MissionExecutionEngine.hydrate` + `refreshStatus`, which recomputes an
execution's status from its checkpoints. That engine is Phase 11, so this
reader returns the record as persisted. For a mission whose stored status
already agrees with its checkpoints the two are identical; where they
disagree, this reports what is on disk.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..core.json_store import read_json


class MissionReader:
    def __init__(self, home: Path) -> None:
        self._home = home

    def _dir(self, project_id: str) -> Path:
        directory = self._home / "missions" / project_id
        # The reference mkdirs on every access, which is why listing a
        # project with no missions is an empty list rather than an error —
        # and therefore `fresh` and empty rather than `unknown`.
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def list(self, project_id: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted(self._dir(project_id).iterdir(), key=lambda p: p.name):
            if not path.name.endswith(".json"):
                continue
            record = read_json(path, None)
            if not record or not record.get("id"):
                continue
            goal_graph = record.get("goalGraph") or {}
            out.append({
                "id": record["id"],
                "projectId": record.get("projectId"),
                "text": record.get("text", ""),
                "createdAt": record.get("createdAt", ""),
                "category": (record.get("classification") or {}).get("category", "unknown"),
                "goalCount": len(goal_graph.get("goals") or []),
                "taskCount": len(goal_graph.get("tasks") or []),
                "approval": record.get("approval"),
                "qualityOverall": (record.get("quality") or {}).get("overall"),
                "execution": record.get("execution"),
            })
        out.sort(key=lambda m: m["createdAt"], reverse=True)
        return out

    def get(self, project_id: str, mission_id: str) -> dict[str, Any] | None:
        return read_json(self._dir(project_id) / f"{mission_id}.json", None)
