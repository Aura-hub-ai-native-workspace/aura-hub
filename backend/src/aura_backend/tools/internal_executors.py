"""AURA-internal executors that the workspace layer unblocks.

The reference registers ten of these. Six are implementable now:
`project.list`, `project.create`, `project.open`, `project.inspect`,
`memory.search` and `governance.audit` — each delegates to the workspace
manager and nothing else.

The other four are still deferred, and deliberately not stubbed:

  * `mission.inspect`, `mission.approve` — need the mission store (Phase 11)
  * `knowledge.graph` — needs the knowledge graph (Phase 4)
  * `workflow.run` — needs the workflow engine (Phase 9)

They stay in the manifest so callers can plan around them, and report
`unsupported` when invoked. A stub that returned an empty graph would be
a capability lying about what it did.
"""

from __future__ import annotations

from typing import Any

from ..fabric.types import ExecutorResult, Invocation, VerificationReport
from ..workspace.manager import WorkspaceManager
from ..workspace.projects import ProjectRejected


def _s(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _ok(detail: str, output: Any = None) -> ExecutorResult:
    return ExecutorResult(ok=True, detail=detail, output=output)


def _no(detail: str) -> ExecutorResult:
    return ExecutorResult(ok=False, detail=detail)


def _pass(kind, detail: str) -> VerificationReport:
    return VerificationReport(passed=True, kind=kind, detail=detail)


def _fail(kind, detail: str) -> VerificationReport:
    return VerificationReport(passed=False, kind=kind, detail=detail)


class ProjectList:
    capability_id = "project.list"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, _inv: Invocation) -> ExecutorResult:
        projects = [p.to_json() for p in self._manager.list_projects()]
        noun = "project" if len(projects) == 1 else "projects"
        return _ok(f"{len(projects)} {noun} registered.", projects)


class ProjectCreate:
    capability_id = "project.create"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, inv: Invocation) -> ExecutorResult:
        name = _s(inv.input.get("name")).strip()
        if not name:
            return _no("A project name is required.")
        parent = inv.input.get("parentPath")
        try:
            result = self._manager.create_project(
                name, _s(parent) if parent is not None else None
            )
        except (ProjectRejected, OSError) as exc:
            return _no(str(exc))
        return _ok(f'Created "{name}".', result.project.to_json())

    async def verify(self, inv: Invocation, _result) -> VerificationReport:
        name = _s(inv.input.get("name")).strip()
        return (
            _pass("read-back", "The project is in the registry.")
            if any(p.name == name for p in self._manager.list_projects())
            else _fail("read-back", "The project is not in the registry after creation.")
        )


class ProjectOpen:
    capability_id = "project.open"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, inv: Invocation) -> ExecutorResult:
        try:
            result = self._manager.open(_s(inv.input.get("projectId")))
        except KeyError as exc:
            return _no(str(exc).strip("'"))
        return _ok("Project opened.", result.to_json())

    async def verify(self, inv: Invocation, _result) -> VerificationReport:
        current = self._manager.current_project()
        return (
            _pass("read-back", "It is the active project.")
            if current is not None and current.id == _s(inv.input.get("projectId"))
            else _fail("read-back", "The active project did not change.")
        )


class ProjectInspect:
    capability_id = "project.inspect"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, inv: Invocation) -> ExecutorResult:
        profile = self._manager.profile(_s(inv.input.get("projectId")))
        if profile is None:
            return _no("That project has no generated profile yet.")
        return _ok("Profile read.", profile.to_json())


class MemorySearch:
    capability_id = "memory.search"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, inv: Invocation) -> ExecutorResult:
        matched = self._manager.search_memory(
            _s(inv.input.get("projectId")), _s(inv.input.get("query"))
        )
        return _ok(f"{len(matched)} matching records.", matched)


class GovernanceAudit:
    capability_id = "governance.audit"

    def __init__(self, manager: WorkspaceManager) -> None:
        self._manager = manager

    async def run(self, inv: Invocation) -> ExecutorResult:
        project_id = _s(inv.input.get("projectId"))
        profile = self._manager.profile(project_id)
        if profile is None:
            return _no("That project has no profile to audit yet.")
        # Collects INPUTS only — the reference does the same. The scoring
        # engine is `packages/governance`, a separate subsystem that is
        # not part of this migration phase.
        return _ok(
            "Audit inputs collected.",
            {"projectId": project_id, "profile": profile.to_json()},
        )


def workspace_executors(manager: WorkspaceManager) -> list[Any]:
    return [
        ProjectList(manager),
        ProjectCreate(manager),
        ProjectOpen(manager),
        ProjectInspect(manager),
        MemorySearch(manager),
        GovernanceAudit(manager),
    ]
