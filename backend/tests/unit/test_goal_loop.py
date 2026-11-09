"""The goal loop keeps working on a goal with no one in the loop."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from aura.goals import (CYCLE_GAP_S, MAX_BACKOFF_S, MIN_BACKOFF_S, GoalLoop, GoalStore,
                        compose_message, failure_kind, repeated_failure)


def _result(outcome, accepted=None, reason=None, summary="did a thing"):
    return SimpleNamespace(orchestrationState="completed", lastResult=SimpleNamespace(
        outcome=outcome, model_dump=lambda: {
            "outcome": outcome, "objectiveAccepted": accepted, "failureReason": reason,
            "summary": summary, "unmetAcceptance": []}))


class Agent:
    """Stand-in for CentralAgent: each submitted session ends with the next result."""

    def __init__(self, results):
        self.results, self.messages, self.cancelled, self.sessions = list(results), [], [], {}

    def submit(self, message, project_path):
        sid = f"agt-{len(self.messages) + 1}"
        self.messages.append(message)
        self.sessions[sid] = self.results.pop(0)
        return sid

    def load(self, sid):
        return self.sessions.get(sid)

    def cancel(self, sid):
        self.cancelled.append(sid)


def _loop(tmp_path, results, sleeps=None):
    agent = Agent(results)
    loop = GoalLoop(submit=agent.submit, load=agent.load, cancel=agent.cancel,
                    store=GoalStore(tmp_path / "goals"),
                    sleep=(sleeps.append if sleeps is not None else lambda s: None))
    return loop, agent


def _drive(loop, goal_id, max_cycles=20):
    for _ in range(max_cycles):
        goal = loop._active(goal_id)  # noqa: SLF001 — the thread's own step
        if goal is None or not loop.run_cycle(goal):
            break
    return loop.store.load(goal_id)


def test_it_replans_after_failures_until_the_goal_is_met(tmp_path):
    loop, agent = _loop(tmp_path, [_result("failed", reason="objective-unaccepted"),
                                   _result("completed", accepted=False),
                                   _result("completed", accepted=True)])
    goal = loop.create("Add a dark mode", str(tmp_path), start=False)
    done = _drive(loop, goal["goalId"])
    assert done["state"] == "achieved"
    assert [c["kind"] for c in done["cycles"]] == ["replan", "replan", "achieved"]
    # Each new plan is made against what actually happened before.
    assert "cycle 1: failed (objective-unaccepted)" in agent.messages[1]
    assert "cycle 2: completed" in agent.messages[2]
    assert "Make reasonable assumptions instead of asking questions." in agent.messages[0]


def test_waiting_problems_back_off_and_retry_without_counting_as_a_new_plan(tmp_path):
    sleeps = []
    loop, agent = _loop(tmp_path, [_result("failed", reason="no-model"),
                                   _result("failed", summary="429 Too Many Requests"),
                                   _result("completed", accepted=True)], sleeps)
    goal = loop.create("Ship it", str(tmp_path), start=False)
    done = _drive(loop, goal["goalId"])
    assert done["state"] == "achieved"
    assert [c["kind"] for c in done["cycles"]] == ["wait", "wait", "achieved"]
    assert sleeps[:2] == [MIN_BACKOFF_S, MIN_BACKOFF_S * 2]


def test_backoff_is_capped_at_an_hour(tmp_path):
    sleeps = []
    loop, _ = _loop(tmp_path, [_result("failed", reason="timeout")] * 12 + [_result("completed", True)],
                    sleeps)
    goal = loop.create("Keep at it", str(tmp_path), start=False)
    _drive(loop, goal["goalId"], max_cycles=20)
    assert max(sleeps) == MAX_BACKOFF_S


def test_the_same_failure_three_times_asks_for_a_different_approach(tmp_path):
    loop, agent = _loop(tmp_path, [_result("failed", reason="correction-budget-exhausted")] * 3
                        + [_result("completed", accepted=True)])
    goal = loop.create("Fix the build", str(tmp_path), start=False)
    _drive(loop, goal["goalId"])
    assert "Do not repeat that approach" not in agent.messages[2]
    assert "Do not repeat that approach" in agent.messages[3]


def test_keep_improving_does_not_stop_when_the_goal_is_met(tmp_path):
    loop, agent = _loop(tmp_path, [_result("completed", accepted=True)] * 3)
    goal = loop.create("Make the app great", str(tmp_path), mode="keep-improving", start=False)
    gid = goal["goalId"]
    for _ in range(3):
        loop.run_cycle(loop._active(gid))  # noqa: SLF001
    assert loop.store.load(gid)["state"] == "running"
    assert "pick the next most valuable improvement" in agent.messages[1]


def test_stop_cancels_the_running_session_and_ends_the_loop(tmp_path):
    loop, agent = _loop(tmp_path, [SimpleNamespace(orchestrationState="running", lastResult=None)])
    goal = loop.create("Long job", str(tmp_path), start=False)
    gid = goal["goalId"]
    loop._sleep = lambda s: loop.stop(gid)  # someone stops it while the run is going
    assert loop.run_cycle(loop._active(gid)) is False  # noqa: SLF001
    stopped = loop.store.load(gid)
    assert stopped["state"] == "stopped" and agent.cancelled == ["agt-1"]


def test_a_restart_resumes_running_goals_and_waits_for_the_session_it_had(tmp_path):
    loop, agent = _loop(tmp_path, [_result("completed", accepted=True)])
    goal = loop.create("Resume me", str(tmp_path), start=False)
    gid = goal["goalId"]
    goal = loop.store.load(gid)
    goal["currentSessionId"] = "agt-before"
    loop.store.save(goal)
    agent.sessions["agt-before"] = _result("completed", accepted=True)
    assert loop.run_cycle(loop._active(gid)) is False  # noqa: SLF001
    assert agent.messages == []  # it did not start a second run
    assert loop.store.load(gid)["state"] == "achieved"


def test_resume_all_restarts_only_active_goals(tmp_path, monkeypatch):
    loop, _ = _loop(tmp_path, [])
    started = []
    monkeypatch.setattr(loop, "_start", started.append)
    a = loop.create("A", str(tmp_path), start=False)
    b = loop.create("B", str(tmp_path / ".."), start=False)
    loop.stop(b["goalId"])
    assert loop.resume_all() == [a["goalId"]] and started == [a["goalId"]]


def test_a_bug_in_one_cycle_does_not_end_the_goal(tmp_path, monkeypatch):
    loop, _ = _loop(tmp_path, [_result("completed", accepted=True)])
    goal = loop.create("Survive", str(tmp_path), start=False)
    calls = []

    def flaky(g):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return GoalLoop.run_cycle(loop, g)

    monkeypatch.setattr(loop, "run_cycle", flaky)
    loop._run(goal["goalId"])  # noqa: SLF001
    done = loop.store.load(goal["goalId"])
    assert done["state"] == "achieved"
    assert done["cycles"][0]["failureReason"] == "loop-error"


@pytest.mark.parametrize("bad", [
    {"goal": "", "project_path": "."}, {"goal": "x", "project_path": "/no/such/dir"},
    {"goal": "x", "project_path": ".", "mode": "forever"},
])
def test_bad_goals_are_refused(tmp_path, bad):
    loop, _ = _loop(tmp_path, [])
    with pytest.raises(ValueError):
        loop.create(**bad, start=False)


def test_one_running_goal_per_project(tmp_path):
    loop, _ = _loop(tmp_path, [])
    loop.create("A", str(tmp_path), start=False)
    with pytest.raises(ValueError, match="already running"):
        loop.create("B", str(tmp_path), start=False)


def test_goal_ids_cannot_reach_outside_the_store(tmp_path):
    with pytest.raises(ValueError):
        GoalStore(tmp_path).path("goal-../../x")


def test_helpers():
    assert failure_kind({"outcome": "completed", "objectiveAccepted": None}) == "achieved"
    assert failure_kind({"outcome": "completed", "objectiveAccepted": False}) == "replan"
    assert failure_kind({"outcome": "failed", "summary": "Quota exceeded"}) == "wait"
    same = {"cycles": [{"n": i, "outcome": "failed", "failureReason": "x", "kind": "replan"}
                       for i in range(1, 4)]}
    assert repeated_failure(same)
    assert "cycle 3: failed (x)" in compose_message({"goal": "g", **same})
    assert CYCLE_GAP_S > 0
