"""Mission status view — what the workspace shows for a finished run.

The synthesized result must say what was understood, whether the mission
acceptance criteria were met, and each planned task's final state, with
the worker that ran it. These are display fields: they are read from the
plan, the recorded outcomes and the verification report, never invented.
"""

from __future__ import annotations

import pytest

from aura.central_agent.execution import ExecutionOutcome
from aura.contracts.agent import TaskOutcome, VerificationRequirement

from test_objective_acceptance import (  # noqa: F401  (shared helpers)
    TestSynthesisHonesty,
    _done,
    _plan,
    _task,
)


def _service(tmp_path):
    return TestSynthesisHonesty()._service()


def _session(tmp_path):
    from aura.central_agent.session import AgentSessionStore

    return AgentSessionStore(tmp_path).create(None)


def _outcome(*outs, workers=None):
    out = ExecutionOutcome()
    out.outcomes.extend(outs)
    out.worker_assignments.update(workers or {})
    return out


def test_completed_run_reports_each_task_and_met_criteria(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"), acceptance=[
        VerificationRequirement(kind="exit-code", description="both ran",
                                expect={"tasks": ["t1", "t2"]})])
    out = _outcome(_done("t1"), _done("t2"),
                   workers={"t1": {"worker": "claude-code"},
                            "t2": {"worker": "kilo-code"}})
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.understanding == "g"
    assert result.objectiveAccepted is True
    assert result.unmetAcceptance == []
    states = {t.taskId: t for t in result.tasks}
    assert states["t1"].state == "done" and states["t1"].verified is True
    assert states["t1"].worker == "claude-code"
    assert states["t2"].worker == "kilo-code"
    assert states["t1"].description == "task t1"


def test_unmet_criteria_are_named_not_hidden(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1", kind="audit-only"), acceptance=[
        VerificationRequirement(kind="read-back", description="file proves it",
                                expect={"tasks": ["t1"]})])
    result = svc._synthesize(_session(tmp_path), plan,
                             _outcome(_done("t1")))
    assert result.outcome == "failed"
    assert result.objectiveAccepted is False
    assert result.unmetAcceptance and "file proves it" in result.unmetAcceptance[0]
    # The worker still shows as done: worker completion is not mission success.
    assert result.tasks[0].state == "done"


def test_partial_failure_shows_failed_and_not_started_tasks(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2", ))
    failed = TaskOutcome(taskId="t1", state="failed", performed=True,
                         verified=False, detail="exit 1")
    out = _outcome(failed, workers={"t1": {"worker": "claude-code"}})
    result = svc._synthesize(_session(tmp_path), plan, out)
    states = {t.taskId: t.state for t in result.tasks}
    assert states == {"t1": "failed", "t2": "pending"}
    assert result.outcome == "failed"
    assert result.failureReason == "task-failed"
    assert "t1" not in result.verified


def test_denied_worker_is_reported_as_denied_not_completed(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"))
    denied = TaskOutcome(taskId="t1", state="denied", performed=False,
                         verified=None, detail="policy refused")
    result = svc._synthesize(_session(tmp_path), plan,
                             _outcome(denied, _done("t2")))
    assert result.outcome == "denied"
    assert result.failureReason == "action-denied"


def test_no_criteria_means_no_mission_verdict(tmp_path):
    svc = _service(tmp_path)
    result = svc._synthesize(_session(tmp_path), _plan(_task("t1")),
                             _outcome(_done("t1")))
    assert result.objectiveAccepted is None
    assert result.unmetAcceptance == []


@pytest.mark.parametrize("field", ["understanding", "objectiveAccepted", "tasks"])
def test_new_fields_have_safe_defaults_for_old_results(field):
    from aura.contracts.agent import AgentResult

    legacy = AgentResult(status="completed", outcome="completed", summary="ok")
    assert getattr(legacy, field) in (None, [])
