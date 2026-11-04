"""Instance ownership on the local API: a backend proves it was launched by
the desktop instance that is connecting, and refuses everything else."""
from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from aura.api import instance_guard as ig
from aura.api.server import create_app

TOKEN = "t" * 32
CHALLENGE = "c" * 24


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("AURA_HOME", str(h))
    return h


def _app(monkeypatch, token: str | None):
    if token is None:
        monkeypatch.delenv(ig.TOKEN_ENV, raising=False)
    else:
        monkeypatch.setenv(ig.TOKEN_ENV, token)
    return TestClient(create_app())


def test_own_backend_answers_the_proof_for_the_launch_token(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    r = c.get(f"/instance/proof?challenge={CHALLENGE}")
    assert r.status_code == 200
    assert r.json() == {"backend": "python", "proof": ig.proof_for(TOKEN, CHALLENGE)}


def test_a_foreign_backend_cannot_produce_the_expected_proof(home, monkeypatch):
    # A healthy AURA backend started by another home, with another token.
    foreign = _app(monkeypatch, "f" * 32)
    assert foreign.get("/health").status_code == 200  # ordinary health says "healthy"
    answer = foreign.get(f"/instance/proof?challenge={CHALLENGE}").json()["proof"]
    assert answer != ig.proof_for(TOKEN, CHALLENGE)


def test_a_proof_is_bound_to_its_challenge(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    a = c.get(f"/instance/proof?challenge={CHALLENGE}").json()["proof"]
    b = c.get(f"/instance/proof?challenge={'d' * 24}").json()["proof"]
    assert a != b


def test_a_malformed_challenge_is_refused(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    assert c.get("/instance/proof?challenge=short").status_code == 400
    assert c.get("/instance/proof").status_code == 400


def test_state_reads_without_the_token_are_refused(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    r = c.get("/workflows")
    assert r.status_code == 401
    assert r.json()["error"] == "instance-token-required"


def test_a_wrong_token_is_refused(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    assert c.get("/workflows", headers={"x-aura-instance-token": "nope"}).status_code == 401


def test_the_right_token_reaches_the_routes(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    r = c.get("/workflows", headers={"x-aura-instance-token": TOKEN})
    assert r.status_code == 200


def test_a_refused_write_creates_nothing(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    body = {"name": "must-not-exist", "nodes": [], "edges": []}
    r = c.post("/workflows", json=body)
    assert r.status_code == 401
    assert c.get("/workflows", headers={"x-aura-instance-token": TOKEN}).status_code == 200
    listed = json.dumps(c.get("/workflows", headers={"x-aura-instance-token": TOKEN}).json())
    assert "must-not-exist" not in listed


def test_health_stays_open_so_liveness_is_separate_from_ownership(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    assert c.get("/health").status_code == 200


def test_the_guard_is_inert_when_no_token_is_configured(home, monkeypatch):
    c = _app(monkeypatch, None)
    assert c.get("/workflows").status_code == 200
    assert c.get(f"/instance/proof?challenge={CHALLENGE}").json()["proof"] is None


def test_the_token_is_never_echoed_in_any_response(home, monkeypatch):
    c = _app(monkeypatch, TOKEN)
    for r in (c.get("/health"), c.get(f"/instance/proof?challenge={CHALLENGE}"),
              c.get("/workflows"), c.get("/workflows", headers={"x-aura-instance-token": "x"})):
        assert TOKEN not in r.text


def test_the_browser_preflight_allows_the_token_header(home, monkeypatch):
    """Regression: the webview (localhost:1420 in dev, tauri://localhost in a
    package) sends the token header, so its CORS preflight must allow it.
    Without this, every state request from the app fails before it is sent."""
    c = _app(monkeypatch, TOKEN)
    r = c.options("/workflows", headers={
        "origin": "http://localhost:1420",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-aura-instance-token",
    })
    assert r.status_code == 200
    assert "x-aura-instance-token" in r.headers.get("access-control-allow-headers", "").lower()
    assert r.headers.get("access-control-allow-origin") == "http://localhost:1420"
