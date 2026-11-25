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


def test_denied_worker_with_successful_sibling_is_reported_as_mixed(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"))
    denied = TaskOutcome(taskId="t1", state="denied", performed=False,
                         verified=None, detail="policy refused")
    result = svc._synthesize(_session(tmp_path), plan,
                             _outcome(denied, _done("t2")))
    states = {task.taskId: task for task in result.tasks}
    assert result.outcome == "failed"
    assert result.status == "failed"
    assert result.failureReason == "mixed-outcomes"
    assert states["t1"].state == "denied"
    assert states["t2"].state == "done" and states["t2"].verified is True
    assert result.verified == ["t2"]
    assert result.summary.startswith("Mission partially completed.")


def test_capability_unavailability_is_a_blocked_mission_with_candidate_detail(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("tool"), _task("independent"))
    blocked = TaskOutcome(
        taskId="tool", state="blocked", performed=False,
        detail=("Capability unavailable: git.diff: no connected provider. "
                "Rejected: provider-x (billing: owner has not allowed it)."))
    result = svc._synthesize(_session(tmp_path), plan,
                             _outcome(blocked, _done("independent")))

    assert (result.status, result.outcome, result.failureReason) == (
        "failed", "blocked", "capability-unavailable")
    assert {task.taskId: task.state for task in result.tasks} == {
        "tool": "blocked", "independent": "done"}
    assert "Capability unavailable" in result.summary
    assert "provider-x (billing" in result.summary
    assert result.verified == ["independent"]


def test_policy_denial_plus_unavailability_and_success_stays_mixed(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("denied"), _task("missing"), _task("independent"))
    denial = TaskOutcome(taskId="denied", state="denied", performed=False,
                         detail="Policy denied database access")
    missing = TaskOutcome(taskId="missing", state="blocked", performed=False,
                          detail="Capability unavailable: no connected provider")
    result = svc._synthesize(_session(tmp_path), plan,
                             _outcome(denial, missing, _done("independent")))

    assert (result.status, result.outcome, result.failureReason) == (
        "failed", "failed", "mixed-outcomes")
    assert {task.taskId: task.state for task in result.tasks} == {
        "denied": "denied", "missing": "blocked", "independent": "done"}
    assert result.summary.startswith("Mission partially completed.")
    assert "Policy denied database access" in result.summary
    assert "Capability unavailable" in result.summary
    assert result.verified == ["independent"]


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


def test_answer_contains_every_verified_worker_output(tmp_path):
    """Regression: the answer used to take only the first verified worker's
    stdout, so a two-worker answer dropped the second worker's findings."""
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"))
    out = _outcome(_done("t1"), _done("t2"),
                   workers={"t1": {"worker": "claude-code"},
                            "t2": {"worker": "kilo-code"}})
    out.verified_outputs["t1"] = {"stdout": "Finding from Claude A"}
    out.verified_outputs["t2"] = {"stdout": "Finding from Kilo B"}
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.outcome == "completed"
    assert "Claude Code:" in result.summary and "Finding from Claude A" in result.summary
    assert "Kilo Code:" in result.summary and "Finding from Kilo B" in result.summary


def test_one_evidenced_worker_does_not_verify_an_unevidenced_one(tmp_path):
    """Mission-level: worker A's evidence is found, worker B's is not. The
    mission must not read as verified, and the unmet criterion names B."""
    from aura.contracts.agent import TaskOutcome, VerificationRequirement

    svc = _service(tmp_path)
    plan = _plan(_task("tA", kind="evidence-present"),
                 _task("tB", kind="evidence-present"), acceptance=[
        VerificationRequirement(kind="evidence-present", description="A read a.txt",
                                expect={"tasks": ["tA"]}),
        VerificationRequirement(kind="evidence-present", description="B read b.txt",
                                expect={"tasks": ["tB"]}),
    ])
    out = _outcome(_done("tA"),
                   TaskOutcome(taskId="tB", state="done", performed=True,
                               verified=False, detail="no evidence"))
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.objectiveAccepted is False
    assert any("B read b.txt" in u for u in result.unmetAcceptance)
    assert not any("A read a.txt" in u for u in result.unmetAcceptance)
    kinds = {t.taskId: t.verification for t in result.tasks}
    assert kinds == {"tA": "evidence-present", "tB": "evidence-present"}


def test_negative_summary_names_the_practical_reason_not_the_criterion(tmp_path):
    """A missing-file failure says what to fix. The planner's criterion
    wording and the internal task id do not reach the ordinary summary."""
    from aura.contracts.agent import TaskOutcome, VerificationRequirement

    svc = _service(tmp_path)
    plan = _plan(_task("implement", kind="evidence-present"), acceptance=[
        VerificationRequirement(kind="evidence-present",
                                description="The requested work was carried out and verified.",
                                expect={"tasks": ["implement"]})])
    plan.tasks[0].description = "Read the requested file and report its contents"
    out = _outcome(TaskOutcome(
        taskId="implement", state="done", performed=True, verified=False,
        detail="Required evidence not found: alpha/missing.txt (its content was not in the worker's output)."))
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert result.failureReason == "objective-unaccepted"
    assert "Mission not verified." in result.summary
    assert "alpha/missing.txt" in result.summary
    assert "requested work was carried out" not in result.summary.lower()
    assert "unverified tasks" not in result.summary
    assert "implement" not in result.summary          # internal task id
    assert result.unmetAcceptance  # diagnostics keep the raw criterion


def test_multi_worker_answer_is_clean_and_keeps_every_finding(tmp_path):
    """Chrome from each worker is removed; both findings and attribution stay."""
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"))
    out = _outcome(_done("t1"), _done("t2"),
                   workers={"t1": {"worker": "claude-code"},
                            "t2": {"worker": "kilo-code"}})
    out.verified_outputs["t1"] = {"stdout": "FINDINGS\nalpha A: the fixture line."}
    out.verified_outputs["t2"] = {"stdout": (
        "[0m\n> code · nvidia/nemotron-3-ultra-550b-a55b:free\n[0m\n"
        "[0m→ [0mRead alpha/b.txt\n## FINDINGS\nalpha B: the other fixture line.")}
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert "alpha A: the fixture line." in result.summary
    assert "alpha B: the other fixture line." in result.summary
    assert "nemotron" not in result.summary
    assert "→" not in result.summary and "[0m" not in result.summary
    assert "Kilo Code:" in result.summary


def test_chrome_only_worker_output_is_not_presented_as_an_answer(tmp_path):
    svc = _service(tmp_path)
    plan = _plan(_task("t1"), _task("t2"))
    out = _outcome(_done("t1"), _done("t2"))
    out.verified_outputs["t1"] = {"stdout": "Real finding here."}
    out.verified_outputs["t2"] = {"stdout": "[0m\n> code · model:x\n[0m→ [0mRead a.txt\n"}
    result = svc._synthesize(_session(tmp_path), plan, out)
    assert "Real finding here." in result.summary
    assert "model:x" not in result.summary


class TestBlockedReasonClassification:
    """``CentralAgent._blocked_reason`` — one classifier for both
    synthesis paths, so a mission's blocked label cannot drift between them."""

    @staticmethod
    def _row(state, detail=""):
        return TaskOutcome(taskId=f"t-{state}-{detail}", state=state,
                           detail=detail)

    def test_specific_blocked_reasons(self):
        from aura.central_agent.service import CentralAgent as S
        assert S._blocked_reason([
            self._row("done"),
            self._row("blocked", "Capability unavailable: git status"),
            self._row("blocked", "Tool blocked: gh")]) == "capability-unavailable"
        assert S._blocked_reason([
            self._row("blocked", "Tool blocked: gh")]) == "tool-blocked"
        assert S._blocked_reason([
            self._row("blocked", "waiting on t1")]) == "task-blocked"

    @pytest.mark.parametrize("state", ["failed", "timed-out", "cancelled", "denied"])
    def test_harder_outcomes_take_precedence_over_blocked(self, state):
        from aura.central_agent.service import CentralAgent as S
        assert S._blocked_reason([
            self._row("blocked", "Capability unavailable: x"),
            self._row(state)]) is None

    def test_nothing_blocked(self):
        from aura.central_agent.service import CentralAgent as S
        assert S._blocked_reason([self._row("done")]) is None
        assert S._blocked_reason([]) is None
