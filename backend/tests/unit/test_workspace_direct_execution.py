"""Workspace runs the assigned goal immediately; Let's Chat only converses.

Workspace: submitting a goal plans it and runs it in the same call — no
plan approval, no per-action approval. Only the hard floors and the
person's own explicit configuration can make it wait.

Let's Chat: a chat-mode session answers in words and never reaches the
Fabric, a worker or a workflow, whatever the message asks; chat and work
sessions refuse each other's routes.

Real CentralAgent with invoke_fabric stubbed: no worker is started.
"""

from __future__ import annotations

import threading

import pytest

from test_cancellation import _ok
from test_stopped_mission_view import MISSION, _agent


@pytest.fixture()
def wired(tmp_path, monkeypatch):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / "a.txt").write_text("alpha A.\n")
    agent = _agent(tmp_path)
    calls: list[dict] = []
    lock = threading.Lock()

    def fake_invoke(cap, payload, context, cfg):
        with lock:
            calls.append({"cap": cap, "taskId": context["taskId"]})
        node = "claude-code" if "claude" in context["taskId"] else "kilo-code"
        return _ok(f"inv-{context['taskId']}", node, stdout="alpha A.")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    return agent, calls, tmp_path


def _sid(agent):
    return next(e.sessionId for e in reversed(agent.bus.tail))


# ── Workspace ────────────────────────────────────────────────────────────

def test_a_submitted_goal_runs_immediately(wired):
    agent, calls, root = wired
    result = agent.submit(MISSION, project_id="p", project_path=str(root))
    assert result.outcome == "completed"
    assert {c["taskId"] for c in calls} == {"delegate-claude", "delegate-kilo"}
    types = [e.type for e in agent.bus.tail]
    assert "execution.started" in types
    assert not any(t.startswith("plan.awaiting") or t == "approval.required"
                   for t in types)


def test_both_workers_run_in_the_same_submit_with_the_shared_board(wired):
    agent, calls, root = wired
    agent.submit(MISSION, project_id="p", project_path=str(root))
    assert len(calls) == 2
    session = agent.sessions.load(_sid(agent))
    assert session.activePlan and session.activePlanId


def test_a_follow_up_goal_runs_as_its_own_plan(wired):
    agent, calls, root = wired
    agent.submit(MISSION, project_id="p", project_path=str(root))
    sid = _sid(agent)
    first = agent.sessions.load(sid).activePlanId
    result = agent.message(sid, MISSION + " Keep the report short.", str(root), None, "p")
    assert result.outcome == "completed"
    assert agent.sessions.load(sid).activePlanId != first
    assert len(calls) == 4


def test_a_policy_the_person_set_to_ask_is_still_honored(tmp_path, monkeypatch):
    """Only the person's own explicit configuration (or a hard floor) can
    make Workspace wait — never AURA's defaults."""
    agent = _agent(tmp_path)
    # The person turned autonomy off: the real Fabric parks the worker
    # before any executor runs.
    agent.fabric_cfg.fabric.set_policy({"allowAutonomous": False})
    result = agent.submit(MISSION, project_id="p", project_path=str(tmp_path))
    assert result.outcome in ("denied", "failed"), result.summary


def test_a_stop_before_the_goal_starts_runs_nothing(wired):
    agent, calls, root = wired
    agent.submit(MISSION, project_id="p", project_path=str(root))
    sid = _sid(agent)
    calls.clear()
    agent.request_cancel(sid, "stop")
    result = agent.message(sid, MISSION, str(root), None, "p")
    assert result.outcome == "cancelled"
    assert calls == []


# ── Let's Chat ───────────────────────────────────────────────────────────

def test_chat_never_runs_work_whatever_it_is_asked(wired):
    agent, calls, root = wired
    result, sid = agent.chat("create a file called project-check.md containing hello",
                             project_id="p", project_path=str(root))
    assert result.outcome == "completed"
    assert result.performed == [] and result.verified == []
    assert result.evidence is None and result.runId is None
    assert calls == []
    assert not (root / "project-check.md").exists()
    session = agent.sessions.load(sid)
    assert session.mode == "chat"
    assert session.activePlan is None
    types = [e.type for e in agent.bus.tail if e.sessionId == sid]
    assert "plan.created" not in types and "execution.started" not in types


def test_a_model_reply_that_promises_work_is_corrected(wired, monkeypatch):
    """Found running the real app on a small local model: asked to create a
    file, Let's Chat answered "Sure, I'll create a file…". Nothing ran — the
    reply must not leave the person believing otherwise."""
    agent, calls, root = wired
    monkeypatch.setattr(type(agent), "_stream_conversation",
                        lambda self, *a, **k: "Sure, I'll create a file called notes.md with \"hi\".")
    result, _sid = agent.chat("please create a file called notes.md containing hi",
                              project_id="p", project_path=str(root))
    assert result.summary.endswith(agent._CHAT_NOTHING_RAN)
    assert "Sure, I'll create" in result.summary  # the model's words are kept, then corrected
    assert calls == [] and not (root / "notes.md").exists()


def test_a_reply_claiming_an_action_is_corrected_even_for_a_vague_message(wired, monkeypatch):
    agent, calls, root = wired
    monkeypatch.setattr(type(agent), "_stream_conversation",
                        lambda self, *a, **k: "Done — I've deleted the old config.")
    result, _sid = agent.chat("the old config", project_id="p")
    assert result.summary.endswith(agent._CHAT_NOTHING_RAN)


def test_a_plain_conversational_reply_is_left_alone(wired, monkeypatch):
    agent, calls, root = wired
    monkeypatch.setattr(type(agent), "_stream_conversation",
                        lambda self, *a, **k: "It has three layers: UI, service and backend.")
    result, _sid = agent.chat("can you explain the architecture?", project_id="p")
    assert result.summary == "It has three layers: UI, service and backend."


def test_chat_keeps_the_conversation(wired):
    agent, calls, root = wired
    _r, sid = agent.chat("let's plan a rate limiter", project_id="p")
    agent.chat("now revise that plan to use a token bucket", session_id=sid)
    users = [m.content for m in agent.sessions.load(sid).messages if m.role == "user"]
    assert users == ["let's plan a rate limiter",
                     "now revise that plan to use a token bucket"]
    assert calls == []


def test_a_chat_session_refuses_every_work_route(wired):
    agent, calls, root = wired
    _r, sid = agent.chat("hello", project_id="p")
    with pytest.raises(ValueError, match="Let's Chat"):
        agent.message(sid, MISSION, str(root), None, "p")
    with pytest.raises(ValueError, match="Let's Chat"):
        agent.resume(sid)
    assert calls == []


def test_a_work_session_cannot_be_continued_as_chat(wired):
    agent, calls, root = wired
    agent.submit(MISSION, project_id="p", project_path=str(root))
    with pytest.raises(ValueError, match="Workspace"):
        agent.chat("hi", session_id=_sid(agent))
