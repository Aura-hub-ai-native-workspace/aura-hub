"""Bounded live-SSE client for tests against the live-follow event route.

`GET /agent/sessions/{sid}/events` intentionally never terminates, so
a plain blocking GET hangs forever. This helper consumes the stream
incrementally over a real socket: it stops at a caller-supplied
terminal condition, enforces an explicit deadline, closes
deterministically, and reports the last observed frames (with session
correlation) when the terminal event never arrives.

Only stdlib is used; no production code is touched.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any


class SseTimeout(AssertionError):
    """Terminal event not observed before the deadline.

    Carries the frames seen so far plus the session id so a failure
    names what the stream actually delivered instead of just timing out.
    """

    def __init__(self, session_id: str, want: str, frames: list[dict],
                 raw_tail: str = "") -> None:
        self.session_id = session_id
        self.want = want
        self.frames = frames
        types = [f.get("type") for f in frames[-8:]]
        super().__init__(
            f"session {session_id}: terminal condition {want!r} not met; "
            f"last event types: {types}; frames seen: {len(frames)}"
            + (f"; tail bytes: {raw_tail[-200:]!r}" if raw_tail else ""))


class SseConnectionError(AssertionError):
    """The stream could not be opened at all (refused/reset/HTTP error)."""

    def __init__(self, base: str, path: str, detail: str) -> None:
        super().__init__(f"GET {base}{path} failed: {detail}")


def _parse_block(block: str) -> dict | None:
    """One SSE block -> event dict, or None for heartbeat/empty/sentinel.

    Raises ValueError with the offending payload on malformed JSON so
    callers can surface it instead of silently skipping evidence.
    """
    data_lines = [line[5:].strip() for line in block.split("\n")
                  if line.startswith("data:")]
    if not data_lines:
        return None  # heartbeat comment or unknown block: liveness only
    text = "\n".join(data_lines)
    if text in ("", "[DONE]"):
        return None
    try:
        event = json.loads(text)
    except ValueError as exc:
        raise ValueError(f"malformed SSE data payload: {text[:200]!r}") from exc
    if not isinstance(event, dict):
        raise ValueError(f"non-object SSE event: {text[:200]!r}")
    return event


def read_frames(base: str, path: str, *, want_frames: int = 0,
                terminal_types: frozenset[str] = frozenset(),
                timeout_s: float = 30.0,
                session_id: str = "",
                extra_headers: dict | None = None) -> list[dict]:
    """Read data frames until `want_frames` arrive or a frame whose
    ``type`` is in `terminal_types` arrives; then close deterministically.

    Raises SseTimeout (with observed frames) when the deadline passes
    first, SseConnectionError when the stream cannot be opened, and
    ValueError on malformed JSON payloads. At least one of `want_frames`
    / `terminal_types` must be given.
    """
    if not want_frames and not terminal_types:
        raise ValueError("read_frames needs want_frames or terminal_types")
    host, _, port_s = base.replace("http://", "").partition(":")
    port = int(port_s or 80)
    frames: list[dict] = []
    raw_tail = ""
    try:
        sock = socket.create_connection((host, port), timeout=timeout_s)
    except OSError as exc:
        raise SseConnectionError(base, path, str(exc)) from exc
    try:
        request_target = (
            f"GET {path} HTTP/1.1\r\nHost: x\r\n"
            + "".join(f"{k}: {v}\r\n"
                      for k, v in (extra_headers or {}).items())
            + "Connection: close\r\n\r\n")
        sock.sendall(request_target.encode())
        sock.settimeout(timeout_s)
        buf = b""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if want_frames and len(frames) >= want_frames:
                break
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                text = block.decode("utf-8", "replace")
                raw_tail = text[-200:]
                try:
                    event = _parse_block(text)
                except ValueError as exc:
                    raise ValueError(
                        f"session {session_id}: {exc}") from exc
                if event is None:
                    continue
                frames.append(event)
                if event.get("type") in terminal_types:
                    return frames
                if want_frames and len(frames) >= want_frames:
                    return frames
    finally:
        try:
            sock.close()
        except OSError:
            pass
    # The deadline passed (or the server closed the stream) without
    # meeting the caller's stop condition: report what WAS observed so
    # the failure names the stream's actual behavior. In particular an
    # "expect empty" probe surfaces as SseTimeout with frames == [].
    raise SseTimeout(
        session_id or "?",
        f"{want_frames} frames" if want_frames
        else str(sorted(terminal_types)),
        frames, raw_tail)


def boot_live_server(monkeypatch, tmp_path, app_factory,
                     port: int = 0) -> tuple[str, Any]:
    """Boot a real uvicorn server for `app_factory()` on an ephemeral
    loopback port with an isolated AURA_HOME. Returns (base_url, server);
    the caller sets `server.should_exit = True` in a finally block.

    Ephemeral ports avoid collisions between parallel test workers.
    """
    import urllib.request

    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        app_factory(), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    bound = None
    for _ in range(100):
        servers = getattr(server, "servers", None) or []
        sockets = (servers[0].sockets if servers else None) or []
        if sockets:
            bound = sockets[0].getsockname()[1]
            break
        if not thread.is_alive():
            raise SseConnectionError("uvicorn", "",
                                     "server thread died during startup")
        time.sleep(0.1)
    if bound is None:
        server.should_exit = True
        raise SseConnectionError("uvicorn", "",
                                 "server did not bind a port in time")
    base = f"http://127.0.0.1:{bound}"
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{base}/health", timeout=2)
            return base, server
        except Exception:
            time.sleep(0.1)
    server.should_exit = True
    raise SseConnectionError(base, "/health", "health check never passed")
