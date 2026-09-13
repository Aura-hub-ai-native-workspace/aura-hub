"""Phase H — objective acceptance: tasks-done ≠ objective-verified.

Engine-level, planner-level, and synthesis-level proof that stated
acceptance criteria are mechanically evaluated and that an unmet
objective is reported honestly instead of as success.
"""

from __future__ import annotations

import pytest

from aura.central_agent.planner import PlanningError, TaskPlanner
from aura.central_agent.verification import VerificationEngine
from aura.contracts import (
    AgentIntent,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)


def _intent():
    return AgentIntent(goal="g", expectedOutcome="o")


def _task(tid, kind="exit-code"):
    return TaskSpecification(
        id=tid, description=f"task {tid}", capabilityId="agent.delegate",
        input={"task": f"do {tid}"},
        verification=VerificationRequirement(
            kind=kind, description=f"{kind} proof"))


def _plan(*tasks, acceptance=None):
    return TaskPlan(planId="pln-h", sessionId="ses-h", intent=_intent(),
                    tasks=list(tasks), createdAt="now",
                    acceptance=acceptance or [])


def _done(tid, verified=True):
    return TaskOutcome(taskId=tid, state="done", performed=True,
                       verified=verified, invocationIds=[f"inv-{tid}"])


# ── engine ────────────────────────────────────────────────────────────

class TestVerifyObjective:
    def test_no_criteria_accepted_legacy(self):
        ok, unmet = VerificationEngine.verify_objective(
            _plan(_task("t1")), [_done("t1")])
        assert (ok, unmet) == (True, [])

    def test_met_criterion_accepted(self):
        plan = _plan(_task("t1"), acceptance=[VerificationRequirement(
            kind="exit-code", description="bug fixed",
            expect={"tasks": ["t1"]})])
        report = VerificationEngine().verify(plan, [_done("t1")])
        assert report.passed is True
        assert report.objectiveAccepted is True

    def test_unverified_task_unmet(self):
        plan = _plan(_task("t1"), _task("t2"), acceptance=[
            VerificationRequirement(
                kind="audit-only", description="both done")])
        report = VerificationEngine().verify(
            plan, [_done("t1"), _done("t2", verified=False)])
        assert report.passed is False
        assert report.objectiveAccepted is False
        assert any("t2" in u for u in report.unmetAcceptance)

    def test_kind_coverage_required(self):
        # Tasks verified audit-only cannot prove a read-back objective.
        plan = _plan(_task("t1", kind="audit-only"), acceptance=[
            VerificationRequirement(
                kind="read-back", description="file proves it",
                expect={"tasks": ["t1"]})])
        report = VerificationEngine().verify(plan, [_done("t1")])
        assert report.objectiveAccepted is False
        assert "read-back" in report.unmetAcceptance[0]

    def test_unknown_task_in_criterion_unmet(self):
        plan = _plan(_task("t1"), acceptance=[VerificationRequirement(
            kind="audit-only", description="ghost",
            expect={"tasks": ["ghost"]})])
        ok, unmet = VerificationEngine.verify_objective(
            plan, [_done("t1")])
        assert ok is False
        assert "unknown tasks" in unmet[0]


# ── planner ───────────────────────────────────────────────────────────

class TestProposalAcceptance:
    def _planner(self):
        return TaskPlanner(
            known_capabilities=lambda: {"agent.delegate"})

    def _proposal(self, **kw):
        base = {"description": "fix", "capabilityId": "agent.delegate",
                "input": {"task": "fix"}, "verificationKind": "exit-code",
                "verification": "exit 0"}
        base.update(kw)
        return {"tasks": [base]}

    def test_acceptance_validated_and_attached(self):
        plan = self._planner().plan_from_model(_intent(), "s", "now", {
            **self._proposal(),
            "acceptance": [{"kind": "exit-code",
                            "description": "bug fixed and proven",
                            "tasks": ["t1"]}],
        })
        assert len(plan.acceptance) == 1
        assert plan.acceptance[0].expect == {"tasks": ["t1"]}

    def test_acceptance_may_use_model_labels(self):
        proposal = self._proposal()
        proposal["tasks"][0]["id"] = "fix"
        plan = self._planner().plan_from_model(_intent(), "s", "now", {
            **proposal,
            "acceptance": [{"kind": "exit-code",
                            "description": "bug fixed",
                            "tasks": ["fix"]}],
        })
        assert plan.acceptance[0].expect == {"tasks": ["t1"]}

    @pytest.mark.parametrize("bad", [
        {"kind": "vibes", "description": "x"},
        {"kind": "exit-code", "description": "  "},
        {"kind": "exit-code", "description": "x", "tasks": ["ghost"]},
        {"kind": "exit-code", "description": "x", "tasks": "t1"},
        {"kind": "exit-code", "description": "x", "approval": True},
    ])
    def test_malformed_acceptance_rejected(self, bad):
        with pytest.raises(PlanningError):
            self._planner().plan_from_model(_intent(), "s", "now", {
                **self._proposal(), "acceptance": [bad]})

    def test_templates_carry_acceptance(self):
        planner = TaskPlanner(
            known_capabilities=lambda: {"git.status", "filesystem.write"})
        intent = AgentIntent(
            goal="write f", expectedOutcome="f written",
            requiredCapabilities=["filesystem.write"],
            entities=[{"type": "path", "value": "f.txt"},
                      {"type": "text", "value": "hi"}])
        plan = planner.plan(intent, "s", "now")
        assert plan.acceptance and plan.acceptance[0].kind == "read-back"


# ── synthesis honesty ─────────────────────────────────────────────────

class TestSynthesisHonesty:
    def _service(self):
        from aura.central_agent.events import EventBus
        from aura.central_agent.evidence import EvidenceCollector
        from aura.central_agent.service import CentralAgent

        svc = CentralAgent.__new__(CentralAgent)
        svc.bus = EventBus()
        svc.verifier = VerificationEngine()
        svc.evidence = EvidenceCollector(lambda: [])
        return svc

    def _session(self, tmp_path):
        from aura.central_agent.session import AgentSessionStore

        store = AgentSessionStore(tmp_path)
        return store.create(None)

    def test_unmet_objective_is_failure_not_success(self, tmp_path):
        svc = self._service()
        session = self._session(tmp_path)
        plan = _plan(_task("t1", kind="audit-only"), acceptance=[
            VerificationRequirement(
                kind="read-back", description="file proves it",
                expect={"tasks": ["t1"]})])
        from aura.central_agent.execution import ExecutionOutcome

        outcome = ExecutionOutcome()
        outcome.outcomes.append(_done("t1"))
        result = svc._synthesize(session, plan, outcome)
        assert result.outcome == "failed"
        assert result.failureReason == "objective-unaccepted"
        assert "NOT verified" in result.summary
        assert result.verified == ["t1"]  # records stay honest

    def test_met_objective_completes(self, tmp_path):
        svc = self._service()
        session = self._session(tmp_path)
        plan = _plan(_task("t1"), acceptance=[VerificationRequirement(
            kind="exit-code", description="done",
            expect={"tasks": ["t1"]})])
        from aura.central_agent.execution import ExecutionOutcome

        outcome = ExecutionOutcome()
        outcome.outcomes.append(_done("t1"))
        result = svc._synthesize(session, plan, outcome)
        assert result.outcome == "completed"
        assert result.failureReason is None
