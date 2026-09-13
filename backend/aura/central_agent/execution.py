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
    #: The inbound request leg that caused this execution (see
    #: central_agent.correlation). Observability only — the outcome's
    #: authority comes from verification, never from this field.
    request_id: str = ""
    resumed_run_id: str | None = None
    parked_runs: dict[str, str] = field(default_factory=dict)  # taskId → rid
    # Verified upstream evidence, keyed by task id, for inputFrom ==
    # "upstream-output" resolution. Populated ONLY from done outcomes
    # whose verification passed; never from failed/parked/unverified work.
    verified_outputs: dict[str, dict] = field(default_factory=dict)
    # Deviation evidence, keyed by task id, for the supervisor correction
    # loop. Filed whenever an outcome carries scopeDeviation in its
    # executor output, regardless of terminal state — the service layer
    # needs it to decide, build, and re-dispatch corrections. Same shape
    # as verified evidence, plus the "outside" list naming the deviation.
    deviation_evidence: dict[str, dict] = field(default_factory=dict)
    # Real-time governed worker actions, in observation order, for the
    # service layer to emit on the event bus. Bounded at the source
    # (executor caps memory; file log stays complete on disk).
    governed_actions: list[dict] = field(default_factory=list)
    # Tasks the user's cancellation stopped from ever starting. Kept
    # apart from failures: nothing here went wrong, it simply never ran.
    cancelled_before: list[str] = field(default_factory=list)
    # Which worker AURA put on which task, and how that task ended.
    # Recorded at dispatch (so a task that never returned still names its
    # worker) and completed from the executor's own output. This is the
    # ONE place worker lifecycle is derived: it restates the task
    # outcome, it never decides it.
    worker_assignments: dict[str, dict] = field(default_factory=dict)


#: Task state → worker lifecycle. Deliberately a restatement of the
#: existing TaskOutcome vocabulary rather than a second state machine:
#: a worker is ACTIVE because its task is running and PARKED because its
#: task parked, so the two can never disagree.
_WORKER_LIFECYCLE = {
    "done": "COMPLETED",
    "skipped": "COMPLETED",
    "awaiting-approval": "PARKED",
    "blocked": "WAITING",
    "denied": "TERMINATED",
    "timed-out": "TERMINATED",
    "cancelled": "CANCELLED",
    "failed": "FAILED",
    "running": "ACTIVE",
    "pending": "IDLE",
    "ready": "IDLE",
}


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
        cancel_token: Any | None = None,
        resume_grants: dict[str, str] | None = None,
        project_cwd: str | None = None,
        prior_verified: dict[str, dict] | None = None,
        correlation: dict[str, str] | None = None,
    ) -> ExecutionOutcome:
        """Run one plan leg. `prior_verified` seeds handoff evidence from an
        earlier leg of the same workflow (verified task_id → evidence
        record, as filed by _note_task_closed): a resumed leg must not
        re-prove what a previous leg already verified, and a parked
        upstream must never silently become verified by re-running.
        `correlation` carries {"session_id", "request_id"} into every
        invocation context, worker assignment, and the outcome itself —
        observability only, never authority."""
        result = ExecutionOutcome()
        correlation = {k: v for k, v in (correlation or {}).items() if v}
        if correlation.get("request_id"):
            result.request_id = correlation["request_id"]
        if prior_verified:
            result.verified_outputs.update(prior_verified)
        resume_grants = resume_grants or {}
        # A run cancelled before a task starts never dispatches it. The
        # token is authoritative; cancel_check stays for callers that
        # pass only a predicate.
        def _stop_requested() -> bool:
            if cancel_token is not None and cancel_token.cancelled:
                return True
            return bool(cancel_check and cancel_check())

        for task in topo_order(plan.tasks):
            if _stop_requested():
                result.cancelled = True
                result.stopped = True
                result.stop_reason = (
                    f"cancelled before {task.id} started; no worker was "
                    "dispatched for it")
                result.cancelled_before.append(task.id)
                break

            # Resume without re-execution: a task whose verification is
            # already seeded (prior leg of the same workflow) is recorded
            # as skipped — never re-dispatched, so settled side effects
            # are not repeated. Its evidence stays available downstream.
            if task.id in result.verified_outputs:
                seed = result.verified_outputs[task.id]
                # Restored, not re-run — but the workspace still needs to
                # know which worker completed it, so lifecycle stays
                # coherent across legs instead of blanking on resume.
                result.worker_assignments[task.id] = {
                    "taskId": task.id,
                    "nodeId": str(seed.get("node_id") or ""),
                    "worker": str(seed.get("agent") or ""),
                    "role": getattr(task, "workerRole", None) or "",
                    "capabilityId": task.capabilityId,
                    "lifecycle": "COMPLETED",
                    "state": "skipped",
                    **({"sessionId": correlation["session_id"]}
                       if correlation.get("session_id") else {}),
                    **({"requestId": correlation["request_id"]}
                       if correlation.get("request_id") else {}),
                    "verified": True,
                }
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="skipped", performed=False,
                    verified=True,
                    invocationIds=list(seed.get("invocation_ids") or []),
                    approvalId=(seed.get("approval_ids") or [None])[0],
                    detail=("Already verified in a prior leg; not "
                            "re-executed."),
                ))
                continue

            # Conditional work: a task planned as remediation runs only
            # when the verified upstream result actually reports
            # something to address. The upstream text is DATA — reading
            # it can skip a dispatch AURA was authorised to make, never
            # authorise one, never satisfy a verification, and never
            # decide acceptance. Anything unreadable runs the task.
            if getattr(task, "runWhen", "always") != "always":
                decision = self._conditional_gate(task, result)
                if decision is not None:
                    result.outcomes.append(decision)
                    result.worker_assignments[task.id] = {
                        "taskId": task.id, "nodeId": "", "role":
                        getattr(task, "workerRole", None) or "",
                        "capabilityId": task.capabilityId,
                        "lifecycle": "COMPLETED", "state": "skipped",
                        "verified": True,
                    }
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
                                    project_cwd=project_cwd,
                                    cancel_token=cancel_token,
                                    correlation=correlation)

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
            if last.state == "cancelled":
                result.cancelled = True
                result.stopped = True
                result.stop_reason = f"{task.id}: {last.detail}"
                break
            if last.state in ("failed", "blocked"):
                # A stop that landed while the worker was settling reads
                # as a failure from the executor's side. The token says
                # what actually happened, and it outranks the exit code.
                if cancel_token is not None and cancel_token.cancelled:
                    result.outcomes[-1] = last.model_copy(update={
                        "state": "cancelled", "verified": None})
                    result.cancelled = True
                result.stopped = True
                result.stop_reason = f"{task.id}: {last.detail}"
                break
        return result

    # ── Phase G worker requirement matching ────────────────────────────
    def _present_nodes(self) -> list[dict]:
        try:
            host = getattr(getattr(self._cfg, "fabric", None), "host", None)
            present = getattr(host, "present_nodes", None)
            nodes = present() if callable(present) else []
            return [n for n in nodes if isinstance(n, dict)]
        except Exception:
            return []

    def _role_usable(self, capability_id: str):
        """Executor usability check, mirroring the Fabric invoke path:
        the routing executor's supportsNode, or None (match on role
        provision only; dispatch still enforces usability).

        The config's own executor map is consulted first, then the
        Fabric's registry. The fallback is what makes selection agree
        with dispatch in the production composition, which hands the
        agent an empty map and registers the real executors on the
        Fabric: without it, selection sees no usability check at all and
        can pick a worker AURA has no verified way to drive — passing
        over one it can — only for dispatch to refuse it. Failing that
        way is honest but useless; the point is to choose a worker that
        works.
        """
        for source in (getattr(self._cfg, "executors", None),
                       getattr(getattr(self._cfg, "fabric", None),
                               "executors", None)):
            try:
                exe = (source or {}).get(capability_id)
            except Exception:
                continue
            fn = getattr(exe, "supportsNode", None)
            if callable(fn):
                return fn
        return None

    def _match_role(self, task: Any, role: str, pinned_id: str | None,
                    exclude: set[str] | None = None) -> str | None:
        from .worker_match import match_worker, node_satisfies_role

        nodes = self._present_nodes()
        barred = exclude or set()
        if pinned_id:
            pinned = next((n for n in nodes if n.get("id") == pinned_id),
                          None)
            if pinned is None or not node_satisfies_role(pinned, role):
                return None
            if pinned_id in barred:
                return None  # a pin never overrides an exclusion
            return pinned_id
        usable = self._role_usable(task.capabilityId)
        node = match_worker(role, nodes, usable, exclude=barred)
        return node.get("id") if node else None

    def _excluded_workers(self, task: Any,
                          result: ExecutionOutcome) -> set[str]:
        """Workers this task may not reuse, resolved from what actually
        ran. Reads the assignments of the named tasks IN THIS RUN, so a
        task that never dispatched contributes no exclusion and cannot
        silently block its dependant."""
        out: set[str] = set()
        for other in (getattr(task, "distinctWorkerFrom", None) or []):
            other = str(other)
            # Three sources, in order of directness. The evidence records
            # matter because the upstream task usually ran on an EARLIER
            # leg: an approval-gated plan parks between tasks, so by the
            # time the reviewer is dispatched the implementer is restored
            # verified evidence, not a live assignment. Reading only the
            # live assignments let the same worker review its own work.
            candidates = (
                (result.worker_assignments.get(other) or {}).get("nodeId"),
                (result.verified_outputs.get(other) or {}).get("node_id"),
                (result.deviation_evidence.get(other) or {}).get("node_id"),
            )
            for node_id in candidates:
                if node_id:
                    out.add(str(node_id))
                    break
        return out

    def _conditional_gate(self, task: Any,
                          result: ExecutionOutcome) -> TaskOutcome | None:
        """Decide a runWhen task, or None to dispatch it normally.

        Returns a settled `skipped` outcome ONLY when every dependency has
        verified evidence in this run AND all of them plainly report
        nothing to address. A missing dependency, a missing verdict, a
        malformed one, or conflicting ones all return None — the task
        runs, which is the direction that cannot manufacture success.
        """
        from .findings import review_verdict, should_run_after

        deps = list(task.dependsOn or [])
        if not deps:
            return None
        verdicts: list[str] = []
        for dep in deps:
            evidence = result.verified_outputs.get(dep)
            if evidence is None:
                return None  # nothing proven upstream: let the gates decide
            verdicts.append(review_verdict(str(evidence.get("stdout") or "")))
        run, why = should_run_after(verdicts)
        if run:
            return None
        return TaskOutcome(
            taskId=task.id, state="skipped", performed=False, verified=True,
            detail=(f"Not needed: {why}. Nothing was dispatched, and "
                    "nothing was changed."))

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
        cancel_token: Any | None = None,
        correlation: dict[str, str] | None = None,
    ) -> None:
        correlation = {k: v for k, v in (correlation or {}).items() if v}
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
        # Leg correlation into the governed invocation (lands in the
        # Fabric audit record; see fabric.invoke._settle). IDs only.
        if correlation.get("session_id"):
            context["sessionId"] = correlation["session_id"]
        if correlation.get("request_id"):
            context["requestId"] = correlation["request_id"]
        # AURA-validated worker pin (planner-checked, routing-enforced):
        # the requested node is never substituted, only denied.
        node_id = getattr(task, "nodeId", None)
        if node_id:
            context["nodeId"] = node_id
        # Phase G requirement matching: "a worker suitable for this
        # task". A stated role resolves to an eligible node BEFORE
        # dispatch and travels the same explicit-nodeId path (routing
        # re-validates, including usability). No eligible worker fails
        # the task closed — never a silent unsuitable dispatch.
        role = getattr(task, "workerRole", None)
        if role:
            excluded = self._excluded_workers(task, result)
            matched = self._match_role(task, role, node_id, excluded)
            if matched is None:
                why = (f"no connected worker satisfies role '{role}' for "
                       "this task; refusing rather than dispatching an "
                       "unsuitable worker.")
                if excluded:
                    why = (f"no SECOND connected worker satisfies role "
                           f"'{role}': this task must not reuse "
                           f"{', '.join(sorted(excluded))}, and no other "
                           "eligible worker is connected. Refusing rather "
                           "than letting a worker review its own work.")
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="failed", performed=False,
                    detail=why))
                return
            context["nodeId"] = matched
        if project_cwd:
            context["cwd"] = project_cwd
        if approval_id:
            context["approvalId"] = approval_id
        if cancel_token is not None:
            # The worker's own stop signal. It reaches run_file, which
            # signals the worker's process GROUP — so STOP terminates
            # what the worker forked as well as the worker itself.
            context["cancelToken"] = cancel_token
            cancel_token.note_dispatch(
                task.id, worker_node_id=context.get("nodeId") or "")
        result.worker_assignments[task.id] = {
            "taskId": task.id,
            "nodeId": context.get("nodeId") or "",
            "role": role or "",
            "capabilityId": task.capabilityId,
            "lifecycle": "ACTIVE",
            **({"sessionId": correlation["session_id"]}
               if correlation.get("session_id") else {}),
            **({"requestId": correlation["request_id"]}
               if correlation.get("request_id") else {}),
        }
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
        # The executor reports a stopped worker as a failed invocation,
        # because from its side that is what a terminated process looks
        # like. Only the run knows the difference, and it records the
        # difference: a cancelled task is never corrected or retried.
        if (invocation.get("output") or {}).get("cancelled"):
            state = "cancelled"
            performed = False
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
        output = output or {}
        assignment = result.worker_assignments.get(task.id)
        if assignment is not None:
            if output.get("nodeId"):
                assignment["nodeId"] = str(output["nodeId"])
            if output.get("agent"):
                assignment["worker"] = str(output["agent"])
            assignment["lifecycle"] = _WORKER_LIFECYCLE.get(
                outcome.state, "FAILED")
            assignment["state"] = outcome.state
            assignment["verified"] = outcome.verified
            # Handoff lineage: which verified upstream results fed this
            # worker. Read from the argument, not from the outcome — the
            # outcome is annotated with it further down this same method,
            # so reading it here would always find it empty.
            if handoff_consumed:
                assignment["consumedFrom"] = list(handoff_consumed)
            if getattr(task, "dependsOn", None):
                assignment["dependsOn"] = list(task.dependsOn)
        governed = output.get("governedActions") or {}
        events = governed.get("events") or output.get("actionEvents")
        if isinstance(events, list) and events:
            for event in events[:500]:
                if isinstance(event, dict):
                    result.governed_actions.append(event)
        if handoff_consumed:
            outcome.consumedFrom = list(handoff_consumed)
        output = output or {}
        scope_check = output.get("scopeCheck") or {}
        if output.get("scopeDeviation"):
            # Deviation evidence is filed even though (especially because)
            # the outcome did not verify: this is what the supervisor
            # correction loop reads. Same shape as verified evidence, plus
            # the outside list that names the deviation.
            result.deviation_evidence[task.id] = {
                "task_id": task.id,
                "node_id": str(output.get("nodeId") or ""),
                "agent": str(output.get("agent") or ""),
                "stdout": str(output.get("stdout") or ""),
                "scope_paths": list(output.get("scopePaths") or []),
                "changed_paths": list(scope_check.get("changed") or []),
                "outside": list(scope_check.get("outside") or []),
                "invocation_ids": list(outcome.invocationIds),
                "approval_ids": ([outcome.approvalId] if outcome.approvalId
                                 else []),
            }
        if outcome.state != "done" or outcome.verified is not True:
            return
        scope = (output or {}).get("scopeCheck") or {}
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
