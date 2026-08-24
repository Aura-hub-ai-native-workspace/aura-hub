"""Built-in executors — effects this backend can actually perform today.

Scope discipline: each executor is a real, reversible effect on AURA's own
state (the workflow store under AURA_HOME). Process-backed and node-routed
executors arrive with P5; nothing here spawns processes or touches projects.

The Workflow records written here use the frozen workflow schema
(aura.contracts.workflow_def), so anything persisted is loadable by every
existing consumer of that contract.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..canonical import graph_hash
from ..config import aura_home
from ..contracts import Workflow, WfEdge, WfNode
from ..jsonutil import read_json_file, write_json_atomic


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class WorkflowCreateExecutor:
    """workflow.create — persist one workflow definition, then read it back."""

    name = "workflow.create"

    def __init__(self, home: Path | None = None) -> None:
        self._home = home  # None → resolved at call time (tests inject AURA_HOME first)

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "workflows"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        wid = f"wf-{uuid.uuid4().hex[:12]}"
        wf = Workflow(
            id=wid,
            name=str(input["name"]),
            description=str(input.get("description") or ""),
            category="Agent Generated",
            favorite=False,
            createdAt=_now(),
            updatedAt=_now(),
            nodes=[WfNode.model_validate(n) for n in input["nodes"]],
            edges=[WfEdge.model_validate(e) for e in input["edges"]],
        )
        path = self._dir() / f"{wid}.json"
        write_json_atomic(path, wf.wire())
        return (
            {"workflowId": wid, "path": str(path),
             "nodeCount": len(wf.nodes), "edgeCount": len(wf.edges)},
            f'Stored workflow "{wf.name}" with {len(wf.nodes)} nodes.',
        )

    def verify(
        self, input: dict[str, Any], context: dict[str, Any], output: Any | None
    ) -> dict[str, Any] | None:
        if not isinstance(output, dict):
            return {"passed": False, "kind": "read-back",
                    "detail": "No workflow id was returned to verify against."}
        path = Path(output["path"])
        stored = read_json_file(path, None)
        if not isinstance(stored, dict):
            return {"passed": False, "kind": "read-back",
                    "detail": f"The stored definition at {path} could not be read back."}
        stored_hash = graph_hash(stored.get("nodes") or [], stored.get("edges") or [])
        expected_hash = graph_hash(input["nodes"], input["edges"])
        if stored.get("id") != output["workflowId"] or stored_hash != expected_hash:
            return {"passed": False, "kind": "read-back",
                    "detail": "The stored graph does not match what was submitted."}
        return {"passed": True, "kind": "read-back",
                "detail": f"Read back from {path.name}; graph hash matches ({stored_hash})."}


class WorkflowListExecutor:
    """workflow.list — read-only inventory of the store."""

    name = "workflow.list"

    def __init__(self, home: Path | None = None) -> None:
        self._home = home

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "workflows"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        items = []
        for path in sorted(self._dir().glob("*.json")):
            raw = read_json_file(path, None)
            if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                items.append({
                    "id": raw["id"],
                    "name": raw.get("name") or "",
                    "nodeCount": len(raw.get("nodes") or []),
                })
        return {"workflows": items}, f"{len(items)} workflow(s) stored."

    def verify(self, input: dict, context: dict, output: Any | None) -> None:
        return None  # read-only listing has no mechanical check


def builtin_executors(home: Path | None = None) -> dict[str, Any]:
    create = WorkflowCreateExecutor(home)
    listing = WorkflowListExecutor(home)
    return {create.name: create, listing.name: listing}
