"""Server handlers that used to swallow a failure now log it (F-07).

Behaviour is unchanged: a failed startup recovery does not stop the service,
and an unloadable session is still a 404. What changes is that the cause is no
longer invisible. (The event-bus publish handler inside the streaming run
driver is not reachable without a long-lived stream and is not covered here.)
"""

from __future__ import annotations

import logging

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app
from aura.central_agent.service import CentralAgent
from aura.central_agent.session import AgentSessionStore


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("AURA_HOME", str(h))
    return h


def test_a_failed_startup_recovery_does_not_stop_the_service_and_is_logged(home, monkeypatch, caplog):
    def boom(self):
        raise RuntimeError("session directory unreadable")

    monkeypatch.setattr(CentralAgent, "recover_interrupted_sessions", boom)
    with caplog.at_level(logging.ERROR, logger="aura.api.server"):
        client = TestClient(create_app())           # the service still starts
    assert client.get("/health").status_code == 200
    logged = [r for r in caplog.records if "could not recover interrupted agent sessions" in r.getMessage()]
    assert logged
    assert "session directory unreadable" in str(logged[0].exc_info[1])


def test_an_unexpected_session_load_failure_is_a_404_and_is_logged(home, monkeypatch, caplog):
    def boom(self, sid):
        raise RuntimeError("unexpected loader failure")

    client = TestClient(create_app())
    monkeypatch.setattr(AgentSessionStore, "load", boom)
    with caplog.at_level(logging.ERROR, logger="aura.api.server"):
        resp = client.get("/agent/sessions/agt-whatever")
    assert resp.status_code == 404
    assert any("could not load agent session agt-whatever" in r.getMessage() for r in caplog.records)


def test_a_plainly_missing_session_is_a_quiet_404(home, caplog):
    client = TestClient(create_app())
    with caplog.at_level(logging.WARNING, logger="aura.api.server"):
        resp = client.get("/agent/sessions/agt-missing")
    assert resp.status_code == 404
    assert not [r for r in caplog.records if "could not load" in r.getMessage()]
