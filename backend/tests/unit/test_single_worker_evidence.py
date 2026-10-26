"""Single-worker read-only inspection must show it read the named file.

A read-only request that names a file binds evidence-present verification.
A request that asks for a change, or names no file, keeps the existing path.
The classifier is conservative: a write verb always wins.
"""

from __future__ import annotations

from aura.central_agent.intent import heuristic_interpret
from aura.central_agent.planner import _read_only_evidence, plan_delegated_work


def _plan(message):
    return plan_delegated_work(heuristic_interpret(message), "ses", "now")


def test_read_only_request_naming_a_file_requires_evidence():
    plan = _plan("Claude Code, inspect alpha/a.txt and report its contents.")
    task = plan.tasks[0]
    assert task.verification.kind == "evidence-present"
    assert task.input["requiredEvidence"] == ["alpha/a.txt"]
    assert plan.acceptance[0].kind == "evidence-present"
    assert plan.acceptance[0].expect == {"tasks": ["implement"]}


def test_a_change_request_keeps_the_change_verification():
    plan = _plan("fix the typo in alpha/a.txt")
    task = plan.tasks[0]
    assert task.verification.kind == "exit-code"
    assert "requiredEvidence" not in task.input
    assert task.workerRole == "code"


def test_a_write_verb_overrides_a_read_only_signal():
    """'inspect ... and fix' is a change: never classified as read-only."""
    assert _read_only_evidence("inspect alpha/a.txt and fix it") == []
    assert _read_only_evidence("inspect and then rewrite alpha/a.txt") == []


def test_read_only_without_a_named_file_keeps_the_existing_path():
    assert _read_only_evidence("inspect the backend architecture") == []
    plan = _plan("inspect the backend architecture")
    assert plan.tasks[0].verification.kind == "exit-code"


def test_named_file_without_a_read_only_signal_is_not_inspection():
    assert _read_only_evidence("alpha/a.txt is in the project") == []
