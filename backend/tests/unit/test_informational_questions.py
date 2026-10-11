"""Informational project questions — answered from real project context.

Before v0.1.21 a question like "Explain the architecture of this
project" was vetoed by the question-word rule and fell through to a
terminal clarification that asked what the user wanted to CHANGE —
the wrong conversation for a question, reported on Windows and Linux
(Issue A). This file pins the fix:

1. An informational question about THIS project routes to a READ-ONLY
   research delegation (the same shape a no-modify review already
   takes): a worker reads the real repository and reports findings.
   It never lands in the mutation-oriented clarification, never
   enters the conversational path, and never plans a change.
2. Effect/change verbs keep their veto: "explain the architecture and
   then refactor it" is implementation work, not a lookup.
3. General-knowledge questions with no project target take neither
   route — the existing behavior holds.
4. A project question framed as "Can you explain …" stops claiming to
   be a capability question about AURA itself; it gets a real
   investigation, not a canned ability line.

Run with `python3 -m pytest backend/tests/unit/test_informational_questions.py`.
"""

from __future__ import annotations

import pytest

from aura.central_agent.intent import (
    IntentCompiler,
    is_capability_question,
    heuristic_interpret,
)
from aura.central_agent.planner import plan_delegated_work


def compile_heuristic(message: str):
    return IntentCompiler(mode="heuristic").compile(message)


class TestInformationalProjectQuestions:
    @pytest.mark.parametrize("message", [
        "Explain the architecture of this project.",
        "Where is authentication implemented?",
        "Explain how this request reaches the backend.",
        "Find the cause of this bug.",
        "Where is the main server entry point defined in this project?",
        "How does the SSE stream reach the frontend in this codebase?",
        "Can you explain this project's directory structure?",
        "What is the deployment model of this application?",
    ])
    def test_informational_question_is_read_only_research(self, message: str) -> None:
        intent = compile_heuristic(message)
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert intent.needsClarification is False
        assert intent.delegateReadOnly is True
        assert "agent.delegate" in [c for c in intent.requiredCapabilities]
        assert any("Read-only" in c for c in intent.constraints), intent.constraints

    @pytest.mark.parametrize("message", [
        "Explain the architecture of this project and then refactor it.",
        "What is the architecture? Then fix the login bug.",
        "Describe the codebase and implement the missing tests.",
    ])
    def test_effect_verbs_keep_their_implementation_route(self, message: str) -> None:
        intent = heuristic_interpret(message)
        # Not read-only: something may change. Not conversational.
        assert getattr(intent, "delegateReadOnly", False) is False
        assert intent.conversational is False

    @pytest.mark.parametrize("message", [
        "Explain the theory of relativity.",
        "Where is the Eiffel Tower?",
        "What is the capital of France?",
    ])
    def test_general_knowledge_never_dispatches_a_worker(self, message: str) -> None:
        intent = compile_heuristic(message)
        assert intent.requiredCapabilities == []
        assert not (intent.requiredCapabilities == ["agent.delegate"])

    def test_capability_frame_no_longer_wins_for_project_questions(self) -> None:
        assert is_capability_question(
            "Can you explain this project's directory structure?") is False
        # Genuine ability questions about AURA keep their canned answer.
        assert is_capability_question("Can you use the connected nodes?") is True

    def test_informational_plan_is_one_research_task_with_no_change(self) -> None:
        intent = compile_heuristic("Explain the architecture of this project.")
        plan = plan_delegated_work(intent, "sess-info", "now")
        assert len(plan.tasks) == 1
        task = plan.tasks[0]
        assert task.capabilityId == "agent.delegate"
        assert task.workerRole == "research"
        # A lookup verifies by reporting, not by changing anything.
        input_block = task.input
        assert input_block.get("expectChange") in (False, None)
        assert any("read-only" in (c or "").lower()
                   for c in (intent.constraints or []))
