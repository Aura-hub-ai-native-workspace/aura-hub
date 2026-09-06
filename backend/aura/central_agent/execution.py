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
    # Verified upstream evidence, keyed by task id, for inputFrom ==
    # "upstream-output" resolution. Populated ONLY from done outcomes
    # whose verification passed; never from failed/parked/unverified work.
    verified_outputs: dict[str, dict] = field(default_factory=dict)


class ExecutionController:
    def __init__(self, fabric_cfg: FabricConfig, engine: WorkflowEngine | None = None) -> None:
        self._cfg = fabric_cfg
        self.engine = engine or WorkflowEngine(
            fabric_cfg,
            *(_default_stores()),
            config=EngineConfig(),
        )

    def execute(
        self,
        plan: TaskPlan,
        project_id: str | None,
        compiled_workflow: dict | None = None,
        cancel_check: Any | None = None,
        resume_grants: dict[str, str] | None = None,
        project_cwd: str | None = None,
        prior_verified: dict[str, dict] | None = None,
    ) -> ExecutionOutcome:
        """Run one plan leg. `prior_verified` seeds handoff evidence from an
        earlier leg of the same workflow (verified task_id → evidence
        record, as filed by _note_task_closed): a resumed leg must not
        re-prove what a previous leg already verified, and a parked
        upstream must never silently become verified by re-running."""
        result = ExecutionOutcome()
        if prior_verified:
            result.verified_outputs.update(prior_verified)
        resume_grants = resume_grants or {}
        for task in topo_order(plan.tasks):
            if cancel_check and cancel_check():
                result.cancelled = True
                result.stopped = True
                result.stop_reason = "cancelled before " + task.id
                break

            # Resume without re-execution: a task whose verification is
            # already seeded (prior leg of the same workflow) is recorded
            # as skipped — never re-dispatched, so settled side effects
            # are not repeated. Its evidence stays available downstream.
            if task.id in result.verified_outputs:
                seed = result.verified_outputs[task.id]
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="skipped", performed=False,
                    verified=True,
                    invocationIds=list(seed.get("invocation_ids") or []),
                    approvalId=(seed.get("approval_ids") or [None])[0],
                    detail=("Already verified in a prior leg; not "
                            "re-executed."),
                ))
                continue

            # Governed handoff gate: a task declaring inputFrom ==
            # "upstream-output" may only run when EVERY dependency has
            # verified evidence in THIS run. Anything else blocks it here —
            # unverified results never reach downstream execution.
            if task.inputFrom == "upstream-output":
                gate = self._gate_handoff(task, result)
                if gate is not None:
                    result.outcomes.append(gate)
                    result.stopped = True
                    result.stop_reason = gate.detail
                    break

            if task.route == "workflow-run":
                grant_for_task = resume_grants.get(task.id)
                if grant_for_task:
                    _, parked_rid = grant_for_task
                    self._resume_workflow(task, parked_rid, result)
                else:
                    self._run_workflow(task, plan, project_id, result,
                                       project_cwd=project_cwd)
            else:
                grant_for_task = resume_grants.get(task.id)
                self._invoke_single(task, project_id, compiled_workflow, result,
                                    approval_id=grant_for_task[0] if grant_for_task else None,
                                    project_cwd=project_cwd)

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

    # ── governed handoff ───────────────────────────────────────────────
    def _gate_handoff(self, task: Any, result: ExecutionOutcome,
                      ) -> TaskOutcome | None:
        """Block tasks whose upstream results are not verified.

        Returns a terminal TaskOutcome to append (and stop on), or None
        when every dependency has verified evidence in THIS run and the
        task may proceed to input resolution. Pure gate — no I/O, never
        executes anything.
        """
        if task.route == "workflow-run":
            return TaskOutcome(
                taskId=task.id, state="failed", performed=False,
                detail=("inputFrom 'upstream-output' is only supported on "
                        "the single-invocation route; refusing rather than "
                        "running with unresolved input."))
        deps = list(task.dependsOn or [])
        if not deps:
            return TaskOutcome(
                taskId=task.id, state="failed", performed=False,
                detail=("inputFrom 'upstream-output' names no dependencies; "
                        "declare dependsOn or use a literal input."))
        missing = [d for d in deps if d not in result.verified_outputs]
        if missing:
            return TaskOutcome(
                taskId=task.id, state="blocked", performed=False,
                detail=("blocked: upstream task(s) have no verified result "
                        f"in this run: {', '.join(missing)}."))
        return None

    def _record_verified(self, task: Any, outcome: TaskOutcome,
                         output: dict[str, Any] | None,
                         result: ExecutionOutcome) -> None:
        """File verified evidence for later dependent tasks to consume.

        Only done+verified outcomes are recorded, and only the allowlisted
        handoff fields — never raw executor output.
        """
        if outcome.state != "done" or outcome.verified is not True:
            return
        output = output or {}
        scope_check = output.get("scopeCheck") or {}
        result.verified_outputs[task.id] = {
            "task_id": task.id,
            "node_id": str(output.get("nodeId") or ""),
            "agent": str(output.get("agent") or ""),
            "stdout": str(output.get("stdout") or ""),
            "scope_paths": list(output.get("scopePaths") or []),
            "changed_paths": list(scope_check.get("changed") or []),
            "invocation_ids": list(outcome.invocationIds),
            "approval_ids": ([outcome.approvalId] if outcome.approvalId
                             else []),
        }

    # ── single-invocation route ──────────────────────────────────────────
    def _invoke_single(
        self,
        task: Any,
        project_id: str | None,
        compiled_workflow: dict | None,
        result: ExecutionOutcome,
        approval_id: str | None = None,
        project_cwd: str | None = None,
    ) -> None:
        if not task.capabilityId:
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state="failed",
                detail="no capability bound to this task"))
            return

        payload = dict(task.input)
        handoff_consumed: list[str] = []
        if task.inputFrom == "upstream-output":
            # The gate in execute() already ensured every dependency has
            # verified evidence; resolution here is pure assembly. Any
            # refusal fails closed without dispatching.
            from .handoff import (
                UpstreamEvidence,
                build_envelope,
                resolve_task_input,
            )

            sources = []
            for dep_id in list(task.dependsOn or []):
                ev = result.verified_outputs.get(dep_id)
                if ev is None:  # pragma: no cover — gate guarantees presence
                    result.outcomes.append(TaskOutcome(
                        taskId=task.id, state="blocked", performed=False,
                        detail=(f"blocked: verified evidence for {dep_id} "
                                "vanished before dispatch.")))
                    return
                sources.append(UpstreamEvidence(
                    task_id=str(ev.get("task_id") or dep_id),
                    node_id=str(ev.get("node_id") or ""),
                    agent=str(ev.get("agent") or ""),
                    stdout=str(ev.get("stdout") or ""),
                    scope_paths=list(ev.get("scope_paths") or []),
                    changed_paths=list(ev.get("changed_paths") or []),
                    invocation_ids=list(ev.get("invocation_ids") or []),
                    approval_ids=list(ev.get("approval_ids") or [])))
            try:
                envelope = build_envelope(sources)
                payload = resolve_task_input(payload, envelope["text"])
            except Exception as exc:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="failed", performed=False,
                    detail=f"handoff resolution refused: {exc}"))
                return
            handoff_consumed = list(envelope["consumed_ids"])
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
        if project_cwd:
            context["cwd"] = project_cwd
        if approval_id:
            context["approvalId"] = approval_id
        # Phase 11 unification: effects with node bindings go through the
        # SAME interpreter as workflows (one runner); everything else keeps
        # the direct governed invoke (policy/audit identical).
        engine = getattr(self, "engine", None)
        if engine is not None and not approval_id and not project_cwd:
            pass  # fall through to direct invoke below (no cwd context)
        if engine is not None and task.capabilityId in engine.NODE_TO_CAPABILITY.values():
            run, _nt = engine.run_ad_hoc(
                task.capabilityId, payload, project_cwd, project_id,
                approval_id=approval_id, task_label=task.description[:60])
            invocations = [e["invocationId"] for e in (run.get("evidence") or [])]
            state_map = {"succeeded": "done", "awaiting-approval": "awaiting-approval",
                         "denied": "denied", "timed-out": "timed-out"}
            outcome_state = state_map.get(run["state"], "failed")
            parked = [n for n in run["nodes"].values()
                      if n["state"] == "awaiting-approval"]
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state=outcome_state,  # type: ignore[arg-type]
                performed=run["state"] in ("succeeded",),
                verified=all(n.get("state") == "succeeded"
                             for n in run["nodes"].values())
                if run["state"] == "succeeded" else None,
                invocationIds=invocations,
                approvalId=(parked[0].get("approval") or {}).get("requestId")
                if parked else None,
                detail=f"Run {run['id']} ended {run['state']}: "
                       f"{next(iter(run['nodes'].values()), {}).get('summary', '')}",
            ))
            if result.run_id is None:
                result.run_id = run["id"]
            if outcome_state == "awaiting-approval" and result.run_id:
                result.parked_runs[task.id] = result.run_id
            self._note_task_closed(task, result, None, handoff_consumed)
            return
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
        self._note_task_closed(
            task, result, invocation.get("output"), handoff_consumed)

    def _note_task_closed(self, task: Any, result: ExecutionOutcome,
                            output: dict[str, Any] | None,
                            handoff_consumed: list[str]) -> None:
        """Attach handoff lineage and file verified evidence, if any.

        Called once per dispatched task, at every exit of _invoke_single.
        Lineage (consumedFrom) is recorded whenever this task consumed
        upstream evidence; verified evidence is filed only for done tasks
        whose verification passed. Both ride the outcome into session and
        run persistence, so restarts can reconstruct the handoff chain.
        """
        if not result.outcomes:
            return
        outcome = result.outcomes[-1]
        if outcome.taskId != task.id:
            return  # defensive: only annotate this task's own outcome
        if handoff_consumed:
            outcome.consumedFrom = list(handoff_consumed)
        if outcome.state != "done" or outcome.verified is not True:
            return
        output = output or {}
        scope = output.get("scopeCheck") or {}
        result.verified_outputs[task.id] = {
            "task_id": task.id,
            "node_id": str(output.get("nodeId") or ""),
            "agent": str(output.get("agent") or ""),
            "stdout": str(output.get("stdout") or ""),
            "scope_paths": list(output.get("scopePaths") or []),
            "changed_paths": list(scope.get("changed") or []),
            "invocation_ids": list(outcome.invocationIds),
            "approval_ids": ([outcome.approvalId] if outcome.approvalId
                             else []),
        }

    # ── workflow-run route ───────────────────────────────────────────────
    def _run_workflow(
        self,
        task: Any,
        plan: TaskPlan,
        project_id: str | None,
        result: ExecutionOutcome,
        project_cwd: str | None = None,
    ) -> None:
        wf_ref = str(task.input.get("workflowRef") or "")
        run = self.engine.start_run(
            wf_ref,
            inputs={},
            project_id=project_id,
            project_path=project_cwd or ".",
        )
        result.run_id = run["id"]
        self._record_run_outcome(task, run, result)

    def _resume_workflow(self, task: Any, parked_rid: str,
                         result: ExecutionOutcome) -> None:
        # The parked leg already carries its project path; the engine
        # reuses it for the resumed leg.
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
