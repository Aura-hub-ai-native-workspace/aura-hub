"""The goal routes run a real cycle through the real agent, with no one in the loop."""
from __future__ import annotations

import time

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def api(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    return TestClient(create_app()), proj, home


def _until(fn, timeout=60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("condition never held")


def test_a_goal_runs_a_real_cycle_records_it_and_stops(api):
    client, proj, home = api
    r = client.post("/goals", json={"goal": "show me git status", "projectPath": str(proj)})
    assert r.status_code == 201, r.text
    gid = r.json()["goal"]["goalId"]
    assert (home / "goals" / f"{gid}.json").exists()

    # The first cycle is an ordinary agent session that settles on its own.
    goal = _until(lambda: (client.get(f"/goals/{gid}").json()["goal"]
                           if client.get(f"/goals/{gid}").json()["goal"]["cycles"] else None))
    cycle = goal["cycles"][0]
    assert cycle["sessionId"].startswith("agt-") and cycle["outcome"]
    assert client.get(f"/agent/sessions/{cycle['sessionId']}").status_code == 200

    assert [g["goalId"] for g in client.get("/goals").json()["goals"]] == [gid]
    stopped = client.post(f"/goals/{gid}/stop").json()["goal"]
    assert stopped["state"] == "stopped"


def test_goal_routes_refuse_bad_input(api):
    client, proj, _ = api
    assert client.post("/goals", json={"goal": "", "projectPath": str(proj)}).status_code == 400
    assert client.post("/goals", json={"goal": "x", "projectPath": "/no/such"}).status_code == 400
    assert client.get("/goals/goal-missing").status_code == 404
    assert client.get("/goals/../../etc").status_code == 404
    assert client.post("/goals/goal-nope/stop").status_code == 404


def test_running_goals_resume_when_the_service_starts(api, monkeypatch):
    client, proj, home = api
    gid = client.post("/goals", json={"goal": "keep going", "projectPath": str(proj)}).json()["goal"]["goalId"]
    resumed = []
    monkeypatch.setattr("aura.goals.GoalLoop._start", lambda self, g: resumed.append(g))
    create_app()  # a restart
    assert resumed == [gid]
    client.post(f"/goals/{gid}/stop")
