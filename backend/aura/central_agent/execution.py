"""Execution controller — drives a plan through the ONE governed path.

The controller performs no side effects itself. Every task becomes an
aura.fabric invoke with actor=agent; policy, approval parking, verification
and audit happen inside the Fabric exactly as they would for any caller.

Failure policy (deliberate, documented): NO automatic retries of
side-effectful steps. A denied or failed invocation stops the run and is
reported with its evidence. awaiting-approval parks the whole run — the
controller surfaces the approval id and exits without deciding it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts import TaskOutcome, TaskPlan
from ..fabric import FabricConfig, invoke_fabric
from .planner import topo_order


@dataclass
class ExecutionOutcome:
    outcomes: list[TaskOutcome] = field(default_factory=list)
    stopped: bool = False
    stop_reason: str = ""
    approval_id: str | None = None
    cancelled: bool = False


class ExecutionController:
    def __init__(self, fabric_cfg: FabricConfig) -> None:
        self._cfg = fabric_cfg

    def execute(
        self,
        plan: TaskPlan,
        project_id: str | None,
        compiled_workflow: dict | None = None,
        cancel_check: callable | None = None,  # type: ignore[valid-type]
    ) -> ExecutionOutcome:
        result = ExecutionOutcome()
        for task in topo_order(plan.tasks):
            if cancel_check and cancel_check():
                result.cancelled = True
                result.stopped = True
                result.stop_reason = "cancelled before " + task.id
                break
            if not task.capabilityId:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="failed",
                    detail="no capability bound to this task"))
                result.stopped = True
                result.stop_reason = f"task {task.id} has no capability"
                break

            payload = dict(task.input)
            if task.inputFrom == "compiled-workflow":
                if compiled_workflow is None:
                    result.outcomes.append(TaskOutcome(
                        taskId=task.id, state="failed",
                        detail="plan expected a compiled workflow but none was produced"))
                    result.stopped = True
                    result.stop_reason = "missing compiled workflow input"
                    break
                payload.update({
                    "name": compiled_workflow["name"],
                    "description": compiled_workflow["description"],
                    "nodes": compiled_workflow["nodes"],
                    "edges": compiled_workflow["edges"],
                })

            invocation = invoke_fabric(
                task.capabilityId,
                payload,
                {
                    "actor": {"kind": "agent", "id": "central-agent"},
                    "projectId": project_id,
                    "taskId": task.id,
                },
                self._cfg,
            )
            outcome = invocation["outcome"]
            performed = outcome in ("succeeded", "unverified")
            state = {
                "succeeded": "done",
                "unverified": "done",       # ran; verification reported separately
                "denied": "blocked",
                "awaiting-approval": "awaiting-approval",
                "failed": "failed",
                "unsupported": "blocked",
            }[outcome]
            entry = TaskOutcome(
                taskId=task.id,
                state=state,  # type: ignore[arg-type]
                performed=performed,
                verified=invocation["verification"]["passed"],
                invocationIds=[invocation["invocationId"]],
                approvalId=invocation.get("approvalId"),
                detail=invocation["detail"],
            )
            result.outcomes.append(entry)

            if outcome == "awaiting-approval":
                result.approval_id = invocation.get("approvalId")
                result.stopped = True
                result.stop_reason = "awaiting human approval"
                break
            if not performed:
                result.stopped = True
                result.stop_reason = f"{task.id}: {invocation['detail']}"
                break
        return result
