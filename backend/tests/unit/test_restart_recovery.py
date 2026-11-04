"""A restart never turns unfinished work into finished work."""

from __future__ import annotations

from aura.contracts import AgentResult
from test_stopped_mission_view import _agent


def interrupted_session(agent, *, verified=("t1",), total=3, state="executing"):
    s = agent.sessions.create("p")
    s.state = state
    s.activePlan = {"planId": "plan-x", "tasks": [{"id": f"t{i + 1}"} for i in range(total)]}
    s.verifiedEvidence = {tid: {"verified": True} for tid in verified}
    agent.sessions.save(s)
    return s.sessionId


def test_an_interrupted_run_is_marked_failed_and_keeps_what_was_proven(tmp_path):
    agent = _agent(tmp_path)
    sid = interrupted_session(agent)
    assert agent.recover_interrupted_sessions() == [sid]
    s = agent.sessions.load(sid)
    assert s.state == "failed" and s.lastResult.outcome == "failed"
    assert s.lastResult.failureReason == "interrupted-by-restart"
    assert "1 of 3 task(s) had already been verified" in s.lastResult.summary
    assert s.activePlan["planId"] == "plan-x" and "t1" in s.verifiedEvidence  # nothing lost


def test_finished_chat_and_live_sessions_are_left_alone(tmp_path):
    agent = _agent(tmp_path)
    done = agent.sessions.create("p")
    done.state = "completed"
    agent.sessions.save(done)
    chat, _ = agent.chat("hello")
    live = interrupted_session(agent)
    agent.runs.begin(live)  # a run really is in flight in this process
    assert agent.recover_interrupted_sessions() == []
    assert agent.sessions.load(live).state == "executing"
    assert agent.sessions.load(done.sessionId).state == "completed"


def test_the_status_answer_after_a_restart_does_not_claim_it_is_running(tmp_path):
    agent = _agent(tmp_path)
    sid = interrupted_session(agent)
    s = agent.sessions.load(sid)
    s.lastResult = None
    agent.sessions.save(s)
    # before recovery: the file says executing, but nothing is running it
    result, _ = agent.chat("how is it going?", project_id="p")
    assert "in progress" not in result.summary
    agent.recover_interrupted_sessions()
    result, _ = agent.chat("what's the status?", project_id="p")
    assert "did not succeed" in result.summary and "interrupted" in result.summary


def test_recovery_is_idempotent(tmp_path):
    agent = _agent(tmp_path)
    interrupted_session(agent)
    assert len(agent.recover_interrupted_sessions()) == 1
    assert agent.recover_interrupted_sessions() == []
