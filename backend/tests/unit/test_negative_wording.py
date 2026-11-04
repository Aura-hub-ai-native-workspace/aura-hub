"""Negative-path wording — the person reads the real reason, never the
generic "ran, but the check did not confirm it" text, and never a success.

The chain under test is the production one: the executor's own verdict
(agent_delegate_verify, against a real project directory) feeds the task
outcome detail (ExecutionController._outcome_detail), which feeds the mission
summary (CentralAgent._synthesize)."""

from __future__ import annotations

import asyncio

import pytest

from aura.central_agent.execution import ExecutionController
from aura.executors import agent_delegate_verify

from test_mission_status_view import _outcome, _plan, _service, _session, _task  # noqa: F401
from aura.contracts.agent import TaskOutcome, VerificationRequirement


@pytest.fixture()
def project(tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / "a.txt").write_text("alpha A: the fixture line.\n")
    return tmp_path


def _verdict(project, required, stdout, exit_code=0):
    inv = {"context": {"cwd": str(project)},
           "input": {"task": "inspect", "requiredEvidence": required}}
    return asyncio.run(agent_delegate_verify(
        inv, {"output": {"stdout": stdout, "exitCode": exit_code}}))


def _invocation(verdict, combined="Claude Code ran, but the check did not confirm it. " ):
    """An invocation record shaped as the fabric writes it."""
    return {"invocationId": "inv-1", "detail": combined + verdict.get("detail", ""),
            "verification": verdict}


def _summary(tmp_path, detail, verified=False):
    svc = _service(tmp_path)
    plan = _plan(_task("implement", kind="evidence-present"), acceptance=[
        VerificationRequirement(kind="evidence-present", description="The requested work was carried out and verified.",
                                expect={"tasks": ["implement"]})])
    plan.tasks[0].description = "Inspect the requested files and report their contents"
    out = _outcome(TaskOutcome(taskId="implement", state="done", performed=True,
                               verified=verified, detail=detail))
    return svc._synthesize(_session(tmp_path), plan, out)


def test_missing_file_reads_the_real_reason_not_the_generic_one(project, tmp_path):
    verdict = _verdict(project, ["alpha/missing.txt"], stdout="Claude Code ran.")
    assert verdict["passed"] is False
    detail = ExecutionController._outcome_detail(_invocation(verdict), False)
    assert detail.startswith("Required evidence not found: alpha/missing.txt")
    result = _summary(tmp_path, detail)
    assert "Mission not verified." in result.summary
    assert "alpha/missing.txt" in result.summary
    assert "ran, but the check did not confirm it" not in result.summary
    assert "carried out" not in result.summary.lower()


def test_missing_evidence_in_output_names_the_file(project, tmp_path):
    verdict = _verdict(project, ["alpha/a.txt"], stdout="No content shown here.")
    detail = ExecutionController._outcome_detail(_invocation(verdict), False)
    result = _summary(tmp_path, detail)
    assert "not in the worker's output" in result.summary or "alpha/a.txt" in result.summary
    assert "ran, but the check" not in result.summary


def test_worker_execution_failure_is_reported_as_failure_not_success(project, tmp_path):
    verdict = _verdict(project, ["alpha/a.txt"], stdout="", exit_code=2)
    detail = ExecutionController._outcome_detail(_invocation(verdict), False)
    result = _summary(tmp_path, detail)
    assert "The agent exited 2." in result.summary
    assert "Mission not verified." in result.summary
    assert "ran, but the check" not in result.summary


def test_unknown_reason_falls_back_to_an_honest_sentence(tmp_path):
    result = _summary(tmp_path, detail="")
    assert "could not be confirmed" in result.summary
    assert "Mission not verified." in result.summary


def test_verified_outcome_keeps_the_invocation_text(project):
    verdict = _verdict(project, ["alpha/a.txt"], stdout="alpha A: the fixture line.")
    inv = _invocation(verdict, combined="Claude Code completed. ")
    assert ExecutionController._outcome_detail(inv, True) == inv["detail"]
    assert ExecutionController._outcome_detail(inv, None) == inv["detail"]


def test_failed_check_without_its_own_detail_keeps_the_invocation_text():
    inv = {"invocationId": "x", "detail": "Claude Code completed. ", "verification": {}}
    assert ExecutionController._outcome_detail(inv, False) == "Claude Code completed. "
