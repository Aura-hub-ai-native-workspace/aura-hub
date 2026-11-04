"""P0-1: the background orchestration thread reaches a real terminal state.

Submit answers `started`; the thread owns the run. These tests exercise the
actual thread (no direct method calls) and assert that the session always
ends with a recorded terminal result, including when the thread itself
crashes. A crash must never leave a session that looks active forever.
"""
from __future__ import annotations

import time

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    return TestClient(create_app()), tmp_path / "proj"


def _settle(client, sid, timeout=90.0):
    deadline = time.monotonic() + timeout
    while True:
        s = client.get(f"/agent/sessions/{sid}").json()
        if s.get("orchestrationState") not in (None, "running") and (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return s
        if time.monotonic() > deadline:
            raise AssertionError(f"session {sid} never reached a terminal state: {str(s)[:300]}")
        time.sleep(0.2)


def test_background_run_without_a_connected_node_ends_in_a_terminal_denial(client, monkeypatch):
    # The tool is found on the machine but cannot be recorded as connected,
    # so policy has no node to authorize and must deny before any effect.
    monkeypatch.setattr("aura.central_agent.provisioner.connect_verified_tool",
                        lambda node_id, version: False)
    api, proj = client
    proj.mkdir()
    body = api.post("/agent/sessions", json={
        "message": "show me git status", "projectPath": str(proj)}).json()
    assert body["result"]["status"] == "started"
    s = _settle(api, body["sessionId"])
    assert s["state"] == "failed"
    assert s["orchestrationState"] == "failed"
    assert s["lastResult"]["outcome"] == "failed"
    assert "Policy denies this plan" in s["lastResult"]["summary"]
    assert s["lastResult"]["performed"] == [] and s["lastResult"]["verified"] == []


def test_a_crashing_background_thread_still_records_a_failed_result(client, monkeypatch):
    from aura.central_agent import service as svc

    def boom(self, *a, **k):
        raise RuntimeError("injected dispatch failure")

    monkeypatch.setattr(svc.CentralAgent, "_dispatch_plan", boom)
    api, proj = client
    proj.mkdir()
    body = api.post("/agent/sessions", json={
        "message": "show me git status", "projectPath": str(proj)}).json()
    s = _settle(api, body["sessionId"])
    assert s["orchestrationState"] == "failed"
    assert s["state"] == "failed"
    assert s["lastResult"]["failureReason"] == "orchestration-crashed"
    assert "injected dispatch failure" in s["lastResult"]["summary"]



def test_a_quickly_ending_run_is_not_overwritten_by_the_started_save(client, monkeypatch):
    """The race behind the intermittent crash test, made deterministic.

    submit() saves the "started" result; the background thread saves the
    terminal result. If the thread is already running when submit() saves,
    the losing order (terminal first, then "started" over it) is forced here:
    the "started" save waits for the thread's save. That left the session
    "started" for good. With the thread started only after submit()'s save,
    the wait never applies and the terminal result is the last write."""
    import threading

    from aura.central_agent import service as svc
    from aura.central_agent.session import AgentSessionStore

    def boom(self, *a, **k):
        raise RuntimeError("injected dispatch failure")

    monkeypatch.setattr(svc.CentralAgent, "_dispatch_plan", boom)
    order: list[str] = []
    thread_saved = threading.Event()
    original_save = AgentSessionStore.save

    def save(self, session):
        orchestration = threading.current_thread().name.startswith("orch-")
        result = session.lastResult
        outcome = getattr(result, "outcome", None) if result is not None else None
        if not orchestration and outcome == "started":
            running = any(t.name == f"orch-{session.sessionId}" and t.is_alive()
                          for t in threading.enumerate())
            if running:  # only possible when the thread was started too early
                thread_saved.wait(timeout=5)
        path = original_save(self, session)
        order.append(f"{'thread' if orchestration else 'request'}:{outcome}")
        if orchestration:
            thread_saved.set()
        return path

    monkeypatch.setattr(AgentSessionStore, "save", save)
    api, proj = client
    proj.mkdir()
    body = api.post("/agent/sessions", json={
        "message": "show me git status", "projectPath": str(proj)}).json()
    s = _settle(api, body["sessionId"], timeout=15.0)
    assert s["state"] == "failed"
    assert s["lastResult"]["failureReason"] == "orchestration-crashed"
    assert order.index("request:started") < order.index("thread:failed"), order
