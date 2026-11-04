"""Ask AURA routing: conversation answers directly, work runs as a mission.

The decision is made by the same intent compiler and gates submit uses. The
action-oriented test proves the route reaches the executor; the conversational
test proves it does not. Real central agent, real session store, real audit.
"""

from __future__ import annotations

from test_central_agent_slice import env  # noqa: F401  (fixture)


def test_greeting_routes_to_conversation(env):
    _, _, _, _, agent = env
    assert agent.classify("hi there")["route"] == "conversation"


def test_action_request_routes_to_mission(env):
    _, _, _, _, agent = env
    decision = agent.classify("create a workflow that shows git status every morning")
    assert decision["route"] == "mission"


def test_empty_request_asks_for_clarification(env):
    _, _, _, _, agent = env
    decision = agent.classify("   ")
    assert decision["route"] == "clarify"
    assert decision["question"]


def test_classify_creates_no_session_and_runs_nothing(env):
    home, audit, _, _, agent = env
    before = len(audit.load())
    agent.classify("create a workflow that shows git status every morning")
    assert len(audit.load()) == before
    assert not (home / "agent" / "sessions").exists() or not list((home / "agent" / "sessions").glob("*.json"))


def test_mission_route_invokes_the_execution_path(env, monkeypatch):
    """The action-oriented route must reach the executor, not a direct answer."""
    _, _, _, _, agent = env
    calls = []
    real = agent.controller.execute

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(agent.controller, "execute", counting)
    result = agent.submit("list my workflows")
    assert calls, "an action request must reach the execution path"
    assert result.outcome == "completed"


def test_conversation_route_never_invokes_execution(env, monkeypatch):
    _, _, _, _, agent = env
    calls = []
    monkeypatch.setattr(agent.controller, "execute",
                        lambda *a, **k: calls.append(1))
    agent.submit("hi there")
    assert calls == []


def test_worker_work_without_a_project_stops_before_dispatch(env, monkeypatch):
    """Missing project is an explicit, actionable outcome, and no worker runs."""
    _, _, _, _, agent = env
    calls = []
    monkeypatch.setattr(agent.controller, "execute",
                        lambda *a, **k: calls.append(1))
    result = agent.submit("Claude Code, inspect alpha/a.txt and report its contents.")
    assert result.failureReason == "no-project"
    assert result.outcome == "needs-clarification"
    assert "Open a project first" in result.summary
    assert calls == []


def test_worker_work_with_a_project_is_not_blocked(env, tmp_path, monkeypatch):
    _, _, _, _, agent = env
    seen = []
    real = agent.controller.execute

    def record(plan, project_id, **kwargs):
        seen.append(kwargs.get("project_cwd"))
        return real(plan, project_id, **kwargs)

    monkeypatch.setattr(agent.controller, "execute", record)
    agent.submit("Claude Code, inspect alpha/a.txt and report its contents.",
                 project_path=str(tmp_path))
    assert seen and seen[0] == str(tmp_path)
