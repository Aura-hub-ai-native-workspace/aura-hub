"""Worker failure isolation — one worker's success never hides another's
failure, and the verdict follows the objective's required tasks.

Real verifier and real synthesis. Evidence verdicts come from the executor's
own check against a real project file, not a stub."""

from __future__ import annotations

import asyncio

import pytest

from aura.central_agent.verification import VerificationEngine
from aura.contracts.agent import TaskOutcome, VerificationRequirement
from aura.executors import agent_delegate_verify

from test_mission_status_view import _outcome, _plan, _service, _session, _task  # noqa: F401


@pytest.fixture()
def project(tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / "a.txt").write_text("alpha A: the fixture line.\n")
    return tmp_path


def _evidence(project, required_file, stdout):
    inv = {"context": {"cwd": str(project)},
           "input": {"task": "x", "requiredEvidence": [required_file]}}
    return asyncio.run(agent_delegate_verify(inv, {"output": {"stdout": stdout, "exitCode": 0}}))


def _criterion(task_id):
    return VerificationRequirement(kind="evidence-present",
                                   description=f"{task_id} read its file",
                                   expect={"tasks": [task_id]})


def _two_worker_plan(acceptance):
    tA = _task("tA", kind="evidence-present")
    tB = _task("tB", kind="evidence-present")
    tA.description = "Read alpha/a.txt"
    tB.description = "Read alpha/b.txt"
    return _plan(tA, tB, acceptance=acceptance)


def test_valid_evidence_is_kept_and_attributed_while_a_sibling_fails(project, tmp_path):
    """Worker A's evidence is found; worker B's is missing. A stays verified
    for A; B is not verified; the mission is not verified, and says why."""
    svc = _service(tmp_path)
    plan = _two_worker_plan([_criterion("tA"), _criterion("tB")])
    ok = _evidence(project, "alpha/a.txt", "alpha A: the fixture line.")
    missing = _evidence(project, "alpha/b.txt", "Worker B reported nothing about its file.")
    assert ok["passed"] is True and missing["passed"] is False
    out = _outcome(
        TaskOutcome(taskId="tA", state="done", performed=True, verified=True, detail="ok"),
        TaskOutcome(taskId="tB", state="done", performed=True, verified=False,
                    detail=missing["detail"]),
        workers={"tA": {"worker": "claude-code"}, "tB": {"worker": "kilo-code"}},
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.outcome == "failed"
    assert result.failureReason == "objective-unaccepted"
    assert result.verified == ["tA"]                       # A kept, B not verified
    by_id = {t.taskId: t for t in result.tasks}
    assert by_id["tA"].worker == "claude-code" and by_id["tA"].verified is True
    assert by_id["tB"].worker == "kilo-code" and by_id["tB"].verified is False
    assert "Mission not verified." in result.summary
    assert "alpha/b.txt" in result.summary                  # the real reason for B
    assert "Worker checks passed" in result.summary         # A is credited, not hidden


def test_a_required_sibling_that_failed_cannot_be_hidden_by_success(tmp_path):
    svc = _service(tmp_path)
    plan = _two_worker_plan([_criterion("tA"), _criterion("tB")])
    out = _outcome(
        TaskOutcome(taskId="tA", state="done", performed=True, verified=True, detail="ok"),
        TaskOutcome(taskId="tB", state="failed", performed=True, verified=False,
                    detail="The agent exited 2."),
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.outcome == "failed"
    assert "tB" not in result.verified
    assert "The agent exited 2." in result.summary
    assert "Mission not verified." in result.summary


def test_an_optional_failure_is_reported_while_the_required_work_passes(project, tmp_path):
    """Only A is named by the criteria. B is optional: its failure does not
    fail the verified objective, but the answer must say B did not finish."""
    svc = _service(tmp_path)
    plan = _two_worker_plan([_criterion("tA")])
    ok = _evidence(project, "alpha/a.txt", "alpha A: the fixture line.")
    out = _outcome(
        TaskOutcome(taskId="tA", state="done", performed=True, verified=True, detail="ok"),
        TaskOutcome(taskId="tB", state="failed", performed=True, verified=False,
                    detail="The agent exited 2."),
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert ok["passed"] is True
    assert result.objectiveAccepted is True
    assert result.outcome == "completed"
    assert result.summary.startswith("Required steps were verified.")
    assert "Optional step(s) did not complete" in result.summary
    assert "The agent exited 2." in result.summary
    assert result.verified == ["tA"]


def test_a_required_task_with_no_outcome_is_not_verified(tmp_path):
    svc = _service(tmp_path)
    plan = _two_worker_plan([_criterion("tA"), _criterion("tB")])
    out = _outcome(TaskOutcome(taskId="tA", state="done", performed=True, verified=True,
                               detail="ok"))
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.objectiveAccepted is False
    assert result.outcome != "completed"
    assert "tB" not in result.verified


def test_without_criteria_every_task_is_required(tmp_path):
    """Legacy rule preserved: no criteria means a failure anywhere fails the run."""
    assert VerificationEngine.required_task_ids(_plan(_task("tA"), _task("tB"))) is None
    svc = _service(tmp_path)
    plan = _plan(_task("tA"), _task("tB"))
    out = _outcome(
        TaskOutcome(taskId="tA", state="done", performed=True, verified=True, detail="ok"),
        TaskOutcome(taskId="tB", state="failed", performed=True, verified=False,
                    detail="The agent exited 2."),
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.outcome == "failed"


def _model_plan(acceptance):
    """A two-task plan through the real model-proposal path."""
    from aura.central_agent.planner import TaskPlanner
    from test_objective_acceptance import _intent

    step = {"description": "inspect", "capabilityId": "agent.delegate",
            "input": {"task": "inspect"}, "verificationKind": "exit-code",
            "verification": "exit 0"}
    return TaskPlanner(known_capabilities=lambda: {"agent.delegate"}).plan_from_model(
        _intent(), "s", "now",
        {"tasks": [dict(step), dict(step, description="inspect more")],
         "acceptance": acceptance})


def test_model_criteria_cannot_make_a_task_optional_by_omission(tmp_path):
    """Regression: a model proposal whose criteria named only t1 turned t2's
    failure into a 'completed' run. Omission by the model must not make a
    task optional: the failure still fails the run."""
    plan = _model_plan([{"kind": "exit-code", "description": "first step proven",
                         "tasks": ["t1"]}])
    assert VerificationEngine.required_task_ids(plan) is None
    svc = _service(tmp_path)
    out = _outcome(
        TaskOutcome(taskId="t1", state="done", performed=True, verified=True, detail="ok"),
        TaskOutcome(taskId="t2", state="failed", performed=True, verified=False,
                    detail="The agent exited 2."),
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.outcome == "failed"
    assert "Optional step" not in result.summary
    assert "The agent exited 2." in result.summary


def test_model_criteria_that_cover_every_task_are_kept_as_written():
    plan = _model_plan([{"kind": "exit-code", "description": "both proven",
                         "tasks": ["t1", "t2"]}])
    assert len(plan.acceptance) == 1
    assert VerificationEngine.required_task_ids(plan) == {"t1", "t2"}


def test_verified_sibling_is_named_by_worker_not_task_id(tmp_path):
    """Regression from the real desktop run (session agt-849cd404ca94): the
    summary read 'Worker checks passed: delegate-claude: verified (…)'."""
    svc = _service(tmp_path)
    plan = _plan(_task("delegate-claude", kind="evidence-present"),
                 _task("delegate-kilo", kind="evidence-present"),
                 acceptance=[_criterion("delegate-claude"), _criterion("delegate-kilo")])
    plan.tasks[1].description = "inspect alpha/missing.txt and report its contents"
    out = _outcome(
        TaskOutcome(taskId="delegate-claude", state="done", performed=True, verified=True,
                    detail="ok"),
        TaskOutcome(taskId="delegate-kilo", state="done", performed=True, verified=False,
                    detail="Required evidence not found: alpha/missing.txt (not a file in the project)."),
        workers={"delegate-claude": {"worker": "claude-code"},
                 "delegate-kilo": {"worker": "kilo-code"}},
    )
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.summary.startswith("Mission not verified.")
    assert "Worker checks passed: Claude Code: verified" in result.summary
    assert "delegate-claude" not in result.summary
    assert "delegate-kilo" not in result.summary
    assert "alpha/missing.txt" in result.summary
