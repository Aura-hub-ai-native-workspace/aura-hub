"""Execution controller — drives a plan through the ONE governed path.

Two routes, both governed:
  single-invocation → one aura.fabric invoke per task;
  workflow-run      → the Python Workflow Engine loads the stored
                      definition and drives nodes through the same Fabric.

The controller performs no side effects itself. Failure policy (deliberate,
documented): NO automatic retries of side-effectful steps. awaiting-approval
parks the whole run — the controller surfaces the approval id and exits
without deciding it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..contracts import TaskOutcome, TaskPlan
from ..fabric import FabricConfig, invoke_fabric
from ..workflow import EngineConfig, WorkflowEngine
from .planner import topo_order


@dataclass
class ExecutionOutcome:
    outcomes: list[TaskOutcome] = field(default_factory=list)
    stopped: bool = False
    stop_reason: str = ""
    approval_id: str | None = None
    cancelled: bool = False
    timed_out: bool = False
    denied: bool = False
    run_id: str | None = None
    resumed_run_id: str | None = None
    parked_runs: dict[str, str] = field(default_factory=dict)  # taskId → rid


class ExecutionController:
    def __init__(self, fabric_cfg: FabricConfig, engine: WorkflowEngine | None = None) -> None:
        self._cfg = fabric_cfg
        self.engine = engine or WorkflowEngine(
            fabric_cfg,
            *(_default_stores()),
            config=EngineConfig(),
        )

    def execute(  # noqa: C901 — one honest control loop for two routes
        self,
        plan: TaskPlan,
        project_id: str | None,
        compiled_workflow: dict | None = None,
        cancel_check: Any | None = None,
        resume_grants: dict[str, str] | None = None,
    ) -> ExecutionOutcome:
        result = ExecutionOutcome()
        resume_grants = resume_grants or {}
        for task in topo_order(plan.tasks):
            if cancel_check and cancel_check():
                result.cancelled = True
                result.stopped = True
                result.stop_reason = "cancelled before " + task.id
                break

            if task.route == "workflow-run":
                grant_for_task = resume_grants.get(task.id)
                if grant_for_task:
                    _, parked_rid = grant_for_task
                    self._resume_workflow(task, parked_rid, result)
                else:
                    self._run_workflow(task, plan, project_id, result)
            else:
                grant_for_task = resume_grants.get(task.id)
                self._invoke_single(task, project_id, compiled_workflow, result,
                                    approval_id=grant_for_task[0] if grant_for_task else None)

            last = result.outcomes[-1] if result.outcomes else None
            if last is None:
                break
            if last.state == "awaiting-approval":
                result.approval_id = last.approvalId
                result.stopped = True
                result.stop_reason = "awaiting human approval"
                if result.run_id:
                    result.parked_runs[task.id] = result.run_id
                break
            if last.state in ("denied",):
                result.denied = True
                result.stopped = True
                result.stop_reason = last.detail
                break
            if last.state == "timed-out":
                result.timed_out = True
                result.stopped = True
                result.stop_reason = last.detail
                break
            if last.state in ("failed", "blocked"):
                result.stopped = True
                result.stop_reason = f"{task.id}: {last.detail}"
                break
        return result

    # ── single-invocation route ──────────────────────────────────────────
    def _invoke_single(
        self,
        task: Any,
        project_id: str | None,
        compiled_workflow: dict | None,
        result: ExecutionOutcome,
        approval_id: str | None = None,
    ) -> None:
        if not task.capabilityId:
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state="failed",
                detail="no capability bound to this task"))
            return

        payload = dict(task.input)
        if task.inputFrom == "compiled-workflow":
            if compiled_workflow is None:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="failed",
                    detail="plan expected a compiled workflow but none was produced"))
                return
            payload.update({
                "name": compiled_workflow["name"],
                "description": compiled_workflow["description"],
                "nodes": compiled_workflow["nodes"],
                "edges": compiled_workflow["edges"],
            })

        context = {
            "actor": {"kind": "agent", "id": "central-agent"},
            "projectId": project_id,
            "taskId": task.id,
        }
        if approval_id:
            context["approvalId"] = approval_id
        invocation = invoke_fabric(
            task.capabilityId, payload, context, self._cfg,
        )
        outcome = invocation["outcome"]
        performed = outcome in ("succeeded", "unverified")
        state = {
            "succeeded": "done",
            "unverified": "done",       # ran; verification reported separately
            "denied": "denied",
            "awaiting-approval": "awaiting-approval",
            "failed": "failed",
            "unsupported": "blocked",
        }[outcome]
        result.outcomes.append(TaskOutcome(
            taskId=task.id,
            state=state,  # type: ignore[arg-type]
            performed=performed,
            verified=invocation["verification"]["passed"],
            invocationIds=[invocation["invocationId"]],
            approvalId=invocation.get("approvalId"),
            detail=invocation["detail"],
        ))

    # ── workflow-run route ───────────────────────────────────────────────
    def _run_workflow(
        self,
        task: Any,
        plan: TaskPlan,
        project_id: str | None,
        result: ExecutionOutcome,
    ) -> None:
        wf_ref = str(task.input.get("workflowRef") or "")
        run = self.engine.start_run(
            wf_ref,
            inputs={},
            project_id=project_id,
        )
        result.run_id = run["id"]
        self._record_run_outcome(task, run, result)

    def _resume_workflow(self, task: Any, parked_rid: str,
                         result: ExecutionOutcome) -> None:
        leg = self.engine.resume_run(parked_rid)
        result.resumed_run_id = leg["id"]
        result.run_id = leg["id"]
        self._record_run_outcome(task, leg, result,
                                 detail_prefix=f"Resumed as {leg['id']}")

    def _record_run_outcome(self, task: Any, run: dict,
                            result: ExecutionOutcome,
                            detail_prefix: str = "Run") -> None:
        node_states = [n["state"] for n in run["nodes"].values()]
        # Every governed node action links back to its audit record.
        invocations = [e["invocationId"] for e in (run.get("evidence") or [])]
        if run["state"] == "awaiting-approval":
            parked = [n for n in run["nodes"].values()
                      if n["state"] == "awaiting-approval"]
            apr = (parked[0].get("approval") or {}).get("requestId") if parked else None
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state="awaiting-approval",
                performed=True,
                invocationIds=invocations,
                approvalId=apr,
                detail=f"{detail_prefix} {run['id']} parked at node "
                       f"{parked[0]['nodeId'] if parked else '?'}",
            ))
            return
        if run["state"] == "succeeded":
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state="done", performed=True,
                verified=all(s == "succeeded" for s in node_states),
                invocationIds=invocations,
                detail=f"{detail_prefix} {run['id']} succeeded "
                       f"({len(node_states)} node(s)); "
                       f"{len(run.get('evidence') or [])} evidence ref(s).",
            ))
            return
        honest = state_of(run)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state=honest, performed=True,
            invocationIds=invocations,
            detail=f"{detail_prefix} {run['id']} ended {run['state']}: "
                   f"{run.get('error') or ''}",
        ))


def _default_stores() -> tuple:
    from ..config import aura_home
    from ..workflow import make_stores
    return make_stores(aura_home())


def state_of(run: dict) -> str:
    """Honest run-state → task-state mapping (never collapses distinct states)."""
    return {
        "succeeded": "done", "awaiting-approval": "awaiting-approval",
        "denied": "denied", "timed-out": "timed-out",
        "cancelled": "cancelled",
    }.get(run["state"], "failed")
