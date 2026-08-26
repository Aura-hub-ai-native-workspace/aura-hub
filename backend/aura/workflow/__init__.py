"""aura.workflow package surface.

Two things live here:

1. Re-exports of the canonical execution primitives (the ONE path).
2. The central-agent seam: `WorkflowEngine`, `EngineConfig` and
   `make_stores` present the engine interface `aura.central_agent` was
   written against, implemented ENTIRELY as a facade over
   `WorkflowRunner.start/.resume` — the same convergence seam every other
   entry point (HTTP run routes, automation actions) uses. No second
   interpreter exists; a facade method that cannot be expressed as a
   runner call must not exist.
"""
from __future__ import annotations

import asyncio
from typing import Any

from .runner import WorkflowRunner

__all__ = ["EngineConfig", "WorkflowEngine", "make_stores", "WorkflowRunner"]


class EngineConfig:
    """Observability hook bundle. `emit` receives engine-level events so
    they can ride the agent event bus; it never influences execution."""

    def __init__(self, *, emit: Any = None, **_ignored: Any) -> None:
        self.emit = emit


def make_stores(home=None):
    """Canonical stores in (workflows, versions, runs) order."""
    from ..config import aura_home
    from ..persistence.runs import WorkflowRunStore
    from ..persistence.versions import WorkflowVersionStore
    from ..persistence.workflows import WorkflowStore

    _ = aura_home() if home is None else home  # stores read config themselves
    return WorkflowStore(), WorkflowVersionStore(), WorkflowRunStore()


def _run_sync(coro) -> Any:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


class WorkflowEngine:
    """Central-agent-facing facade over the canonical runner.

    Shapes returned are the runner's own persisted run records
    (`nodes: {id → {state, summary, approval?, evidence[]}}`,
    `evidence: [{invocationId,…}]`), which is what the agent's outcome
    projection reads.
    """

    NODE_TO_CAPABILITY = {
        "git-status": "git.status",
        "export-file": "filesystem.write",
    }

    def __init__(self, fabric_cfg=None, workflows=None, versions=None,
                 runs=None, config: EngineConfig | None = None) -> None:
        from ..fabric.scopes import RunScopeRegistry

        cfg = fabric_cfg
        self._cfg = cfg
        self._config = config or EngineConfig()
        self.workflows = workflows
        self.versions = versions
        self.runs = runs
        if workflows is None or versions is None or runs is None:
            ws, vs, rs = make_stores()
            self.workflows = workflows or ws
            self.versions = versions or vs
            self.runs = runs or rs
        self._runner = WorkflowRunner(
            fabric=getattr(cfg, "fabric", None),
            run_scopes=RunScopeRegistry(),
            versions=self.versions, runs=self.runs,
            secrets=getattr(cfg, "secrets", None) if cfg is not None else None,
        )
        self._listeners: list[Any] = [self._config.emit] if self._config.emit is not None else []

    # ── stored-workflow route ────────────────────────────────────────────
    def start_run(self, wf_ref: str, inputs: dict | None = None,
                  project_id: str | None = None,
                  project_path: str = ".") -> dict:
        wf = self._resolve(wf_ref)
        if wf is None:
            raise RuntimeError(f'no stored workflow "{wf_ref}"')
        out = _run_sync(self._runner.start_workflow_run(
            wf, project_id=project_id or "default",
            project_path=project_path,
            trigger={"kind": "agent", "by": "central-agent"},
            inputs=inputs))
        return out["run"]

    def resume_run(self, rid: str, actor_by: str = "user") -> dict:
        previous = self.runs.find(rid)
        if previous is None:
            raise RuntimeError(f'no such run "{rid}"')
        wf = self.workflows.get(previous["workflowId"])
        if wf is None:
            raise RuntimeError(f'workflow {previous["workflowId"]} no longer exists')
        out = _run_sync(self._runner.resume(
            wf, rid, lambda e: None,
            {"actor": {"kind": "agent", "id": f"agent:{actor_by}"}}))
        if isinstance(out, dict) and out.get("error"):
            raise RuntimeError(out["error"])
        fresh = self.runs.get(previous["workflowId"], out["run"]["id"])
        return fresh or out["run"]

    # ── single-invocation route through the SAME interpreter ─────────────
    def run_ad_hoc(self, capability_id: str, payload: dict,
                   project_cwd: str | None, project_id: str | None,
                   approval_id: str | None = None,
                   task_label: str = "") -> tuple[dict, str]:
        node_type = {v: k for k, v in self.NODE_TO_CAPABILITY.items()}.get(capability_id)
        if node_type is None:
            raise RuntimeError(
                f"capability {capability_id} has no ad-hoc node route; "
                "use invoke_fabric")
        wf = {
            "name": task_label or node_type,
            "nodes": [{"id": "ad-hoc", "type": node_type, "x": 0, "y": 0,
                       "config": dict(payload)}],
            "edges": [],
        }
        created = self.workflows.create(wf) if hasattr(self.workflows, "create") else wf
        try:
            out = _run_sync(self._runner.start_workflow_run(
                created, project_id=project_id or "default",
                project_path=project_cwd or ".",
                trigger={"kind": "agent", "by": "central-agent"},
                inputs={}))
        finally:
            if hasattr(self.workflows, "remove") and created.get("id"):
                try:
                    self.workflows.remove(created["id"])
                    self.versions.remove_all(created["id"])
                    self.runs.remove_all(created["id"])
                except Exception:
                    pass
        return out["run"], node_type

    def listen(self, fn) -> None:
        """Register an observer for engine-level events (observability only)."""
        if fn not in self._listeners:
            self._listeners.append(fn)

    def _emit(self, event: dict) -> None:
        for fn in self._listeners:
            try:
                fn(event)
            except Exception:
                pass

    def _resolve(self, ref: str) -> dict | None:
        getter = getattr(self.workflows, "get", None)
        if getter is not None:
            direct = getter(ref)
            if direct is not None:
                return direct
        return next((w for w in self.workflows.list()
                     if (w.get("name") or "").strip().lower() == ref.strip().lower()),
                    None)
