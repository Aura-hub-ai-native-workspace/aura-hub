"""CentralAgent — the orchestration facade.

Wires intent → plan → discovery → authority → compilation → governed
execution → verification → evidence, emitting an AgentEvent at every
boundary. The agent REASONS here; every decision about authority belongs
to aura.policy, and every effect to aura.fabric.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..audit import AuditStore
from ..contracts import (
    AgentEvent,
    AgentIntent,
    AgentResult,
    AgentSession,
    ExecutionPlan,
)
from ..fabric import FabricConfig
from .authority import AuthorityChecker
from .discovery import CapabilityDiscovery
from .evidence import EvidenceCollector
from .events import EventBus
from .execution import ExecutionController, ExecutionOutcome
from .intent import IntentCompiler
from .planner import PlanningError, TaskPlanner
from .session import AgentSessionStore
from .verification import VerificationEngine
from .workflow_compiler import CompilationError, WorkflowCompiler


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    ) -> None:
        self.fabric_cfg = fabric_cfg
        self.sessions = session_store
        self.bus = bus or EventBus()
        self.intents = intent_compiler or IntentCompiler(mode="heuristic")
        self.planner = planner or TaskPlanner()
        self.discovery = discovery or CapabilityDiscovery()
        self.authority = AuthorityChecker(fabric_cfg)
        self.compiler = compiler or WorkflowCompiler()
        self.controller = ExecutionController(fabric_cfg)
        self.verifier = VerificationEngine()
        audit_store: AuditStore | None = fabric_cfg.audit_store
        self.evidence = EvidenceCollector(lambda: (audit_store.load() if audit_store else []))

    # ── event helper ─────────────────────────────────────────────────────
    def _emit(self, etype: str, session_id: str, **payload) -> None:
        self.bus.emit(AgentEvent(type=etype, at=_now(), sessionId=session_id, payload=payload))  # type: ignore[arg-type]

    # ── the loop ─────────────────────────────────────────────────────────
    def submit(
        self,
        user_message: str,
        project_id: str | None = None,
        session: AgentSession | None = None,
    ) -> AgentResult:
        session = session or self.sessions.create(project_id)
        if project_id:
            session.projectId = project_id
        self.sessions.append_message(session, "user", user_message)
        self.sessions.save(session)
        self._emit("session.started", session.sessionId, projectId=project_id)

        try:
            result = self._run(session, user_message)
        except (PlanningError, CompilationError) as exc:
            result = self._fail(session, f"The request could not be planned: {exc}")
        except Exception as exc:  # noqa: BLE001 — a fault becomes an honest failure
            result = self._fail(session, f"Unexpected failure: {exc}")

        self.sessions.finish(session, result)
        self.sessions.save(session)
        return result

    def _run(self, session: AgentSession, user_message: str) -> AgentResult:
        sid = session.sessionId

        # 1. intent
        intent = self.intents.compile(user_message)
        if intent.needsClarification:
            self._emit("intent.clarification-needed", sid, question=intent.clarificationQuestion)
            return AgentResult(
                status="planning", outcome="blocked",
                summary=intent.clarificationQuestion or "Clarification required.",
                failureReason="ambiguous-intent",
            )
        self._emit("intent.compiled", sid, goal=intent.goal, complexity=intent.complexity)

        # 2. plan
        plan = self.planner.plan(intent, sid, _now())
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

        execution_plan = ExecutionPlan(
            planId=plan.planId, sessionId=sid,
            route="workflow-run" if compiled else "single-invocation",
            singleInvocation=None, workflow=compiled_ref if compiled else None,
            authority=requirements, blocked=False,
        )
        self._emit("workflow.validated", sid, planId=plan.planId)

        # 6. execute — through the Fabric; nothing here decides authority
        self._emit("execution.started", sid, planId=plan.planId)
        outcome: ExecutionOutcome = self.controller.execute(
            plan, session.projectId, compiled_workflow=compiled)
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
            )

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
        return AgentResult(
            status="completed" if report.passed else "verifying",
            outcome="completed",
            summary=f"{'; '.join(summary_bits)}. Evidence: {len(bundle.auditRecordIds)} audit record(s).",
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


__all__ = ["CentralAgent", "AgentIntent"]
