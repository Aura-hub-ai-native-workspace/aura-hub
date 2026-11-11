"""Undoing a run through the API: list a session's restore points, restore one."""
from __future__ import annotations

import subprocess
import time

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app
from aura.central_agent import restore_point


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    _git(proj, "init", "-q")
    _git(proj, "config", "user.email", "t@t")
    _git(proj, "config", "user.name", "t")
    (proj / "app.py").write_text("v1\n")
    _git(proj, "add", "-A")
    _git(proj, "commit", "-qm", "init")
    return TestClient(create_app()), proj


def _session(client, proj):
    r = client.post("/agent/sessions", json={"message": "show me git status", "projectPath": str(proj)})
    assert r.status_code in (200, 201, 202), r.text
    sid = r.json()["sessionId"]
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if client.get(f"/agent/sessions/{sid}").status_code == 200:
            return sid
        time.sleep(0.2)
    raise AssertionError("session never stored")


def test_a_session_restores_its_project(api):
    client, proj = api
    sid = _session(client, proj)
    point = restore_point.create(str(proj), "task-1")
    (proj / "app.py").write_text("broken\n")
    (proj / "extra.py").write_text("left by an agent\n")

    listed = client.get(f"/agent/sessions/{sid}/restore-points").json()["points"]
    assert point in [p["id"] for p in listed]

    r = client.post(f"/agent/sessions/{sid}/restore", json={"id": point})
    assert r.status_code == 200, r.text
    assert r.json()["removed"] == ["extra.py"]
    assert (proj / "app.py").read_text() == "v1\n"
    assert not (proj / "extra.py").exists()


def test_an_unknown_point_or_session_is_refused(api):
    client, proj = api
    sid = _session(client, proj)
    assert client.post(f"/agent/sessions/{sid}/restore", json={"id": "0" * 40}).status_code == 400
    assert client.post("/agent/sessions/agt-nope/restore", json={"id": "0" * 40}).status_code == 404
