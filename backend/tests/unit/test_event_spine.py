"""P2: live event spine — sequence, cursor replay, bounds, isolation.

The AgentEvent contract is canonical; the bus assigns monotonic seq,
the route replays bounded windows after a cursor and follows live.
Delivery is at-least-once with cursor dedupe (effectively-once);
audit stays authoritative.
"""

import queue
import threading
import time

import pytest

from aura.central_agent.events import EventBus, _StreamLagged
from aura.contracts import AgentEvent


def _ev(etype: str, sid: str, **payload) -> AgentEvent:
    return AgentEvent(type=etype, at="2026-09-09T00:00:00.000Z",
                      sessionId=sid, payload=dict(payload))


def test_seq_monotonic_and_present() -> None:
    bus = EventBus()
    bus.emit(_ev("session.started", "agt-1"))
    bus.emit(_ev("intent.compiled", "agt-1"))
    seqs = [e.seq for e in bus.tail]
    assert seqs == sorted(seqs) and all(isinstance(s, int) for s in seqs)
    assert seqs[1] == seqs[0] + 1


def test_tail_after_cursor_and_bound() -> None:
    bus = EventBus()
    for i in range(10):
        bus.emit(_ev("invocation.observed", "agt-1", n=i))
    after = bus.tail[4].seq
    assert after is not None
    replay = bus.tail_after("agt-1", after)
    assert [e.seq for e in replay] == [e.seq for e in bus.tail[5:]]
    assert len(bus.tail_after("agt-1", None, limit=3)) == 3
    assert bus.tail_after("agt-1", 10 ** 9) == []


def test_session_filter_no_cross_session_leak() -> None:
    bus = EventBus()
    bus.emit(_ev("intent.compiled", "agt-1"))
    bus.emit(_ev("plan.created", "agt-2"))
    bus.emit(_ev("execution.started", "-"))
    got = bus.tail_after("agt-1", None)
    assert {e.type for e in got} == {"intent.compiled", "execution.started"}
    assert all(e.sessionId in ("agt-1", "-") for e in got)


def test_live_follow_order_and_filter() -> None:
    bus = EventBus()
    pump, close = bus.subscribe_live("agt-1")
    try:
        got: list = []

        def drain(n: int) -> None:
            for _ in range(n):
                got.append(pump(timeout=5))

        threading.Thread(target=lambda: [
            bus.emit(_ev("invocation.observed", "agt-1", n=i)) for i in range(3)],
            daemon=True).start()
        drain(3)
        assert [e.payload.get("n") for e in got] == [0, 1, 2]
        bus.emit(_ev("plan.created", "agt-9"))
        with pytest.raises(queue.Empty):
            pump(timeout=0.3)
    finally:
        close()
    assert bus.subscriber_count() == 0


def test_lagged_consumer_signals_resync() -> None:
    bus = EventBus()
    bus.LIVE_QUEUE_MAX = 2
    try:
        pump, close = bus.subscribe_live("agt-1")
        try:
            for i in range(6):
                bus.emit(_ev("invocation.observed", "agt-1", n=i))
            # Buffered frames drain first; exhaustion with drops
            # outstanding signals resync instead of silent skipping.
            assert pump(timeout=5).payload.get("n") == 0
            assert pump(timeout=5).payload.get("n") == 1
            with pytest.raises(_StreamLagged):
                pump(timeout=5)
        finally:
            close()
    finally:
        bus.LIVE_QUEUE_MAX = 200


def test_disconnect_cleans_up() -> None:
    bus = EventBus()
    _, close1 = bus.subscribe_live("agt-1")
    _, close2 = bus.subscribe_live("agt-2")
    assert bus.subscriber_count() == 2
    close1()
    assert bus.subscriber_count() == 1
    close2()
    assert bus.subscriber_count() == 0


def _live_server(monkeypatch, tmp_path, port: int):
    """Real uvicorn server on a loopback port: TestClient cannot hold
    open infinite SSE streams, so live-follow is proven over real HTTP
    like production serves it."""
    import os
    import urllib.request

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.api.server import create_app

    app = create_app()
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{base}/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    return base, server


def _http_post(base: str, path: str, body: dict):
    import json as _json
    import urllib.request

    req = urllib.request.Request(
        base + path, data=_json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, _json.loads(resp.read())


def _http_get(base: str, path: str):
    import urllib.request

    with urllib.request.urlopen(base + path, timeout=15) as resp:
        return resp.status, resp.read()


def test_http_replay_cursor_and_scope(tmp_path, monkeypatch) -> None:
    base, server = _live_server(monkeypatch, tmp_path, 44321)
    try:
        status, body = _http_post(
            base, "/agent/sessions",
            {"message": "Explain this project briefly",
             "projectId": "p1"})
        assert status == 200, body
        sid = body["sessionId"]
        frames = _read_frames(base, f"/agent/sessions/{sid}/events?after=0",
                              want=3, timeout=15)
        types = [f["type"] for f in frames]
        assert "session.started" in types, types
        seqs = [f["seq"] for f in frames if isinstance(f.get("seq"), int)]
        assert seqs == sorted(seqs) and len(seqs) >= 2
        last = seqs[-1]
        # Reconnect from cursor: only newer frames, none duplicated.
        frames2 = _read_frames(
            base, f"/agent/sessions/{sid}/events?after={last}",
            want=1, timeout=8, allow_empty=True)
        assert all(f.get("seq", last + 1) > last for f in frames2
                   if isinstance(f.get("seq"), int))
        # Unknown session and malformed cursor fail safely.
        st404, _ = _http_get_status(
            base, "/agent/sessions/agt-000000000000/events")
        assert st404 == 404
        st400, _ = _http_get_status(
            base, f"/agent/sessions/{sid}/events?after=nope")
        assert st400 == 400
        st400b, _ = _http_get_status(
            base, f"/agent/sessions/{sid}/events?after=-5")
        assert st400b == 400
    finally:
        server.should_exit = True


def _http_get_status(base: str, path: str) -> tuple:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(base + path, timeout=15) as resp:
            return resp.status, None
    except urllib.error.HTTPError as exc:
        return exc.code, None


def _read_frames(base: str, path: str, want: int, timeout: float,
                 allow_empty: bool = False) -> list:
    """Read SSE data frames over a real socket until `want` arrive or
    the timeout lapses, then close (mirrors a client disconnect)."""
    import json as _json
    import socket

    host, _, port = base.replace("http://", "").partition(":")
    frames: list = []
    sock = socket.create_connection((host, int(port)), timeout=timeout)
    try:
        sock.sendall(f"GET {path} HTTP/1.1\r\nHost: x\r\n"
                     "Connection: close\r\n\r\n".encode())
        sock.settimeout(timeout)
        buf = b""
        deadline = time.monotonic() + timeout
        while len(frames) < want and time.monotonic() < deadline:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                for line in block.decode("utf-8", "replace").split("\n"):
                    if line.startswith("data:"):
                        text = line[5:].strip()
                        if text in ("", "[DONE]"):
                            continue
                        try:
                            frames.append(_json.loads(text))
                        except ValueError:
                            pass  # malformed, like the UI
    finally:
        try:
            sock.close()
        except OSError:
            pass
    assert allow_empty or frames, "expected frames from live stream"
    return frames


def test_http_live_delivery_and_cancel_close(tmp_path, monkeypatch) -> None:
    base, server = _live_server(monkeypatch, tmp_path, 44322)
    try:
        _, body = _http_post(base, "/agent/sessions",
                             {"message": "Explain this project briefly"})
        sid = body["sessionId"]
        frames = _read_frames(base, f"/agent/sessions/{sid}/events?after=0",
                              want=2, timeout=15)
        assert frames[0].get("seq", 0) <= frames[1].get("seq", 0)
        # Closing the socket is the disconnect: a fresh reconnect with
        # the cursor must still work and only replay newer frames.
        last = max(f.get("seq", 0) for f in frames)
        frames_again = _read_frames(
            base, f"/agent/sessions/{sid}/events?after={last}",
            want=1, timeout=8, allow_empty=True)
        assert all(f.get("seq", last + 1) > last for f in frames_again
                   if isinstance(f.get("seq"), int))
    finally:
        server.should_exit = True
