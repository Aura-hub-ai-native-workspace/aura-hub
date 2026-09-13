"""Regression tests for the bounded live-SSE test helper itself.

The helper is test infrastructure with real semantics (deadlines,
terminal detection, diagnostics), so it gets its own tests against a
tiny stdlib fake SSE server — no AURA code involved, fully
deterministic, no sleeps beyond the timeout under test.
"""

import json
import threading

import pytest

from .sse_live import (
    SseConnectionError,
    SseTimeout,
    boot_live_server,
    read_frames,
)


class FakeSseServer:
    """Minimal chunked SSE endpoint with scripted blocks."""

    def __init__(self, blocks, close_after=False):
        from http.server import BaseHTTPRequestHandler, HTTPServer

        payload = b"".join(blocks)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = payload
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                if close_after:
                    return

            def log_message(self, *a):
                pass

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *a):
        self._server.shutdown()
        self._thread.join(timeout=10)


def _block(etype, seq=None):
    event = {"type": etype, "at": "t", "sessionId": "agt-1", "payload": {}}
    if seq is not None:
        event["seq"] = seq
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}data: {json.dumps(event)}\n\n".encode()


def test_terminal_event_consumed_then_stream_closed():
    blocks = [_block("session.started", 1), _block("result.ready", 2),
              _block("agent.failed", 3)]
    with FakeSseServer(blocks) as srv:
        frames = read_frames(srv.base, "/x", terminal_types={"result.ready"},
                             timeout_s=10.0, session_id="agt-1")
    assert [f["type"] for f in frames] == ["session.started", "result.ready"]


def test_missing_terminal_times_out_with_diagnostics():
    blocks = [_block("session.started", 1), _block("intent.compiled", 2)]
    with FakeSseServer(blocks) as srv:
        try:
            read_frames(srv.base, "/x",
                        terminal_types=frozenset({"result.ready"}),
                        timeout_s=3.0, session_id="agt-77")
            raised = False
        except SseTimeout as exc:
            raised = True
            assert exc.session_id == "agt-77"
            assert [f["type"] for f in exc.frames] == [
                "session.started", "intent.compiled"]
            assert "result.ready" in str(exc)
    assert raised, "missing terminal must time out, not hang"


def test_malformed_data_produces_useful_failure():
    blocks = [_block("session.started", 1), b"data: {not json\n\n"]
    with FakeSseServer(blocks) as srv:
        try:
            read_frames(srv.base, "/x", want_frames=5, timeout_s=10.0,
                        session_id="agt-9")
            raised = False
        except ValueError as exc:
            raised = True
            assert "agt-9" in str(exc) and "{not json" in str(exc)
    assert raised, "malformed payload must fail loudly with context"


def test_connection_failure_reported_clearly():
    import socket

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    dead_port = probe.getsockname()[1]
    probe.close()
    try:
        read_frames(f"http://127.0.0.1:{dead_port}", "/x",
                    want_frames=1, timeout_s=5.0, session_id="agt-1")
        raised = False
    except SseConnectionError as exc:
        raised = True
        assert str(dead_port) in str(exc)
    assert raised, "refused connections must not hang or pass silently"


def test_no_plain_get_usage_in_migrated_tests():
    """Guard: the migrated E2E tests must not open the live-follow route
    with unbounded clients (plain TestClient `.get()`, which blocks
    forever on a stream that never terminates). Workflow-run streams
    terminate and may keep their inline parsing."""
    import pathlib

    for name in ("test_real_spine_e2e.py", "test_final_reverification.py"):
        src = (pathlib.Path(__file__).parent / name).read_text()
        for i, line in enumerate(src.splitlines(), 1):
            stripped = line.strip()
            if "/events" not in stripped:
                continue
            bad = (".get(" in stripped and "agent/sessions" in stripped) \
                or ("urlopen(" in stripped and "events" in stripped
                    and "sse_live" not in stripped)
            assert not bad, \
                f"{name}:{i}: unbounded events read: {stripped}"
