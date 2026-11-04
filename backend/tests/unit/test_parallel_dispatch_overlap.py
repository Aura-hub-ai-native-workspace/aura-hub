"""Parallel dispatch — deterministic overlap harness.

Worker invocation is replaced by a fake that sleeps and records its own
start/end wall-clock times, so overlap is measured from real thread timing
rather than from UI state or worker-card counts. Everything else in the
controller (plan gating, dispatch, merge) is the real code path.
"""

from __future__ import annotations

import sys
import threading
import time
from types import SimpleNamespace

import pytest

from aura.central_agent import execution as execution_mod
from aura.central_agent.execution import ExecutionController
from aura.contracts.agent import AgentIntent, TaskOutcome, TaskPlan, TaskSpecification

WORK_SECONDS = 0.4


def _task(tid, depends=(), cap="git.status"):
    """Wave mechanics are exercised with READ-ONLY tasks: those may share a
    wave. Project-mutating tasks (a coding worker, a file write…) never do —
    see test_one_mutating_task_at_a_time.py."""
    return TaskSpecification(
        id=tid, description=f"work {tid}", capabilityId=cap,
        dependsOn=list(depends),
    )


def _plan(tasks):
    return TaskPlan(
        planId="plan-overlap", sessionId="agt-aaaaaaaaaaaa",
        intent=AgentIntent(goal="g", expectedOutcome="e"),
        tasks=tasks, createdAt="2026-10-18T00:00:00Z",
    )


@pytest.fixture()
def timing(monkeypatch):
    spans: dict[str, tuple[float, float]] = {}
    lock = threading.Lock()
    # task id -> terminal state the fake worker reports; default "done".
    monkeypatch.setattr(sys.modules[__name__], "STATES", {}, raising=False)
    # task id -> changed_paths the fake worker reports as its own evidence.
    monkeypatch.setattr(sys.modules[__name__], "PATHS", {}, raising=False)

    def fake_invoke(self, task, project_id, compiled_workflow, result,
                    approval_id=None, project_cwd=None, cancel_token=None,
                    correlation=None):
        start = time.monotonic()
        time.sleep(WORK_SECONDS)
        end = time.monotonic()
        with lock:
            spans[task.id] = (start, end)
        state = STATES.get(task.id, "done")
        if task.id in PATHS:
            result.verified_outputs[task.id] = {
                "changed_paths": list(PATHS[task.id]), "verified": True}
        result.outcomes.append(TaskOutcome(
            taskId=task.id, state=state, performed=state == "done",
            verified=True if state == "done" else None,
            approvalId="apr-1" if state == "awaiting-approval" else None,
            detail=f"{task.id} {state}"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake_invoke)
    return spans


def _controller():
    return ExecutionController(
        fabric_cfg=SimpleNamespace(), engine=SimpleNamespace())


def _overlap(a, b):
    return min(a[1], b[1]) - max(a[0], b[0])


def test_control_two_independent_tasks_overlap(timing):
    """Control: a plan of two independent tasks already runs concurrently."""
    _controller().execute(_plan([_task("t1"), _task("t2")]), project_id=None)
    assert _overlap(timing["t1"], timing["t2"]) > WORK_SECONDS / 2


def test_independent_tasks_overlap_even_when_plan_has_a_dependency(timing):
    """Reproduces the suspected defect: t1 and t2 are independent of each
    other, and t3 depends on t1. Today the WHOLE plan falls back to the
    sequential scheduler, so t1 and t2 never overlap."""
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    _controller().execute(_plan(tasks), project_id=None)
    assert _overlap(timing["t1"], timing["t2"]) > WORK_SECONDS / 2


def test_dependent_task_waits_for_its_prerequisite(timing):
    """Ordering guarantee that must hold under any fix: t3 starts only
    after t1 has finished."""
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    _controller().execute(_plan(tasks), project_id=None)
    assert timing["t3"][0] >= timing["t1"][1]


def _states(monkeypatch, mapping):
    monkeypatch.setitem(sys.modules[__name__].__dict__, "STATES", mapping)


def test_failed_wave_member_stops_dependents_but_not_siblings(timing, monkeypatch):
    """One worker's failure is reported as a failed run, dependents of
    that worker never start, and in-flight siblings are still recorded."""
    _states(monkeypatch, {"t1": "failed"})
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    result = _controller().execute(_plan(tasks), project_id=None)
    assert result.stopped is True
    assert "t1" in result.stop_reason
    assert "t3" not in timing  # dependent never dispatched
    assert "t2" in timing       # independent sibling already in flight
    by_id = {o.taskId: o for o in result.outcomes}
    assert by_id["t1"].state == "failed"
    assert by_id["t2"].state == "done"


def test_timeout_in_wave_is_reported_not_success(timing, monkeypatch):
    _states(monkeypatch, {"t1": "timed-out"})
    tasks = [_task("t1"), _task("t2")]
    result = _controller().execute(_plan(tasks), project_id=None)
    assert result.timed_out is True
    assert result.stopped is True


def test_denied_in_wave_is_reported_as_denied(timing, monkeypatch):
    _states(monkeypatch, {"t2": "denied"})
    tasks = [_task("t1"), _task("t2")]
    result = _controller().execute(_plan(tasks), project_id=None)
    assert result.denied is True
    assert result.stopped is True


def test_cancellation_before_wave_dispatches_nothing(timing):
    class _Token:
        cancelled = True
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    result = _controller().execute(_plan(tasks), project_id=None,
                                   cancel_token=_Token())
    assert result.cancelled is True
    assert timing == {}


def test_each_worker_keeps_its_own_task_id_and_single_outcome(timing):
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    result = _controller().execute(_plan(tasks), project_id=None)
    ids = [o.taskId for o in result.outcomes]
    assert sorted(ids) == ["t1", "t2", "t3"]  # one outcome per task, no duplicates
    assert all(o.state == "done" for o in result.outcomes)


def _paths(monkeypatch, mapping):
    monkeypatch.setitem(sys.modules[__name__].__dict__, "PATHS", mapping)


def test_write_conflict_across_waves_is_detected(timing, monkeypatch):
    """t1 and t3 write the same file, but t3 runs in a later wave (it
    depends on t1). The conflict must still be reported."""
    _paths(monkeypatch, {"t1": ["src/a.py"], "t2": ["src/b.py"],
                         "t3": ["src/a.py"]})
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    result = _controller().execute(_plan(tasks), project_id=None)
    assert timing["t3"][0] >= timing["t1"][1]  # really a later wave
    assert result.write_conflicts == [{
        "path": "src/a.py", "tasks": ["t1", "t3"],
        "risk": "post-execution-write-conflict"}]


def test_disjoint_writes_report_no_conflict(timing, monkeypatch):
    _paths(monkeypatch, {"t1": ["src/a.py"], "t2": ["src/b.py"],
                         "t3": ["src/c.py"]})
    tasks = [_task("t1"), _task("t2"), _task("t3", depends=["t1"])]
    result = _controller().execute(_plan(tasks), project_id=None)
    assert result.write_conflicts == []
