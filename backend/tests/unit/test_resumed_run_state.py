"""Issue #110 — a run AURA resumes after a restart says what it is doing.

On startup, ``recover_interrupted_sessions`` relaunches a run that was in
flight (``orchestrationState == "running"`` with an unfinished task queue).
It used to leave the session at ``"interrupted"`` while the relaunched
worker ran, and because the orchestration thread only records a terminal
state for a ``"running"`` session, the run then stayed ``"interrupted"``
for ever, even after it finished or the user stopped it.

A run the user had already asked to stop before the restart must come back
cancelled and must not continue on its own (``AgentSession.cancellation``).
"""

from __future__ import annotations

import threading

import pytest

from aura.central_agent.task_queue import TaskQueue
from aura.contracts import AgentResult
from aura.contracts.agent import AgentIntent, TaskPlan, TaskSpecification
from test_stopped_mission_view import _agent


def _running_session(agent, *, cancellation=None):
    """A session file exactly as a crash leaves it: running, queue unfinished."""
    s = agent.sessions.create("p")
    plan = TaskPlan(
        planId="pln-resume", sessionId=s.sessionId,
        intent=AgentIntent(goal="add sub to calc.py", expectedOutcome="done"),
        tasks=[TaskSpecification(id="implement", description="Carry out the requested change",
                                 capabilityId="agent.delegate")],
        createdAt="2026-11-25T00:00:00Z")
    s.state = "executing"
    s.activePlan = plan.model_dump()
    s.activePlanId = plan.planId
    s.taskQueue = TaskQueue.from_plan(plan).to_dict()
    s.orchestrationState = "running"
    s.orchestrationStartedAt = "2026-11-25T00:00:00Z"
    s.lastResult = AgentResult(status="started", outcome="started",
                               summary="Plan created; execution started.")
    if cancellation is not None:
        s.cancellation = cancellation
    agent.sessions.save(s)
    return s.sessionId


@pytest.fixture()
def agent(tmp_path, monkeypatch):
    a = _agent(tmp_path)
    # Never scan or signal real processes from a unit test.
    monkeypatch.setattr(a, "_kill_orphaned_workers", lambda _sid: None)
    return a


def _join(agent, sid, timeout=10):
    thread = agent._orchestrator_threads.get(sid)  # noqa: SLF001
    assert thread is not None, "recovery did not relaunch the run"
    thread.join(timeout)
    assert not thread.is_alive(), "the resumed run did not finish"


def test_a_resumed_run_reads_as_running_while_its_worker_works(agent, monkeypatch):
    sid = _running_session(agent)
    working, release = threading.Event(), threading.Event()
    seen = {}

    def dispatch(session, plan, intent, user_message, on_task_complete=None):
        working.set()
        release.wait(10)
        return AgentResult(status="completed", outcome="completed", summary="done")

    monkeypatch.setattr(agent, "_dispatch_plan", dispatch)
    assert agent.recover_interrupted_sessions() == [sid]
    assert working.wait(10), "the relaunched orchestration never started"
    s = agent.sessions.load(sid)
    seen["state"], seen["summary"] = s.orchestrationState, s.lastResult.summary
    release.set()
    _join(agent, sid)

    assert seen["state"] == "running"
    assert "resumed" in seen["summary"].lower()
    assert "Plan created; execution started." not in seen["summary"]


@pytest.mark.parametrize("outcome,expected", [
    ("completed", "completed"),
    ("failed", "failed"),
    ("cancelled", "cancelled"),
])
def test_a_resumed_run_ends_in_its_real_terminal_state(agent, monkeypatch, outcome, expected):
    sid = _running_session(agent)
    monkeypatch.setattr(agent, "_dispatch_plan", lambda *a, **k: AgentResult(
        status=outcome, outcome=outcome, summary=f"ended {outcome}"))
    agent.recover_interrupted_sessions()
    _join(agent, sid)
    s = agent.sessions.load(sid)
    assert s.orchestrationState == expected
    assert s.orchestrationFinishedAt is not None
    assert s.lastResult.outcome == outcome


def test_a_run_the_user_stopped_before_the_restart_is_not_resumed(agent, monkeypatch):
    sid = _running_session(agent, cancellation={
        "cancelled": True, "accepted": True, "reason": "stop", "requestedBy": "user",
        "requestedAt": "2026-11-25T00:00:01Z", "settled": False})
    dispatched = []
    monkeypatch.setattr(agent, "_dispatch_plan", lambda *a, **k: dispatched.append(1))

    touched = agent.recover_interrupted_sessions()

    assert dispatched == [], "a run the user stopped was resumed"
    assert agent._orchestrator_threads.get(sid) is None  # noqa: SLF001
    s = agent.sessions.load(sid)
    assert s.orchestrationState == "cancelled"
    assert s.lastResult.outcome == "cancelled"
    assert s.cancellation.get("settled") is True
    assert sid in touched
    # Idempotent: a second startup changes nothing and relaunches nothing.
    assert agent.recover_interrupted_sessions() == []
    assert dispatched == []
