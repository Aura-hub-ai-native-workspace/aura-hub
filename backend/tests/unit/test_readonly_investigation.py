"""Read-only investigation — clear inspection objectives execute.

A request that says what to find out must reach a worker; a request
that says nothing may change must not plan a change.

Three shapes, pinned here:

1. An explicit no-modify contract ("Do not modify source files") turns
   the delegation into ONE research task — never an implementation
   task, never expectChange.
2. A standalone review with a target and a purpose ("Review this
   project for security problems") is the same shape: inspect and
   report. A bare "review the code please" (no purpose) is still a
   clarification — the `for <purpose>` clause is what makes it an
   objective.
3. Anything carrying a change verb ("fix", "implement", …) stays on
   the implementation path even beside review language.

Run with `python3 -m pytest backend/tests/unit/test_readonly_investigation.py`.
"""

from __future__ import annotations

import asyncio

import pytest

from aura.central_agent.intent import IntentCompiler, heuristic_interpret
from aura.central_agent.planner import expects_change, plan_delegated_work
from aura.executors import agent_delegate_verify


def compile_heuristic(message: str):
    return IntentCompiler(mode="heuristic").compile(message)


class TestReadOnlyRouting:
    @pytest.mark.parametrize("message", [
        "Inspect this project and run the typecheck. Do not modify source files.",
        "Inspect the project and summarize the architecture. Change nothing.",
        "Track down the login bug without changing any files.",
        "Check why the build fails, but never edit anything.",
    ])
    def test_no_modify_contract_delegates_as_read_only(self, message: str) -> None:
        intent = heuristic_interpret(message)
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert intent.needsClarification is False
        assert intent.delegateReadOnly is True
        assert any("Read-only" in c for c in intent.constraints)
        assert "reported" in intent.expectedOutcome.lower()

    @pytest.mark.parametrize("message", [
        "Review this project for security problems.",
        "Review this project for security problems. Do not modify any files.",
        "audit the repo for vulnerabilities",
        "Do a security review of this project.",
    ])
    def test_standalone_review_with_purpose_is_read_only_work(self, message: str) -> None:
        intent = heuristic_interpret(message)
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert intent.needsClarification is False
        assert intent.delegateReadOnly is True

    def test_bare_review_still_asks(self) -> None:
        """The pinned guard: no purpose, no dispatch."""
        intent = heuristic_interpret("review the code please")
        assert intent.requiredCapabilities == []
        assert intent.needsClarification is True
        assert getattr(intent, "delegateReadOnly", None) is None

    @pytest.mark.parametrize("message", [
        "Fix the authentication bug",
        "Implement token refresh in src/auth and have another AI review it",
        "Check the project and fix the login bug",
        "Review this project for security problems and fix the login bug",
    ])
    def test_change_verbs_stay_implementation(self, message: str) -> None:
        intent = heuristic_interpret(message)
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert getattr(intent, "delegateReadOnly", False) is False

    def test_contradiction_honours_the_constraint(self) -> None:
        """'Fix it but change nothing' cannot be satisfied by changing,
        so the safe direction wins: investigate, do not implement."""
        intent = heuristic_interpret("Fix the login bug but do not modify any files.")
        assert getattr(intent, "delegateReadOnly", None) is True


class TestReadOnlyPlan:
    def test_read_only_plans_one_research_task(self) -> None:
        plan = plan_delegated_work(
            compile_heuristic("Review this project for security problems."),
            "ses", "now")
        assert [t.id for t in plan.tasks] == ["investigate"]
        task = plan.tasks[0]
        assert task.workerRole == "research"
        assert task.capabilityId == "agent.delegate"
        assert task.input["role"] == "research"
        assert task.input.get("expectChange") is None
        assert task.reversible is True
        assert plan.acceptance[0].expect["tasks"] == ["investigate"]

    def test_review_plus_fix_still_plans_implement_and_review(self) -> None:
        plan = plan_delegated_work(
            compile_heuristic(
                "Review this project for security problems and fix the login bug"),
            "ses", "now")
        assert [t.id for t in plan.tasks] == ["implement", "review"]
        assert plan.tasks[0].input.get("expectChange") is True

    def test_research_never_requires_an_artifact(self) -> None:
        assert expects_change("research", "always") is False

    def test_zero_change_investigation_verifies(self) -> None:
        """A worker that inspected and changed nothing passes: reporting
        is the artifact, and the Fabric measured no deviation."""
        out = {
            "agent": "OpenCode", "exitCode": 0,
            "scopeCheck": {"supported": True, "allowed": True,
                           "changed": [], "outside": [], "detail": ""},
        }
        inv = {"input": {"task": "Review this project for security problems.",
                         "role": "research"}}
        res = asyncio.run(agent_delegate_verify(inv, {"output": out}))
        assert res["passed"] is True


class TestFixQuestionAsksPrecisely:
    def test_no_false_limitation_claim(self) -> None:
        intent = heuristic_interpret("Which tests should I fix first?")
        assert intent.needsClarification is True
        question = intent.clarificationQuestion or ""
        assert "does not have" not in question
        assert "executor" not in question.lower()

    def test_asks_for_the_target(self) -> None:
        question = (heuristic_interpret("What should I repair?").clarificationQuestion
                    or "")
        assert "which" in question.lower() and "test" in question.lower()
