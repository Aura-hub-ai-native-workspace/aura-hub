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
    AgentResult,
    AgentSession,
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
from .planner import PlanningError, TaskPlanner
from .session import AgentSessionStore
from .verification import VerificationEngine
from .workflow_compiler import CompilationError, WorkflowCompiler


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    ) -> None:
        self.fabric_cfg = fabric_cfg
        self.sessions = session_store
        self.bus = bus or EventBus()
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
                    c.id for c in all_capabilities()})
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
        self.context = ContextAssembler(
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

        try:
            result = self._run(session, user_message)
        except (PlanningError, CompilationError) as exc:
            result = self._fail(session, f"The request could not be planned: {exc}")
        except Exception as exc:
            result = self._fail(session, f"Unexpected failure: {exc}")

        self.sessions.finish(session, result)
        self.sessions.save(session)
        return result

    def _run(self, session: AgentSession, user_message: str) -> AgentResult:
        sid = session.sessionId

        # 1. intent — compiled against a bounded, provenance-marked context
        bundle = self.context.assemble(
            session_id=session.sessionId,
            project_path=getattr(session, "projectPath", None))
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

        # 2. plan
        plan = self.planner.plan(intent, sid, _now())
        session.pendingQuestion = None
        self._active_plans[plan.planId] = plan
        session.activePlanId = plan.planId
        self._emit("plan.created", sid, planId=plan.planId, tasks=[t.id for t in plan.tasks])

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
            project_cwd=getattr(session, "projectPath", None))
        for o in outcome.outcomes:
            self._emit("invocation.observed", sid, taskId=o.taskId,
                       state=o.state, verified=o.verified, detail=o.detail[:200])

        if outcome.cancelled:
            return AgentResult(status="cancelled", outcome="cancelled",
                               summary=outcome.stop_reason)

        if outcome.approval_id:
            report = self.verifier.verify(plan, outcome.outcomes)
            self._emit("verification.completed", sid, passed=report.passed)
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
        if outcome.cancelled:
            return AgentResult(status="cancelled", outcome="cancelled",
                               summary=outcome.stop_reason)
        if outcome.stopped:
            return self._fail(session, outcome.stop_reason,
                              outcomes=outcome.outcomes)

        # 7. verify + 8. evidence + 9. result
        report = self.verifier.verify(plan, outcome.outcomes)
        self._emit("verification.completed", sid, passed=report.passed,
                   unverified=report.unverifiedActions)
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
    def resume(self, session_id: str) -> AgentResult:
        """Continue a parked session after a human decision.

        Validates the grant BEFORE re-executing; the Fabric spends it
        single-use at invoke time. A resumed run is a NEW leg — the parked
        record is never mutated and evidence is never duplicated.
        """
        session = self.sessions.load(session_id)
        if session is None:
            raise ValueError(f"no such session: {session_id}")
        last = session.lastResult
        if last is None or last.outcome != "awaiting-approval":
            raise ValueError("this session is not awaiting an approval")
        approval_ids = last.evidence.approvalIds if last.evidence else []
        ledger = self.fabric_cfg.ledger
        grants: dict[str, str] = {}
        for apr in approval_ids:
            request = ledger.by_id(apr) if ledger else None
            if request and request.get("state") == "denied":
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
        plan = None
        # Rebuild the plan deterministically from the stored intent message.
        user_messages = [m.content for m in session.messages if m.role == "user"]
        if not user_messages:
            raise ValueError("session has no intent to resume")
        intent = self.intents.compile(user_messages[0])
        plan = self.planner.plan(intent, session.sessionId, _now())
        task = plan.tasks[-1]  # parked task is the last planned one
        apr_id = next(iter(grants.values()), None)
        task_grants = {task.id: (apr_id, last.runId)} if apr_id else {}
        self._emit("execution.started", session.sessionId,
                   resumed=True, planId=plan.planId)
        outcome = self.controller.execute(
            plan, session.projectId, resume_grants=task_grants,
            project_cwd=getattr(session, "projectPath", None))
        for o in outcome.outcomes:
            self._emit("invocation.observed", session.sessionId,
                       taskId=o.taskId, state=o.state,
                       verified=o.verified, detail=o.detail[:200])
        report = self.verifier.verify(plan, outcome.outcomes)
        self._emit("verification.completed", session.sessionId, passed=report.passed)
        bundle = self.evidence.collect(session.sessionId, plan.planId,
                                       outcome.outcomes,
                                       f"Resumed; {report.detail}", _now())
        if outcome.stopped and outcome.approval_id:
            result = AgentResult(
                status="awaiting-approval", outcome="awaiting-approval",
                summary=f"Resumed run parked again on {outcome.approval_id}.",
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                evidence=bundle,
                runId=outcome.run_id,
            )
        elif outcome.denied or outcome.timed_out or outcome.cancelled or outcome.stopped:
            honest = ("denied" if outcome.denied else
                      "timeout" if outcome.timed_out else
                      "cancelled" if outcome.cancelled else "failed")
            result = AgentResult(status="failed" if honest != "cancelled" else "cancelled",
                                 outcome=honest,  # type: ignore[arg-type]
                                 summary=outcome.stop_reason or honest,
                                 performed=[o.taskId for o in outcome.outcomes if o.performed],
                                 evidence=bundle, failureReason=outcome.stop_reason)
        else:
            result = AgentResult(
                status="completed" if report.passed else "verifying",
                outcome="completed",
                summary=(f"Resumed and completed. "
                         f"Evidence: {len(bundle.auditRecordIds)} audit record(s)."),
                performed=[o.taskId for o in outcome.outcomes if o.performed],
                verified=[o.taskId for o in report.outcomes if o.verified is True],
                evidence=bundle,
            )
        self._emit("result.ready", session.sessionId, resumed=True,
                   passed=result.outcome == "completed")
        self.sessions.finish(session, result)
        self.sessions.save(session)
        return result

    def cancel(self, session_id: str) -> bool:
        session = self.sessions.load(session_id)
        if session is None:
            raise ValueError(f"no such session: {session_id}")
        rid = getattr(self.controller, "_active_run_id", None)
        cancelled = False
        engine = getattr(self.controller, "engine", None)
        if rid and engine is not None:
            cancelled = engine.cancel(rid)
        if not cancelled:
            self._fail(session, "cancelled before completion")
            cancelled = True
        self._emit("agent.cancelled", session_id)
        return cancelled


__all__ = ["AgentIntent", "CentralAgent"]
