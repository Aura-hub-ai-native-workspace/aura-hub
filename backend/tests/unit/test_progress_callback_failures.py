"""A failing progress notification neither kills a run nor vanishes (F-07).

`on_task_start` / `on_task_complete` persist the task queue that recovery and
resume read. They used to be wrapped in `except Exception: pass`: the run
survived, but a failure to record progress left no trace. The run must still
finish; the failure must be logged.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app
from aura.central_agent.execution import _progress

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def test_the_helper_returns_normally_and_logs_the_failure(caplog):
    def broken(task_id, outcome=None):
        raise RuntimeError("disk full")

    with caplog.at_level(logging.WARNING, logger="aura.central_agent.execution"):
        _progress(broken, "on_task_complete", "t1", object())
    messages = [r.getMessage() for r in caplog.records]
    assert any("on_task_complete callback failed for task t1" in m for m in messages)
    assert any(r.exc_info and "disk full" in str(r.exc_info[1]) for r in caplog.records)


def test_the_helper_passes_its_arguments_through():
    seen = []
    _progress(lambda *a: seen.append(a), "on_task_complete", "t1", "outcome")
    assert seen == [("t1", "outcome")]


@pytest.fixture()
def api(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=proj, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "t@t")
    run("config", "user.name", "t")
    (proj / "a.txt").write_text("x\n")
    run("add", ".")
    run("commit", "-qm", "init")
    return TestClient(create_app()), proj


def test_a_run_finishes_and_the_progress_failure_is_logged(api, monkeypatch, caplog):
    from aura.central_agent import service as svc

    def broken(self, session, task_id, outcome):
        raise RuntimeError("could not save the queue")

    monkeypatch.setattr(svc.CentralAgent, "_on_task_complete", broken)
    client, proj = api
    with caplog.at_level(logging.WARNING):
        body = client.post("/agent/sessions", json={
            "message": "show me git status", "projectPath": str(proj)}).json()
        deadline = time.monotonic() + 60
        while True:
            s = client.get(f"/agent/sessions/{body['sessionId']}").json()
            if s.get("orchestrationState") not in (None, "running") and \
                    (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
                break
            assert time.monotonic() < deadline, str(s)[:300]
            time.sleep(0.1)
    assert s["lastResult"]["outcome"] == "completed"            # the run was not killed
    assert "branch main" in s["lastResult"]["summary"]            # and its result is real
    assert any("on_task_complete callback failed" in r.getMessage() for r in caplog.records)


def test_queue_progress_that_cannot_be_saved_is_logged_not_hidden(api, monkeypatch, caplog):
    from aura.central_agent.session import AgentSessionStore

    saves = {"n": 0}
    original = AgentSessionStore.save

    def flaky(self, session):
        # The queue save inside _on_task_complete fails; every other save works.
        import inspect

        if any(f.function == "_on_task_complete" for f in inspect.stack()):
            saves["n"] += 1
            raise OSError("no space left on device")
        return original(self, session)

    monkeypatch.setattr(AgentSessionStore, "save", flaky)
    client, proj = api
    with caplog.at_level(logging.WARNING):
        body = client.post("/agent/sessions", json={
            "message": "show me git status", "projectPath": str(proj)}).json()
        deadline = time.monotonic() + 60
        while True:
            s = client.get(f"/agent/sessions/{body['sessionId']}").json()
            if s.get("orchestrationState") not in (None, "running") and \
                    (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
                break
            assert time.monotonic() < deadline, str(s)[:300]
            time.sleep(0.1)
    assert saves["n"] >= 1
    assert s["lastResult"]["outcome"] == "completed"
    assert any("could not record progress for session" in r.getMessage() for r in caplog.records)


def test_a_crash_that_cannot_even_be_recorded_is_logged(api, monkeypatch, caplog):
    from aura.central_agent import service as svc

    def boom(self, *a, **k):
        raise RuntimeError("injected dispatch failure")

    original_finish = svc.CentralAgent._finish

    def finish(self, session, result):
        if getattr(result, "failureReason", None) == "orchestration-crashed":
            raise OSError("cannot write the session file")
        return original_finish(self, session, result)

    monkeypatch.setattr(svc.CentralAgent, "_dispatch_plan", boom)
    monkeypatch.setattr(svc.CentralAgent, "_finish", finish)
    client, proj = api
    with caplog.at_level(logging.ERROR):
        client.post("/agent/sessions", json={"message": "show me git status", "projectPath": str(proj)})
        deadline = time.monotonic() + 30
        while not any("could not record the crash" in r.getMessage() for r in caplog.records):
            assert time.monotonic() < deadline, "the unrecordable crash was never logged"
            time.sleep(0.05)
