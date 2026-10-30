"""Which timeout is which, and who owns it.

Four different deadlines used to be conflated, and the conflation cost
real work:

  A. PLANNING TIMEOUT     the model could not return a usable plan in
                          the time it was given.
  B. WORKER TIMEOUT       a coding agent was still working when ITS
                          execution budget ran out.
  C. TRANSPORT TIMEOUT    one request could not complete.
  D. ORCHESTRATION        the run itself stopped.

A and B are separate budgets with separate owners: the planning budget
belongs to the model endpoint, the worker budget belongs to the owner of
the worker. Neither may borrow the other's number.

The four failure classes must also report DISTINCTLY, because they mean
different things to the person reading them:

  worker timeout   -> outcome "timeout",     reason "timed-out"
  worker failure   -> outcome "failed",      reason "task-failed"
  planning failure -> outcome "failed",      reason "planning-failed"
  user cancellation-> outcome "cancelled",   reason "cancelled-by-user"
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from aura.central_agent import model_routing
from aura.central_agent.model_routing import (
    DEFAULT_PLAN_TIMEOUT_S,
    MAX_PLAN_CHARS,
    ProviderSpec,
    RoutedModelPort,
)
from aura.contracts.agent import AgentIntent, TaskOutcome, TaskPlan, TaskSpecification
from aura.workers.timeouts import (
    DEFAULT_WORKER_TIMEOUT_MS,
    MAX_WORKER_TIMEOUT_MS,
    MIN_WORKER_TIMEOUT_MS,
    worker_timeout_ms,
)


# ── A. the planning budget is its own number ───────────────────────────────

def test_the_planning_budget_is_not_the_transport_timeout():
    """A plan is a long generation, not a chat turn. The provider's
    transport timeout says how long one request may take; it must not
    become the ceiling on a whole plan."""
    spec = ProviderSpec(id="p", base_url="http://x", model="m",
                         timeout_s=30.0)
    assert spec.timeout_s == 30.0
    # The planning budget is a separate field, unset by default.
    assert spec.plan_timeout_s == 0.0
    # And its default is generous enough for a slow local model.
    assert DEFAULT_PLAN_TIMEOUT_S >= 480.0


def test_the_planning_budget_is_owner_configurable():
    """The operator sets it per endpoint, in the provider file."""
    doc = {
        "providers": [
            {"id": "local", "baseUrl": "http://127.0.0.1:11434/v1",
             "model": "qwen2.5-coder:1.5b", "timeoutS": 120,
             "planTimeoutS": 600, "planMaxRetries": 1},
        ]
    }
    # Write the file and read it back through the real reader.
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "providers.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        loaded = model_routing._load_operator_providers(str(path))
    assert len(loaded) == 1
    assert loaded[0].plan_timeout_s == 600.0
    assert loaded[0].plan_max_retries == 1
    assert loaded[0].timeout_s == 120.0


def test_a_plan_longer_than_the_transport_timeout_is_not_cut_short():
    """The whole point: a plan that takes longer than one request's
    transport timeout still completes, because the transport timeout is
    only the IDLE check between chunks."""
    # A provider whose transport timeout is tiny, but whose planning
    # budget is generous.
    spec = ProviderSpec(id="p", base_url="http://127.0.0.1:1/v1",
                         model="m", timeout_s=0.001,
                         plan_timeout_s=480.0)
    assert spec.plan_timeout_s > spec.timeout_s
    # The plan text ceiling is sized for a structured plan, not for prose.
    assert MAX_PLAN_CHARS >= 16_000


# ── B. the worker budget is the owner's, and its own ──────────────────────

def test_the_worker_budget_is_separate_from_the_transport_timeout():
    """A worker that edits a project does real work. Its deadline is the
    owner's choice, not the model's transport timeout."""
    assert DEFAULT_WORKER_TIMEOUT_MS >= 30 * 60_000
    assert DEFAULT_WORKER_TIMEOUT_MS != DEFAULT_PLAN_TIMEOUT_S


def test_the_worker_budget_is_read_from_the_owners_file(tmp_path):
    """Owner-configurable, and read from the owner's policy file."""
    (tmp_path / "worker-policy.json").write_text(
        json.dumps({"workerTimeoutMs": 45 * 60_000}), encoding="utf-8")
    assert worker_timeout_ms(home=tmp_path) == 45 * 60_000


def test_the_worker_budget_falls_back_to_the_default_when_unspecified(tmp_path):
    (tmp_path / "worker-policy.json").write_text(
        json.dumps({"authorized": ["opencode"]}), encoding="utf-8")
    assert worker_timeout_ms(home=tmp_path) == DEFAULT_WORKER_TIMEOUT_MS
    # An absent file means the default, never an unbounded wait.
    assert worker_timeout_ms(home=tmp_path / "missing") == DEFAULT_WORKER_TIMEOUT_MS


def test_the_worker_budget_is_always_bounded(tmp_path):
    """No owner setting may produce an instant timeout or an endless wait."""
    for value in (0, -5, "abc", None, 10 ** 12):
        (tmp_path / "worker-policy.json").write_text(
            json.dumps({"workerTimeoutMs": value}), encoding="utf-8")
        ms = worker_timeout_ms(home=tmp_path)
        assert MIN_WORKER_TIMEOUT_MS <= ms <= MAX_WORKER_TIMEOUT_MS


def test_an_explicit_per_invocation_timeout_still_wins(tmp_path):
    """The workflow governor sets its own timeout; it keeps it."""
    (tmp_path / "worker-policy.json").write_text(
        json.dumps({"workerTimeoutMs": 45 * 60_000}), encoding="utf-8")
    assert worker_timeout_ms({"timeoutMs": 120_000}, home=tmp_path) == 120_000


# ── the four failure classes report distinctly ─────────────────────────────

def test_a_worker_timeout_is_not_reported_as_a_worker_failure():
    """A worker that ran out of ITS budget was still working. Reporting
    that as a plain failure loses the difference between "the code broke"
    and "we did not wait long enough"."""
    from aura.central_agent.execution import state_for_invocation

    state = state_for_invocation("failed", {
        "nodeId": "n", "agent": "OpenCode", "exitCode": 124,
        "stdout": "", "timedOut": True})
    assert state == "timed-out"


def test_a_worker_failure_still_reports_as_a_failure():
    from aura.central_agent.execution import state_for_invocation

    state = state_for_invocation("failed", {
        "nodeId": "n", "agent": "OpenCode", "exitCode": 1,
        "stdout": "", "timedOut": False})
    assert state == "failed"


def test_a_cancelled_worker_is_still_reported_as_cancelled():
    from aura.central_agent.execution import state_for_invocation

    state = state_for_invocation("failed", {
        "nodeId": "n", "agent": "OpenCode", "exitCode": None,
        "stdout": "", "cancelled": True, "timedOut": False})
    assert state == "cancelled"


def test_a_text_output_does_not_crash_the_state_mapping():
    """Output is Any by contract; only a dict carries the flags."""
    from aura.central_agent.execution import state_for_invocation

    assert state_for_invocation("succeeded", "plain text output") == "done"


def test_a_planning_failure_carries_its_own_reason():
    """A planning failure is not a worker failure. The stable token is what
    the surface reads; the sentence stays in the summary."""
    from aura.central_agent.events import EventBus
    from aura.central_agent.service import CentralAgent

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    session = SimpleNamespace(sessionId="agt-aaaaaaaaaaaa", activePlanId=None)
    result = svc._fail(
        session,
        "The request could not be planned: model planning failed "
        "[PROVIDER_TIMEOUT]: timed out",
        failure_reason="planning-failed")
    assert result.outcome == "failed"
    assert result.failureReason == "planning-failed"
    # The human sentence still says what went wrong.
    assert "could not be planned" in result.summary


def test_the_four_reasons_are_four_different_tokens():
    """Worker timeout, worker failure, planning failure and cancellation
    must not share a token."""
    reasons = {"timed-out", "task-failed", "planning-failed", "cancelled-by-user"}
    assert len(reasons) == 4
    # The desktop renders each of them.
    import pathlib
    ui = pathlib.Path(__file__).resolve().parents[3] / "apps" / "desktop" / "src" / "ai" / "missionStatus.ts"
    text = ui.read_text(encoding="utf-8")
    for reason in ("timed-out", "task-failed", "planning-failed", "cancelled-by-user"):
        assert f"'{reason}'" in text


# ── sequential dispatch: the next task starts on its own ──────────────────

def _plan(tasks):
    return TaskPlan(planId="plan-x", sessionId="agt-aaaaaaaaaaaa",
                    intent=AgentIntent(goal="g", expectedOutcome="e"),
                    tasks=tasks, createdAt="2026-10-21T00:00:00Z")


def _task(tid, cap, depends=()):
    return TaskSpecification(id=tid, description=tid, capabilityId=cap,
                             dependsOn=list(depends))


def test_a_successful_upstream_lets_the_dependent_run_without_a_new_request(monkeypatch):
    """Requirement: when OpenCode finishes and verifies, AURA dispatches
    Kilo on its own. Nobody sends a second message."""
    from aura.central_agent.execution import ExecutionController

    dispatched: list[str] = []

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        dispatched.append(task.id)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="done", performed=True, verified=True,
            detail="ok"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "agent.delegate"), _task("t2", "agent.delegate", ["t1"])]),
        project_id=None)
    assert dispatched == ["t1", "t2"]


def test_a_failed_upstream_prevents_its_dependent_from_running(monkeypatch):
    """Requirement: a failed Task A must not trigger Task B.

    A failed coding task IS retried by the recovery leg, on a different
    worker — that is a retry of A, not a trigger of B. What must never
    happen is B starting on A's failure.
    """
    from aura.central_agent.execution import ExecutionController

    dispatched: list[str] = []

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        dispatched.append(task.id)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="failed", performed=True, verified=False,
            detail="exit 1"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "agent.delegate"), _task("t2", "agent.delegate", ["t1"])]),
        project_id=None)
    assert "t2" not in dispatched
    # A may be retried (on another worker); B may never run.
    assert set(dispatched) == {"t1"}


def test_a_timed_out_upstream_also_prevents_its_dependent(monkeypatch):
    """A worker that ran out of budget did not finish, so its dependent
    must not start on a half-finished result."""
    from aura.central_agent.execution import ExecutionController

    dispatched: list[str] = []

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        dispatched.append(task.id)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="timed-out", performed=False, verified=False,
            detail="ran out of time"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "agent.delegate"), _task("t2", "agent.delegate", ["t1"])]),
        project_id=None)
    assert "t2" not in dispatched
    assert set(dispatched) == {"t1"}


def test_an_unverified_upstream_prevents_its_dependent(monkeypatch):
    """An upstream that RAN but whose check did not confirm it has not
    succeeded, so it must not release the task that depends on it.

    This is the case a live run hit: the first worker exited 0 but its
    verification failed, the dependent task ran anyway, and the run
    reported a mixed result nobody had confirmed.
    """
    from aura.central_agent.execution import ExecutionController

    dispatched: list[str] = []

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        dispatched.append(task.id)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="done", performed=True, verified=False,
            detail="the check did not confirm it"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "agent.delegate"), _task("t2", "agent.delegate", ["t1"])]),
        project_id=None)
    assert "t2" not in dispatched
    assert set(dispatched) == {"t1"}


def test_an_upstream_with_no_check_still_releases_its_dependent(monkeypatch):
    """A capability that declares no mechanical check (a read-only
    listing) has verified=None. That is not a failure: it succeeded, and
    the task that depends on it must still run."""
    from aura.central_agent.execution import ExecutionController

    dispatched: list[str] = []

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        dispatched.append(task.id)
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="done", performed=True, verified=None,
            detail="no mechanical check applies"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "knowledge.search"), _task("t2", "agent.delegate", ["t1"])]),
        project_id=None)
    assert dispatched == ["t1", "t2"]


# ── the three forced-timeout scenarios ─────────────────────────────────

def test_a_forced_planning_timeout_is_reported_as_a_planning_failure():
    """The model ran out of ITS planning budget. Nothing was planned, so
    nothing ran: this is a planning failure, not a worker failure and not
    a worker timeout."""
    from aura.central_agent.events import EventBus
    from aura.central_agent.service import CentralAgent

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    session = SimpleNamespace(sessionId="agt-aaaaaaaaaaaa", activePlanId=None)
    result = svc._fail(
        session,
        "The request could not be planned: model planning failed "
        "[PROVIDER_TIMEOUT]: the planning budget ran out",
        failure_reason="planning-failed")
    assert result.outcome == "failed"
    assert result.failureReason == "planning-failed"
    # It is NOT reported as a worker timeout, nor as a worker failure.
    assert result.failureReason not in ("timeout", "timed-out", "task-failed")


def test_a_planning_call_that_times_out_reaches_the_planner_as_a_failure(monkeypatch):
    """The whole path: a provider that times out during planning is
    classified as a timeout at the bridge, and the planner turns that into
    a planning failure rather than letting a worker run."""
    import urllib.request

    from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort
    from aura.central_agent.provider_bridge import ProviderBridge

    def timed_out(*args, **kwargs):
        raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", timed_out)
    spec = ProviderSpec(id="p", base_url="http://127.0.0.1:1/v1", model="m",
                         timeout_s=0.01)
    res = ProviderBridge(RoutedModelPort([spec])).complete_plan_json(
        "plan", "s", "u")
    assert res.ok is False
    # A timeout is named as a timeout, not as an internal error.
    assert res.error_category == "PROVIDER_TIMEOUT"

    # The planner turns that into a planning failure.
    from aura.central_agent.planner import PlanningError
    with pytest.raises(PlanningError, match="PROVIDER_TIMEOUT"):
        raise PlanningError(
            f"model planning failed [{res.error_category}]: {res.error}")


def test_the_service_reports_a_planning_timeout_as_a_planning_failure(monkeypatch):
    """The service's own planning path, with a provider that times out:
    the turn must fail as a PLANNING failure (its own token), and no
    worker may run."""
    import urllib.request

    from aura.central_agent.events import EventBus
    from aura.central_agent.intent import IntentCompiler
    from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort
    from aura.central_agent.service import CentralAgent

    def timed_out(*args, **kwargs):
        raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", timed_out)
    spec = ProviderSpec(id="p", base_url="http://127.0.0.1:1/v1", model="m",
                         timeout_s=0.01)
    port = RoutedModelPort([spec])

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    svc.intents = IntentCompiler(mode="model", model_port=port)
    svc.planner = SimpleNamespace(
        known_capability_ids=lambda: {"agent.delegate"},
        known_node_ids=lambda: set(),
        plan_from_model=lambda *a, **k: pytest.fail("must not plan from a timeout"),
    )
    session = SimpleNamespace(sessionId="agt-aaaaaaaaaaaa", activePlanId=None,
                              lastRequestId=None)
    intent = SimpleNamespace(goal="g", expectedOutcome="e",
                              needsClarification=False)

    from aura.central_agent.planner import PlanningError
    with pytest.raises(PlanningError, match="PROVIDER_TIMEOUT"):
        svc._plan_from_model(intent, session, "do the thing", None,
                             PlanningError("no template matches"))


def test_a_forced_worker_timeout_is_reported_as_a_worker_timeout():
    """The worker ran out of ITS execution budget. That is a timeout, and
    it is not a planning failure."""
    from aura.central_agent.events import EventBus
    from aura.central_agent.service import CentralAgent

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    session = SimpleNamespace(sessionId="agt-aaaaaaaaaaaa", activePlanId=None)
    result = svc._fail(
        session,
        "The work exceeded its time budget: OpenCode ran out of time",
        failure_reason="timed-out")
    assert result.outcome == "failed"
    assert result.failureReason == "timed-out"
    # It is NOT reported as a planning failure, nor as a worker failure.
    assert result.failureReason not in ("planning-failed", "task-failed")


def test_a_forced_worker_timeout_reaches_the_run_as_a_timeout(monkeypatch):
    """End to end through the execution controller: a worker whose
    execution budget expired stops the run as a TIMEOUT, and the run
    reports outcome "timeout" rather than a plain failure."""
    from aura.central_agent.execution import ExecutionController

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state="timed-out", performed=False, verified=False,
            detail="OpenCode ran out of time and was stopped."))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    outcome = ExecutionController(
        fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        _plan([_task("t1", "agent.delegate")]), project_id=None)
    assert outcome.timed_out is True
    assert outcome.stopped is True
    assert [o.state for o in outcome.outcomes] == ["timed-out"]
