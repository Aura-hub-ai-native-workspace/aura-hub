"""Execution controller — drives a plan through the ONE governed path.

Two routes, both governed:
  single-invocation → one aura.fabric invoke per task;
  workflow-run      → the Python Workflow Engine loads the stored
                      definition and drives nodes through the same Fabric.

The controller performs no side effects itself. Failure policy (deliberate,
documented): NO automatic retries of side-effectful steps. Nothing parks
for a human: a step the policy refuses is refused at once, and the run ends.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..contracts import TaskOutcome, TaskPlan
from ..fabric import FabricConfig, invoke_fabric
from ..workflow import EngineConfig, WorkflowEngine
from .planner import topo_order

#: Read-only tools whose real result is the answer. Their executors return the
#: result itself (text, a list of names, records), not a worker's
#: {"stdout": ...}, and the record kept only `stdout`, so the result was
#: dropped and the answer said "1 task(s) executed". It is recorded as text.
_TEXT_RESULT_CAPS = frozenset({"git.diff", "filesystem.list",
                               "filesystem.read", "project.list", "workflow.list"})


def _result_text(value: Any) -> str:
    """A read-only tool's result as plain text, without inventing anything."""
    import json

    if isinstance(value, str):
        return value
    if isinstance(value, dict) and len(value) == 1 and isinstance(next(iter(value.values())), list):
        value = next(iter(value.values()))  # {"workflows": [...]} -> the list
    if isinstance(value, list):
        return "\n".join(v if isinstance(v, str) else json.dumps(v, sort_keys=True, default=str)
                         for v in value)
    return json.dumps(value, sort_keys=True, default=str)


def _progress(callback: Any, label: str, *args: Any) -> None:
    """Tell the owner of the run that a task started or finished.

    A failing notification must not kill the run (it is bookkeeping), but it
    must not vanish either: that bookkeeping is the queue state recovery and
    resume read, so a failure is logged with its traceback."""
    try:
        callback(*args)
    except Exception:  # noqa: BLE001 — the run continues; the failure is recorded
        import logging

        logging.getLogger(__name__).warning(
            "%s callback failed for task %s; the run continues, but its "
            "recorded progress may be stale", label, args[0] if args else "?",
            exc_info=True)


def _recorded_output(capability: Any, output: Any) -> dict:
    """The executor output as the mapping the record reads, with a read-only
    tool's result carried as `stdout`."""
    if capability in _TEXT_RESULT_CAPS and output is not None and not (
            isinstance(output, dict) and "stdout" in output):
        return {"stdout": _result_text(output)}
    return output if isinstance(output, dict) else {}

#: Fabric outcome → leg state. Unknown outcomes fail closed as "failed":
#: a new outcome string must never crash the leg with KeyError (the
#: engine path already defaults this way).
_OUTCOME_STATES = {
    "succeeded": "done",
    "unverified": "done",       # ran; verification reported separately
    "denied": "denied",
    "failed": "failed",
    "unsupported": "blocked",
}


#: Capabilities that change a project's files or repository, or run code in
#: it. The product rule: at most ONE of these is in flight for a project at a
#: time — a coding worker never edits files while another worker (or an AURA
#: write, a commit, a command) is changing them. Read-only capabilities
#: (status, search, inspection) may still run side by side.
MUTATING_CAPABILITIES = frozenset({
    "agent.delegate", "filesystem.write", "git.commit", "git.branch",
    "git.push", "terminal.execute", "sandbox.execute", "workflow.run",
})


def mutates_project(task: Any) -> bool:
    return getattr(task, "capabilityId", None) in MUTATING_CAPABILITIES


def task_state(o: TaskOutcome) -> str:
    """The Workspace checklist state of one settled task. A worker finishing
    is not the task being complete: only a passed check is `verified`."""
    if o.state in ("done", "skipped"):
        if o.state == "skipped" or o.verified is True:
            return "verified"
        return "failed" if o.verified is False else "unverified"
    return {"failed": "failed", "timed-out": "timeout", "timeout": "timeout",
            "blocked": "blocked", "denied": "denied", "cancelled": "cancelled"}.get(o.state, "failed")


def _outcome_state(outcome: str) -> str:
    return _OUTCOME_STATES.get(outcome, "failed")


def state_for_invocation(outcome: str, output: Any) -> str:
    """The task state one settled invocation means.

    The Fabric has no timed-out outcome of its own: a worker that ran
    out of its execution budget is a FAILED invocation from the Fabric's
    point of view, because that is what a terminated process looks like
    there. The difference travels in the executor's output, and the run is
    the only layer that can say what actually happened — so a worker that
    was still working when its deadline arrived reads as "timed-out",
    not as a worker that failed.

    Output is Any by contract (file text, stdout, structured results);
    only a dict can carry the flag, so a text output must not reach .get.
    """
    state = _outcome_state(outcome)
    if not isinstance(output, dict):
        return state
    if output.get("cancelled"):
        return "cancelled"
    if output.get("timedOut"):
        return "timed-out"
    return state


def _fill_session_inputs(capability_id: str, payload: dict, project_id: str | None) -> None:
    """Supply the one input a plan can never know better than the session: which project.

    A planner (or a local model) names a capability and often leaves out a required
    `projectId` the Workspace already holds, which used to fail the task at the
    contract check with "projectId is required" for a project that was open the
    whole time. Only a missing or empty value is filled; an explicit one is kept.
    """
    if not project_id or str(payload.get("projectId") or "").strip():
        return
    from ..fabric import describe_capability

    cap = describe_capability(capability_id) or {}
    for spec in cap.get("input") or []:
        if spec.get("name") == "projectId" and spec.get("required"):
            payload["projectId"] = project_id
            return


@dataclass
class ExecutionOutcome:
    outcomes: list[TaskOutcome] = field(default_factory=list)
    stopped: bool = False
    stop_reason: str = ""
    cancelled: bool = False
    timed_out: bool = False
    denied: bool = False
    run_id: str | None = None
    #: The inbound request leg that caused this execution (see
    #: central_agent.correlation). Observability only — the outcome's
    #: authority comes from verification, never from this field.
    request_id: str = ""
    # Verified upstream evidence, keyed by task id, for inputFrom ==
    # "upstream-output" resolution. Populated ONLY from done outcomes
    # whose verification passed; never from failed/unverified work.
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
    # Paths of artifacts generated by artifact.generate invocations.
    # Populated by _note_task_closed when the executor returns {"path":…}.
    # Consumed by EvidenceCollector to link artifacts to the evidence bundle.
    artifact_paths: list[str] = field(default_factory=list)
    # Scope overlap conflicts detected BEFORE parallel dispatch: two or more
    # concurrent write tasks declared overlapping scopePaths. Non-blocking
    # (the run continues) but recorded for the evidence bundle and UI.
    scope_conflicts: list[dict] = field(default_factory=list)
    # Write conflicts detected AFTER parallel dispatch: two workers modified
    # the same file path. Recorded for evidence; the service layer surfaces
    # them through the verification report and worker lifecycle events.
    write_conflicts: list[dict] = field(default_factory=list)
    # Coordinator recovery history: one record per task retried by the
    # completion check (round, task, worker before/after, how it ended).
    recovery: list[dict] = field(default_factory=list)
    # Files that changed on disk while each project-mutating task ran,
    # MEASURED (central_agent/change_observer.py), keyed by task id:
    # {"changes": [{path, op}], "complete": bool, "worker": str}.
    file_changes: dict[str, dict] = field(default_factory=dict)
    # The plan this leg is executing, so each worker's brief can carry the
    # shared run board (run_board.render_board). Never serialized.
    plan: Any = field(default=None, repr=False, compare=False)
    # Outcomes settled before a concurrent wave started, for the run board
    # of that wave's workers only. Never merged into `outcomes`.
    board_outcomes: list = field(default_factory=list, repr=False, compare=False)

#: Worker task attempts in one run, the first included. Bounded on purpose:
#: a task that fails twice on two workers needs a person, not a third try.
MAX_TASK_ATTEMPTS = 2
#: Extra legs the completion check may run after the first.
MAX_RECOVERY_ROUNDS = 2


#: Task state → worker lifecycle. Deliberately a restatement of the
#: existing TaskOutcome vocabulary rather than a second state machine:
#: a worker is ACTIVE while its task runs and COMPLETED or TERMINATED once it
#: settles, so the two can never disagree.
_WORKER_LIFECYCLE = {
    "done": "COMPLETED",
    "skipped": "COMPLETED",
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
    # Optional hooks default at class level so a controller that is built
    # without __init__ (tests do this) still runs: they are telemetry and
    # advice, never required for execution.
    emit: Any | None = None
    error_lookup: Any | None = None

    def __init__(self, fabric_cfg: FabricConfig, engine: WorkflowEngine | None = None,
                 capability_registry=None, model_registry=None) -> None:
        self._cfg = fabric_cfg
        # Optional measured registry, used ONLY to enrich refusal
        # messages with which machine tools a role is missing. Matching
        # and dispatch are unchanged: connected worker nodes decide.
        self._registry = capability_registry
        # Sovereign model registry: when present, ModelRouter uses it to
        # select a local/private model for agent.delegate tasks. Never
        # blocks dispatch — absent or empty means no model preference.
        self._model_registry = model_registry
        #: Last worker-registry read failure, if any. A broken registry
        #: must not read as "no workers connected" — the refusal reason
        #: below names it instead.
        self._nodes_error: str | None = None
        #: Optional event sink, `emit(type, session_id, **payload)`. The
        #: CentralAgent wires its own bus here; absent in unit tests.
        self.emit: Any | None = None
        #: Optional `lookup(project_root, query) -> str`: relevant earlier
        #: errors for a worker's brief (see error_knowledge.py).
        self.error_lookup: Any | None = None
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
        project_cwd: str | None = None,
        prior_verified: dict[str, dict] | None = None,
        correlation: dict[str, str] | None = None,
        on_task_complete: Any | None = None,
        on_task_start: Any | None = None,
    ) -> ExecutionOutcome:
        """Run the plan to completion, then check write conflicts across
        the WHOLE run: every task that recorded changed paths, whatever wave
        or sequential step it ran in.

        Completion check: after a leg, anything still unverified is
        compared against the plan. When every open failure is a worker task
        that failed, timed out or did not verify, the work is scheduled
        again — on another eligible worker when the person did not name
        one — with verified work seeded so it is never repeated, and the
        tasks that were waiting on it run in the same leg. Bounded by
        MAX_TASK_ATTEMPTS and MAX_RECOVERY_ROUNDS; a cancellation, a policy
        denial, a scope deviation (the supervisor's) or
        a non-worker failure ends it honestly instead."""
        legs = dict(compiled_workflow=compiled_workflow,
                    cancel_check=cancel_check, cancel_token=cancel_token,
                    project_cwd=project_cwd,
                    correlation=correlation,
                    on_task_complete=on_task_complete,
                    on_task_start=on_task_start,
                    )
        result = self._execute_plan(plan, project_id,
                                    prior_verified=prior_verified, **legs)
        attempts: dict[str, int] = {}
        for round_no in range(1, MAX_RECOVERY_ROUNDS + 1):
            retry = self._recoverable(plan, result, attempts, cancel_token)
            if not retry:
                break
            leg_plan, notes = self._recovery_plan(plan, result, retry)
            for tid in retry:
                attempts[tid] = attempts.get(tid, 1) + 1
            leg = self._execute_plan(leg_plan, project_id,
                                     prior_verified=dict(result.verified_outputs),
                                     **legs)
            self._merge_leg(result, leg, round_no, notes)
        result.plan = plan
        result.write_conflicts = self._detect_write_conflicts(
            plan, result.verified_outputs)
        return result

    # ── coordinator: completion check and recovery ─────────────────────
    @staticmethod
    def _unmet_dependency(task: Any, result: ExecutionOutcome) -> str | None:
        """Why a task cannot run because something it depends on did not
        succeed — only meaningful once the run keeps going past a blocker."""
        bad = {"blocked", "failed", "denied", "cancelled", "timed-out"}
        latest = {o.taskId: o for o in result.outcomes}
        for dep in list(getattr(task, "dependsOn", []) or []):
            o = latest.get(dep)
            if o is None:
                continue
            if o.state in bad:
                return f"depends on {dep}, which did not complete ({o.state})"
            if o.state == "done" and o.verified is False:
                # The upstream RAN but its check did not confirm it: the
                # work happened, the proof did not. The Workspace already
                # reports that as failed (task_state maps done+unverified
                # to "failed"), so releasing a dependent on it would let
                # later work build on results nobody confirmed.
                #
                # verified=None is NOT this case: it means the capability
                # declares no mechanical check (a read-only listing), and
                # such a task genuinely succeeded.
                #
                # A task that consumes upstream OUTPUT has a stricter
                # gate of its own (_gate_handoff: the upstream must be in
                # verified_outputs) which also stops the run. That gate
                # speaks for those tasks; this one covers plain ordering
                # dependencies.
                if getattr(task, "inputFrom", "literal") != "upstream-output":
                    return (f"depends on {dep}, which did not complete "
                            f"(not verified)")
        return None

    @staticmethod
    def _unverified_failure(o: TaskOutcome) -> bool:
        return (o.state in ("failed", "timed-out")
                or (o.state == "done" and o.verified is not True))

    def _recoverable(self, plan: TaskPlan, result: ExecutionOutcome,
                     attempts: dict[str, int],
                     cancel_token: Any | None) -> dict[str, TaskOutcome]:
        """Tasks the completion check may schedule again, or {} when the
        run must end as it is."""
        if (result.cancelled or result.denied
                or (cancel_token is not None and getattr(cancel_token, "cancelled", False))):
            return {}
        if result.deviation_evidence:
            return {}  # the supervisor's correction loop owns deviations
        by_id = {t.id: t for t in plan.tasks}
        latest: dict[str, TaskOutcome] = {}
        for o in result.outcomes:
            latest[o.taskId] = o
        retry: dict[str, TaskOutcome] = {}
        for tid, o in latest.items():
            if tid in result.verified_outputs or o.state in ("skipped", "blocked", "pending"):
                continue
            if o.state in ("denied", "cancelled"):
                return {}
            if not self._unverified_failure(o):
                continue
            task = by_id.get(tid)
            if task is None or task.capabilityId != "agent.delegate":
                # No automatic re-run of a side-effectful non-worker step.
                return {}
            if attempts.get(tid, 1) >= MAX_TASK_ATTEMPTS:
                return {}
            retry[tid] = o
        return retry

    def _recovery_plan(self, plan: TaskPlan, result: ExecutionOutcome,
                       retry: dict[str, TaskOutcome]) -> tuple[TaskPlan, dict]:
        """A copy of the plan for the recovery leg: each retried task
        reassigned to another eligible worker unless the person named one,
        and told what the previous attempt hit. Returns (plan, notes)."""
        from .quota import classify_failure, is_quota_exhaustion
        leg_plan = plan.model_copy(deep=True)
        notes: dict[str, dict] = {}
        for task in leg_plan.tasks:
            if task.id not in retry:
                continue
            failed = retry[task.id]
            before = str((result.worker_assignments.get(task.id) or {}).get("nodeId") or "")
            quota = is_quota_exhaustion(failed.detail,
                                       timed_out=(failed.state == "timed-out"))
            # A retry always avoids the worker that just failed (that is
            # what makes it a recovery rather than a repeat); quota
            # exhaustion is the case that forces a different worker even
            # when the task was pinned to the failing one.
            exclude = {before} if before else set()
            after = before
            # On quota, the pin is overridden so the work can move to a
            # genuinely available worker.
            # An agent Laya selected (the person did not name it) is not a
            # commitment: after any failed attempt the retry goes to another
            # allowed agent when there is one.
            selected = getattr(task, "workerChoice", None) == "selected"
            pinned = None if (quota or selected) else getattr(task, "nodeId", None)
            if quota or selected or not getattr(task, "nodeId", None):
                alt = self._match_role(task, getattr(task, "workerRole", None) or "code",
                                       pinned, exclude)
                if alt:
                    task.nodeId = alt
                    after = alt
            brief = dict(task.input or {})
            reason = ("quota exhausted" if quota
                      else classify_failure(failed.detail,
                                           timed_out=(failed.state == "timed-out"),
                                           exit_code=1 if failed.state in ("failed", "timed-out") else None))
            prior = (f"A previous attempt{' by ' + before if before else ''} "
                     f"did not complete ({failed.state}, {reason}): "
                     f"{failed.detail[:300]}. "
                     "Continue from the project as it is now; keep work other "
                     "tasks have verified.")
            brief["task"] = f"{brief.get('task') or task.description}\n\n{prior}"
            task.input = brief
            notes[task.id] = {"fromNode": before, "toNode": after,
                              "previousState": failed.state, "reason": reason,
                              "handoff": quota and before != after}
        return leg_plan, notes

    @staticmethod
    def _merge_leg(result: ExecutionOutcome, leg: ExecutionOutcome,
                   round_no: int, notes: dict) -> None:
        """Fold a recovery leg into the run. The leg's rows replace the
        open rows they settled; verified evidence, assignments and actions
        accumulate; the run's stop state is the leg's, since the leg is the
        latest word on every task it touched."""
        rerun = {o.taskId: o for o in leg.outcomes if o.state != "skipped"}
        result.outcomes = [rerun.pop(o.taskId) if o.taskId in rerun else o
                           for o in result.outcomes] + list(rerun.values())
        result.verified_outputs.update(leg.verified_outputs)
        result.worker_assignments.update(
            {k: v for k, v in leg.worker_assignments.items()
             if (v or {}).get("state") != "skipped"})
        result.governed_actions.extend(leg.governed_actions)
        result.file_changes.update(leg.file_changes)
        result.deviation_evidence.update(leg.deviation_evidence)
        result.artifact_paths.extend(p for p in leg.artifact_paths
                                     if p not in result.artifact_paths)
        result.scope_conflicts.extend(leg.scope_conflicts)
        result.cancelled_before = list(leg.cancelled_before)
        for flag in ("stopped", "stop_reason", "cancelled",
                     "timed_out", "denied"):
            setattr(result, flag, getattr(leg, flag))
        if leg.run_id:
            result.run_id = leg.run_id
        settled = {o.taskId: o for o in leg.outcomes}
        for tid, note in notes.items():
            o = settled.get(tid)
            result.recovery.append({
                "round": round_no, "taskId": tid, **note,
                "state": o.state if o else "not-dispatched",
                "verified": bool(o and o.verified is True),
            })

    def _execute_plan(
        self,
        plan: TaskPlan,
        project_id: str | None,
        compiled_workflow: dict | None = None,
        cancel_check: Any | None = None,
        cancel_token: Any | None = None,
        project_cwd: str | None = None,
        prior_verified: dict[str, dict] | None = None,
        correlation: dict[str, str] | None = None,
        on_task_complete: Any | None = None,
        on_task_start: Any | None = None,
    ) -> ExecutionOutcome:
        """Run one plan leg. `prior_verified` seeds handoff evidence from an
        earlier leg of the same workflow (verified task_id → evidence
        record, as filed by _note_task_closed): a resumed leg must not
        re-prove what a previous leg already verified, and an unverified
        upstream must never silently become verified by re-running.
        `correlation` carries {"session_id", "request_id"} into every
        invocation context, worker assignment, and the outcome itself —
        observability only, never authority."""
        result = ExecutionOutcome()
        result.plan = plan
        correlation = {k: v for k, v in (correlation or {}).items() if v}
        if correlation.get("request_id"):
            result.request_id = correlation["request_id"]
        if prior_verified:
            result.verified_outputs.update(prior_verified)
        # A run cancelled before a task starts never dispatches it. The
        # token is authoritative; cancel_check stays for callers that
        # pass only a predicate.
        def _stop_requested() -> bool:
            if cancel_token is not None and cancel_token.cancelled:
                return True
            return bool(cancel_check and cancel_check())

        # Worker runs can span minutes; an invocation timeout is per-run,
        # not mission-wide, so several independent workers may all be in
        # flight together for the same project and mission. Run such a
        # plan fully concurrently; dependency-gated/workflow/upstream
        # plans fall through to the sequential scheduler below, which
        # preserves task ordering and dependency semantics exactly.
        if self._all_parallel_runnable(plan, result):
            self._dispatch_parallel(plan, project_id, compiled_workflow,
                                    result, project_cwd=project_cwd,
                                    cancel_token=cancel_token,
                                    correlation=correlation,
                                    on_task_complete=on_task_complete,
                                    )
            return result

        # Tasks already launched as a concurrent wave (see _ready_wave).
        dispatched: set[str] = set()
        for task in topo_order(plan.tasks):
            if task.id in dispatched:
                continue
            if _stop_requested():
                result.cancelled = True
                result.stopped = True
                result.stop_reason = (
                    f"cancelled before {task.id} started; no worker was "
                    "dispatched for it")
                result.cancelled_before.append(task.id)
                break

            # Independent work runs concurrently even when the plan also has
            # dependency-gated tasks: every ready, eligible task goes out as
            # one wave, then the sequential loop resumes for the rest. A wave
            # of one is just the normal sequential path below.
            wave = self._ready_wave(plan, result, dispatched)
            if len(wave) >= 2 and any(t.id == task.id for t in wave):
                self._dispatch_parallel(
                    plan, project_id, compiled_workflow, result,
                    project_cwd=project_cwd, cancel_token=cancel_token,
                    correlation=correlation, tasks=wave,
                    on_task_complete=on_task_complete,
                    )
                dispatched.update(t.id for t in wave)
                # Same stop rules the sequential loop applies per task: a
                # wave member that failed, was denied, timed out, was
                # cancelled halts the run before
                # any dependent task starts. In-flight siblings finish.
                wave_ids = {t.id for t in wave}
                for o in result.outcomes:
                    if o.taskId in wave_ids:
                        self._stop_for_outcome(result, o)
                if result.stopped:
                    return result
                continue

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
                    detail=("Already verified in a prior leg; not "
                            "re-executed."),
                ))
                continue

            # A task whose required tool could not be provided never runs, and
            # neither does anything that depends on it — but independent work
            # carries on. The blocker is reported with its exact reason.
            blocker = getattr(task, "toolBlocked", None) or self._unmet_dependency(task, result)
            if blocker:
                blocked = TaskOutcome(taskId=task.id, state="blocked", performed=False,
                                      detail=str(blocker))
                result.outcomes.append(blocked)
                self._notify("task.state", correlation, taskId=task.id, state="blocked",
                             detail=str(blocker)[:300])
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
                self._run_workflow(task, plan, project_id, result,
                                   project_cwd=project_cwd,
                                   )
            else:
                if on_task_start is not None:
                    _progress(on_task_start, "on_task_start", task.id)
                self._run_task(task, project_id, compiled_workflow, result,
                                    project_cwd=project_cwd,
                                    cancel_token=cancel_token,
                                    correlation=correlation,
                                    )

            last = result.outcomes[-1] if result.outcomes else None
            if on_task_complete is not None and last is not None:
                _progress(on_task_complete, "on_task_complete", task.id, last)
            if last is None:
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

    @staticmethod
    def _outcome_detail(invocation: dict, fabric_verified: bool | None) -> str:
        """The detail a task outcome carries to the mission summary.

        A failed check's own detail is the reason a person can act on
        ("Required evidence not found: …"). The invocation's combined text
        ("<capability> ran, but the check did not confirm it. …") is for the
        audit record, so it is not what the person reads.
        """
        verdict = invocation.get("verification") or {}
        check_detail = str(verdict.get("detail") or "").strip()
        if fabric_verified is False and check_detail:
            return check_detail
        return invocation.get("detail") or ""

    def _run_task(self, task: Any, project_id: str | None, compiled_workflow: dict | None,
                  result: ExecutionOutcome, *,
                  project_cwd: str | None = None, cancel_token: Any | None = None,
                  correlation: dict[str, str] | None = None) -> None:
        """Dispatch one task and report its real lifecycle: it started, what
        it changed on disk (measured, not claimed), and how it settled."""
        from . import change_observer

        before_len = len(result.outcomes)
        watch = bool(project_cwd) and mutates_project(task)
        before = change_observer.snapshot(project_cwd) if watch else None
        self._notify("task.state", correlation, taskId=task.id, state="running",
                     capability=task.capabilityId)
        try:
            self._invoke_single(task, project_id, compiled_workflow, result,
                                project_cwd=project_cwd,
                                cancel_token=cancel_token, correlation=correlation)
        finally:
            worker = str((result.worker_assignments.get(task.id) or {}).get("nodeId") or "")
            if watch:
                changes, complete = change_observer.diff(before, change_observer.snapshot(project_cwd))
                if changes or not complete:
                    result.file_changes[task.id] = {"changes": changes, "complete": complete,
                                                    "worker": worker}
                self._notify("files.changed", correlation, taskId=task.id, worker=worker,
                             changes=changes[:200], total=len(changes), complete=complete)
            for o in result.outcomes[before_len:]:
                self._notify("task.state", correlation, taskId=o.taskId, state=task_state(o),
                             worker=worker, verified=o.verified, detail=(o.detail or "")[:300])

    def _notify(self, event_type: str, correlation: dict | None, **payload: Any) -> None:
        sid = (correlation or {}).get("session_id")
        if self.emit is not None and sid:
            try:
                self.emit(event_type, sid, **payload)
            except Exception:  # noqa: BLE001 — telemetry must never break execution
                pass

    def _all_parallel_runnable(self, plan: TaskPlan,
                               seeded: Any) -> bool:
        """True when every task in the plan can run concurrently: no
        dependency edges between tasks, no upstream-output handoff, no
        conditional (runWhen) gate, not a workflow-run route, a bound
        capability, and not already a resumed/verified task. A plan like
        'Claude inspect backend || Kilo inspect frontend' meets this; the
        sequential scheduler keeps dependency chains correct for the rest.
        """
        if len(plan.tasks) < 2:
            return False
        if any(getattr(t, "toolBlocked", None) for t in plan.tasks):
            return False
        # One project-mutating task at a time: two workers (or a worker and
        # a file write) never run side by side, whatever their scopes say.
        if sum(1 for t in plan.tasks if mutates_project(t)) > 1:
            return False
        scopes = [s for t in plan.tasks for s in [self._write_scope(t)] if s]
        if any(self._paths_overlap(p, q)
               for i, a in enumerate(scopes) for b in scopes[i + 1:]
               for p in a for q in b):
            # Overlapping write scopes: the wave scheduler serializes them.
            return False
        seeded_ids = set(getattr(seeded, "verified_outputs", {}) or {})
        for task in plan.tasks:
            if (not self._task_parallel_eligible(task, seeded_ids)
                    or list(getattr(task, "dependsOn", []) or [])):
                return False
        return True

    @staticmethod
    def _task_parallel_eligible(task: Any, seeded_ids: set[str]) -> bool:
        """Per-task rule for concurrent dispatch: no upstream-output
        handoff, no conditional gate, not a workflow-run route, a bound
        capability, and not already settled by a prior leg. Dependency
        edges are a separate, ordering concern handled by the wave
        scheduler in execute()."""
        return not (
            task.id in seeded_ids
            or task.route == "workflow-run"
            or task.inputFrom == "upstream-output"
            or getattr(task, "runWhen", "always") != "always"
            or getattr(task, "toolBlocked", None)
            or not task.capabilityId
        )

    def _ready_wave(self, plan: TaskPlan, result: ExecutionOutcome,
                    dispatched: set[str]) -> list[Any]:
        """Every task that may start now concurrently: parallel-eligible,
        not yet started, and with all dependsOn already settled in this
        run. Settled is read from the recorded outcomes, never inferred
        from intent.

        Settled means the upstream actually succeeded: done with its
        check confirming it (or declaring no check, verified=None), or
        skipped (verified in an earlier leg). A task that ran and whose
        check did NOT confirm it has not succeeded, so it does not
        release the tasks that depend on it.
        """
        seeded_ids = set(result.verified_outputs or {})
        started = {o.taskId for o in result.outcomes} | dispatched
        settled = {o.taskId for o in result.outcomes
                   if o.state == "skipped"
                   or (o.state == "done" and o.verified is not False)}
        ready = [
            t for t in plan.tasks
            if t.id not in started
            and self._task_parallel_eligible(t, seeded_ids)
            and set(t.dependsOn or []) <= settled
        ]
        # File ownership: two write tasks whose scopes overlap never run in
        # the same wave. The later one waits and runs once the first has
        # settled, working on its result instead of racing it.
        wave: list[Any] = []
        claimed: list[str] = []
        mutating_taken = False
        for t in ready:
            if mutates_project(t):
                if mutating_taken:
                    continue  # one project-mutating task per wave, ever
                mutating_taken = True
            scope = self._write_scope(t)
            if scope and any(self._paths_overlap(p, c) for p in scope for c in claimed):
                continue
            wave.append(t)
            claimed.extend(scope)
        return wave

    @staticmethod
    def _write_scope(task: Any) -> list[str]:
        inp = task.input if isinstance(getattr(task, "input", None), dict) else {}
        if inp.get("expectChange") is True:
            return [str(p).strip().rstrip("/") for p in (inp.get("scopePaths") or [])
                    if str(p).strip()]
        return []

    @staticmethod
    def _paths_overlap(a: str, b: str) -> bool:
        """Whole-segment containment either way: `src` overlaps `src/a.py`,
        `src` does not overlap `srcx`."""
        a, b = a.strip("/"), b.strip("/")
        return a == b or a.startswith(b + "/") or b.startswith(a + "/") or "" in (a, b)

    @staticmethod
    def _stop_for_outcome(result: ExecutionOutcome, o: TaskOutcome) -> None:
        """Apply the sequential loop's stop rules to one settled outcome.
        Flags are always applied, so a timeout or denial is never lost
        because a sibling already stopped the run. The first stop reason
        recorded for the run is kept."""
        if o.state == "denied":
            result.denied = True
            reason = o.detail
        elif o.state == "timed-out":
            result.timed_out = True
            reason = o.detail
        elif o.state == "cancelled":
            result.cancelled = True
            reason = f"{o.taskId}: {o.detail}"
        elif o.state in ("failed", "blocked"):
            reason = f"{o.taskId}: {o.detail}"
        else:
            return
        if not result.stopped or not result.stop_reason:
            result.stop_reason = reason
        result.stopped = True

    def _dispatch_parallel(self, plan: TaskPlan, project_id: str | None,
                           compiled_workflow: dict | None,
                           result: ExecutionOutcome,
                           *, project_cwd: str | None,
                           cancel_token: Any | None,
                           correlation: dict[str, str] | None,
                           tasks: list[Any] | None = None,
                           on_task_complete: Any | None = None,
                           on_task_start: Any | None = None,
                           ) -> None:
        """Run the given tasks (default: all of the plan's tasks)
        concurrently through the SAME _invoke_single path, each into its
        own ExecutionOutcome, then merge deterministically in task-plan
        order. Each task keeps its own invocation context, node
        assignment, exit code, stdout and audit record — there is no
        shared mutable run state.
        """
        correlation = dict(correlation or {})
        batch = list(tasks) if tasks is not None else list(plan.tasks)

        # Pre-dispatch: flag concurrent write tasks with overlapping scopes.
        # Accumulated across waves so an earlier wave's conflicts persist.
        result.scope_conflicts.extend(self._detect_scope_conflicts(batch))

        def _invoke(task) -> ExecutionOutcome:
            per = ExecutionOutcome()
            per.plan = result.plan or plan
            # Concurrent workers see the run as it stood when the wave
            # started (board only — these rows are never merged back).
            per.board_outcomes = list(result.outcomes)
            per.verified_outputs.update(result.verified_outputs)
            per.deviation_evidence.update(result.deviation_evidence)
            if on_task_start is not None:
                _progress(on_task_start, "on_task_start", task.id)
            self._run_task(task, project_id, compiled_workflow, per,
                                project_cwd=project_cwd,
                                cancel_token=cancel_token,
                                correlation=correlation,
                                )
            if on_task_complete is not None:
                last = per.outcomes[-1] if per.outcomes else None
                if last is not None:
                    _progress(on_task_complete, "on_task_complete", task.id, last)
            return per

        with ThreadPoolExecutor(max_workers=max(2, len(batch))) as pool:
            futures = {pool.submit(_invoke, task): task for task in batch}
            per_task: dict[str, ExecutionOutcome] = {}
            for fut in as_completed(futures):
                per = fut.result()
                per_task[futures[fut].id] = per

        merged_stop = None
        for task in plan.tasks:
            per = per_task.get(task.id)
            if per is None:
                continue
            result.outcomes.extend(per.outcomes)
            result.verified_outputs.update(per.verified_outputs)
            result.worker_assignments.update(per.worker_assignments)
            result.governed_actions.extend(per.governed_actions)
            result.file_changes.update(per.file_changes)
            result.deviation_evidence.update(per.deviation_evidence)
            result.cancelled_before.extend(per.cancelled_before)
            if per.run_id and result.run_id is None:
                result.run_id = per.run_id
            if per.stopped and merged_stop is None:
                merged_stop = (per.stop_reason, per.cancelled, per.timed_out,
                               per.denied)
        if merged_stop is not None:
            reason, cancelled, timed_out, denied = merged_stop
            result.stopped = True
            result.stop_reason = reason
            result.cancelled = result.cancelled or cancelled
            result.timed_out = result.timed_out or timed_out
            result.denied = result.denied or denied
        # The run's stop state follows each merged outcome's own state, as
        # the sequential loop does. Per-task flags alone can miss a denial
        # or timeout, so a denied worker could be lost at run level.
        for task in batch:
            per = per_task.get(task.id)
            if per is None:
                continue
            for o in per.outcomes:
                self._stop_for_outcome(result, o)
        result.request_id = correlation.get("request_id") or result.request_id

        # Post-dispatch: detect actual file conflicts from verified changed_paths.


    # ── Concurrent-worker conflict detection ─────────────────────────
    @staticmethod
    def _detect_scope_conflicts(tasks: list[Any]) -> list[dict]:
        """Pre-dispatch: return conflicts where two concurrent write tasks
        declare overlapping scopePaths.  Non-blocking — the run proceeds —
        but the conflicts are recorded in ExecutionOutcome and surface
        through the evidence bundle so the UI can warn before a worker
        overwrites another worker's files."""
        write_tasks = [
            (t.id, set(t.input.get("scopePaths") or []))
            for t in tasks
            if (t.input or {}).get("expectChange") is True
            and (t.input or {}).get("scopePaths")
        ]
        conflicts: list[dict] = []
        for i, (id1, paths1) in enumerate(write_tasks):
            for id2, paths2 in write_tasks[i + 1:]:
                overlap = sorted(paths1 & paths2)
                if overlap:
                    conflicts.append({
                        "tasks": [id1, id2],
                        "overlappingPaths": overlap,
                        "risk": "concurrent-write-conflict",
                    })
        return conflicts

    @staticmethod
    def _detect_write_conflicts(
        plan: TaskPlan, verified_outputs: dict[str, dict]
    ) -> list[dict]:
        """Post-dispatch: find paths two or more tasks actually modified.
        Ownership is read from each task's OWN verified evidence record
        (verified_outputs[task.id]), never from a copy of other tasks'
        records, so a path is attributed only to the task that wrote it,
        across every execution wave of the run. Returns one record per
        conflicting path so the service layer can emit worker.lifecycle
        events and the UI can highlight them."""
        path_owners: dict[str, list[str]] = {}
        for task in plan.tasks:
            evidence = verified_outputs.get(task.id) or {}
            for path in (evidence.get("changed_paths") or []):
                owners = path_owners.setdefault(str(path), [])
                if task.id not in owners:
                    owners.append(task.id)
        return [
            {"path": path, "tasks": task_ids,
             "risk": "post-execution-write-conflict"}
            for path, task_ids in path_owners.items()
            if len(task_ids) > 1
        ]

    # ── Phase G worker requirement matching ────────────────────────────
    def _present_nodes(self) -> list[dict]:
        try:
            host = getattr(getattr(self._cfg, "fabric", None), "host", None)
            present = getattr(host, "present_nodes", None)
            nodes = present() if callable(present) else []
            self._nodes_error = None
            # Billing policy: only authorized/verified-free workers may run.
            # Filter denied workers here so selection never picks one that
            # dispatch would refuse (honest failure, but useless).
            from ..workers.billing import decide
            out = []
            for n in nodes:
                if not isinstance(n, dict):
                    continue
                if not decide(str(n.get("id") or "")).allowed:
                    continue
                out.append(n)
            return out
        except Exception as exc:
            self._nodes_error = str(exc)[:200]
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

    def _unmet_role_tools(self, role: str) -> list[str]:
        """Machine tools a role wants but the machine lacks, for refusal
        messages. Empty without a registry or without needs — reporting
        only, never authority."""
        registry = getattr(self, "_registry", None)
        if registry is None or not role:
            return []
        try:
            return list(registry.unmet_tool_needs(role) or [])
        except Exception:
            return []

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
            # Billing policy: a pinned worker that is denied cannot run.
            from ..workers.billing import decide
            if not decide(pinned_id).allowed:
                return None
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
            # leg, so by the time the reviewer is dispatched the implementer is restored
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
        }

    # ── single-invocation route ──────────────────────────────────────────
    def _invoke_single(
        self,
        task: Any,
        project_id: str | None,
        compiled_workflow: dict | None,
        result: ExecutionOutcome,
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
                    invocation_ids=list(ev.get("invocation_ids") or [])))
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

        _fill_session_inputs(task.capabilityId, payload, project_id)

        context = {
            "actor": {"kind": "agent", "id": "central-agent"},
            "projectId": project_id,
            "taskId": task.id,
        }
        if getattr(task, "missionId", None):
            context["missionId"] = task.missionId
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
            # Billing policy: a pinned node that is denied cannot run,
            # even when no role matching is requested.
            from ..workers.billing import decide
            if not decide(str(node_id)).allowed:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="failed", performed=False,
                    detail=f"Policy denied this request: {decide(str(node_id)).reason}"))
                return
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
                if self._nodes_error:
                    why = (f"the worker registry could not be read "
                           f"({self._nodes_error}); refusing rather than "
                           "reporting no workers on broken evidence.")
                else:
                    why = (f"no connected worker satisfies role '{role}' for "
                           "this task; refusing rather than dispatching an "
                           "unsuitable worker.")
                    needs = self._unmet_role_tools(role)
                    if needs:
                        why += (f" The machine also lacks tools role '{role}' "
                                f"wants available: {', '.join(needs)}.")
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
        if cancel_token is not None:
            # The worker's own stop signal. It reaches run_file, which
            # signals the worker's process GROUP — so STOP terminates
            # what the worker forked as well as the worker itself.
            context["cancelToken"] = cancel_token
            cancel_token.note_dispatch(
                task.id, worker_node_id=context.get("nodeId") or "")
        # Phase 2: TaskClassifier + ModelRouter for agent.delegate tasks.
        # Both are local heuristics — no model calls, no network. Never
        # block dispatch; failures are silent and the worker runs without
        # a model preference. Sovereign guarantee: ModelRouter only ever
        # selects local/private models — cloud never enters this path.
        _task_type: str | None = None
        _routing_record = None
        _routing_reason: str | None = None
        if task.capabilityId == "agent.delegate":
            # The shared run board: every worker on this goal works from the
            # same picture — goal, acceptance, tasks, file ownership, what
            # verified tasks found, what failed. Appended to the AURA
            # context the brief already carries; data, never authority.
            from .run_board import render_board

            board = render_board(getattr(result, "plan", None), result, task.id)
            if self.error_lookup is not None and project_cwd:
                try:
                    known = self.error_lookup(project_cwd, str(task.description or "")
                                              + " " + str((task.input or {}).get("task") or ""))
                except Exception:  # noqa: BLE001 — lessons are help, never a gate
                    known = ""
                if known:
                    board = f"{board}\n\n{known}" if board else known
            if board:
                existing = payload.get("context")
                payload["context"] = (f"{existing}\n\n{board}"
                                      if isinstance(existing, str) and existing
                                      else board)
            _task_desc = (getattr(task, "description", None) or
                          (task.input or {}).get("task") or "")
            try:
                from ..sovereign.model_router import (TaskClassifier as _TC,
                                                       ModelRouter as _MR)
                if _task_desc:
                    _task_type = _TC().classify(_task_desc)
                if self._model_registry is not None:
                    _decision = _MR(self._model_registry).route(
                        _task_desc or "", task_type=_task_type)
                    _routing_record = _decision.record
                    _routing_reason = _decision.reason
                    # The worker has its own configured model. AURA's model router
                    # selects a model for AURA's own planning, not for the
                    # worker's --model flag, which expects "provider/model"
                    # syntax that sovereign model names do not use. Passing
                    # an unparseable name makes the worker fail before it
                    # starts. Leave the worker's model choice to its own
                    # configuration.
                    pass
            except Exception:
                pass

        result.worker_assignments[task.id] = {
            "taskId": task.id,
            "nodeId": context.get("nodeId") or "",
            "role": role or "",
            "capabilityId": task.capabilityId,
            **({"missionId": task.missionId} if getattr(task, "missionId", None) else {}),
            "lifecycle": "ACTIVE",
            "startedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            **({"taskType": _task_type} if _task_type else {}),
            **({"modelId": _routing_record.id,
                "modelName": _routing_record.model_name,
                "networkClass": _routing_record.network_class,
                "routingReason": _routing_reason}
               if _routing_record is not None else {}),
            **({"sessionId": correlation["session_id"]}
               if correlation.get("session_id") else {}),
            **({"requestId": correlation["request_id"]}
               if correlation.get("request_id") else {}),
        }
        # Phase 11 unification: effects with node bindings go through the
        # SAME interpreter as workflows (one runner); everything else keeps
        # the direct governed invoke (policy/audit identical).
        engine = getattr(self, "engine", None)
        if engine is not None and task.capabilityId in engine.NODE_TO_CAPABILITY.values():
            run, _nt = engine.run_ad_hoc(
                task.capabilityId, payload, project_cwd, project_id,
                task_label=task.description[:60],
                )
            invocations = [e["invocationId"] for e in (run.get("evidence") or [])]
            state_map = {"succeeded": "done",
                         "denied": "denied", "timed-out": "timed-out"}
            outcome_state = state_map.get(run["state"], "failed")
            result.outcomes.append(TaskOutcome(
                taskId=task.id, state=outcome_state,  # type: ignore[arg-type]
                performed=run["state"] in ("succeeded",),
                verified=all(n.get("state") == "succeeded"
                             for n in run["nodes"].values())
                if run["state"] == "succeeded" else None,
                invocationIds=invocations,
                detail=f"Run {run['id']} ended {run['state']}: "
                       f"{next(iter(run['nodes'].values()), {}).get('summary', '')}",
            ))
            if result.run_id is None:
                result.run_id = run["id"]
            # The node's output is the executor's real result (for git.status,
            # git's own text). Passing None here dropped it, so the verified
            # record and the answer had nothing to report.
            node_out = next(iter(run["nodes"].values()), {}).get("output")
            text = node_out.get("text") if isinstance(node_out, dict) else None
            self._note_task_closed(
                task, result,
                {"stdout": text} if isinstance(text, str) else None,
                handoff_consumed)
            return
        lease = None
        lease_key = project_cwd or project_id
        if task.capabilityId == "agent.delegate" and lease_key:
            from .worker_lease import LEASES, LeaseCancelled

            def _waiting(holder: Any) -> None:
                self._notify("worker.queued", correlation, taskId=task.id,
                             waitingFor={"taskId": holder.task_id, "sessionId": holder.session_id,
                                         "worker": holder.worker},
                             reason="another worker is editing this project; one at a time")

            try:
                lease = LEASES.acquire(
                    str(lease_key), session_id=str(correlation.get("session_id") or ""),
                    task_id=task.id, worker=str(context.get("nodeId") or ""),
                    cancelled=lambda: bool(cancel_token is not None and cancel_token.cancelled),
                    on_wait=_waiting)
            except LeaseCancelled as exc:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="cancelled", performed=False,
                    detail=f"{exc}; no worker was started for this task"))
                return
            except TimeoutError as exc:
                result.outcomes.append(TaskOutcome(
                    taskId=task.id, state="timeout", performed=False, detail=str(exc)))
                return
        try:
            invocation = invoke_fabric(
                task.capabilityId, payload, context, self._cfg,
            )
        finally:
            if lease is not None:
                LEASES.release(lease)
        outcome = invocation["outcome"]
        performed = outcome in ("succeeded", "unverified")
        # The executor reports a stopped worker as a failed invocation,
        # because from its side that is what a terminated process looks
        # like. Only the run knows the difference, and it records the
        # difference: a cancelled task is never corrected or retried.
        _output = invocation.get("output")
        state = state_for_invocation(outcome, _output)
        if state in ("cancelled", "timed-out"):
            performed = False
        # Audit-only tasks (knowledge.search, memory.search, ...) have no
        # fabric-level read-back check — the invocation record IS the
        # verification. When the fabric verifier reports None (no check
        # configured) and the plan declares audit-only, treat the task as
        # verified so its output reaches verified_outputs and downstream
        # answer synthesis (Phase 15 fix: without this the model never
        # sees retrieved knowledge chunks).
        fabric_verified = invocation["verification"]["passed"]
        task_verify_kind = getattr(
            getattr(task, "verification", None), "kind", None)
        if fabric_verified is None and state == "done" and \
                performed and task_verify_kind == "audit-only":
            fabric_verified = True
        # A failed check's own detail is the reason a person can act on
        # ("Required evidence not found: …"). The invocation's combined text
        # ("<capability> ran, but the check did not confirm it. …") stays in
        # the audit record for diagnostics.
        result.outcomes.append(TaskOutcome(
            taskId=task.id,
            state=state,  # type: ignore[arg-type]
            performed=performed,
            verified=fabric_verified,
            invocationIds=[invocation["invocationId"]],
            detail=self._outcome_detail(invocation, fabric_verified),
        ))
        self._note_task_closed(
            task, result, invocation.get("output"), handoff_consumed)

    def _note_task_closed(self, task: Any, result: ExecutionOutcome,
                            output: Any,
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
        # Executor output is Any by contract (file text, stdout,
        # structured results). The metadata reads below assume a mapping;
        # text carries none, so normalize once here instead of at every
        # .get — a second instance of the crash fixed above.
        output = _recorded_output(getattr(task, "capabilityId", None), output)
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
            assignment["completedAt"] = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
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
            }
        # Evidence is filed only for done tasks the run actually verified.
        # Audit-only tasks whose invocation record IS the verification are
        # promoted before their outcome row is appended (_invoke_single:
        # fabric_verified None + audit-only + performed → True), so they
        # arrive here with verified=True; a deliberately unverified task
        # (passed=False, e.g. non-zero exit) must NOT file evidence — its
        # dependents gate on verified_outputs, and handoff only ever
        # carries results the run could prove. VerificationEngine applies
        # its performed/audit-only relaxation to the user-facing report,
        # never to what downstream tasks consume as input.
        if outcome.state != "done" or outcome.verified is not True:
            return
        # Collect artifact paths for the evidence bundle.
        if getattr(task, "capabilityId", None) == "artifact.generate":
            art_path = output.get("path") or ""
            if art_path:
                result.artifact_paths.append(str(art_path))
        scope = (output or {}).get("scopeCheck") or {}
        result.verified_outputs[task.id] = {
            "task_id": task.id,
            "node_id": str(output.get("nodeId") or ""),
            "agent": str(output.get("agent") or ""),
            "stdout": str(output.get("stdout") or ""),
            "scope_paths": list(output.get("scopePaths") or []),
            "changed_paths": list(scope.get("changed") or []),
            "invocation_ids": list(outcome.invocationIds),
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

    def _record_run_outcome(self, task: Any, run: dict,
                            result: ExecutionOutcome,
                            detail_prefix: str = "Run") -> None:
        node_states = [n["state"] for n in run["nodes"].values()]
        # Every governed node action links back to its audit record.
        invocations = [e["invocationId"] for e in (run.get("evidence") or [])]
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
        "succeeded": "done",
        "denied": "denied", "timed-out": "timed-out",
        "cancelled": "cancelled",
    }.get(run["state"], "failed")
