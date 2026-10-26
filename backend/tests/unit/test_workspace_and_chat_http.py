"""Workspace and Let's Chat through the real HTTP API.

Workspace (`POST /agent/sessions`): a goal that writes a file runs at once
and the write happens with no approval request in the ledger. Let's Chat
(`POST /agent/chat`): the same words write nothing. The removed plan
approval route is gone, a client can never supply a plan grant, and the
hard floors still stop.

Isolated AURA_HOME and a temporary project; no worker is started.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    project = tmp_path / "proj"
    project.mkdir()
    return TestClient(create_app()), project


GOAL = "Create report.md containing hello"


def settled(client, body, timeout=90.0):
    """Workspace runs in the background: submit answers `started`; the
    terminal result is the session's `lastResult` once orchestration has
    left `running`. Returns the POST result when it is already terminal."""
    import time

    res = body["result"]
    if res.get("status") != "started":
        return res
    deadline = time.monotonic() + timeout
    while True:
        s = client.get(f"/agent/sessions/{body['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return s["lastResult"]
        if time.monotonic() > deadline:
            raise AssertionError(f"session never settled: {str(s)[:300]}")
        time.sleep(0.25)


def test_workspace_runs_the_goal_immediately_with_no_approval(api):
    client, project = api
    r = client.post("/agent/sessions", json={"message": GOAL, "projectPath": str(project)})
    assert r.status_code == 200, r.text
    result = settled(client, r.json())
    assert result["outcome"] == "completed", result
    assert (project / "report.md").read_text().strip() == "hello"
    assert client.get("/fabric/approvals").status_code == 404  # the approval queue no longer exists
    session = client.get(f"/agent/sessions/{r.json()['sessionId']}").json()
    assert "pendingPlan" not in session and "planReview" not in result


def test_lets_chat_never_writes_whatever_it_is_asked(api):
    client, project = api
    r = client.post("/agent/chat", json={"message": GOAL, "projectPath": str(project)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["result"]["outcome"] == "completed"
    assert body["result"]["performed"] == [] and body["result"]["evidence"] is None
    assert not (project / "report.md").exists()
    assert client.get("/fabric/approvals").status_code == 404  # the approval queue no longer exists
    follow = client.post("/agent/chat", json={"message": "revise that plan",
                                              "sessionId": body["sessionId"]})
    assert follow.status_code == 200
    assert follow.json()["sessionId"] == body["sessionId"]


def test_chat_and_workspace_sessions_refuse_each_other(api):
    client, project = api
    chat = client.post("/agent/chat", json={"message": "hi"}).json()["sessionId"]
    r = client.post(f"/agent/sessions/{chat}/message",
                    json={"message": GOAL, "projectPath": str(project)})
    assert r.status_code == 409, r.text
    assert not (project / "report.md").exists()
    work = client.post("/agent/sessions", json={"message": "Create w.md containing x",
                                                "projectPath": str(project)}).json()["sessionId"]
    r = client.post("/agent/chat", json={"message": "hi", "sessionId": work})
    assert r.status_code == 409, r.text


def test_chat_input_is_validated(api):
    client, _ = api
    assert client.post("/agent/chat", json={}).status_code == 400
    assert client.post("/agent/chat", json={"message": "x", "sessionId": "nope"}).status_code == 400


def test_the_plan_approval_route_is_gone(api):
    client, _ = api
    r = client.post("/agent/sessions/agt-000000000000/plan/approve",
                    json={"planId": "p", "planHash": "h"})
    assert r.status_code in (404, 405), r.text


def test_a_configured_ask_runs_without_waiting_for_a_person(api):
    """A legacy "ask" setting no longer parks work: the action runs under policy."""
    client, project = api
    client.post("/fabric/policy", json={"overrides": {"filesystem.write": "ask-user"}})
    r = client.post("/agent/sessions", json={"message": GOAL, "projectPath": str(project)})
    assert settled(client, r.json())["outcome"] == "completed"
    assert (project / "report.md").exists()


def test_an_old_default_policy_file_reads_as_direct_execution(tmp_path, monkeypatch):
    """A stored policy that is exactly the old shipped default (as on an
    existing install) no longer makes routine work wait, and the file
    itself is left untouched."""
    import json

    home = tmp_path / "home"
    home.mkdir()
    old = {"byRisk": {"low": "auto-execute", "medium": "ask-user", "high": "require-approval"},
           "overrides": {"mission.approve": "ask-user", "provider.connect": "require-approval"},
           "nodeOverrides": {}, "nodeAllowlists": {}, "allowAutonomous": True}
    (home / "fabric-policy.json").write_text(json.dumps(old))
    monkeypatch.setenv("AURA_HOME", str(home))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    client = TestClient(create_app())
    project = tmp_path / "proj"
    project.mkdir()
    r = client.post("/agent/sessions", json={"message": GOAL, "projectPath": str(project)})
    assert settled(client, r.json())["outcome"] == "completed"
    assert json.loads((home / "fabric-policy.json").read_text()) == old
    effective = client.get("/fabric/policy").json()["policy"]
    assert effective["byRisk"]["medium"] == "auto-execute"
    assert "mission.approve" not in effective["overrides"]
