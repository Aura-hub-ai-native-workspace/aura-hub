"""An implementation task must not verify by doing nothing.

A worker whose meaningful actions were DENIED can exit 0 having changed
nothing. The task criterion "the worker exits 0 and every file it
changed lies inside the declared scope" is then vacuously true, so the
task was recorded VERIFIED and the objective ACCEPTED — a false success
built out of a correct denial.

The fix asserts over what AURA measured, and only for tasks whose own
contract requires an artifact. Review, investigation and conditional
remediation still finish honestly having touched nothing.
"""
import asyncio

import pytest

from aura.central_agent.planner import expects_change, plan_delegated_work
from aura.executors import agent_delegate_verify


def _verify(inv: dict, output: dict) -> dict:
    return asyncio.run(agent_delegate_verify(inv, {"output": output}))


def _measured(changed: list[str], denied: list[dict] | None = None) -> dict:
    out = {
        "agent": "OpenCode",
        "exitCode": 0,
        "scopeCheck": {"supported": True, "allowed": True,
                       "changed": list(changed), "outside": [],
                       "detail": ""},
    }
    if denied is not None:
        out["governedActions"] = {"worker": "OpenCode", "governed": True,
                                  "allowed": 0, "denied": denied}
    return out


IMPL = {"input": {"task": "add login", "scopePaths": ["src/auth"],
                  "expectChange": True}}
READONLY = {"input": {"task": "review it", "scopePaths": ["src/auth"]}}


class TestDeniedRequiredWork:
    def test_all_meaningful_writes_denied_is_not_verified(self):
        """Case 1: denied writes, exit 0, nothing changed."""
        res = _verify(IMPL, _measured([], denied=[
            {"tool": "write", "target": "src/auth/login.py",
             "reason": "outside task scope"}]))
        assert res["passed"] is False
        assert "prevented" in res["detail"]
        assert "denied 1" in res["detail"]

    def test_denied_detail_names_what_was_blocked(self):
        res = _verify(IMPL, _measured([], denied=[
            {"tool": "bash", "command": "cat ../secrets", "reason": "scope"}]))
        assert "cat ../secrets" in res["detail"]

    def test_nothing_denied_is_reported_as_no_work_not_prevention(self):
        """Case 2: exit 0, no denials, still nothing done."""
        res = _verify(IMPL, _measured([]))
        assert res["passed"] is False
        assert "never made" in res["detail"]
        assert "prevented" not in res["detail"]


class TestLegitimateZeroChangeWork:
    def test_review_with_no_file_changes_still_verifies(self):
        """Case 3: a review is asked NOT to modify anything."""
        assert _verify(READONLY, _measured([]))["passed"] is True

    def test_investigation_with_no_file_changes_still_verifies(self):
        inv = {"input": {"task": "investigate the failure"}}
        assert _verify(inv, _measured([]))["passed"] is True

    def test_conditional_remediation_may_change_nothing(self):
        """The remediate task is told to change nothing when the review
        reported nothing, so it must never carry expectChange."""
        inv = {"input": {"task": "fix what the review found",
                         "scopePaths": ["src/auth"]}}
        assert _verify(inv, _measured([]))["passed"] is True


class TestRealWorkAndUnmeasuredTrees:
    def test_real_implementation_verifies(self):
        """Case 6: the artifact exists."""
        assert _verify(IMPL, _measured(["src/auth/login.py"]))["passed"] is True

    def test_unmeasured_tree_claims_nothing(self):
        """No scopeCheck means AURA did not measure. Silence about an
        unmeasured tree is not evidence of failure."""
        assert _verify(IMPL, {"agent": "OpenCode", "exitCode": 0})["passed"] is True

    def test_unsupported_scope_check_claims_nothing(self):
        out = {"agent": "OpenCode", "exitCode": 0,
               "scopeCheck": {"supported": False, "changed": []}}
        assert _verify(IMPL, out)["passed"] is True

    def test_nonzero_exit_still_fails_on_exit_code(self):
        out = _measured([])
        out["exitCode"] = 3
        res = _verify(IMPL, out)
        assert res["passed"] is False and res["kind"] == "exit-code"

    def test_scope_deviation_still_takes_precedence(self):
        """Phase J deny-before-execution parking is unchanged."""
        out = {"agent": "OpenCode", "exitCode": 0, "scopeDeviation": True,
               "scopeCheck": {"supported": True, "allowed": False,
                              "changed": [], "outside": ["rogue.txt"]}}
        res = _verify(IMPL, out)
        assert res["passed"] is False
        assert "outside the declared scope" in res["detail"]


class TestContractShape:
    def test_only_unconditional_code_work_requires_an_artifact(self):
        assert expects_change("code", "always") is True
        assert expects_change("review", "always") is False
        assert expects_change("code", "upstream-reports-findings") is False
        assert expects_change(None, "always") is False

    def test_planner_marks_implement_only(self):
        from aura.central_agent.intent import IntentCompiler

        intent = IntentCompiler(mode="heuristic").compile(
            "Build auth in src/auth/. Have another AI review it. If the "
            "reviewer finds a problem, fix it and verify everything.")
        plan = plan_delegated_work(intent, "ses", "now")
        marks = {t.id: (t.input or {}).get("expectChange") for t in plan.tasks}
        assert marks == {"implement": True, "review": None, "remediate": None}

    def test_a_model_proposal_cannot_set_the_requirement_itself(self):
        """expectChange is AURA-owned: it is not an accepted input key."""
        from aura.central_agent.planner import _DELEGATE_INPUT_KEYS, _MODEL_TASK_KEYS

        assert "expectChange" not in _DELEGATE_INPUT_KEYS
        assert "expectChange" not in _MODEL_TASK_KEYS


class TestObjectiveAcceptanceFollows:
    """Case 5: a denied required action must not yield an accepted
    objective. The engine already refuses to accept over a task that is
    not verified — this pins that the new verdict reaches it."""

    def _pieces(self):
        from aura.contracts.agent import (
            AgentIntent, TaskOutcome, TaskPlan, TaskSpecification,
            VerificationRequirement,
        )
        from aura.central_agent.verification import VerificationEngine
        return (AgentIntent, TaskOutcome, TaskPlan, TaskSpecification,
                VerificationRequirement, VerificationEngine)

    def _plan_with(self, verified: bool):
        (AgentIntent, TaskOutcome, TaskPlan, TaskSpecification,
         VerificationRequirement, VerificationEngine) = self._pieces()
        intent = AgentIntent(goal="Implement authentication.",
                             surface="project", expectedOutcome="auth exists")
        task = TaskSpecification(
            id="implement", description="Carry out the requested change",
            capabilityId="agent.delegate",
            input={"task": "implement auth", "scopePaths": ["src/auth"],
                   "expectChange": True},
            workerRole="code", risk="high", reversible=False,
            verification=VerificationRequirement(
                kind="exit-code", description="exits 0 and stays in scope"))
        plan = TaskPlan(
            planId="pln-o", sessionId="ses-o", intent=intent, tasks=[task],
            createdAt="now",
            acceptance=[VerificationRequirement(
                kind="exit-code",
                description="The requested work was carried out and verified.",
                expect={"tasks": ["implement"]})])
        outcome = TaskOutcome(taskId="implement", state="done", performed=True,
                              verified=verified, invocationIds=["inv-1"])
        return VerificationEngine, plan, [outcome]

    def test_denied_required_work_leaves_objective_unaccepted(self):
        engine, plan, outcomes = self._plan_with(verified=False)
        ok, unmet = engine.verify_objective(plan, outcomes)
        assert ok is False
        assert unmet, "an unaccepted objective must say what is unmet"

    def test_real_work_accepts_the_objective(self):
        engine, plan, outcomes = self._plan_with(verified=True)
        assert engine.verify_objective(plan, outcomes) == (True, [])


class TestModelProposedImplementationIsCovered:
    def test_model_code_task_gets_the_requirement(self):
        from aura.central_agent.planner import TaskPlanner
        from aura.contracts.agent import AgentIntent

        planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
        plan = planner.plan_from_model(
            AgentIntent(goal="build it", surface="project",
                        expectedOutcome="built"), "s", "now",
            {"tasks": [{"description": "write the feature",
                        "capabilityId": "agent.delegate",
                        "input": {"task": "write it"},
                        "workerRole": "code",
                        "verificationKind": "exit-code",
                        "verification": "exit 0"}]})
        assert (plan.tasks[0].input or {}).get("expectChange") is True

    def test_model_review_task_does_not(self):
        from aura.central_agent.planner import TaskPlanner
        from aura.contracts.agent import AgentIntent

        planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
        plan = planner.plan_from_model(
            AgentIntent(goal="review it", surface="project",
                        expectedOutcome="reviewed"), "s", "now",
            {"tasks": [{"description": "review the feature",
                        "capabilityId": "agent.delegate",
                        "input": {"task": "review it"},
                        "workerRole": "review",
                        "verificationKind": "exit-code",
                        "verification": "exit 0"}]})
        assert (plan.tasks[0].input or {}).get("expectChange") is None


class TestRunOutcomeIsNotCompleted:
    """A run whose objective went unmet must not report outcome
    "completed", however honest its prose is. Callers branch on the
    outcome, not the summary."""

    def _service(self):
        from aura.central_agent.events import EventBus
        from aura.central_agent.evidence import EvidenceCollector
        from aura.central_agent.service import CentralAgent
        from aura.central_agent.verification import VerificationEngine

        svc = CentralAgent.__new__(CentralAgent)
        svc.bus = EventBus()
        svc.verifier = VerificationEngine()
        svc.evidence = EvidenceCollector(lambda: [])
        return svc

    def _run(self, verified: bool):
        from aura.central_agent.execution import ExecutionOutcome
        from aura.central_agent.session import AgentSessionStore
        from aura.contracts.agent import (
            AgentIntent, TaskOutcome, TaskPlan, TaskSpecification,
            VerificationRequirement,
        )
        import tempfile

        svc = self._service()
        with tempfile.TemporaryDirectory() as tmp:
            session = AgentSessionStore(tmp).create(None)
            task = TaskSpecification(
                id="implement", description="Carry out the requested change",
                capabilityId="agent.delegate",
                input={"task": "implement auth", "scopePaths": ["src/auth"],
                       "expectChange": True},
                workerRole="code", risk="high", reversible=False,
                verification=VerificationRequirement(
                    kind="exit-code", description="exits 0, stays in scope"))
            plan = TaskPlan(
                planId="pln-r", sessionId="ses-r",
                intent=AgentIntent(goal="Implement authentication.",
                                   surface="project",
                                   expectedOutcome="auth exists"),
                tasks=[task], createdAt="now",
                acceptance=[VerificationRequirement(
                    kind="exit-code",
                    description="The requested work was carried out and verified.",
                    expect={"tasks": ["implement"]})])
            out = ExecutionOutcome()
            out.outcomes.append(TaskOutcome(
                taskId="implement", state="done", performed=True,
                verified=verified, invocationIds=["inv-1"]))
            return svc._synthesize(session, plan, out)

    def test_denied_required_work_run_is_not_completed(self):
        result = self._run(verified=False)
        assert result.outcome != "completed"
        assert result.failureReason == "objective-unaccepted"
        assert result.verified == []

    def test_real_work_run_completes(self):
        result = self._run(verified=True)
        assert result.outcome == "completed"
        assert result.failureReason is None
        assert result.verified == ["implement"]
