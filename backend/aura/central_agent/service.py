"""CentralAgent — the orchestration facade.

Wires intent → plan → discovery → authority → compilation → governed
execution → verification → evidence, emitting an AgentEvent at every
boundary. The agent REASONS here; every decision about authority belongs
to aura.policy, and every effect to aura.fabric.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..audit import AuditStore
from ..contracts import (
    AgentEvent,
    AgentIntent,
    AgentMessage,
    AgentResult,
    AgentSession,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
)
from ..fabric import FabricConfig
from ..fabric.manifest import all_capabilities
from ..persistence.runs import WorkflowRunStore
from ..persistence.workflows import WorkflowStore
from .authority import AuthorityChecker
from .context import ContextAssembler
from .discovery import CapabilityDiscovery
from .events import EventBus
from .evidence import EvidenceCollector
from .execution import ExecutionController, ExecutionOutcome
from .intent import IntentCompiler
from .planner import PlanningError, TaskPlanner, topo_order
from .runcontrol import RUN_CONTROL
from .session import AgentSessionStore
from .supervisor import (
    MAX_CORRECTION_ATTEMPTS,
    CorrectionRecord,
    build_correction,
    decide_task,
)
from .verification import VerificationEngine
from .workflow_compiler import CompilationError, WorkflowCompiler


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _connected_node_ids(fabric_cfg) -> set[str]:
    """Connected-node ids for worker-pin validation. Best-effort READ of
    the one node catalogue execution resolves against; any failure yields
    the empty set, which only makes nodeId validation stricter."""
    try:
        host = getattr(getattr(fabric_cfg, "fabric", None), "host", None)
        present = getattr(host, "present_nodes", None)
        nodes = present() if callable(present) else []
        return {str(n.get("id")) for n in nodes
                if isinstance(n, dict) and n.get("id")}
    except Exception:
        return set()


_PLAN_PROPOSAL_SYSTEM = """You are AURA's task planner. Propose ONLY a JSON object shaped {"tasks": [...]} — a proposal, never authority. AURA validates everything and owns task identity, ordering, workers, and approval.
One task: {"id": "short-label (optional)", "description": "what must be done", "capabilityId": "one of ALLOWED CAPABILITIES", "nodeId": "one of CONNECTED NODES, or omit for AURA routing", "dependsOn": ["labels of prerequisite tasks"], "inputFrom": "literal" (default) or "upstream-output", "input": {"task": "plain-language brief (agent tasks)"}, "scopePaths": ["repo-relative dirs, same or narrower downstream"], "verificationKind": "read-back" | "exit-code" | "schema-match" | "audit-only", "verification": "how success is confirmed (required for agent tasks)"}.
Agent work uses capabilityId "agent.delegate". A task may state "workerRole": "code" | "review" | "execute" to require a suitable worker (omit for default routing), "distinctWorkerFrom": ["labels"] so a reviewer is never the worker that produced the work, and "runWhen": "upstream-reports-findings" for remediation that should only run when a dependency's verified result reports something to address. A task with inputFrom "upstream-output" MUST name dependsOn and receives verified upstream evidence as data. Optionally add top-level "acceptance": [{"kind": ..., "description": "objective proof required", "tasks": ["labels"]}] — objective criteria beyond per-task success. Rules, no exceptions: no shell commands, no binaries, no approval/policy/secret/credential fields, no absolute or escaping paths, no invented capabilities or nodes."""


def _engine_config(bus) -> Any:
    from ..workflow import EngineConfig

    def forward(event: dict) -> None:
        # Engine events ride the same bus, namespaced — one stream for the UI.
        bus.emit(AgentEvent(
            type="invocation.observed", at=_now(), sessionId="-",
            payload={"engine": event},
        ))

    return EngineConfig(emit=forward)


def _default_version_store(workflow_store):
    from ..persistence.versions import WorkflowVersionStore
    return WorkflowVersionStore(clock=workflow_store._clock)


class CentralAgent:
    #: The ONE cancellation authority for this process, as a class
    #: default so every instance has one — including the bare instances
    #: unit tests build with __new__ to exercise a single method.
    runs = RUN_CONTROL

    def __init__(
        self,
        fabric_cfg: FabricConfig,
        session_store: AgentSessionStore,
        bus: EventBus | None = None,
        intent_compiler: IntentCompiler | None = None,
        planner: TaskPlanner | None = None,
        discovery: CapabilityDiscovery | None = None,
        compiler: WorkflowCompiler | None = None,
        workflow_engine: Any | None = None,
        workflow_store: WorkflowStore | None = None,
        run_store: WorkflowRunStore | None = None,
        mcp_context_provider: Any | None = None,
    ) -> None:
        self.fabric_cfg = fabric_cfg
        self.sessions = session_store
        self.bus = bus or EventBus()
        # Optional AGENT 2 extension: MCP resources/prompts context feed
        # (untrusted, fenced — see mcp_context.py). Inert when absent.
        self._mcp_context_provider = mcp_context_provider
        self.intents = intent_compiler or IntentCompiler(mode="heuristic")
        if planner is not None:
            self.planner = planner
        else:
            from ..workflow import WorkflowEngine, make_stores

            stores = (workflow_store, run_store)
            if any(s is None for s in stores) or workflow_engine is None:
                default_ws, _, default_rs = make_stores()
                workflow_store = workflow_store or default_ws
                run_store = run_store or default_rs
            self.engine = workflow_engine or WorkflowEngine(
                fabric_cfg, workflow_store,
                _default_version_store(workflow_store), run_store,
                config=_engine_config(self.bus),
            )
            self.workflow_store = workflow_store
            self.run_store = run_store
            self.planner = TaskPlanner(
                workflow_resolver=self._resolve_workflow_ref,
                known_capabilities=lambda: {
                    c.id for c in all_capabilities()},
                known_nodes=lambda: _connected_node_ids(self.fabric_cfg))
        self.discovery = discovery or CapabilityDiscovery()
        self.authority = AuthorityChecker(fabric_cfg)
        self.compiler = compiler or WorkflowCompiler()
        self.controller = ExecutionController(
            fabric_cfg, engine=getattr(self, "engine", None))
        self.verifier = VerificationEngine()
        self._active_plans: dict[str, Any] = {}
        audit_store: AuditStore | None = fabric_cfg.audit_store
        self.evidence = EvidenceCollector(lambda: (audit_store.load() if audit_store else []))
        ledger = fabric_cfg.ledger
        store = getattr(self, "workflow_store", None)
        # Project context is COLLECTED, not assumed. The scanner is
        # bounded and read-only, and everything it returns is fenced as
        # untrusted external content before it can reach a model prompt.
        from .context import scan_project

        self.context = ContextAssembler(
            project_scanner=scan_project,
            workflow_lister=(lambda: store.list()[:20]) if store else None,
            capability_lister=lambda: [
                type("V", (), {"id": c.id, "description": c.description,
                               "risk": c.risk})()
                for c in all_capabilities()],
            approval_lister=(lambda: ledger.pending()) if ledger else None,
            session_loader=self.sessions.load if hasattr(self.sessions, "load") else None,
        )

    # ── helpers ──────────────────────────────────────────────────────────
    def _resolve_workflow_ref(self, ref: str) -> str | None:
        """Resolve a user-visible reference to a stored workflow id."""
        store = getattr(self, "workflow_store", None)
        if store is None:
            return None
        direct = store.get(ref)
        if direct is not None:
            return ref
        lowered = ref.strip().lower()
        for wf in store.list():
            if (wf.get("name") or "").strip().lower() == lowered:
                return wf["id"]
        return None

    def _emit(self, etype: str, session_id: str, **payload) -> None:
        self.bus.emit(AgentEvent(type=etype, at=_now(), sessionId=session_id, payload=payload))  # type: ignore[arg-type]

    # ── the loop ─────────────────────────────────────────────────────────
    def submit(
        self,
        user_message: str,
        project_id: str | None = None,
        session: AgentSession | None = None,
        project_path: str | None = None,
    ) -> AgentResult:
        session = session or self.sessions.create(project_id)
        if project_id:
            session.projectId = project_id
        if project_path:
            session.projectPath = project_path  # extra field, persisted
        # Clarification CONTINUATION: a pending question turns this message
        # into the ANSWER to it — one combined request, same session, zero
        # side effects having occurred in between.
        pending = getattr(session, "pendingQuestion", None)
        if pending:
            originals = [m.content for m in session.messages if m.role == "user"]
            original = originals[0] if originals else ""
            user_message = f"{original}\n(Clarification answer: {user_message})"
            session.pendingQuestion = None
        self.sessions.append_message(session, "user", user_message)
        self.sessions.save(session)
        self._emit("session.started", session.sessionId, projectId=project_id)

        # A session the user already cancelled does not quietly start
        # working again because another message arrived: recovery is an
        # explicit act (resume_cancelled), never a side effect.
        if getattr(session, "cancellation", None) and self.runs.is_cancelled(session.sessionId):
            return self._cancelled_result(session, resumed=False)
        token = self.runs.begin(session.sessionId)
        try:
            result = self._run(session, user_message)
        except (PlanningError, CompilationError) as exc:
            result = self._fail(session, f"The request could not be planned: {exc}")
        except Exception as exc:
            result = self._fail(session, f"Unexpected failure: {exc}")
        if token.cancelled and result.outcome != "cancelled":
            # A leg that finished as the stop landed is still cancelled.
            # Explicit user cancellation outranks whatever the run was
            # about to report (invariant 10).
            result = self._settle_cancellation(session, result)
        if result.outcome not in ("cancelled", "awaiting-approval"):
            # A parked run is not finished. Dropping its token here left
            # the worker that the resumed leg launches with nothing
            # watching for STOP — which is every approval-gated run.
            self.runs.clear(session.sessionId)

        self.sessions.finish(session, result)
        self._record_answer(session, result)
        # Phase I: parked legs keep their verified evidence for resume;
        # terminal outcomes drop it (a later resume must not inherit it).
        if result.outcome != "awaiting-approval":
            session.verifiedEvidence = {}
        self.sessions.save(session)
        return result

    @staticmethod
    def _record_answer(session: AgentSession, result: AgentResult) -> None:
        """AURA's own answer joins the conversation, once per objective.

        Without it the session holds only the user's side, so a follow-up
        ("now add rate limiting") is interpreted with no memory of what
        AURA just did or whether it worked. Parked legs are deliberately
        NOT recorded: "waiting on your approval" is run state, it is
        already on the result and the event bus, and several in a row
        would push the user's actual objective out of the bounded context
        the next turn assembles. Always AURA's synthesised summary —
        never model reasoning, never worker output.
        """
        if result.outcome == "awaiting-approval":
            return
        session.messages.append(AgentMessage(
            role="agent", content=f"[{result.outcome}] {result.summary}"[:2000],
            at=_now()))
        session.updatedAt = _now()

    def _emit_worker_observations(self, sid: str, outcome: Any) -> None:
        """Worker lifecycle + governed actions onto the EXISTING bus.

        Called from every leg that executes, first run and resumed alike.
        A resumed leg is where the work usually happens — the first leg
        parked on the approval — so emitting only from the first leg left
        the workspace showing an approval and then silence, exactly when
        the governed actions it exists to display were being observed.

        Both streams are restatements of what already settled: lifecycle
        restates the task outcome, actions restate the worker's own
        governance log. Neither decides anything, and both are bounded at
        the source (25 actions plus a count; the file log on disk stays
        complete as evidence).
        """
        for assignment in list(
                (getattr(outcome, "worker_assignments", None) or {}).values()):
            if isinstance(assignment, dict):
                self._emit("worker.lifecycle", sid, **assignment)
        actions = list(getattr(outcome, "governed_actions", None) or [])
        for event in actions[:25]:
            if isinstance(event, dict):
                self._emit("worker.action", sid, **{
                    k: event.get(k) for k in
                    ("taskId", "workerNodeId", "invocationId",
                     "attemptId", "sequence", "actionType", "tool",
                     "target", "command", "decision", "reason")
                })
        if actions:
            denied = sum(1 for e in actions
                         if isinstance(e, dict) and e.get("decision") == "DENY")
            self._emit("worker.action", sid, summary=True,
                       actions=len(actions), denied=denied)

    def _run(self, session: AgentSession, user_message: str) -> AgentResult:
        sid = session.sessionId

        # 1. intent — compiled against a bounded, provenance-marked context
        bundle = self.context.assemble(
            session_id=session.sessionId,
            project_path=getattr(session, "projectPath", None))
        if self._mcp_context_provider is not None:
            try:
                bundle.items.extend(self._mcp_context_provider()[:8])
            except Exception:  # noqa: BLE001 — context must never break intent
                pass
        intent = self.intents.compile(user_message,
                                      context_summary=bundle.render(4000))
        if intent.needsClarification:
            question = intent.clarificationQuestion or "Could you clarify the outcome?"
            session.pendingQuestion = question  # persisted with the session
            self.sessions.save(session)
            self._emit("intent.clarification-needed", sid, question=question)
            return AgentResult(
                status="planning", outcome="needs-clarification",
                summary=question,
                failureReason="ambiguous-intent",
            )
        self._emit("intent.compiled", sid, goal=intent.goal, complexity=intent.complexity)

        # 2. plan — deterministic templates first; a validated MODEL
        # proposal only when no template matches. Without a model port
        # this path raises exactly what plan() raised: current behavior
        # is unchanged when model planning is unavailable.
        try:
            plan = self.planner.plan(intent, sid, _now())
        except PlanningError as first_err:
            plan = self._plan_from_model(intent, session, user_message,
                                         bundle, first_err)
        # Phase I: persist the validated plan body now — a restart
        # resumes THIS plan, never a re-derivation.
        session.activePlan = plan.model_dump()
        session.pendingQuestion = None
        self._active_plans[plan.planId] = plan
        session.activePlanId = plan.planId
        self._emit(
            "plan.created", sid, planId=plan.planId,
            tasks=[t.id for t in plan.tasks],
            # What the user asked for, and the shape AURA derived from it.
            # The workspace shows the objective it is working toward; the
            # per-task rows let it name roles and dependencies without
            # inventing either.
            objective=intent.goal[:400],
            expectedOutcome=intent.expectedOutcome[:400],
            plan=[{"id": t.id, "description": t.description[:160],
                   "role": t.workerRole, "dependsOn": list(t.dependsOn),
                   "conditional": getattr(t, "runWhen", "always") != "always",
                   "scopePaths": list((t.input or {}).get("scopePaths") or [])}
                  for t in plan.tasks],
            acceptance=[c.description[:200] for c in (plan.acceptance or [])])

        # 3. discovery — what exists for these tasks (read-only)
        tools = self.discovery.available_for([t.capabilityId for t in plan.tasks if t.capabilityId])
        self._emit("capability.discovery", sid,
                   tools=[{"id": t.id, "available": t.available, "source": t.source}
                          for t in tools])
        missing = sorted({t.capabilityId for t in plan.tasks if t.capabilityId}
                         - {t.id for t in tools})
        if missing:
            return self._fail(session,
                              f"No available capability for: {', '.join(missing)}")

        # 4. authority — read-only preflight through the ONE policy engine
        requirements = self.authority.check_plan(plan, session.projectId)
        blocked = self.authority.blocked(requirements)
        approvals = self.authority.expected_approvals(requirements)
        self._emit("authority.checked", sid,
                   decisions=[r.model_dump() for r in requirements])
        if blocked:
            return self._fail(session, "Policy denies this plan: " + "; ".join(blocked))
        if approvals:
            self._emit("approval.required", sid, expected=approvals)

        # 5. compile (only when a task consumes a compiled graph)
        compiled = None
        if any(t.inputFrom == "compiled-workflow" for t in plan.tasks):
            compiled_ref = self.compiler.compile(plan)
            compiled = compiled_ref.model_dump()
            self._emit("workflow.compiled", sid,
                       workflowId=compiled_ref.workflowId,
                       nodes=len(compiled_ref.nodes),
                       graphHash=compiled_ref.graphHash)

        self._emit("workflow.validated", sid, planId=plan.planId)

        # 6. execute — through the Fabric; nothing here decides authority
        self._emit("execution.started", sid, planId=plan.planId)
        outcome: ExecutionOutcome = self.controller.execute(
            plan, session.projectId, compiled_workflow=compiled,
            project_cwd=getattr(session, "projectPath", None),
            cancel_token=self.runs.begin(sid))
        for o in outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified, detail=o.detail[:200])
        self._emit_worker_observations(sid, outcome)

        if outcome.cancelled:
            return self._settle_cancellation(
                session, AgentResult(status="cancelled", outcome="cancelled",
                                     summary=outcome.stop_reason),
                outcome=outcome, plan=plan)

        if outcome.approval_id:
            report = self.verifier.verify(plan, outcome.outcomes)
            self._emit("verification.completed", sid, passed=report.passed)
            # Phase I: verified work so far persists for the resumed leg.
            self._stash_verified(session, outcome.verified_outputs)
            # Which task the human is being asked about. Needed on resume
            # to spend the grant on the task that raised it.
            session.parkedTaskId = next(
                (o.taskId for o in outcome.outcomes
                 if o.approvalId == outcome.approval_id), None)
            bundle = self.evidence.collect(sid, plan.planId, outcome.outcomes,
                                           "Awaiting human approval.", _now())
            self._emit("approval.required", sid, approvalId=outcome.approval_id)
            return AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=("Ready but parked: a human must decide "
                         f"{outcome.approval_id}. Nothing unauthorized has run."),
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                evidence=bundle, failureReason=None,
                runId=outcome.run_id,
            )

        if outcome.denied:
            report = self.verifier.verify(plan, outcome.outcomes)
            bundle = self.evidence.collect(sid, plan.planId, outcome.outcomes,
                                           f"Denied: {outcome.stop_reason}", _now())
            self._emit("agent.failed", sid, reason="policy denial", denied=True)
            return AgentResult(status="failed", outcome="denied",
                               summary=f"Policy denied this request: {outcome.stop_reason}",
                               performed=[o.taskId for o in outcome.outcomes if o.performed],
                               evidence=bundle, failureReason="policy-denied")
        if outcome.timed_out:
            bundle = self.evidence.collect(sid, plan.planId, outcome.outcomes,
                                           "Timed out.", _now())
            self._emit("agent.failed", sid, reason="timeout")
            return AgentResult(status="failed", outcome="timeout",
                               summary=f"The work exceeded its time budget: {outcome.stop_reason}",
                               performed=[o.taskId for o in outcome.outcomes if o.performed],
                               evidence=bundle, failureReason="timeout")
        if outcome.stopped:
            corrected = self._maybe_correct(session, plan, outcome)
            if corrected is not None:
                return corrected
            return self._fail(session, outcome.stop_reason,
                              outcomes=outcome.outcomes)

        # Deviations that did not stop the run (done-but-unverified) still
        # go through the correction path before any success is reported.
        if getattr(outcome, "deviation_evidence", None):
            corrected = self._maybe_correct(session, plan, outcome)
            if corrected is not None:
                return corrected

        return self._synthesize(session, plan, outcome)

    def _plan_from_model(self, intent: AgentIntent, session: AgentSession,
                         user_message: str, bundle: Any,
                         first_err: PlanningError) -> TaskPlan:
        """Phase F: model-proposed, AURA-owned planning.

        The model proposes structure over the SAME ModelPort abstraction
        used for intent (no second model API). The proposal is DATA until
        TaskPlanner.plan_from_model validates it fail-closed; the
        resulting TaskPlan then flows through the unchanged pipeline
        (discovery → authority → approval → execution → supervision →
        handoff → correction → verification). The model can never skip,
        approve, or widen any layer.
        """
        compiler = self.intents
        port = getattr(compiler, "model_port", None)
        if getattr(compiler, "mode", "heuristic") != "model" or port is None:
            raise first_err
        caps = sorted(self.planner.known_capability_ids())
        nodes = sorted(self.planner.known_node_ids())
        system = (
            _PLAN_PROPOSAL_SYSTEM
            + f"\nALLOWED CAPABILITIES: {', '.join(caps) or '(none)'}"
            + ("\nCONNECTED NODES: " + ", ".join(nodes)
               if nodes else "\nCONNECTED NODES: none — omit nodeId.")
        )
        user = (f"INTENT GOAL:\n{intent.goal}\n\nEXPECTED OUTCOME:\n"
                f"{intent.expectedOutcome}\n\nUSER REQUEST:\n{user_message}")
        try:
            raw = port.complete_json(system, user)
        except Exception as exc:
            raise PlanningError(
                f"model planning failed: {exc}") from exc
        if raw is None:
            # Model silent: retain deterministic behavior exactly.
            raise first_err
        try:
            return self.planner.plan_from_model(
                intent, session.sessionId, _now(), raw)
        except PlanningError as exc:
            raise PlanningError(f"model plan rejected: {exc}") from exc

    # ── Phase I persisted recovery ───────────────────────────────────
    # Verified handoff evidence and the validated plan body ride the
    # session file (the EXISTING store — no new persistence). A restart
    # restores both: verified tasks skip via prior_verified, unfinished
    # work continues, in-flight process handles stay ephemeral (never
    # persisted, never resumed).
    @staticmethod
    def _stash_verified(session: AgentSession,
                        verified: dict[str, dict]) -> None:
        from .handoff import MAX_ENVELOPE_CHARS

        bounded: dict[str, dict] = {}
        for tid, rec in (verified or {}).items():
            if not isinstance(rec, dict):
                continue
            slim = dict(rec)
            for key in ("stdout", "context"):
                val = slim.get(key)
                if isinstance(val, str) and len(val) > MAX_ENVELOPE_CHARS:
                    slim[key] = (val[:MAX_ENVELOPE_CHARS]
                                 + "\n[truncated by AURA for persistence]")
            bounded[str(tid)] = slim
        session.verifiedEvidence = bounded

    @staticmethod
    def _restored_verified(session: AgentSession) -> dict[str, dict]:
        prior = getattr(session, "verifiedEvidence", None) or {}
        return {str(tid): dict(rec) for tid, rec in prior.items()
                if isinstance(rec, dict)}

    @staticmethod
    def _snapshot_outcomes(snapshot: dict, task_ids: list[str],
                           ) -> list[TaskOutcome]:
        """Rebuild outcome records from persisted verified evidence.

        A resumed correction round has no live original outcome; without
        this, the settled record would silently drop already-verified
        tasks (and objective acceptance over them would evaluate
        vacuously). Restored rows are marked as restored, carry their
        original invocation/approval ids, and never re-execute."""
        out: list[TaskOutcome] = []
        for tid in task_ids:
            rec = (snapshot or {}).get(tid)
            if not isinstance(rec, dict):
                continue
            inv = list(rec.get("invocation_ids") or [])
            aprs = list(rec.get("approval_ids") or [])
            out.append(TaskOutcome(
                taskId=str(tid), state="done",
                performed=bool(inv), verified=True,
                invocationIds=inv,
                approvalId=aprs[0] if aprs else None,
                detail=("Restored from persisted verified evidence; "
                        "not re-executed.")))
        return out

    def _synthesize(self, session: AgentSession, plan: TaskPlan,
                    outcome: ExecutionOutcome) -> AgentResult:
        """Steps 7-9: verify + evidence + result synthesis from records."""
        sid = session.sessionId
        report = self.verifier.verify(plan, outcome.outcomes)
        self._emit("verification.completed", sid, passed=report.passed,
                   unverified=report.unverifiedActions,
                   objectiveAccepted=report.objectiveAccepted,
                   unmet=report.unmetAcceptance)
        summary_bits = [f"{len(outcome.outcomes)} task(s) executed"]
        if report.passed:
            summary_bits.append("all verifications passed")
        elif report.unverifiedActions:
            summary_bits.append("unverified: " + ", ".join(report.unverifiedActions))
        bundle = self.evidence.collect(sid, plan.planId, outcome.outcomes,
                                       "; ".join(summary_bits), _now())
        self._emit("result.ready", sid, passed=report.passed)
        # Result SYNTHESIS from actual records — never a bare "done".
        by_task = {t.id: t for t in plan.tasks}
        verified_lines = []
        for row in report.outcomes:
            if row.verified is True:
                task = by_task.get(row.taskId)
                how = task.verification.description or task.verification.kind \
                    if task else "audit-only"
                verified_lines.append(f"{row.taskId}: verified ({how})")
        audit_ref = (f"audit invocation {bundle.auditRecordIds[0]}"
                     if bundle.auditRecordIds else "no governed invocations")
        if report.unverifiedActions and report.passed is False:
            tail = f" Unverified: {', '.join(report.unverifiedActions)}."
        else:
            tail = ""
        # Phase H honesty: every task verified but the objective
        # acceptance unmet is NOT success. Report the objective as
        # failed with the unmet criteria named — never fabricate it.
        # An unaccepted objective is never reported as success. The guard
        # used to require every row to be "done", which silently exempted
        # any run containing a restored or unnecessary task — exactly the
        # runs where the distinction matters most.
        if (report.objectiveAccepted is False
                and not report.unverifiedActions
                and report.outcomes):
            unmet = "; ".join(report.unmetAcceptance)
            return AgentResult(
                status="failed", outcome="failed",
                summary=(
                    f"{'; '.join(summary_bits)}. "
                    + ("Verified — " + "; ".join(verified_lines) + ". "
                       if verified_lines else "")
                    + f"Objective NOT verified: {unmet}. "
                    + f"Audit: {audit_ref}.".strip()
                ),
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                verified=[o.taskId for o in report.outcomes
                          if o.verified is True],
                evidence=bundle,
                failureReason="objective-unaccepted",
            )
        return AgentResult(
            status="completed" if report.passed else "verifying",
            outcome="completed",
            summary=(
                f"{'; '.join(summary_bits)}. "
                + ("Verified — " + "; ".join(verified_lines) + ". " if verified_lines else "")
                + f"{tail}Audit: {audit_ref}.".strip()
            ),
            performed=[o.taskId for o in outcome.outcomes if o.performed],
            verified=[o.taskId for o in report.outcomes if o.verified is True],
            evidence=bundle,
        )

    # ── supervisor correction loop ─────────────────────────────────────
    # Wires the supervisor decision library into the live agent path.
    # Deviation evidence (filed by the execution controller) triggers at
    # most one bounded correction round per call; every round re-enters
    # the governed Fabric with a fresh approval. Nothing here spawns,
    # plans, or decides authority — it only connects existing pieces.
    def _chain_for(self, session: AgentSession,
                   contract: str) -> list[dict]:
        return [e for e in (session.correctionChain or [])
                if isinstance(e, dict) and e.get("taskContractId") == contract]

    def _maybe_correct(self, session: AgentSession, plan: TaskPlan,
                       outcome: ExecutionOutcome,
                       project_cwd: str | None = None,
                       ) -> AgentResult | None:
        """Handle one parked deviation, if any. Returns an AgentResult
        when correction handling takes over, else None (existing paths
        proceed unchanged)."""
        sid = session.sessionId
        # Invariant: the user's stop outranks AURA's own judgement. A
        # worker terminated by cancellation looks exactly like one that
        # deviated and died, and correcting it would restart the very
        # work the user just stopped.
        if self.runs.is_cancelled(sid):
            return None
        deviation = getattr(outcome, "deviation_evidence", None) or {}
        if not deviation:
            return None
        by_task = {t.id: t for t in plan.tasks}
        target_id = next(
            (t.id for t in topo_order(plan.tasks) if t.id in deviation),
            None)
        if target_id is None or target_id not in by_task:
            return None
        task = by_task[target_id]
        ev = deviation[target_id]
        verdict = decide_task(
            "done",
            {"taskId": task.id, "scopeDeviation": True,
             "scopeCheck": {"outside": list(ev.get("outside") or []),
                            "changed": list(ev.get("changed_paths") or [])}},
            verified=False)
        if not verdict.correctable:
            return None
        contract = f"{sid}:{task.id}"
        attempt = len(self._chain_for(session, contract)) + 2
        if attempt > 1 + MAX_CORRECTION_ATTEMPTS:
            return self._correction_exhausted(
                session, plan, outcome, contract, task, ev, verdict)
        try:
            built = build_correction(
                task_contract_id=contract, task_id=task.id,
                capability_id=task.capabilityId or "",
                base_input=dict(task.input or {}),
                approved_scope=list((task.input or {}).get("scopePaths") or []),
                deviation=verdict, attempt=attempt, extra_context="")
        except ValueError:
            return None  # defensive: fall through to existing handling
        corr_id = f"{task.id}-correction-{attempt}"
        corr_task = TaskSpecification(
            id=corr_id,
            description=(f"Correction attempt {attempt} for {task.id}: "
                         f"{'; '.join(verdict.reasons)[:200]}"),
            capabilityId=task.capabilityId,
            input=built["input"],
            dependsOn=[],
            risk=task.risk,
            reversible=task.reversible,
            verification=task.verification,
            route="single-invocation",
        )
        corr_plan = TaskPlan(
            planId=f"{plan.planId}-correction-{attempt}",
            sessionId=sid, intent=plan.intent, tasks=[corr_task],
            createdAt=_now())
        self._active_plans[corr_plan.planId] = corr_plan
        self._emit("execution.started", sid, planId=corr_plan.planId,
                   correctionFor=task.id, attempt=attempt)
        corr_outcome = self.controller.execute(
            corr_plan, session.projectId, project_cwd=project_cwd)
        for o in corr_outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified,
                       detail=o.detail[:200])
        return self._settle_correction(
            session, plan, outcome, contract, task, ev, verdict,
            attempt, corr_id, corr_plan, corr_outcome, project_cwd)

    def _correction_exhausted(self, session: AgentSession, plan: TaskPlan,
                              outcome: ExecutionOutcome, contract: str,
                              task: Any, ev: dict,
                              verdict: Any) -> AgentResult:
        """Budget spent: record the refusal and fail for review."""
        sid = session.sessionId
        record = CorrectionRecord(
            task_contract_id=contract, task_id=task.id,
            worker_node_id=None, attempt=len(self._chain_for(session, contract)) + 2,
            parent_attempt=None, verdict="budget-exhausted",
            reasons=[f"correction budget exhausted ({MAX_CORRECTION_ATTEMPTS} "
                     "corrections used); parked for review."],
            evidence={"invocationIds": list(ev.get("invocation_ids") or []),
                      "outside": list(ev.get("outside") or [])})
        session.correctionChain.append(record.to_dict())
        self.sessions.save(session)
        self._emit("agent.failed", sid, reason="correction-budget-exhausted")
        bundle = self.evidence.collect(
            sid, plan.planId, outcome.outcomes,
            "Correction budget exhausted; all evidence preserved for review.",
            _now())
        return AgentResult(
            status="failed", outcome="failed",
            summary=("Correction budget exhausted after "
                     f"{MAX_CORRECTION_ATTEMPTS} attempts. Original deviation "
                     f"preserved with evidence; nothing was reverted."),
            performed=[o.taskId for o in outcome.outcomes if o.performed],
            verified=[o.taskId for o in outcome.outcomes
                      if o.verified is True],
            evidence=bundle,
            failureReason="correction-budget-exhausted")

    def _persist_correction(self, session: AgentSession, *,
                              contract: str, task_id: str,
                              worker_node_id: str | None, attempt: int,
                              parent_attempt: int | None, verdict: str,
                              reasons: list, evidence: dict,
                              status: str, approval_id: str | None,
                              corrective_plan: dict | None,
                              verified_snapshot: dict,
                              plan_snapshot: dict | None) -> None:
        """Append one chain entry and persist the session. The single
        writer for correction history — both fresh and resumed rounds."""
        session.correctionChain.append(CorrectionRecord(
            task_contract_id=contract, task_id=task_id,
            worker_node_id=worker_node_id, attempt=attempt,
            parent_attempt=parent_attempt, verdict=verdict,
            reasons=list(reasons or []),
            evidence=dict(evidence or {}),
            corrective_input=None,
            status=status, approval_id=approval_id,
            corrective_plan=corrective_plan,
            verified_snapshot=verified_snapshot,
            plan_snapshot=plan_snapshot).to_dict())
        self.sessions.save(session)

    def _settle_correction(self, session: AgentSession, plan: TaskPlan,
                           outcome: ExecutionOutcome, contract: str,
                           task: Any, ev: dict, verdict: Any,
                           attempt: int, corr_id: str, corr_plan: TaskPlan,
                           corr_outcome: ExecutionOutcome,
                           project_cwd: str | None) -> AgentResult:
        """Settle one corrective leg from a fresh (_run) dispatch."""
        snapshot = {tid: dict(rec) for tid, rec in
                    outcome.verified_outputs.items()}

        def _persist(status: str, approval_id: str | None,
                     plan_snapshot: dict | None = None) -> None:
            self._persist_correction(
                session, contract=contract, task_id=task.id,
                worker_node_id=None, attempt=attempt,
                parent_attempt=(attempt - 1) if attempt > 1 else None,
                verdict=(verdict.status if hasattr(verdict, "status")
                         else str(verdict)),
                reasons=list(getattr(verdict, "reasons", []) or []),
                evidence={"invocationIds": list(ev.get("invocation_ids") or []),
                          "approvalIds": list(ev.get("approval_ids") or []),
                          "outside": list(ev.get("outside") or [])},
                status=status, approval_id=approval_id,
                corrective_plan=corr_plan.model_dump(),
                verified_snapshot=snapshot,
                plan_snapshot=(plan_snapshot if plan_snapshot is not None
                               else plan.model_dump()))

        return self._settle_corrective_outcome(
            session, plan=plan,
            prior_outcomes=list(outcome.outcomes),
            prior_run_id=outcome.run_id,
            snapshot=snapshot, task_id=task.id,
            attempt=attempt, corr_id=corr_id, corr_plan=corr_plan,
            corr_outcome=corr_outcome, project_cwd=project_cwd,
            persist=_persist)

    def _settle_corrective_outcome(
            self, session: AgentSession, *, plan: TaskPlan,
            prior_outcomes: list, prior_run_id: str | None,
            snapshot: dict, task_id: str,
            attempt: int, corr_id: str,
            corr_plan: TaskPlan, corr_outcome: ExecutionOutcome,
            project_cwd: str | None,
            persist) -> AgentResult:
        """Shared settlement for one corrective leg, fresh or resumed.

        `persist(status, approval_id)` records the chain entry; callers
        supply it so fresh dispatches append while resumed rounds update
        in place. Every branch preserves evidence and never auto-retries.
        """
        sid = session.sessionId

        if corr_outcome.approval_id:
            persist("parked", corr_outcome.approval_id)
            report = self.verifier.verify(corr_plan, corr_outcome.outcomes)
            bundle = self.evidence.collect(
                sid, corr_plan.planId, corr_outcome.outcomes,
                "Correction dispatched; awaiting human approval.", _now())
            self._emit("approval.required", sid,
                       approvalId=corr_outcome.approval_id)
            return AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=("Correction ready but parked: a human must decide "
                         f"{corr_outcome.approval_id}. Nothing unauthorized "
                         "has run."),
                performed=[o.taskId for o in corr_outcome.outcomes
                           if o.performed],
                evidence=bundle, failureReason=None,
                runId=corr_outcome.run_id)

        if corr_outcome.denied:
            persist("failed", None)
            bundle = self.evidence.collect(
                sid, corr_plan.planId, corr_outcome.outcomes,
                f"Correction denied: {corr_outcome.stop_reason}", _now())
            self._emit("agent.failed", sid, reason="correction denied",
                       denied=True)
            return AgentResult(
                status="failed", outcome="denied",
                summary=("Correction denied: "
                         f"{corr_outcome.stop_reason}"),
                performed=[o.taskId for o in corr_outcome.outcomes
                           if o.performed],
                evidence=bundle, failureReason="correction-denied")

        if corr_outcome.timed_out:
            persist("failed", None)
            bundle = self.evidence.collect(
                sid, corr_plan.planId, corr_outcome.outcomes,
                "Correction timed out.", _now())
            self._emit("agent.failed", sid, reason="correction timeout")
            return AgentResult(
                status="failed", outcome="timeout",
                summary=("Correction timed out: "
                         f"{corr_outcome.stop_reason}"),
                performed=[o.taskId for o in corr_outcome.outcomes
                           if o.performed],
                evidence=bundle, failureReason="correction-timeout")

        if corr_outcome.cancelled:
            persist("failed", None)
            return AgentResult(status="cancelled", outcome="cancelled",
                               summary=corr_outcome.stop_reason)

        if corr_outcome.stopped:
            # The corrective leg itself deviated or failed: extend the
            # chain and stop here. A later approval round may correct
            # again while budget remains; this call never loops.
            persist("parked", corr_outcome.approval_id)
            return self._fail(
                session,
                f"Correction attempt {attempt} did not verify: "
                f"{corr_outcome.stop_reason}. Evidence preserved; "
                "a further correction may be requested while budget remains.",
                outcomes=corr_outcome.outcomes)

        # Corrective leg verified: alias its evidence under the original
        # task id so dependents resolve, then continue the remainder.
        corr_ev = dict(corr_outcome.verified_outputs.get(corr_id) or {})
        merged = dict(snapshot)
        if corr_ev:
            merged[task_id] = corr_ev
            merged[corr_id] = corr_ev
        persist("resolved", None)
        return self._continue_after_correction(
            session, plan, prior_outcomes, prior_run_id, task_id,
            merged, project_cwd,
            list(corr_outcome.outcomes))

    def _continue_after_correction(
            self, session: AgentSession, plan: TaskPlan,
            prior_outcomes: list, prior_run_id: str | None, task_id: str,
            merged_verified: dict[str, dict],
            project_cwd: str | None,
            corr_outcomes: list) -> AgentResult:
        """Run the still-unverified remainder, then synthesize combined.

        `corr_outcomes` are this round's corrective-leg outcomes, passed
        explicitly (never cached on self: restart reconstruction reads
        them from the persisted chain + audit instead). Prior outcomes
        and run id arrive as plain data so resumed rounds — which have no
        live original outcome — can share this exact path.
        """
        sid = session.sessionId
        order = [t.id for t in topo_order(plan.tasks)]
        try:
            pos = order.index(task_id)
        except ValueError:
            pos = -1
        # The remainder must keep the already-verified predecessors it
        # depends on. They are NOT re-executed — execute() records a task
        # whose verification is already seeded as skipped — but dropping
        # them entirely leaves a dependant naming a task the plan no
        # longer contains, which reads as a dependency deadlock and
        # strands a run that had corrected itself successfully.
        pending = [t for t in topo_order(plan.tasks)
                   if order.index(t.id) > pos
                   and t.id not in merged_verified]
        needed = {d for t in pending for d in (t.dependsOn or [])}
        remainder = [t for t in topo_order(plan.tasks)
                     if t in pending or (t.id in needed
                                         and t.id in merged_verified)]
        prior = [o for o in prior_outcomes if o.taskId != task_id]
        # Phase J: a VERIFIED corrective outcome completes the ORIGINAL
        # task — alias it onto the original id so verification, objective
        # acceptance, and synthesis all read one coherent record.
        # Invocation ids and handoff lineage ride along untouched; nothing
        # is rewritten when the correction did not verify.
        plan_ids = {t.id for t in plan.tasks}
        aliased = [o.model_copy(update={"taskId": task_id})
                   if (o.taskId != task_id and o.taskId not in plan_ids
                       and o.verified is True)
                   else o
                   for o in corr_outcomes]
        if not remainder:
            combined = ExecutionOutcome(
                outcomes=prior + list(aliased),
                stopped=False, stop_reason="")
            return self._synthesize(session, plan, combined)
        rem_plan = TaskPlan(
            planId=f"{plan.planId}-continue", sessionId=sid,
            intent=plan.intent, tasks=remainder, createdAt=_now())
        self._active_plans[rem_plan.planId] = rem_plan
        self._emit("execution.started", sid, planId=rem_plan.planId,
                   continuedFrom=task_id)
        rem_outcome = self.controller.execute(
            rem_plan, session.projectId, project_cwd=project_cwd,
            prior_verified=dict(merged_verified))
        for o in rem_outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified,
                       detail=o.detail[:200])
        if rem_outcome.approval_id:
            # Phase I: the continued leg's verified work persists too, and
            # so does WHICH task the human is now being asked about — the
            # next resume spends the grant on that task, not on whatever
            # parked before the correction.
            stashed = dict(merged_verified)
            stashed.update(rem_outcome.verified_outputs)
            self._stash_verified(session, stashed)
            session.parkedTaskId = next(
                (o.taskId for o in rem_outcome.outcomes
                 if o.approvalId == rem_outcome.approval_id), None)
            bundle = self.evidence.collect(
                sid, rem_plan.planId,
                prior + [o for o in corr_outcomes if o.taskId != task_id]
                + list(rem_outcome.outcomes),
                "Continued run parked awaiting human approval.", _now())
            self._emit("approval.required", sid,
                       approvalId=rem_outcome.approval_id)
            return AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=("Continued run parked: a human must decide "
                         f"{rem_outcome.approval_id}. Nothing unauthorized "
                         "has run."),
                performed=[o.taskId for o in rem_outcome.outcomes
                           if o.performed],
                evidence=bundle, failureReason=None,
                runId=rem_outcome.run_id)
        combined = ExecutionOutcome(
            outcomes=(prior + list(aliased) + list(rem_outcome.outcomes)),
            stopped=rem_outcome.stopped,
            stop_reason=rem_outcome.stop_reason,
            approval_id=rem_outcome.approval_id,
            cancelled=rem_outcome.cancelled,
            timed_out=rem_outcome.timed_out,
            denied=rem_outcome.denied,
            run_id=rem_outcome.run_id or prior_run_id)
        # Terminal remainder states flow into the same honest synthesis:
        # denied/timeout/cancelled outcomes shape the summary exactly as
        # they would in a fresh run, over the combined record.
        return self._synthesize(session, plan, combined)

    def _pending_correction(self, session: AgentSession,
                            approval_ids: list[str]) -> dict | None:
        """Latest parked chain entry whose approval is now decided."""
        approved = set(approval_ids or [])
        for entry in reversed(session.correctionChain or []):
            if not isinstance(entry, dict):
                continue
            if entry.get("status") != "parked":
                continue
            if entry.get("approvalId") and entry["approvalId"] in approved:
                return entry
        return None

    def _fail_correction_entries(self, session: AgentSession,
                                 approval_id: str) -> None:
        """Mark parked chain entries for a denied approval as failed.

        A denial ends that correction round: no retry, no re-dispatch.
        Later submits start new rounds subject to the same budget.
        """
        touched = False
        for entry in session.correctionChain or []:
            if (isinstance(entry, dict)
                    and entry.get("status") == "parked"
                    and entry.get("approvalId") == approval_id):
                entry["status"] = "failed"
                touched = True
        if touched:
            self.sessions.save(session)

    def _resume_correction(self, session: AgentSession, entry: dict,
                           last: AgentResult) -> AgentResult:
        """Continue a parked correction whose approval was just decided.

        Rebuilds the STORED corrective plan (never re-plans from intent),
        executes it with the decided grant plus the entry's verified
        snapshot, then settles through the shared corrective path
        (park again / mirror terminal / verify + continue remainder).
        Grants were already validated spendable by resume().
        """
        sid = session.sessionId
        project_cwd = getattr(session, "projectPath", None)
        try:
            corr_plan = TaskPlan.model_validate(entry.get("correctivePlan"))
            orig_plan = TaskPlan.model_validate(entry.get("planSnapshot"))
        except Exception as exc:
            raise ValueError(
                "parked correction lacks a usable plan snapshot; "
                "cannot resume safely") from exc
        if len(corr_plan.tasks) != 1:
            raise ValueError(
                "parked correction plan is malformed; cannot resume safely")
        corr_id = corr_plan.tasks[0].id
        apr = entry.get("approvalId")
        task_grants = {corr_id: (apr, last.runId)} if apr else {}
        prior = dict(entry.get("verifiedSnapshot") or {})
        self._emit("execution.started", sid, planId=corr_plan.planId,
                   resumed=True, correctionFor=entry.get("taskId"),
                   attempt=entry.get("attempt"))
        self._active_plans[corr_plan.planId] = corr_plan
        outcome = self.controller.execute(
            corr_plan, session.projectId, resume_grants=task_grants,
            project_cwd=project_cwd, prior_verified=prior)
        for o in outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified,
                       detail=o.detail[:200])

        def _update(status: str, approval_id: str | None) -> None:
            entry["status"] = status
            if approval_id:
                entry["approvalId"] = approval_id
            self.sessions.save(session)

        # Phase J: the resumed round rebuilds the settled record of
        # already-verified tasks from the persisted snapshot — the
        # combined synthesis must see the whole run, not just the leg.
        restored = self._snapshot_outcomes(
            prior,
            [t.id for t in orig_plan.tasks
             if t.id != str(entry.get("taskId") or "")])
        return self._settle_corrective_outcome(
            session, plan=orig_plan,
            prior_outcomes=restored,
            prior_run_id=last.runId,
            snapshot=prior,
            task_id=str(entry.get("taskId") or ""),
            attempt=int(entry.get("attempt") or 2),
            corr_id=corr_id, corr_plan=corr_plan,
            corr_outcome=outcome, project_cwd=project_cwd,
            persist=_update)

    # ── cancellation ─────────────────────────────────────────────────
    # STOP is an authority decision, so it settles here rather than in
    # any of the paths that might otherwise interpret it. A cancelled
    # run is terminal: it is not corrected, not retried, not resumed on
    # its own, and it cannot be reopened by an approval that was pending
    # when the user stopped it.

    def request_cancel(self, session_id: str, reason: str = "",
                       by: str = "user") -> dict:
        """Ask a run to stop. Idempotent, and safe before it has begun.

        Returns immediately with what was recorded. Stopping a worker
        takes as long as the worker takes to die, so the caller learns
        that the request landed — not that the process is already gone.
        The `run.cancelled` event says that.
        """
        session = self.sessions.load(session_id)
        if session is None:
            raise ValueError(f"no such session: {session_id}")
        record = self.runs.request_cancel(session_id, reason, by)
        self._emit("run.cancellation-requested", session_id, **record)
        if record.get("firstRequest"):
            self._emit("run.stopping", session_id,
                       taskId=record.get("taskId"),
                       workerNodeId=record.get("workerNodeId"))
            # Persist immediately: a crash between the request and the
            # run noticing it must still come back cancelled.
            session.cancellation = {**record, "settled": False}
            self.sessions.save(session)
            self._invalidate_pending(session, record)
        return record

    def _invalidate_pending(self, session: AgentSession,
                            record: dict) -> list[str]:
        """Close the approvals this run was waiting on.

        A grant decided after the user stopped the run would otherwise be
        spendable by a later leg — the run would come back from the dead
        holding an authorisation for work nobody wants any more. The
        request is declined in the SAME ledger the Fabric spends from,
        so there is one answer, and the decline is attributed to the
        cancellation rather than to the user pretending to refuse.
        """
        last = session.lastResult
        ids = list(last.evidence.approvalIds) if (last and last.evidence) else []
        ledger = self.fabric_cfg.ledger
        invalidated: list[str] = []
        for apr in ids:
            request = ledger.by_id(apr) if ledger else None
            if not request or request.get("state") != "pending":
                continue
            ledger.decide(apr, False, "aura:cancellation",
                          f"run cancelled: {record.get('reason') or 'stopped'}")
            invalidated.append(apr)
            self._emit("approval.invalidated", session.sessionId,
                       approvalId=apr, reason="run-cancelled")
        for entry in (session.correctionChain or []):
            if isinstance(entry, dict) and entry.get("status") == "parked":
                entry["status"] = "cancelled"
        if invalidated or session.correctionChain:
            self.sessions.save(session)
        return invalidated

    def _settle_cancellation(self, session: AgentSession,
                             result: AgentResult,
                             outcome: Any | None = None,
                             plan: TaskPlan | None = None) -> AgentResult:
        """Turn a stopped run into its one terminal record."""
        sid = session.sessionId
        token = self.runs.token_for(sid)
        record = token.snapshot() if token is not None else {
            "cancelled": True, "reason": "cancelled"}
        performed = [o.taskId for o in (outcome.outcomes if outcome else [])
                     if o.performed]
        verified = [o.taskId for o in (outcome.outcomes if outcome else [])
                    if o.verified is True]
        never_started = list(getattr(outcome, "cancelled_before", None) or [])
        if plan is not None and outcome is not None:
            settled = {o.taskId for o in outcome.outcomes}
            never_started = [t.id for t in plan.tasks if t.id not in settled]
        bundle = None
        if outcome is not None and outcome.outcomes:
            bundle = self.evidence.collect(
                sid, plan.planId if plan else (session.activePlanId or "-"),
                outcome.outcomes,
                f"Cancelled: {record.get('reason') or 'stopped by the user'}",
                _now())
        # Verified work already done stays verified and stays available;
        # cancelling a run does not un-do what it finished.
        if outcome is not None:
            self._stash_verified(session, outcome.verified_outputs)
        session.cancellation = {
            **record, "settled": True, "at": _now(),
            "performedTasks": performed, "verifiedTasks": verified,
            "neverStarted": never_started,
        }
        summary = self._cancellation_summary(record, verified, never_started)
        settled = AgentResult(
            status="cancelled", outcome="cancelled", summary=summary,
            performed=performed, verified=verified, evidence=bundle,
            failureReason="cancelled-by-user",
            runId=getattr(outcome, "run_id", None) if outcome else None)
        self._emit("run.cancelled", sid, **session.cancellation)
        self._invalidate_pending(session, record)
        self.sessions.save(session)
        return settled

    @staticmethod
    def _cancellation_summary(record: dict, verified: list[str],
                              never_started: list[str]) -> str:
        parts = ["You stopped this run."]
        stopped = record.get("taskId")
        if stopped:
            worker = record.get("workerNodeId")
            parts.append(
                f"{stopped} was stopped mid-flight"
                + (f" on {worker}" if worker else "") + ".")
        if verified:
            parts.append(
                "Work already verified is kept: " + ", ".join(verified) + ".")
        if never_started:
            parts.append(
                "Not started: " + ", ".join(never_started) + ".")
        parts.append("Nothing will continue on its own — ask to resume when "
                     "you want the rest of this objective attempted again.")
        return " ".join(parts)

    def _cancelled_result(self, session: AgentSession,
                          resumed: bool) -> AgentResult:
        """The standing answer for a run that is already cancelled."""
        record = dict(getattr(session, "cancellation", None) or {})
        return AgentResult(
            status="cancelled", outcome="cancelled",
            summary=(record.get("summary")
                     or self._cancellation_summary(
                         record, record.get("verifiedTasks") or [],
                         record.get("neverStarted") or [])),
            performed=list(record.get("performedTasks") or []),
            verified=list(record.get("verifiedTasks") or []),
            failureReason="cancelled-by-user")

    def _fail(self, session: AgentSession, reason: str,
              outcomes=None) -> AgentResult:
        self._emit("agent.failed", session.sessionId, reason=reason[:300])
        bundle = None
        if outcomes:
            bundle = self.evidence.collect(session.sessionId, session.activePlanId or "-",
                                           outcomes, f"Failed: {reason}", _now())
        return AgentResult(status="failed", outcome="failed", summary=reason,
                           evidence=bundle, failureReason=reason)

    def message(self, session_id: str, text: str,
                project_path: str | None = None) -> AgentResult:
        """Continue an existing conversation: answer a clarification or add
        a follow-up. Never replays previously performed side effects."""
        session = self.sessions.load(session_id)
        if session is None:
            raise ValueError(f"no such session: {session_id}")
        return self.submit(text, session=session, project_path=project_path)

    def review_plan(self, session_id: str) -> dict | None:
        """Human-readable review of the active plan — intended actions,
        risks, approvals, verification. NEVER model reasoning."""
        session = self.sessions.load(session_id)
        if session is None or not session.activePlanId:
            return None
        plan = getattr(self, "_active_plans", {}).get(session.activePlanId)
        if plan is None:
            return None
        rows = []
        for t in plan.tasks:
            rows.append({
                "id": t.id,
                "action": t.description,
                "capability": t.capabilityId,
                "risk": t.risk,
                "reversible": t.reversible,
                "verification": t.verification.description or t.verification.kind,
            })
        return {"planId": plan.planId, "steps": rows,
                "estimatedApprovals": plan.estimatedApprovals}

    # ── resume / cancel ──────────────────────────────────────────────────
    def resume(self, session_id: str,
               resume_cancelled: bool = False) -> AgentResult:
        """Continue a parked session after a human decision.

        A CANCELLED session is refused unless the caller explicitly asks
        to resume it. That is the difference between recovery and a
        cancellation that quietly undid itself: the user stopped this
        run, so restarting it has to be something the user asked for.
        Resuming clears the stop and starts a FRESH attempt — the
        terminated attempt is never reported as having completed.

        Validates the grant BEFORE re-executing; the Fabric spends it
        single-use at invoke time. A resumed run is a NEW leg — the parked
        record is never mutated and evidence is never duplicated.
        """
        session = self.sessions.load(session_id)
        if session is None:
            raise ValueError(f"no such session: {session_id}")
        cancellation = getattr(session, "cancellation", None)
        if cancellation and not resume_cancelled:
            return self._cancelled_result(session, resumed=False)
        if cancellation and resume_cancelled:
            # A new attempt, explicitly asked for. The stop is lifted,
            # the record of it is kept, and the approvals that were
            # invalidated stay invalidated — the fresh attempt asks
            # again rather than spending a grant the user cancelled.
            self.runs.release(session_id)
            session.cancellation = {**cancellation, "resumedAt": _now()}
            self.sessions.save(session)
            self.runs.begin(session_id)
            return self._retry_after_cancellation(session)
        last = session.lastResult
        if last is None or last.outcome != "awaiting-approval":
            raise ValueError("this session is not awaiting an approval")
        approval_ids = last.evidence.approvalIds if last.evidence else []
        ledger = self.fabric_cfg.ledger
        grants: dict[str, str] = {}
        for apr in approval_ids:
            request = ledger.by_id(apr) if ledger else None
            if request and request.get("state") == "denied":
                self._fail_correction_entries(session, apr)
                result = AgentResult(
                    status="failed", outcome="denied",
                    summary=(f"The human declined this request "
                             f"({apr}). Nothing has run."),
                    failureReason="approval-denied",
                )
                self.sessions.finish(session, result)
                self.sessions.save(session)
                return result
            if not request or request.get("state") != "granted" \
                    or request.get("consumedAt"):
                raise PermissionError(
                    f"approval {apr} is not spendable; obtain a fresh decision")
            grants["_"] = apr  # task mapping resolved below
        # A parked supervisor correction resumes from its persisted chain
        # entry — never by re-planning from intent (which would discard
        # the correction and re-run the deviated original).
        pending = self._pending_correction(session, approval_ids)
        if pending is not None:
            return self._finish_resume(
                session, self._resume_correction(session, pending, last))
        # Phase I: prefer the persisted validated plan (same plan the
        # parked leg ran — including model-proposed DAGs); rebuild from
        # intent only for sessions parked before plan persistence.
        plan = None
        stored = getattr(session, "activePlan", None)
        if stored:
            try:
                plan = TaskPlan.model_validate(stored)
            except Exception:
                plan = None
        if plan is None:
            user_messages = [m.content for m in session.messages
                             if m.role == "user"]
            if not user_messages:
                raise ValueError("session has no intent to resume")
            intent = self.intents.compile(user_messages[0])
            plan = self.planner.plan(intent, session.sessionId, _now())
        # The task the human was actually asked about. Sessions parked
        # before this was recorded fall back to the last planned task,
        # which is correct for the single-task plans they could hold.
        parked_id = getattr(session, "parkedTaskId", None)
        task = next((t for t in plan.tasks if t.id == parked_id),
                    plan.tasks[-1])
        apr_id = next(iter(grants.values()), None)
        task_grants = {task.id: (apr_id, last.runId)} if apr_id else {}
        self._emit("execution.started", session.sessionId,
                   resumed=True, planId=plan.planId)
        # Phase I: verified work from the parked leg is restored and
        # skipped — never re-executed; downstream handoff resolves from
        # the restored evidence.
        outcome = self.controller.execute(
            plan, session.projectId, resume_grants=task_grants,
            project_cwd=getattr(session, "projectPath", None),
            prior_verified=self._restored_verified(session),
            cancel_token=self.runs.begin(session.sessionId))
        for o in outcome.outcomes:
            self._emit("invocation.observed", session.sessionId,
                       taskId=o.taskId, state=o.state,
                       verified=o.verified, detail=o.detail[:200])
        self._emit_worker_observations(session.sessionId, outcome)
        report = self.verifier.verify(plan, outcome.outcomes)
        self._emit("verification.completed", session.sessionId,
                   passed=report.passed,
                   unverified=report.unverifiedActions,
                   objectiveAccepted=report.objectiveAccepted,
                   unmet=report.unmetAcceptance)
        bundle = self.evidence.collect(session.sessionId, plan.planId,
                                       outcome.outcomes,
                                       f"Resumed; {report.detail}", _now())
        if outcome.stopped and outcome.approval_id:
            # A resumed leg that parks AGAIN must record the same two
            # things the first leg records, or a multi-task plan can
            # never get past its second approval: which task the human
            # is now being asked about, and the work already verified so
            # the next leg skips it instead of re-running it. Without
            # both, the next resume spends the grant on the wrong task
            # and re-executes settled side effects.
            session.parkedTaskId = next(
                (o.taskId for o in outcome.outcomes
                 if o.approvalId == outcome.approval_id), None)
            self._stash_verified(session, outcome.verified_outputs)
            result = AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=f"Resumed run parked again on {outcome.approval_id}.",
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                evidence=bundle,
                runId=outcome.run_id,
            )
        elif outcome.denied or outcome.timed_out or outcome.cancelled or outcome.stopped:
            # A scope deviation on a RESUMED leg is the normal case, not
            # the exception: agent.delegate always parks for approval, so
            # the worker's first real dispatch happens here. Without this
            # the correction loop was unreachable in production — a
            # governed denial simply ended the run as "failed" and the
            # human's next move was to ask again from scratch.
            corrected = self._maybe_correct(
                session, plan, outcome,
                project_cwd=getattr(session, "projectPath", None))
            if corrected is not None:
                return self._finish_resume(session, corrected)
            honest = ("denied" if outcome.denied else
                      "timeout" if outcome.timed_out else
                      "cancelled" if outcome.cancelled else "failed")
            result = AgentResult(status="failed" if honest != "cancelled" else "cancelled",
                                 outcome=honest,  # type: ignore[arg-type]
                                 summary=outcome.stop_reason or honest,
                                 performed=[o.taskId for o in outcome.outcomes if o.performed],
                                 evidence=bundle, failureReason=outcome.stop_reason)
        else:
            # A done-but-deviated task must go through correction before
            # any success is reported, on a resumed leg exactly as on the
            # first one.
            corrected = None
            if getattr(outcome, "deviation_evidence", None):
                corrected = self._maybe_correct(
                    session, plan, outcome,
                    project_cwd=getattr(session, "projectPath", None))
            # Phase J coherence: resumed completion synthesizes through
            # the ONE record-grounded path (objective acceptance included),
            # never a second hand-rolled vocabulary.
            result = corrected or self._synthesize(session, plan, outcome)
        return self._finish_resume(session, result)

    def _finish_resume(self, session: AgentSession,
                       result: AgentResult) -> AgentResult:
        """Persist the outcome of a resumed leg. EVERY exit from resume()
        goes through here.

        A leg that returned a result without recording it left the
        session still pointing at the previous one, so the next human
        decision resumed the leg that had already run — replaying a
        correction until its budget was spent instead of continuing the
        plan.
        """
        token = self.runs.token_for(session.sessionId)
        if token is not None and token.cancelled:
            # Settle here whatever the leg concluded. The user's decision
            # outranks it, AND this is what writes the persisted record —
            # a leg that already knew it was cancelled still has to write
            # it down, or a restart finds a stop requested and never
            # settled.
            result = self._settle_cancellation(session, result)
        self._emit("result.ready", session.sessionId, resumed=True,
                   passed=result.outcome == "completed")
        self.sessions.finish(session, result)
        self._record_answer(session, result)
        if result.outcome != "awaiting-approval":
            session.verifiedEvidence = {}
        self.sessions.save(session)
        if result.outcome not in ("cancelled", "awaiting-approval"):
            self.runs.clear(session.sessionId)
        return result

    def _retry_after_cancellation(self, session: AgentSession) -> AgentResult:
        """Re-attempt what cancellation left unfinished.

        Verified work is restored, not repeated: a task proven before the
        stop is skipped exactly as it is across an approval. Everything
        else is a NEW attempt with a new invocation identity — the
        terminated attempt keeps its own record and is never described
        as having finished.
        """
        sid = session.sessionId
        stored = getattr(session, "activePlan", None)
        if not stored:
            return self._fail(
                session, "This cancelled run has no stored plan to resume; "
                         "state the objective again and AURA will re-plan.")
        try:
            plan = TaskPlan.model_validate(stored)
        except Exception as exc:  # noqa: BLE001
            return self._fail(session,
                              f"The stored plan could not be restored: {exc}")
        self._active_plans[plan.planId] = plan
        session.parkedTaskId = None
        self._emit("execution.started", sid, planId=plan.planId,
                   resumedFromCancellation=True)
        outcome = self.controller.execute(
            plan, session.projectId,
            project_cwd=getattr(session, "projectPath", None),
            prior_verified=self._restored_verified(session),
            cancel_token=self.runs.begin(sid))
        for o in outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified,
                       detail=o.detail[:200])
        self._emit_worker_observations(sid, outcome)
        if outcome.cancelled:
            return self._finish_resume(session, self._settle_cancellation(
                session, AgentResult(status="cancelled", outcome="cancelled",
                                     summary=outcome.stop_reason),
                outcome=outcome, plan=plan))
        if outcome.approval_id:
            self._stash_verified(session, outcome.verified_outputs)
            session.parkedTaskId = next(
                (o.taskId for o in outcome.outcomes
                 if o.approvalId == outcome.approval_id), None)
            bundle = self.evidence.collect(
                sid, plan.planId, outcome.outcomes,
                "Awaiting human approval after a resumed cancellation.",
                _now())
            self._emit("approval.required", sid, approvalId=outcome.approval_id)
            return self._finish_resume(session, AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=("Resumed after cancellation and parked: a human "
                         f"must decide {outcome.approval_id}."),
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                evidence=bundle, runId=outcome.run_id))
        if outcome.stopped:
            return self._finish_resume(session, self._fail(
                session, outcome.stop_reason, outcomes=outcome.outcomes))
        return self._finish_resume(session,
                                   self._synthesize(session, plan, outcome))

    def cancel(self, session_id: str) -> bool:
        """Stop this run. The request is what returns; the stop follows.

        This used to mark the session FAILED and emit an event without
        signalling anything, so a worker mid-flight kept running and the
        record said the wrong thing about why the run ended. Now the
        request reaches the token the worker is watching, and any engine
        run in flight is cancelled through the engine that owns it.
        """
        record = self.request_cancel(session_id, "cancelled by the user")
        rid = getattr(self.controller, "_active_run_id", None)
        engine = getattr(self.controller, "engine", None)
        if rid and engine is not None:
            try:
                engine.cancel(rid)
            except Exception:  # noqa: BLE001 — the token still stands
                pass
        self._emit("agent.cancelled", session_id, **record)
        return True


__all__ = ["AgentIntent", "CentralAgent"]
