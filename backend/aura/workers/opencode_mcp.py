"""Send an OpenCode task only after its Common Context MCP connection is real.

OpenCode 2.x connects a project's MCP servers asynchronously, a moment after
the first request for that project. ``opencode run --standalone`` builds its
first model request without waiting, so a task can reach the model with no
Common Context tools while everything looks normal. (Measured with OpenCode
2.2.6: an MCP server that took 6 s to start was still unconnected when the
first model step began.)

When OpenCode's resolved configuration declares the ``common-context`` server,
the task therefore runs against a private ``opencode serve``:

1. start the private server (free local port, one-time password),
2. ask OpenCode's own MCP client, through that server, until it reports
   ``common-context`` connected,
3. only then send the task with ``opencode run --server <url>``,
4. end the server and everything it started.

A spawned server, a parsed configuration or a listening port is never treated
as connectivity. If the connection fails, times out or the run is cancelled,
the task is NOT sent and :class:`McpNotReady` says why.

Every request to the private server, the gate's own and the runtime CLIs',
goes through an AURA-owned loopback relay (:mod:`aura.workers.server_identity`)
that forwards a connection only after the operating system shows the server
side of that exact connection held by the process AURA started. The address
printed on stdout is not trusted (the server's children share that pipe); it
only selects among the server's own listeners when it has more than one. No
credential, status request or task is sent before that check, and a failed
check refuses the run (``unverified-server``). Where the OS cannot be asked
(Windows, missing tools, permission denied) the run is refused
(``identity-unavailable``) rather than sent unverified. This binds connections
to a process, not to code: a plugin inside the server or a compromised runtime
is out of scope; see ``docs/COMMON_CONTEXT_GATE_SECURITY.md``.

When ``common-context`` is not configured there is nothing to wait for and the
task runs exactly as before. The private server is launched with the same
environment as the task (so the run's governance configuration applies to it)
and is never the user's background service.

Kilo Code (an OpenCode-lineage engine) is gated by the same code with its own
runtime profile (:data:`KILO`): its configuration declares servers under
``mcp.<name>``, its private ``kilo serve`` is protected by
``KILO_SERVER_PASSWORD``, connectivity is read from that server's own
``GET /mcp`` (structured JSON), and the task is sent with
``kilo run --attach <url>`` (its ``--dir`` kept). Because a Kilo task then
runs inside the private server, the server gets the task's exact environment
(``KILO_CONFIG`` and AURA's governance plugin) and is never started with
``--pure``, which would disable plugins. A connected Common Context proves
context connectivity only; it does not prove that policy is enforced.

This mirrors ``packages/ai-service/src/fabric/opencodeMcp.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from .server_identity import (
    IdentityMismatch,
    IdentityUnavailable,
    VerifiedRelay,
    default_backend,
    resolve_server,
)

CONTEXT_SERVER = "common-context"
READY_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.4
PROBE_TIMEOUT_MS = 15_000
# Kilo settles an MCP handshake within its own 30 s limit (measured with Kilo
# 7.5.14), and its GET /mcp answers only once that has happened. One request
# may therefore take a little over 30 s; the readiness deadline leaves room.
KILO_READY_TIMEOUT_S = 40.0
KILO_HTTP_TIMEOUT_S = 35.0
KILO_USERNAME = "kilo"
HTTP_BODY_LIMIT = 1_000_000
# The oldest Kilo this gate was verified against (debug config, serve on a
# self-chosen port, GET /mcp, run --attach).
KILO_MIN_VERIFIED = "7.5.14"

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
# The private server announces where it listens, e.g.
# "kilo server listening on http://127.0.0.1:39637" (Kilo 7.5.14) or
# "server listening on http://127.0.0.1:39091" (OpenCode 2.3.2). Each runtime's
# exact line, at the start of a line, on loopback. The announcement is NOT
# evidence of who listens (children share stdout); it only selects among
# listeners the OS shows the server itself holding.
_OPENCODE_LISTENING = re.compile(r"^server listening on (http://127\.0\.0\.1:(\d{1,5}))(?![\w.:])", re.MULTILINE)
_KILO_LISTENING = re.compile(r"^kilo server listening on (http://127\.0\.0\.1:(\d{1,5}))(?![\w.:])", re.MULTILINE)
# A CLI that does not know `debug config` (too old, or not this runtime).
_UNSUPPORTED_COMMAND = re.compile(
    r"unknown (command|argument|arguments)|not a valid command|unrecognized|invalid choice", re.IGNORECASE)


class McpNotReady(RuntimeError):
    """The task was not sent.

    ``reason`` is config-error | launch-failed | failed | timeout | cancelled
    | server-exited | lost | unverified-server | identity-unavailable.
    """

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def config_declares_server(debug_config_output: str, server: str = CONTEXT_SERVER,
                           *, layout: str = "opencode") -> bool:
    """Does the resolved configuration declare this MCP server, enabled?

    ``layout`` is where the runtime keeps its servers: ``"opencode"`` reads
    ``mcp.servers.<name>``, ``"kilo"`` reads ``mcp.<name>``.
    """
    parsed = _parse_resolved_config(debug_config_output)
    if parsed is None:
        return False

    def visit(value: Any, depth: int) -> bool:
        if depth > 12:
            return False
        if isinstance(value, dict):
            mcp = value.get("mcp")
            servers = (mcp if layout == "kilo" else mcp.get("servers")) if isinstance(mcp, dict) else None
            entry = servers.get(server) if isinstance(servers, dict) else None
            if isinstance(entry, dict) and entry.get("enabled") is not False:
                return True
            return any(visit(v, depth + 1) for v in value.values())
        if isinstance(value, list):
            return any(visit(v, depth + 1) for v in value)
        return False

    return visit(parsed, 0)


def _parse_resolved_config(debug_config_output: str) -> dict | None:
    """The resolved configuration as one object, or None when it cannot be read.

    OpenCode up to 2.2.x prints one configuration object. OpenCode 2.3.x prints
    the list of configuration layers it loaded, in load order, e.g.
    ``[{"type": "document", "path": ..., "info": {...config...}},
    {"type": "directory", "path": ...}]``; only document layers carry ``info``.
    Those ``info`` objects are merged, later layers taking precedence, into the
    same single object the old format gave. Anything else (an empty list, a
    list holding a non-object, a list with no configuration document, or text
    that is not JSON) is unreadable, and the gate fails closed on it.
    """
    text = debug_config_output or ""
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        return None
    try:
        parsed = json.loads(text[min(starts):])
    except ValueError:
        return None
    if isinstance(parsed, dict):
        return parsed
    if not isinstance(parsed, list) or not parsed or not all(isinstance(layer, dict) for layer in parsed):
        return None
    documents = [layer["info"] for layer in parsed if isinstance(layer.get("info"), dict)]
    if not documents:
        return None
    merged: dict = {}
    for document in documents:
        _merge_into(merged, document)
    return merged


def _merge_into(target: dict, layer: dict) -> None:
    """Deep-merge ``layer`` into ``target``; the later layer wins on a conflict."""
    for key, value in layer.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_into(target[key], value)
        else:
            target[key] = value


def server_status(list_output: str, server: str = CONTEXT_SERVER) -> tuple[str, str]:
    """(state, detail) for one server in ``opencode mcp list`` output.

    state is connected | failed | pending. Another server whose name merely
    starts with this one's is never mistaken for it.
    """
    pattern = re.compile(rf"(^|\s){re.escape(server)}\s+(.*)$")
    for line in _ANSI.sub("", list_output or "").splitlines():
        match = pattern.search(line)
        if not match:
            continue
        detail = match.group(2).strip()
        if re.match(r"connected\b", detail, re.IGNORECASE):
            return "connected", detail
        if re.match(r"(failed|needs authentication|disabled)", detail, re.IGNORECASE):
            return "failed", detail
        return "pending", detail
    return "pending", ""


def gated_args(args: list[str], url: str) -> list[str]:
    """The task argv re-pointed at the private server: ``--standalone`` out, ``--server`` in."""
    out = [a for a in args if a != "--standalone"]
    at = out.index("run") + 1 if "run" in out else 0
    return [*out[:at], "--server", url, *out[at:]]


def kilo_gated_args(args: list[str], url: str) -> list[str]:
    """A Kilo task argv attached to the private server; every other argument (``--dir``) kept.

    The password is never an argument: ``kilo run`` reads it from
    ``KILO_SERVER_PASSWORD`` in its environment.
    """
    out = list(args)
    at = out.index("run") + 1 if "run" in out else 0
    return [*out[:at], "--attach", url, *out[at:]]


_KILO_FAILED = {"failed", "disabled", "needs_auth", "needs_client_registration"}


def kilo_status(http_code: int, body: str, server: str = CONTEXT_SERVER) -> tuple[str, str]:
    """(state, detail) for one server from Kilo's ``GET /mcp``.

    state is connected | failed | pending. Kilo answers once each server's
    handshake has settled, e.g. ``{"common-context": {"status": "connected"}}``
    or ``{"common-context": {"status": "failed", "error": "Connection closed"}}``.
    A refused credential is a failure (it cannot get better by waiting); any
    other non-200 answer or unreadable body is still pending.
    """
    if http_code in (401, 403):
        return "failed", "the private Kilo server refused its one-time credentials"
    if http_code != 200:
        return "pending", ""
    try:
        parsed = json.loads(body or "")
    except ValueError:
        return "pending", ""
    entry = parsed.get(server) if isinstance(parsed, dict) else None
    if not isinstance(entry, dict):
        return "pending", ""
    status = str(entry.get("status") or "").lower()
    error = str(entry.get("error") or "")
    if status == "connected":
        return "connected", "connected"
    if status in _KILO_FAILED:
        return "failed", f"{status}: {error}" if error else status
    return "pending", status


def announced_ports(output: str | None, runtime: str) -> set[int]:
    """Every port announced on stdout with ``runtime``'s exact wording ("opencode" | "kilo").

    Only ``http://127.0.0.1:<port>`` with 1 <= port <= 65535, at the start of a
    line after ANSI colour codes are removed. Forged lines are expected and
    harmless: a port counts only if the OS shows the server process holding it.
    """
    pattern = _KILO_LISTENING if runtime == "kilo" else _OPENCODE_LISTENING
    ports = set()
    for match in pattern.finditer(_ANSI.sub("", output or "")):
        port = int(match.group(2))
        if 0 < port < 65536:
            ports.add(port)
    return ports


def _looks_unsupported(output: str) -> bool:
    return bool(_UNSUPPORTED_COMMAND.search(_ANSI.sub("", output or "")))


_IS_WINDOWS = os.name == "nt"
_which = shutil.which


def _kill_tree_windows(pid: int) -> None:
    """Windows has no process groups: taskkill /T reaches the whole tree (as exec_ does)."""
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=10,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)


def _popen_windows(command_line: str, cwd: str, env: dict[str, str]) -> subprocess.Popen:
    """A Windows .cmd/.bat shim, through cmd.exe as one pre-quoted line (as exec_.run_file does)."""
    return subprocess.Popen(
        command_line, cwd=cwd, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                       | getattr(subprocess, "CREATE_NO_WINDOW", 0)))


class _Server:
    """A private runtime server and everything it starts.

    ``proc`` is an asyncio subprocess, or a ``subprocess.Popen`` for a Windows
    .cmd shim run through cmd.exe. stdout (where the server announces its
    address) and stderr (its logs) are drained into bounded buffers.
    """

    def __init__(self, proc: Any):
        self._proc = proc
        self._out = b""
        self._log = b""
        self._popen = isinstance(proc, subprocess.Popen)
        self._readers: list[asyncio.Future] = []
        if self._popen:
            for stream, which in ((proc.stdout, "out"), (proc.stderr, "log")):
                threading.Thread(target=self._drain_sync, args=(stream, which), daemon=True).start()
        else:
            self._readers = [asyncio.ensure_future(self._drain(proc.stdout, "out")),
                             asyncio.ensure_future(self._drain(proc.stderr, "log"))]

    def _append(self, which: str, chunk: bytes) -> None:
        if which == "out":
            self._out = (self._out + chunk)[-200_000:]
        else:
            self._log = (self._log + chunk)[-200_000:]

    async def _drain(self, stream: Any, which: str) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return
            self._append(which, chunk)

    def _drain_sync(self, stream: Any, which: str) -> None:
        if stream is None:
            return
        read = getattr(stream, "read1", stream.read)
        while True:
            chunk = read(4096)
            if not chunk:
                return
            self._append(which, chunk)

    @property
    def pid(self) -> int:
        return int(self._proc.pid)

    def exited(self) -> bool:
        if self._popen:
            return self._proc.poll() is not None
        return self._proc.returncode is not None

    def output(self) -> str:
        return self._out.decode("utf-8", "replace")

    def log(self) -> str:
        return self._log.decode("utf-8", "replace")

    def _signal(self, sig: int) -> None:
        try:
            if _IS_WINDOWS:
                _kill_tree_windows(self._proc.pid)
            else:
                os.killpg(self._proc.pid, sig)
        except (ProcessLookupError, PermissionError, OSError, subprocess.SubprocessError):
            pass

    async def _wait(self, timeout_s: float) -> None:
        try:
            if self._popen:
                await asyncio.wait_for(asyncio.to_thread(self._proc.wait), timeout_s)
            else:
                await asyncio.wait_for(self._proc.wait(), timeout_s)
        except TimeoutError:
            pass

    async def stop(self) -> None:
        if not self.exited():
            self._signal(signal.SIGTERM)
            await self._wait(1.5)
        # The group (tree, on Windows) is swept even when the leader is gone:
        # an MCP child it started must not outlive the run.
        self._signal(signal.SIGKILL if not _IS_WINDOWS else signal.SIGTERM)
        await self._wait(2.0)
        for reader in self._readers:
            reader.cancel()


async def _start_server(binary: str, args: list[str], cwd: str, env: dict[str, str]) -> _Server:
    """Start the private server: allow-listed binary, resolved like every agent launch.

    A failure to start is a :class:`McpNotReady` (``launch-failed``), never a
    stray exception, so the task is refused cleanly.
    """
    from ..exec_ import resolve_agent_binary

    allowed = resolve_agent_binary(binary)
    if not allowed.ok:
        raise McpNotReady("launch-failed", f"{binary} is not an allowed agent, so no private server was started; "
                                           "the task was not sent.")
    path = _which(binary)
    if path is None:
        raise McpNotReady("launch-failed", f"{binary} is not installed, so its private server could not start; "
                                           "the task was not sent.")
    merged = {**os.environ, **env, "PWD": cwd}
    try:
        if _IS_WINDOWS and path.lower().endswith((".cmd", ".bat")):
            from ..environment.procexec import _windows_cmd_wrapper

            line = _windows_cmd_wrapper([path, *args])
            if line is None:
                raise McpNotReady("launch-failed", f"{binary}'s private server could not be launched safely "
                                                   "through cmd.exe; the task was not sent.")
            return _Server(_popen_windows(line, cwd, merged))
        proc = await asyncio.create_subprocess_exec(
            path, *args, cwd=cwd, env=merged,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)} if _IS_WINDOWS else {"start_new_session": True}),
        )
    except OSError as exc:
        raise McpNotReady("launch-failed", f"{binary}'s private server could not be started "
                                           f"({exc.strerror or type(exc).__name__}); the task was not sent.") from exc
    return _Server(proc)


class VerifiedEndpoints:
    """Opens the verified relay for a started server (see :mod:`.server_identity`)."""

    def __init__(self, backend: Any = None):
        self.backend = backend or default_backend()

    def available(self) -> tuple[bool, str]:
        return self.backend.available()

    async def open(self, server: Any, runtime: str) -> VerifiedRelay | None:
        """The relay, or None while the server is not listening yet.

        The port is one the OS shows the server process itself listening on.
        Only if it holds several is the announcement used, to choose among
        them; an announced port the server does not hold is ignored.
        """
        proc = await asyncio.to_thread(resolve_server, self.backend, server.pid)
        if proc is None:
            return None
        ports = await asyncio.to_thread(self.backend.listen_ports, proc)
        if len(ports) > 1:
            ports &= announced_ports(server.output(), runtime)
        if len(ports) != 1:
            return None
        relay = VerifiedRelay(self.backend, proc, ports.pop())
        try:
            await relay.start()
        except BaseException:
            await relay.close()
            raise
        return relay


RunAgent = Callable[..., Awaitable[Any]]
# (method, url, password, timeout_s) -> (http status code, body text). Raises an
# OSError (refused, reset, timed out, malformed answer) on a transport failure.
HttpRequest = Callable[[str, str, str, float], Awaitable[tuple[int, str]]]


class MalformedHttp(ConnectionError):
    """The private server's answer was not readable HTTP (a transport failure)."""


# What "not ready yet" may mean. Anything else is a defect and is not hidden.
_TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (OSError, EOFError)


async def _read_chunked(reader: asyncio.StreamReader) -> bytes:
    body = b""
    while True:
        size_line = await reader.readuntil(b"\r\n")
        size = int(size_line.split(b";", 1)[0].strip() or b"0", 16)
        if size == 0:
            return body
        chunk = await reader.readexactly(size)
        await reader.readexactly(2)
        body = (body + chunk)[:HTTP_BODY_LIMIT]


async def _http_exchange(method: str, url: str, password: str) -> tuple[int, str]:
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or not parts.port:
        raise ValueError("the private server URL must be http://127.0.0.1:<port>")
    reader, writer = await asyncio.open_connection("127.0.0.1", parts.port)
    try:
        token = base64.b64encode(f"{KILO_USERNAME}:{password}".encode()).decode()
        writer.write((f"{method} {parts.path or '/'} HTTP/1.1\r\nHost: 127.0.0.1:{parts.port}\r\n"
                      f"Authorization: Basic {token}\r\nAccept: application/json\r\n"
                      "Content-Length: 0\r\nConnection: close\r\n\r\n").encode())
        await writer.drain()
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            status_line, *header_lines = head.split("\r\n")
            version, code, *_ = status_line.split(" ", 2) + [""]
            if not version.startswith("HTTP/") or not code.isdigit():
                raise MalformedHttp("not an HTTP response")
            headers = {k.strip().lower(): v.strip() for k, _, v in (h.partition(":") for h in header_lines if h)}
            if headers.get("transfer-encoding", "").lower() == "chunked":
                body = await _read_chunked(reader)
            elif "content-length" in headers:
                body = await reader.readexactly(min(int(headers["content-length"]), HTTP_BODY_LIMIT))
            else:
                # No length given: the body runs until the server closes (Connection: close).
                body = b""
                while len(body) < HTTP_BODY_LIMIT:
                    chunk = await reader.read(HTTP_BODY_LIMIT - len(body))
                    if not chunk:
                        break
                    body += chunk
        except (ValueError, asyncio.LimitOverrunError) as exc:
            raise MalformedHttp("unreadable HTTP response") from exc
        return int(code), body[:HTTP_BODY_LIMIT].decode("utf-8", "replace")
    finally:
        writer.close()


async def _http_request(method: str, url: str, password: str, timeout_s: float) -> tuple[int, str]:
    """One loopback HTTP request, natively async: bounded, cancellable, never through a proxy."""
    return await asyncio.wait_for(_http_exchange(method, url, password), timeout_s)


@dataclass(frozen=True)
class Runtime:
    """What differs between the runtimes the gate supports; the gate itself is shared."""

    name: str
    binary: str
    runtime: str                     # which exact announcement is this runtime's: "opencode" | "kilo"
    config_args: tuple[str, ...]
    layout: str                      # where servers are declared: "opencode" | "kilo"
    password_env: str
    serve_args: tuple[str, ...]      # always --port 0: the server picks, then announces, its port
    task_args: Callable[[list[str], str], list[str]]
    ready_timeout_s: float
    http_status: bool                # True: read GET /mcp; False: `mcp list --server`
    min_verified: str | None = None  # named when the CLI does not know the config command


OPENCODE = Runtime(
    name="OpenCode", binary="opencode", runtime="opencode",
    config_args=("--standalone", "debug", "config"), layout="opencode",
    password_env="OPENCODE_PASSWORD",
    serve_args=("serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "info"),
    task_args=gated_args, ready_timeout_s=READY_TIMEOUT_S, http_status=False,
)

# Never `--pure` anywhere here: it disables plugins, and AURA's governance is a plugin.
KILO = Runtime(
    name="Kilo", binary="kilo", runtime="kilo",
    config_args=("debug", "config"), layout="kilo",
    password_env="KILO_SERVER_PASSWORD",
    serve_args=("serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "INFO"),
    task_args=kilo_gated_args, ready_timeout_s=KILO_READY_TIMEOUT_S, http_status=True,
    min_verified=KILO_MIN_VERIFIED,
)


async def _until_done_or_cancelled(coro: Awaitable[Any], cancel: asyncio.Event | None) -> tuple[bool, Any]:
    """(cancelled, result): a cancellation stops a request in flight (its socket is closed at once)."""
    task = asyncio.ensure_future(coro)
    if cancel is None:
        return False, await task
    stopper = asyncio.ensure_future(cancel.wait())
    try:
        await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stopper.cancel()
    if not task.done():
        task.cancel()
        try:
            await task
        except BaseException:  # noqa: BLE001 — the cancelled request's own outcome is not needed
            pass
        return True, None
    return False, task.result()


async def run_with_context_gate(
    rt: Runtime,
    run_agent: RunAgent,
    args: list[str],
    cwd: str,
    timeout_ms: int | None,
    *,
    env: dict[str, str] | None = None,
    cancel: asyncio.Event | None = None,
    binary: str | None = None,
    ready_timeout_s: float | None = None,
    start_server: Callable[..., Awaitable[Any]] = _start_server,
    http: HttpRequest = _http_request,
    endpoints: Any = None,
) -> tuple[Any, str]:
    """Run one task on ``rt``; returns ``(ProcessOutput, mcp)``.

    ``mcp`` is ``"connected"`` (Common Context was connected before the task
    was sent) or ``"not-configured"`` (nothing to wait for). Raises
    :class:`McpNotReady`, without sending the task, when Common Context is
    configured but did not connect.
    """
    binary = binary or rt.binary
    ready_timeout_s = rt.ready_timeout_s if ready_timeout_s is None else ready_timeout_s

    def cancelled() -> bool:
        return cancel is not None and cancel.is_set()

    def stop_error() -> McpNotReady:
        return McpNotReady("cancelled", f"The run was cancelled before {rt.name} was ready, so the task was not sent.")

    base: dict[str, Any] = {}
    if env:
        base["env"] = env
    if cancel is not None:
        base["cancel"] = cancel
    if cancelled():
        raise stop_error()

    try:
        config = await run_agent(binary, list(rt.config_args), cwd, PROBE_TIMEOUT_MS, **base)
    except Exception as exc:  # noqa: BLE001 — unreadable config must never bypass the MCP gate
        raise McpNotReady(
            "config-error", f"Could not read {rt.name}'s resolved configuration; the task was not sent.") from exc
    if cancelled():
        raise stop_error()
    if config.code != 0 or _parse_resolved_config(config.out) is None:
        hint = ""
        if rt.min_verified and _looks_unsupported(config.out):
            hint = (f" This {rt.name} does not appear to support `{' '.join(rt.config_args)}`; AURA's readiness "
                    f"check was verified with {rt.name} {rt.min_verified} or newer.")
        raise McpNotReady(
            "config-error",
            f"Could not read {rt.name}'s resolved configuration (exit {config.code}); the task was not sent.{hint}")
    declared = config_declares_server(config.out, layout=rt.layout)
    if not declared:
        return await run_agent(binary, args, cwd, timeout_ms, **base), "not-configured"

    endpoints = endpoints or VerifiedEndpoints()
    supported, why = endpoints.available()
    if not supported:
        raise McpNotReady("identity-unavailable", f"{rt.name}'s private server cannot be verified on this system "
                                                  f"({why}), so the task was not sent.")
    password = secrets.token_hex(24)
    gated_env = {**(env or {}), rt.password_env: password}
    probe_kwargs: dict[str, Any] = {"env": gated_env}
    if cancel is not None:
        probe_kwargs["cancel"] = cancel
    try:
        server = await start_server(binary, list(rt.serve_args), cwd, gated_env)
    except McpNotReady:
        raise
    except OSError as exc:
        raise McpNotReady("launch-failed", f"{rt.name}'s private server could not be started; "
                                           "the task was not sent.") from exc
    def exited_error() -> McpNotReady:
        tail = " | ".join([ln for ln in server.log().splitlines() if re.search(r"error|mcp", ln, re.I)][-3:])
        return McpNotReady(
            "server-exited",
            f"{rt.name}'s private server stopped before the task was sent, so the task was not sent."
            + (f" Last server messages: {tail[:300]}" if tail else ""))

    relay: Any = None

    def refuse_if_violated() -> None:
        """A connection the OS did not attribute to the server ends the run."""
        if relay is not None and relay.violations:
            first = relay.violations[0]
            raise McpNotReady(first.reason, f"{rt.name}: {first}; no credentials or task were sent to it, "
                                            "and the task was not sent.")

    async def probe(deadline: float) -> tuple[str, str]:
        if rt.http_status:
            limit = max(0.5, min(KILO_HTTP_TIMEOUT_S, deadline - time.monotonic()))
            try:
                stopped, answer = await _until_done_or_cancelled(http("GET", f"{relay.url}/mcp", password, limit), cancel)
            except _TRANSPORT_ERRORS:     # not listening yet, reset, timed out, unreadable: not ready
                return "pending", ""
            if stopped:
                raise stop_error()
            return kilo_status(*answer)
        out = await run_agent(binary, ["mcp", "list", "--server", relay.url], cwd, PROBE_TIMEOUT_MS, **probe_kwargs)
        return server_status(out.out) if out.code == 0 else ("pending", "")

    try:
        deadline = time.monotonic() + ready_timeout_s
        last = ""
        while True:
            if cancelled():
                raise stop_error()
            if server.exited():
                raise exited_error()
            if relay is None:
                try:
                    stopped, relay = await _until_done_or_cancelled(endpoints.open(server, rt.runtime), cancel)
                except IdentityMismatch as exc:
                    raise McpNotReady("unverified-server", f"{rt.name}'s private server could not be identified "
                                                           f"({exc}), so the task was not sent.") from exc
                except IdentityUnavailable as exc:
                    raise McpNotReady("identity-unavailable", f"{rt.name}'s private server could not be verified "
                                                              f"({exc}), so the task was not sent.") from exc
                if stopped:
                    raise stop_error()
            if relay is None:
                state, detail = "pending", "the private server is not listening yet"
            else:
                state, detail = await probe(deadline)
                refuse_if_violated()
            if cancelled():
                raise stop_error()
            if state == "connected":
                break
            if state == "failed":
                raise McpNotReady(
                    "failed", f"{rt.name} could not connect to Common Context ({detail[:200]}), so the task was not sent.")
            last = detail
            if time.monotonic() >= deadline:
                raise McpNotReady(
                    "timeout",
                    f"{rt.name} did not connect to Common Context within {round(ready_timeout_s)} seconds"
                    + (f" ({last[:120]})" if last else "") + ", so the task was not sent.")
            await asyncio.sleep(POLL_INTERVAL_S)

        if rt.http_status:
            # Kilo reports a dropped connection at once and does not restore it
            # by itself, so the connection is read once more right before the
            # task goes. If it was lost, exactly one reconnect is asked for,
            # through the same verified relay.
            if server.exited():
                raise exited_error()
            state, detail = await probe(time.monotonic() + KILO_HTTP_TIMEOUT_S)
            refuse_if_violated()
            if state != "connected":
                if cancelled():
                    raise stop_error()
                if server.exited():
                    raise exited_error()
                try:
                    stopped, _ = await _until_done_or_cancelled(
                        http("POST", f"{relay.url}/mcp/{CONTEXT_SERVER}/connect", password, KILO_HTTP_TIMEOUT_S), cancel)
                except _TRANSPORT_ERRORS:    # a failed reconnect is judged by the next read
                    stopped = False
                if stopped:
                    raise stop_error()
                refuse_if_violated()
                state, detail = await probe(time.monotonic() + KILO_HTTP_TIMEOUT_S)
                refuse_if_violated()
                if cancelled():
                    raise stop_error()
                if server.exited():
                    raise exited_error()
                if state != "connected":
                    raise McpNotReady(
                        "lost",
                        f"{rt.name}'s Common Context connection was lost before the task was sent and one "
                        f"reconnect did not restore it ({detail[:160] or 'no status'}), so the task was not sent.")

        if cancelled():
            raise stop_error()
        if server.exited():
            raise exited_error()
        refuse_if_violated()
        # The task talks only to the relay, whose every connection is verified;
        # its URL is fixed for the run and never re-read from stdout.
        result = await run_agent(binary, rt.task_args(args, relay.url), cwd, timeout_ms, **probe_kwargs)
        if relay.violations:
            first = relay.violations[0]
            raise McpNotReady(first.reason, f"{rt.name}: during the task, {first}. The result is not trusted.")
        return result, "connected"
    finally:
        try:
            if relay is not None:
                await relay.close()
        finally:
            await server.stop()


async def run_opencode(
    run_agent: RunAgent,
    args: list[str],
    cwd: str,
    timeout_ms: int | None,
    *,
    env: dict[str, str] | None = None,
    cancel: asyncio.Event | None = None,
    binary: str = "opencode",
    ready_timeout_s: float = READY_TIMEOUT_S,
    start_server: Callable[..., Awaitable[Any]] = _start_server,
    endpoints: Any = None,
) -> tuple[Any, str]:
    """Run one OpenCode task behind the gate (see :func:`run_with_context_gate`)."""
    return await run_with_context_gate(
        OPENCODE, run_agent, args, cwd, timeout_ms, env=env, cancel=cancel, binary=binary,
        ready_timeout_s=ready_timeout_s, start_server=start_server, endpoints=endpoints)


async def run_kilo(
    run_agent: RunAgent,
    args: list[str],
    cwd: str,
    timeout_ms: int | None,
    *,
    env: dict[str, str] | None = None,
    cancel: asyncio.Event | None = None,
    binary: str = "kilo",
    ready_timeout_s: float = KILO_READY_TIMEOUT_S,
    start_server: Callable[..., Awaitable[Any]] = _start_server,
    http: HttpRequest = _http_request,
    endpoints: Any = None,
) -> tuple[Any, str]:
    """Run one Kilo task behind the gate (see :func:`run_with_context_gate`)."""
    return await run_with_context_gate(
        KILO, run_agent, args, cwd, timeout_ms, env=env, cancel=cancel, binary=binary,
        ready_timeout_s=ready_timeout_s, start_server=start_server, http=http, endpoints=endpoints)
