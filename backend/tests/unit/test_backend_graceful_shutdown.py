"""POST /shutdown on the Python backend (X-05).

Windows has no SIGTERM, so the shell asks the backend to stop itself. The route
must be impossible for an untrusted caller to use, idempotent, non-blocking, and
truthful, and a real process must actually exit, within a bound, even with a
connection still open.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from aura.api.shutdown import GRACEFUL_TIMEOUT_S, ShutdownCoordinator

TOKEN = "t" * 40
ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture()
def app_with_token(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_INSTANCE_TOKEN", TOKEN)
    from aura.api.server import create_app
    return create_app()


def _post(client, headers=None):
    return client.post("/shutdown", headers=headers or {})


GOOD = {"x-aura-instance-token": TOKEN, "x-aura-shutdown": "1"}


def test_untrusted_callers_cannot_stop_it(app_with_token):
    stopped = []
    app_with_token.state.shutdown.bind(lambda: stopped.append(1))
    c = TestClient(app_with_token)
    assert _post(c).status_code == 401                                          # no token: the guard
    assert _post(c, {"x-aura-shutdown": "1"}).status_code == 401
    assert _post(c, {"x-aura-instance-token": "x" * 40, "x-aura-shutdown": "1"}).status_code == 401
    assert _post(c, {"x-aura-instance-token": TOKEN}).status_code == 403        # token but no shutdown header
    assert c.get("/shutdown", headers=GOOD).status_code == 405                  # only POST
    assert stopped == []


def test_authorized_request_stops_once_and_repeats_are_idempotent(app_with_token):
    stopped = []
    app_with_token.state.shutdown.bind(lambda: stopped.append(1))
    c = TestClient(app_with_token)
    first = _post(c, GOOD)
    assert first.status_code == 200
    assert first.json() == {"ok": True, "shuttingDown": True, "alreadyRequested": False}
    for _ in range(3):
        again = _post(c, GOOD)
        assert again.status_code == 200 and again.json()["alreadyRequested"] is True
    assert stopped == [1]                                                        # stop() ran exactly once


def test_without_a_configured_token_the_route_is_refused(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_INSTANCE_TOKEN", raising=False)
    from aura.api.server import create_app
    app = create_app()
    stopped = []
    app.state.shutdown.bind(lambda: stopped.append(1))
    r = _post(TestClient(app), {"x-aura-shutdown": "1"})
    assert r.status_code == 403 and stopped == []                                # inert guard must not mean open


def test_truthful_failures(app_with_token):
    c = TestClient(app_with_token)
    r = _post(c, GOOD)                                                           # nothing bound to stop
    assert r.status_code == 503 and r.json()["ok"] is False

    def boom():
        raise RuntimeError("cannot stop")
    app_with_token.state.shutdown.bind(boom)
    r = _post(c, GOOD)
    assert r.status_code == 500 and r.json()["ok"] is False
    ok = []
    app_with_token.state.shutdown.bind(lambda: ok.append(1))                     # a failed attempt does not latch
    assert _post(c, GOOD).json()["alreadyRequested"] is False and ok == [1]


def test_coordinator_is_thread_safe():
    import threading
    calls = []
    co = ShutdownCoordinator()
    co.bind(lambda: calls.append(1))
    ts = [threading.Thread(target=co.request) for _ in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert calls == [1]


# --- a real backend process ------------------------------------------------

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def backend(tmp_path):
    port = _free_port()
    env = {**os.environ, "AURA_HOME": str(tmp_path), "AURA_INSTANCE_TOKEN": TOKEN,
           "PYTHONPATH": str(ROOT / "backend")}
    proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "serve_central_agent_api.py"), str(port)],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        assert "AURA_PYTHON_API_READY" in proc.stdout.readline()
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).read()
                break
            except OSError:
                time.sleep(0.1)
        yield proc, port
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def _http_post(port, headers):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/shutdown", method="POST", headers=headers, data=b"")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@pytest.mark.skipif(os.name == "nt", reason="uses a POSIX subprocess wait only for convenience; the route itself is platform independent")
def test_real_process_refuses_untrusted_then_exits_cleanly_for_the_owner(backend):
    proc, port = backend
    assert _http_post(port, {})[0] == 401
    assert _http_post(port, {"x-aura-shutdown": "1"})[0] == 401
    time.sleep(0.3)
    assert proc.poll() is None, "an untrusted request stopped the backend"
    t0 = time.monotonic()
    status, _ = _http_post(port, GOOD)
    assert status == 200
    assert proc.wait(timeout=GRACEFUL_TIMEOUT_S + 3) == 0                        # clean exit status
    assert time.monotonic() - t0 < GRACEFUL_TIMEOUT_S + 3


def test_real_process_exit_is_bounded_with_a_stuck_connection(backend):
    proc, port = backend
    stuck = socket.create_connection(("127.0.0.1", port))
    stuck.sendall(b"POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial")   # never completes
    try:
        time.sleep(0.3)
        t0 = time.monotonic()
        assert _http_post(port, GOOD)[0] == 200
        proc.wait(timeout=GRACEFUL_TIMEOUT_S + 4)
        assert time.monotonic() - t0 < GRACEFUL_TIMEOUT_S + 4, "an open connection made the exit unbounded"
    finally:
        stuck.close()


def test_a_stop_request_the_instant_the_port_opens_still_exits_cleanly(tmp_path):
    """Startup race: the route is bound before the server listens, so a request that arrives at the
    first moment the port accepts connections must be honoured, not lost or answered 503."""
    port = _free_port()
    env = {**os.environ, "AURA_HOME": str(tmp_path), "AURA_INSTANCE_TOKEN": TOKEN,
           "PYTHONPATH": str(ROOT / "backend")}
    proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "serve_central_agent_api.py"), str(port)],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        status = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and status is None:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            except OSError:
                time.sleep(0.01)
                continue
            status = _http_post(port, GOOD)[0]                  # no health wait in between
        assert status == 200
        assert proc.wait(timeout=GRACEFUL_TIMEOUT_S + 4) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
