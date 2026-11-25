"""An OpenCode task is sent only after OpenCode's own MCP client reports Common Context connected."""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

from aura.exec_ import ProcessOutput, run_agent
from aura.workers.opencode_mcp import (
    McpNotReady,
    config_declares_server,
    gated_args,
    kilo_gated_args,
    kilo_status,
    run_kilo,
    run_opencode,
    server_status,
)

CONFIGURED = json.dumps({"sources": [{"info": {"mcp": {"servers": {"common-context": {"type": "local"}}}}}]})
NOT_CONFIGURED = json.dumps({"sources": [{"info": {"mcp": {"servers": {}}}}]})
# OpenCode 2.3.x `debug config`: the list of configuration layers it loaded, in
# load order. Recorded shape (paths and command shortened); only document
# layers carry `info`.
LAYERED_CONFIGURED = json.dumps([
    {"type": "document", "path": "/home/u/.config/opencode/opencode.json",
     "info": {"mcp": {"servers": {"common-context": {
         "type": "local", "command": ["common-context-mcp"],
         "environment": {"CONTEXT_MCP_AGENT_ID": "opencode"}}}}}},
    {"type": "directory", "path": "/home/u/.config/opencode"},
])
LAYERED_NOT_CONFIGURED = json.dumps([
    {"type": "document", "path": "/home/u/.config/opencode/opencode.json",
     "info": {"mcp": {"servers": {"other": {"type": "local"}}}}},
    {"type": "directory", "path": "/home/u/.config/opencode"},
])
PENDING = "No MCP servers configured\n"
CONNECTED = "\x1b[32m✓\x1b[0m common-context  connected\n"
FAILED = "✗ common-context  failed: spawn common-context-mcp ENOENT\n"
TASK = ["run", "--standalone", "--auto", "--model", "m", "do the work"]


class _Server:
    """A scripted private server. It announces `url` on its own stdout after
    `announce_after` reads (None: never)."""

    def __init__(self, exits_after: int | None = None, url: str = "http://127.0.0.1:45678",
                 announce_after: int | None = 0):
        self.stopped = 0
        self.exits_after = exits_after
        self.lists = 0
        self._url, self.announce_after, self.url_reads = url, announce_after, 0

    def url(self):
        self.url_reads += 1
        if self.announce_after is None or self.url_reads <= self.announce_after:
            return None
        return self._url

    def exited(self):
        return self.exits_after is not None and self.lists >= self.exits_after

    def log(self):
        return 'level=ERROR message="mcp transport error" server=common-context'

    async def stop(self):
        self.stopped += 1


class _AnnouncedRelay:
    def __init__(self, url):
        self.url, self.violations, self.closed = url, [], 0

    async def close(self):
        self.closed += 1


class _AnnouncedEndpoints:
    """TEST-ONLY stand-in for the verified relay: the scripted server's URL as is.

    The scripted servers below have no process or socket, so these tests cover
    the readiness logic (waiting, failure, reconnect, cancellation). The
    security boundary itself (process ownership of every connection) is covered
    by the real-process adversarial tests at the end of this file, which use
    the production ``VerifiedEndpoints``.
    """

    def available(self):
        return True, "test stand-in"

    async def open(self, server, runtime):
        url = server.url()
        return _AnnouncedRelay(url) if url else None


class _Script:
    """A scripted OpenCode: one reply per `mcp list`, the last one repeating."""

    def __init__(self, lists, config=CONFIGURED, config_code=0, exits_after=None, on_list=None):
        self.lists, self.config, self.on_list = lists, config, on_list
        self.config_code = config_code
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []
        self.server = _Server(exits_after)
        self.started = False

    async def run_agent(self, binary, args, cwd, timeout_ms, **kwargs):
        self.calls.append(list(args))
        self.envs.append(kwargs.get("env"))
        if "debug" in args:
            return ProcessOutput(out=self.config, code=self.config_code)
        if args[0] == "mcp":
            if self.on_list:
                self.on_list(self.server.lists)
            reply = self.lists[min(self.server.lists, len(self.lists) - 1)]
            self.server.lists += 1
            return ProcessOutput(out=reply, code=0)
        return ProcessOutput(out="task finished", code=0)

    async def start_server(self, binary, args, cwd, env):
        self.started = True
        return self.server

    def task_calls(self):
        return [c for c in self.calls if c and c[0] == "run"]

    async def go(self, **kwargs):
        return await run_opencode(self.run_agent, TASK, "/p", 60_000, start_server=self.start_server,
                                  endpoints=_AnnouncedEndpoints(), **kwargs)


def test_reading_opencode_output():
    assert config_declares_server(CONFIGURED) is True
    assert config_declares_server(NOT_CONFIGURED) is False
    assert config_declares_server("not json") is False
    assert config_declares_server(json.dumps({"mcp": {"servers": {"common-context": {"enabled": False}}}})) is False
    assert server_status(CONNECTED)[0] == "connected"
    assert server_status(FAILED)[0] == "failed"
    assert server_status(PENDING)[0] == "pending"
    # Another server with a longer name is never mistaken for this one.
    assert server_status("✓ common-context-extra  connected\n")[0] == "pending"
    assert server_status("⚠ common-context  needs authentication\n")[0] == "failed"


def test_reading_opencode_2_3_layered_configuration():
    assert config_declares_server(LAYERED_CONFIGURED) is True
    assert config_declares_server(LAYERED_NOT_CONFIGURED) is False
    # Layers merge in load order, so a later layer that disables the server wins…
    disabled_later = json.dumps([
        json.loads(LAYERED_CONFIGURED)[0],
        {"type": "document", "path": "/p/opencode.json",
         "info": {"mcp": {"servers": {"common-context": {"enabled": False}}}}},
    ])
    assert config_declares_server(disabled_later) is False
    # …and a later layer can add the server to one that did not declare it.
    added_later = json.dumps([
        json.loads(LAYERED_NOT_CONFIGURED)[0],
        {"type": "document", "path": "/p/opencode.json",
         "info": {"mcp": {"servers": {"common-context": {"type": "local"}}}}},
    ])
    assert config_declares_server(added_later) is True
    # Log text before the JSON is skipped, as for the object format.
    assert config_declares_server("INFO loading config\n" + LAYERED_CONFIGURED) is True


async def test_opencode_2_3_layered_configuration_is_gated_like_the_object_format(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _Script([PENDING, CONNECTED], config=LAYERED_CONFIGURED)
    res, mcp = await s.go()
    assert mcp == "connected"
    assert s.started is True
    assert s.task_calls()[-1][:3] == ["run", "--server", "http://127.0.0.1:45678"]


async def test_opencode_2_3_layered_configuration_without_common_context_runs_as_before():
    s = _Script([CONNECTED], config=LAYERED_NOT_CONFIGURED)
    res, mcp = await s.go()
    assert mcp == "not-configured"
    assert s.calls[-1] == TASK
    assert s.started is False and s.server.lists == 0


def test_the_task_argv_is_repointed_at_the_private_server():
    assert gated_args(TASK, "http://127.0.0.1:1") == [
        "run", "--server", "http://127.0.0.1:1", "--auto", "--model", "m", "do the work"]


async def test_a_delayed_mcp_start_is_waited_out_and_the_task_goes_last(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _Script([PENDING, PENDING, PENDING, CONNECTED])
    res, mcp = await s.go()
    assert (res.out, mcp) == ("task finished", "connected")
    assert s.server.lists == 4
    assert s.calls[-1] == ["run", "--server", "http://127.0.0.1:45678", "--auto", "--model", "m", "do the work"]
    assert len(s.task_calls()) == 1
    assert s.server.stopped == 1


async def test_ready_at_once_sends_the_task_with_the_password_only_in_env():
    s = _Script([CONNECTED])
    res, mcp = await s.go(env={"KEEP": "1"})
    assert mcp == "connected"
    sent_env = s.envs[-1]
    assert sent_env["KEEP"] == "1" and len(sent_env["OPENCODE_PASSWORD"]) == 48
    assert sent_env["OPENCODE_PASSWORD"] not in " ".join(s.calls[-1])
    assert s.server.stopped == 1


async def test_a_failed_connection_sends_nothing_and_says_why(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _Script([PENDING, FAILED])
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "failed" and "ENOENT" in str(err.value)
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_a_connection_that_never_arrives_times_out_and_sends_nothing(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0.01)
    s = _Script([PENDING])
    with pytest.raises(McpNotReady) as err:
        await s.go(ready_timeout_s=0.1)
    assert err.value.reason == "timeout"
    assert s.server.lists > 2 and s.task_calls() == [] and s.server.stopped == 1


async def test_a_server_that_exits_is_not_mistaken_for_connectivity(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _Script([PENDING], exits_after=2)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "server-exited" and "mcp transport error" in str(err.value)
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_cancellation_while_waiting_sends_nothing_and_cleans_up(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    cancel = asyncio.Event()
    s = _Script([PENDING], on_list=lambda n: cancel.set() if n == 1 else None)
    with pytest.raises(McpNotReady) as err:
        await s.go(cancel=cancel)
    assert err.value.reason == "cancelled"
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_cancelled_before_it_begins_starts_nothing():
    cancel = asyncio.Event()
    cancel.set()
    s = _Script([CONNECTED])
    with pytest.raises(McpNotReady):
        await s.go(cancel=cancel)
    assert s.calls == [] and s.started is False


async def test_not_configured_runs_exactly_as_before_without_a_private_server():
    s = _Script([CONNECTED], config=NOT_CONFIGURED)
    res, mcp = await s.go()
    assert mcp == "not-configured"
    assert s.calls[-1] == TASK
    assert s.started is False and s.server.lists == 0


@pytest.mark.parametrize("config,code", [
    ("invalid configuration", 1),
    ("not JSON", 0),
    ("[]", 0),
    ("[1, 2]", 0),
    ('[{"type": "document", "path": "/x"}, "text"]', 0),
    ('[{"type": "directory", "path": "/home/u/.config/opencode"}]', 0),
])
async def test_unreadable_resolved_config_fails_closed_without_sending_task(config, code):
    s = _Script([CONNECTED], config=config, config_code=code)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "config-error"
    assert s.task_calls() == []
    assert s.started is False


# ── with a real process: the real allow-list, spawn and process-group teardown ──

def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


ADVERSARY = Path(__file__).resolve().parents[1] / "fixtures" / "gate_adversary.py"


def _install_adversary(tmp: Path, runtime: str, *, wrapper: str | None = None, **cfg) -> None:
    """Install the shared fake runtime (``tests/fixtures/gate_adversary.py``) as ``runtime`` on PATH.

    ``wrapper=None`` execs it directly (the spawned process is the server);
    ``"node"`` puts an npm-style node launcher in front (as Kilo's bin/kilo);
    ``"node-two"`` is a launcher that starts two processes (ambiguous).
    """
    (tmp / "adv.json").write_text(json.dumps({"dir": str(tmp), "runtime": runtime, **cfg}))
    env = f'GATE_ADVERSARY="{tmp}/adv.json"'
    script = tmp / runtime
    if wrapper is None:
        script.write_text(f'#!/bin/sh\n{env} exec "{sys.executable}" "{ADVERSARY}" "$@"\n')
    else:
        node = __import__("shutil").which("node")
        extra = ("spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {stdio: 'ignore'});"
                 if wrapper == "node-two" else "")
        script.write_text(f"""#!{node}
const {{ spawn }} = require('child_process');
process.env.GATE_ADVERSARY = {json.dumps(str(tmp / "adv.json"))};
{extra}
const child = spawn({json.dumps(sys.executable)}, [{json.dumps(str(ADVERSARY))}, ...process.argv.slice(2)], {{ stdio: 'inherit' }});
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
child.on('exit', (code) => process.exit(code ?? 0));
""")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)


def _install(tmp: Path, delay) -> None:
    _install_adversary(tmp, "opencode", connect_delay=None if delay == "never" else delay)


def _task_after_connected(tmp: Path) -> bool:
    """The real server received the task, and only after it had answered status requests."""
    log = [json.loads(line) for line in (tmp / "server.log").read_text().splitlines()]
    return (tmp / "task.json").exists() and log[-1]["path"].endswith("/task") and \
        any(e["path"].endswith("/mcp") for e in log[:-1]) and all(e["auth_ok"] for e in log)


async def _gone(tmp: Path) -> bool:
    pids = [int((tmp / name).read_text().strip()) for name in ("server.pid", "grandchild.pid")]
    end = time.monotonic() + 5
    while time.monotonic() < end and any(_alive(p) for p in pids):
        await asyncio.sleep(0.05)
    left = [p for p in pids if _alive(p)]
    for p in left:
        os.kill(p, 9)
    return not left


posix = pytest.mark.skipif(sys.platform == "win32", reason="process groups are POSIX")


@posix
async def test_real_process_sends_after_a_delayed_connection_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install(tmp_path, 2)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    res, mcp = await run_opencode(run_agent, TASK, str(tmp_path), 20_000)
    assert mcp == "connected" and res.code == 0
    assert _task_after_connected(tmp_path)
    assert await _gone(tmp_path)


@posix
async def test_real_process_times_out_without_sending_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install(tmp_path, "never")
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    with pytest.raises(McpNotReady) as err:
        await run_opencode(run_agent, TASK, str(tmp_path), 20_000, ready_timeout_s=1.5)
    assert err.value.reason == "timeout"
    assert not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


@posix
async def test_real_process_cancellation_sends_nothing_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install(tmp_path, "never")
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    cancel = asyncio.Event()
    pending = asyncio.ensure_future(run_opencode(run_agent, TASK, str(tmp_path), 20_000, cancel=cancel))
    end = time.monotonic() + 5
    while time.monotonic() < end and not (tmp_path / "grandchild.pid").exists():
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.1)
    cancel.set()
    with pytest.raises(McpNotReady) as err:
        await pending
    assert err.value.reason == "cancelled"
    assert not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


# ══ Kilo: the same gate with Kilo's runtime profile ══════════════════════════
#
# Kilo 7.5.14 (measured): servers are declared under `mcp.<name>`; a private
# `kilo serve` is protected by KILO_SERVER_PASSWORD; its GET /mcp answers, once
# each handshake has settled, with structured JSON; the task is sent with
# `kilo run --attach <url>`. A dropped connection is reported at once and not
# restored by Kilo itself, so exactly one reconnect is asked for before giving up.

KILO_CONFIGURED = json.dumps({"mcp": {"common-context": {"type": "local", "command": ["common-context-mcp"]}}})
KILO_NOT_CONFIGURED = json.dumps({"mcp": {"other": {"type": "local"}}})
KILO_DISABLED = json.dumps({"mcp": {"common-context": {"type": "local", "enabled": False}}})
KILO_TASK = ["run", "--dir", "/p", "--auto", "do the work"]


def _mcp(status: str, error: str = "") -> tuple[int, str]:
    entry = {"status": status, **({"error": error} if error else {})}
    return 200, json.dumps({"common-context": entry})


K_CONNECTED = _mcp("connected")
K_UNAVAILABLE = _mcp("failed", "ENOENT: no such file or directory, posix_spawn '/x/common-context-mcp'")
K_HANDSHAKE_TIMEOUT = _mcp("failed", "Operation timed out after 30000ms")
K_LOST = _mcp("failed", "Connection closed")


class _KiloScript:
    """A scripted Kilo: one GET /mcp answer per call (the last repeats); a list entry
    that is an Exception is raised (not listening yet, reset, timed out)."""

    def __init__(self, gets, config=KILO_CONFIGURED, config_code=0, exits_after=None,
                 reconnect_ok=True, on_get=None):
        self.gets, self.config, self.config_code = gets, config, config_code
        self.reconnect_ok, self.on_get = reconnect_ok, on_get
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []
        self.requests: list[tuple[str, str]] = []
        self.passwords: set[str] = set()
        self.server = _Server(exits_after, url="http://127.0.0.1:45679")
        self.server_env: dict | None = None
        self.server_args: list[str] | None = None
        self.started = False
        self.get_calls = 0

    async def run_agent(self, binary, args, cwd, timeout_ms, **kwargs):
        assert binary == "kilo"
        self.calls.append(list(args))
        self.envs.append(kwargs.get("env"))
        if args[:2] == ["debug", "config"]:
            return ProcessOutput(out=self.config, code=self.config_code)
        return ProcessOutput(out="task finished", code=0)

    async def start_server(self, binary, args, cwd, env):
        self.started, self.server_args, self.server_env = True, list(args), dict(env)
        return self.server

    async def http(self, method, url, password, timeout_s):
        self.requests.append((method, url))
        self.passwords.add(password)
        if method == "POST":
            if self.reconnect_ok:
                self.gets = [K_CONNECTED]
                self.get_calls = 0
            return 200, "true"
        if self.on_get:
            self.on_get(self.get_calls)
        reply = self.gets[min(self.get_calls, len(self.gets) - 1)]
        self.get_calls += 1
        self.server.lists += 1
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            return await reply()
        return reply

    def task_calls(self):
        return [c for c in self.calls if c and c[0] == "run"]

    async def go(self, **kwargs):
        return await run_kilo(self.run_agent, KILO_TASK, "/p", 60_000, start_server=self.start_server,
                              http=self.http, endpoints=_AnnouncedEndpoints(), **kwargs)


def test_reading_kilo_output():
    assert config_declares_server(KILO_CONFIGURED, layout="kilo") is True
    assert config_declares_server(KILO_NOT_CONFIGURED, layout="kilo") is False
    assert config_declares_server(KILO_DISABLED, layout="kilo") is False
    # Each runtime reads only its own layout, so OpenCode's detection is unchanged.
    assert config_declares_server(KILO_CONFIGURED) is False
    assert config_declares_server(CONFIGURED, layout="kilo") is False
    assert kilo_status(*K_CONNECTED) == ("connected", "connected")
    assert kilo_status(*K_UNAVAILABLE)[0] == "failed"
    assert kilo_status(*K_HANDSHAKE_TIMEOUT) == ("failed", "failed: Operation timed out after 30000ms")
    assert kilo_status(401, "")[0] == "failed"
    assert kilo_status(503, "")[0] == "pending"
    assert kilo_status(200, "not json")[0] == "pending"
    assert kilo_status(200, json.dumps({"other": {"status": "connected"}}))[0] == "pending"
    assert kilo_status(*_mcp("disabled"))[0] == "failed"


def test_the_kilo_task_argv_is_attached_and_keeps_its_directory():
    assert kilo_gated_args(KILO_TASK, "http://127.0.0.1:1") == [
        "run", "--attach", "http://127.0.0.1:1", "--dir", "/p", "--auto", "do the work"]


async def test_kilo_connected_sends_the_task_through_attach_with_the_password_only_in_env():
    s = _KiloScript([K_CONNECTED])
    res, mcp = await s.go(env={"KILO_CONFIG": "/aura/kilo.jsonc", "KEEP": "1"})
    assert mcp == "connected" and res.out == "task finished"
    task = s.task_calls()
    assert task == [["run", "--attach", "http://127.0.0.1:45679", "--dir", "/p", "--auto", "do the work"]]
    password = s.envs[-1]["KILO_SERVER_PASSWORD"]
    assert len(password) >= 32 and s.passwords == {password}
    # Never on any command line, never `--pure` (it would disable the governance plugin).
    assert not any(password in a for c in s.calls for a in c)
    assert not any(password in a for a in s.server_args)
    assert all("--pure" not in c for c in [*s.calls, s.server_args])
    # The private server runs with the task's exact environment (KILO_CONFIG, plugin).
    assert s.server_env == {"KILO_CONFIG": "/aura/kilo.jsonc", "KEEP": "1", "KILO_SERVER_PASSWORD": password}
    assert s.calls[0] == ["debug", "config"]
    assert s.requests[0] == ("GET", "http://127.0.0.1:45679/mcp")
    assert s.server.stopped == 1


async def test_kilo_waits_while_its_server_is_not_listening_yet_and_sends_last(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    order: list[str] = []
    s = _KiloScript([ConnectionRefusedError(), ConnectionRefusedError(), K_CONNECTED],
                    on_get=lambda n: order.append(f"get{n}"))
    real = s.run_agent

    async def tracked(*a, **k):
        if a[1] and a[1][0] == "run":
            order.append("task")
        return await real(*a, **k)

    s.run_agent = tracked
    _, mcp = await s.go()
    assert mcp == "connected"
    assert order[-1] == "task" and order.count("task") == 1


@pytest.mark.parametrize("reply,needle", [
    (K_UNAVAILABLE, "ENOENT"),
    (K_HANDSHAKE_TIMEOUT, "Operation timed out after 30000ms"),
    ((401, ""), "refused its one-time credentials"),
])
async def test_kilo_unavailable_context_sends_nothing_and_says_why(reply, needle):
    s = _KiloScript([reply])
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "failed" and needle in str(err.value)
    assert s.task_calls() == []
    assert s.server.stopped == 1


async def test_kilo_no_answer_within_the_deadline_times_out_and_sends_nothing(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _KiloScript([TimeoutError()])
    with pytest.raises(McpNotReady) as err:
        await s.go(ready_timeout_s=0.05)
    assert err.value.reason == "timeout"
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_kilo_server_that_exits_is_not_mistaken_for_connectivity(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _KiloScript([ConnectionRefusedError()], exits_after=2)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "server-exited"
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_kilo_connection_lost_before_sending_is_reconnected_once_then_sent():
    s = _KiloScript([K_CONNECTED, K_LOST])        # verified, then dropped before the task
    res, mcp = await s.go()
    assert mcp == "connected"
    assert [m for m, _ in s.requests].count("POST") == 1
    assert ("POST", "http://127.0.0.1:45679/mcp/common-context/connect") in s.requests
    assert len(s.task_calls()) == 1
    # The reconnect was confirmed by a fresh read before the task went.
    assert s.requests[-1] == ("GET", "http://127.0.0.1:45679/mcp")


async def test_kilo_failed_reconnect_sends_nothing():
    s = _KiloScript([K_CONNECTED, K_LOST], reconnect_ok=False)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "lost" and "Connection closed" in str(err.value)
    assert [m for m, _ in s.requests].count("POST") == 1      # exactly one attempt
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_kilo_initial_failure_is_never_retried():
    s = _KiloScript([K_UNAVAILABLE, K_CONNECTED])
    with pytest.raises(McpNotReady):
        await s.go()
    assert [m for m, _ in s.requests] == ["GET"]
    assert s.task_calls() == []


async def test_kilo_cancelled_before_it_begins_starts_nothing():
    cancel = asyncio.Event()
    cancel.set()
    s = _KiloScript([K_CONNECTED])
    with pytest.raises(McpNotReady) as err:
        await s.go(cancel=cancel)
    assert err.value.reason == "cancelled"
    assert s.calls == [] and s.started is False


async def test_kilo_cancellation_during_a_blocked_status_request_sends_nothing_and_cleans_up():
    cancel = asyncio.Event()

    async def handshake_in_progress():          # Kilo's GET /mcp blocks until it settles
        await asyncio.sleep(30)
        return K_CONNECTED

    s = _KiloScript([handshake_in_progress])
    pending = asyncio.ensure_future(s.go(cancel=cancel))
    while s.get_calls == 0:
        await asyncio.sleep(0.01)
    started = time.monotonic()
    cancel.set()
    with pytest.raises(McpNotReady) as err:
        await pending
    assert err.value.reason == "cancelled"
    assert time.monotonic() - started < 2           # did not wait for the request to finish
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_kilo_cancellation_before_the_reconnect_sends_nothing():
    cancel = asyncio.Event()
    s = _KiloScript([K_CONNECTED, K_LOST], on_get=lambda n: cancel.set() if n == 1 else None)
    with pytest.raises(McpNotReady) as err:
        await s.go(cancel=cancel)
    assert err.value.reason == "cancelled"
    assert s.task_calls() == [] and s.server.stopped == 1


@pytest.mark.parametrize("config", [KILO_NOT_CONFIGURED, KILO_DISABLED])
async def test_kilo_without_enabled_common_context_runs_exactly_as_before(config):
    s = _KiloScript([K_CONNECTED], config=config)
    res, mcp = await s.go()
    assert mcp == "not-configured"
    assert s.calls[-1] == KILO_TASK
    assert s.started is False and s.requests == []


@pytest.mark.parametrize("config,code", [
    ("invalid configuration", 1),
    ("not JSON", 0),
    ("[]", 0),
    ("[1, 2]", 0),
])
async def test_kilo_unreadable_resolved_config_fails_closed_without_sending_task(config, code):
    s = _KiloScript([K_CONNECTED], config=config, config_code=code)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "config-error"
    assert s.task_calls() == [] and s.started is False


# ── the executor routes only OpenCode and Kilo, and only on this computer ─────

@pytest.mark.parametrize("bin_name,argv_prefix,gated", [
    ("kilo", None, True),
    ("opencode", None, True),
    ("claude", None, False),
    ("codex", None, False),
    ("kilo", ["sandbox-exec", "--"], False),
    ("opencode", ["sandbox-exec", "--"], False),
])
async def test_the_executor_gates_only_opencode_and_kilo_outside_a_sandbox(monkeypatch, bin_name, argv_prefix, gated):
    import aura.executors as executors

    seen: list[list[str]] = []

    async def fake_run_agent(binary, args, cwd, timeout_ms, **kwargs):
        seen.append(list(args))
        if "debug" in args:   # neither runtime declares Common Context here
            return ProcessOutput(out=json.dumps({"mcp": {"servers": {}}}), code=0)
        return ProcessOutput(out="task finished", code=0)

    monkeypatch.setattr(executors, "run_agent", fake_run_agent)
    governance: dict = {}
    task = ["run", "the task"]
    res = await executors._run_governed(bin_name, task, "/p", 60_000, governance, [], argv_prefix=argv_prefix)
    assert res.out == "task finished"
    assert seen[-1] == task
    if gated:
        assert seen[0][-2:] == ["debug", "config"]
        assert governance["contextMcp"] == "not-configured"
    else:
        assert seen == [task]
        assert "contextMcp" not in governance


async def test_the_executor_reports_a_kilo_gate_refusal_as_a_failed_run(monkeypatch):
    import aura.executors as executors

    async def unreadable(binary, args, cwd, timeout_ms, **kwargs):
        return ProcessOutput(out="boom", code=1)

    monkeypatch.setattr(executors, "run_agent", unreadable)
    governance: dict = {}
    res = await executors._run_governed("kilo", ["run", "t"], "/p", 60_000, governance, [])
    assert res.code == 1 and "Kilo" in res.out and "not sent" in res.out
    assert governance["contextMcp"] == "not-ready:config-error"


# ── Kilo with a real process: real spawn, real HTTP, real process-group teardown ──

def _install_kilo(tmp: Path, mode: str, delay: float = 0) -> None:
    _install_adversary(tmp, "kilo", connect_delay=None if mode == "never" else delay)


@posix
async def test_real_kilo_process_sends_after_a_delayed_connection_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install_kilo(tmp_path, "delayed", delay=1.5)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    task = ["run", "--dir", str(tmp_path), "do the work"]
    res, mcp = await run_kilo(run_agent, task, str(tmp_path), 20_000)
    assert mcp == "connected" and res.code == 0
    record = json.loads((tmp_path / "task.json").read_text())
    assert _task_after_connected(tmp_path) and record["password_in_env"] is True
    assert record["argv"][:2] == ["run", "--attach"] and record["argv"][3:5] == ["--dir", str(tmp_path)]
    assert "--pure" not in record["argv"]
    assert "--pure" not in json.loads((tmp_path / "serve-args.json").read_text())
    assert await _gone(tmp_path)


@posix
async def test_real_kilo_process_times_out_without_sending_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install_kilo(tmp_path, "never")
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    with pytest.raises(McpNotReady) as err:
        await run_kilo(run_agent, ["run", "--dir", str(tmp_path), "x"], str(tmp_path), 20_000, ready_timeout_s=2.0)
    assert err.value.reason == "timeout"
    assert not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


@posix
async def test_real_kilo_process_cancellation_sends_nothing_and_leaves_nothing_running(tmp_path, monkeypatch):
    _install_kilo(tmp_path, "never")
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    cancel = asyncio.Event()
    pending = asyncio.ensure_future(
        run_kilo(run_agent, ["run", "--dir", str(tmp_path), "x"], str(tmp_path), 20_000, cancel=cancel))
    end = time.monotonic() + 5
    while time.monotonic() < end and not (tmp_path / "grandchild.pid").exists():
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    cancel.set()
    with pytest.raises(McpNotReady) as err:
        await pending
    assert err.value.reason == "cancelled"
    assert not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


# ══ Review findings: regression tests ═══════════════════════════════════════

import io  # noqa: E402
import subprocess  # noqa: E402

import aura.workers.opencode_mcp as gate  # noqa: E402
from aura.workers.opencode_mcp import (  # noqa: E402
    KILO,
    OPENCODE,
    MalformedHttp,
    _http_request,
    _until_done_or_cancelled,
    announced_ports,
)


# ── M1: the address comes only from the server AURA started ────────────────

def test_only_a_loopback_announcement_in_the_runtime_s_own_words_is_read():
    assert announced_ports("kilo server listening on http://127.0.0.1:39637\n", "kilo") == {39637}
    assert announced_ports("server listening on http://127.0.0.1:39091", "opencode") == {39091}
    assert announced_ports("INFO boot\n\x1b[32mkilo server listening on http://127.0.0.1:5\x1b[0m\n", "kilo") == {5}
    assert announced_ports("server listening on http://127.0.0.1:1\r\n", "opencode") == {1}
    assert announced_ports("kilo server listening on http://127.0.0.1:65535\r\n", "kilo") == {65535}
    for text in ["server listening on http://0.0.0.0:4096", "server listening on http://192.0.2.7:4096",
                 "server listening on http://127.0.0.1:0", "server listening on http://127.0.0.1:65536",
                 "server listening on http://127.0.0.1.evil:80", "plugin: server listening on http://127.0.0.1:9",
                 "\tserver listening on http://127.0.0.1:9", "opencode server listening on http://127.0.0.1:9",
                 "kilo server listening on http://127.0.0.1:9", "starting", ""]:
        assert announced_ports(text, "opencode") == set(), text
    assert announced_ports("server listening on http://127.0.0.1:9", "kilo") == set()
    # Several announcements are all reported; which one is real is decided by the OS, not by the text.
    assert announced_ports("kilo server listening on http://127.0.0.1:7\nkilo server listening on "
                           "http://127.0.0.1:8\n", "kilo") == {7, 8}


def test_both_runtimes_let_their_server_choose_its_own_port():
    assert OPENCODE.serve_args[OPENCODE.serve_args.index("--port") + 1] == "0"
    assert KILO.serve_args[KILO.serve_args.index("--port") + 1] == "0"
    assert "--pure" not in KILO.serve_args and "--pure" not in KILO.config_args


async def test_kilo_waits_for_its_server_to_announce_and_talks_only_to_that_address(monkeypatch):
    monkeypatch.setattr("aura.workers.opencode_mcp.POLL_INTERVAL_S", 0)
    s = _KiloScript([K_CONNECTED])
    s.server.announce_after = 3
    _, mcp = await s.go()
    assert mcp == "connected"
    assert s.server.url_reads >= 4
    assert {url for _, url in s.requests} <= {"http://127.0.0.1:45679/mcp"}
    assert s.task_calls()[0][:3] == ["run", "--attach", "http://127.0.0.1:45679"]


async def test_kilo_server_that_never_announces_times_out_without_any_request():
    s = _KiloScript([K_CONNECTED])
    s.server.announce_after = None
    with pytest.raises(McpNotReady) as err:
        await s.go(ready_timeout_s=0.05)
    assert err.value.reason == "timeout" and "not listening yet" in str(err.value)
    assert s.requests == [] and s.task_calls() == [] and s.server.stopped == 1


async def test_opencode_server_that_never_announces_times_out_without_probing():
    s = _Script([CONNECTED])
    s.server.announce_after = None
    with pytest.raises(McpNotReady) as err:
        await s.go(ready_timeout_s=0.05)
    assert err.value.reason == "timeout"
    assert s.server.lists == 0 and s.task_calls() == [] and s.server.stopped == 1


# ── M2: contextMcp reaches the executor's result ───────────────────────────

def _git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture()
def git_project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _git(str(root), "init", "-q")
    _git(str(root), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    return str(root)


class _Out:
    def __init__(self, out="", code=0):
        self.out, self.code, self.timedOut, self.signal = out, code, False, None


@pytest.mark.parametrize("node,config,expected", [
    ({"id": "opencode", "name": "OpenCode", "binary": "opencode"}, '{"mcp":{"servers":{}}}', "not-configured"),
    ({"id": "kilo-code", "name": "Kilo Code", "binary": "kilo"}, '{"mcp":{}}', "not-configured"),
    ({"id": "kilo-code", "name": "Kilo Code", "binary": "kilo"}, "Error: Unknown command: debug", "not-ready:config-error"),
])
def test_the_executor_result_records_what_was_established_about_common_context(
        monkeypatch, git_project, node, config, expected):
    import aura.executors as ex

    async def fake_run(bin_name, args, cwd, timeout_ms=None, env=None, **kw):
        if args[-2:] == ["debug", "config"]:
            return _Out(out=config, code=0 if config.startswith("{") else 1)
        return _Out(out="done", code=0)

    monkeypatch.setattr(ex, "run_agent", fake_run)
    out = asyncio.run(ex.agent_delegate_run({
        "input": {"task": "do the thing"},
        "context": {"cwd": git_project, "actor": {"kind": "agent", "id": "t"}},
        "node": node}))
    assert out["output"]["contextMcp"] == expected, out
    if expected.startswith("not-ready"):
        assert out["ok"] is False and "not sent" in out["output"]["stdout"]


# ── M3: launch, including Windows .cmd shims, and tree teardown ─────────────

async def test_a_runtime_that_is_not_installed_is_a_clean_launch_refusal(monkeypatch):
    monkeypatch.setattr(gate, "_which", lambda name: None)
    with pytest.raises(McpNotReady) as err:
        await gate._start_server("kilo", ["serve"], "/p", {})
    assert err.value.reason == "launch-failed" and "not installed" in str(err.value)


async def test_only_an_allowed_agent_binary_can_be_started_as_a_private_server():
    with pytest.raises(McpNotReady) as err:
        await gate._start_server("bash", ["-c", "true"], "/p", {})
    assert err.value.reason == "launch-failed"


async def test_a_spawn_error_is_a_clean_launch_refusal(monkeypatch, tmp_path):
    monkeypatch.setattr(gate, "_which", lambda name: str(tmp_path / "no-such-kilo"))
    with pytest.raises(McpNotReady) as err:
        await gate._start_server("kilo", ["serve"], str(tmp_path), {})
    assert err.value.reason == "launch-failed"


async def test_the_gate_reports_a_server_start_failure_as_launch_failed_and_sends_nothing():
    s = _KiloScript([K_CONNECTED])

    async def failing_start(*a, **k):
        raise PermissionError(13, "Permission denied")

    s.start_server = failing_start
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "launch-failed" and s.task_calls() == []


class _FakeWindowsPopen(subprocess.Popen):
    """Stands in for a cmd.exe-launched npm shim; never spawns anything."""

    def __init__(self, line):  # noqa: D107 — deliberately does not call Popen.__init__
        self.line, self.pid, self.killed = line, 7777, False
        self.stdout = io.BytesIO(b"kilo server listening on http://127.0.0.1:43210\r\n")
        self.stderr = io.BytesIO(b"INFO started\r\n")
        self.returncode = None

    def poll(self):
        return 0 if self.killed else None

    def wait(self, timeout=None):
        return 0

    def __del__(self):
        pass


async def test_windows_cmd_shim_runs_through_cmd_exe_and_stops_as_a_whole_tree(monkeypatch):
    import aura.environment.procexec as procexec

    wrapped: list[list[str]] = []
    trees: list[int] = []
    procs: list[_FakeWindowsPopen] = []
    monkeypatch.setattr(gate, "_IS_WINDOWS", True)
    monkeypatch.setattr(gate, "_which", lambda name: r"C:\Users\u\AppData\Roaming\npm\kilo.cmd")
    monkeypatch.setattr(procexec, "_windows_cmd_wrapper",
                        lambda argv: wrapped.append(list(argv)) or 'cmd.exe /d /s /c "kilo.cmd serve"')

    def fake_popen(line, cwd, env):
        procs.append(_FakeWindowsPopen(line))
        assert env["KILO_SERVER_PASSWORD"] == "p" and env["PWD"] == "C:\\p"
        return procs[-1]

    def fake_tree_kill(pid):
        trees.append(pid)
        procs[-1].killed = True

    monkeypatch.setattr(gate, "_popen_windows", fake_popen)
    monkeypatch.setattr(gate, "_kill_tree_windows", fake_tree_kill)
    server = await gate._start_server("kilo", list(KILO.serve_args), "C:\\p", {"KILO_SERVER_PASSWORD": "p"})
    assert wrapped == [[r"C:\Users\u\AppData\Roaming\npm\kilo.cmd", *KILO.serve_args]]
    assert procs[0].line == 'cmd.exe /d /s /c "kilo.cmd serve"'
    end = time.monotonic() + 2
    while not gate.announced_ports(server.output(), "kilo") and time.monotonic() < end:
        await asyncio.sleep(0.01)
    assert gate.announced_ports(server.output(), "kilo") == {43210}
    await server.stop()
    assert trees and set(trees) == {7777}          # taskkill /F /T on the shim's whole tree
    assert server.exited()


def test_windows_tree_kill_uses_taskkill_on_the_whole_tree(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(gate.subprocess, "run", lambda argv, **kw: calls.append(argv))
    gate._kill_tree_windows(4242)
    assert calls == [["taskkill", "/F", "/T", "/PID", "4242"]]


# ── M4: Kilo without `debug config` support ────────────────────────────────

@pytest.mark.parametrize("out,code", [
    ("Error: Unknown command: debug", 1),
    ("error: unknown arguments: debug, config", 1),
])
async def test_a_kilo_without_debug_config_is_refused_and_names_the_verified_version(out, code):
    s = _KiloScript([K_CONNECTED], config=out, config_code=code)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "config-error" and "7.5.14" in str(err.value)
    assert s.task_calls() == [] and s.started is False


async def test_opencode_config_error_wording_is_unchanged():
    s = _Script([CONNECTED], config="Error: Unknown command: debug", config_code=1)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert str(err.value) == "Could not read OpenCode's resolved configuration (exit 1); the task was not sent."


# ── L1/L2: cancellation and server exit are named for what they are ────────

async def test_kilo_cancellation_during_the_confirming_read_after_a_reconnect_is_cancelled():
    cancel = asyncio.Event()
    s = _KiloScript([K_CONNECTED, K_LOST], reconnect_ok=False,
                    on_get=lambda n: cancel.set() if n == 2 else None)
    with pytest.raises(McpNotReady) as err:
        await s.go(cancel=cancel)
    assert err.value.reason == "cancelled"
    assert s.task_calls() == [] and s.server.stopped == 1


async def test_kilo_server_exiting_after_verification_is_server_exited_not_lost():
    s = _KiloScript([K_CONNECTED], exits_after=1)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "server-exited"
    assert [m for m, _ in s.requests] == ["GET"] and s.task_calls() == []


async def test_kilo_server_exiting_before_the_reconnect_is_server_exited():
    s = _KiloScript([K_CONNECTED, K_LOST], reconnect_ok=False, exits_after=2)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "server-exited"
    assert "POST" not in [m for m, _ in s.requests] and s.task_calls() == []


async def test_opencode_server_exiting_after_connection_never_receives_the_task():
    s = _Script([CONNECTED], exits_after=1)
    with pytest.raises(McpNotReady) as err:
        await s.go()
    assert err.value.reason == "server-exited" and s.task_calls() == []


# ── L4/L5: the loopback HTTP client, and errors that are not hidden ─────────

async def _serve_once(handler):
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    return server, f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"


async def test_the_http_client_reads_length_chunked_and_bounded_bodies():
    async def length(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{"a": "b"}xyz')
        await writer.drain(); writer.close()

    async def chunked(reader, writer):
        req = await reader.readuntil(b"\r\n\r\n")
        assert b"Authorization: Basic " in req
        writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")
        await writer.drain(); writer.close()

    async def huge(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\n\r\n" + b"x" * (gate.HTTP_BODY_LIMIT + 5000))
        await writer.drain(); writer.close()

    for handler, check in [(length, lambda c, b: (c, b) == (200, '{"a": "b"}xyz')),
                           (chunked, lambda c, b: (c, b) == (200, "hello world")),
                           (huge, lambda c, b: c == 200 and len(b) == gate.HTTP_BODY_LIMIT)]:
        server, url = await _serve_once(handler)
        try:
            code, body = await _http_request("GET", f"{url}/mcp", "pw", 5)
            assert check(code, body), (code, body[:40])
        finally:
            server.close()


async def test_a_malformed_answer_is_a_transport_failure():
    async def junk(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"SSH-2.0-not-http\r\n\r\n")
        await writer.drain(); writer.close()

    server, url = await _serve_once(junk)
    try:
        with pytest.raises(MalformedHttp) as err:
            await _http_request("GET", f"{url}/mcp", "pw", 5)
        assert isinstance(err.value, OSError)
    finally:
        server.close()


async def test_cancelling_a_status_read_closes_its_connection_at_once():
    closed = asyncio.Event()

    async def silent(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        await reader.read()          # returns once AURA closes its side
        closed.set()

    server, url = await _serve_once(silent)
    cancel = asyncio.Event()
    try:
        pending = asyncio.ensure_future(_until_done_or_cancelled(_http_request("GET", f"{url}/mcp", "pw", 30), cancel))
        await asyncio.sleep(0.2)
        started = time.monotonic()
        cancel.set()
        assert await pending == (True, None)
        await asyncio.wait_for(closed.wait(), 2)
        assert time.monotonic() - started < 2
    finally:
        server.close()


async def test_the_http_client_never_goes_through_a_configured_proxy(monkeypatch):
    async def ok(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
        await writer.drain(); writer.close()

    server, url = await _serve_once(ok)
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    try:
        assert await _http_request("GET", f"{url}/mcp", "pw", 5) == (200, "{}")
    finally:
        server.close()


async def test_a_programming_error_while_reading_status_is_not_hidden_as_not_ready():
    s = _KiloScript([KeyError("bug")])
    with pytest.raises(KeyError):
        await s.go()
    assert s.task_calls() == [] and s.server.stopped == 1


# ══ The security boundary: adversarial real-process tests ═══════════════════
#
# Every test below runs the production gate (default VerifiedEndpoints: the
# AURA-owned relay that forwards a connection only after the OS shows the
# server side of that exact connection held by the server process AURA
# started) against tests/fixtures/gate_adversary.py: a real server, a real CLI
# and a real impostor child that inherits the server's environment (it knows
# the one-time password), shares its stdout (it prints exact announcements)
# and speaks the full protocol (401 for a wrong password, "connected" for the
# right one). The impostor records every byte it ever receives. Each scenario
# runs with the Linux /proc method and with the lsof method macOS uses.

from aura.workers import server_identity as ident  # noqa: E402
from aura.workers.opencode_mcp import VerifiedEndpoints  # noqa: E402

linux = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the /proc method is Linux-only")
BACKENDS = [pytest.param("procfs", marks=linux),
            pytest.param("lsof", marks=pytest.mark.skipif(
                not ident.Lsof().available()[0] or sys.platform == "win32", reason="lsof/ps not available"))]
SECRET_TASK = "the secret task text"


async def _no_process_left(tmp: Path) -> bool:
    """No process started for this test (its environment names the test's directory) is still alive."""
    marker = str(tmp).encode()
    end = time.monotonic() + 5
    while True:
        left = []
        for entry in os.listdir("/proc"):
            if entry.isdigit() and int(entry) != os.getpid():
                try:
                    if marker in Path(f"/proc/{entry}/environ").read_bytes():
                        left.append(int(entry))
                except OSError:
                    pass
        if not left or time.monotonic() > end:
            return not left
        await asyncio.sleep(0.05)


def _backend(name):
    return ident.Procfs() if name == "procfs" else ident.Lsof()


def _impostor_traffic(tmp: Path) -> tuple[int, int]:
    """(connections the impostor accepted, bytes it received)."""
    log = tmp / "impostor.log"
    if not log.exists():
        return 0, 0
    entries = [json.loads(line) for line in log.read_text().splitlines()]
    return sum(1 for e in entries if e.get("accepted")), sum(e.get("bytes", 0) for e in entries)


def _nothing_reached_the_impostor(tmp: Path) -> bool:
    text = (tmp / "impostor.log").read_text() if (tmp / "impostor.log").exists() else ""
    password = ""
    if (tmp / "server.log").exists() or (tmp / "server.pid").exists():
        pid = (tmp / "server.pid").read_text().strip() if (tmp / "server.pid").exists() else ""
        try:
            environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if pid else []
            password = next((e.split(b"=", 1)[1].decode() for e in environ
                             if e.split(b"=", 1)[0] in (b"KILO_SERVER_PASSWORD", b"OPENCODE_PASSWORD")), "")
        except OSError:
            pass
    return _impostor_traffic(tmp)[1] == 0 and SECRET_TASK not in text and (not password or password not in text)


async def _gate(runtime: str, tmp: Path, backend: str | None = "procfs", **kwargs):
    # Never let a test reach a real runtime: the fake must be what PATH resolves first.
    first = Path(os.environ["PATH"].split(os.pathsep)[0]) / runtime
    assert first.exists() and "gate_adversary.py" in first.read_text(), f"{runtime} on PATH is not the test adversary"
    endpoints = VerifiedEndpoints(_backend(backend)) if backend else None
    if runtime == "kilo":
        return await run_kilo(run_agent, ["run", "--dir", str(tmp), SECRET_TASK], str(tmp), 20_000,
                              endpoints=endpoints, **kwargs)
    return await run_opencode(run_agent, ["run", "--standalone", SECRET_TASK], str(tmp), 20_000,
                              endpoints=endpoints, **kwargs)


def _on_path(monkeypatch, tmp: Path) -> None:
    monkeypatch.setenv("PATH", f"{tmp}{os.pathsep}{os.environ['PATH']}")


@posix
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("runtime", ["opencode", "kilo"])
async def test_a_forged_announcement_before_the_real_one_never_reaches_the_impostor(tmp_path, monkeypatch, runtime, backend):
    # The impostor prints an exact announcement 1 s before the real server listens.
    _install_adversary(tmp_path, runtime, attack="forge_first", attack_delay=1.0)
    _on_path(monkeypatch, tmp_path)
    res, mcp = await _gate(runtime, tmp_path, backend, ready_timeout_s=15)
    assert mcp == "connected" and res.code == 0
    assert (tmp_path / "impostor.port").exists()             # the attack really ran
    assert _task_after_connected(tmp_path)                   # the task reached the real server
    assert _impostor_traffic(tmp_path) == (0, 0)             # the impostor was never even contacted
    assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("runtime", ["opencode", "kilo"])
async def test_a_forged_announcement_after_the_real_one_is_ignored(tmp_path, monkeypatch, runtime):
    _install_adversary(tmp_path, runtime, attack="forge_late", connect_delay=0.5)
    _on_path(monkeypatch, tmp_path)
    _, mcp = await _gate(runtime, tmp_path)
    assert mcp == "connected" and _task_after_connected(tmp_path)
    assert _impostor_traffic(tmp_path) == (0, 0)
    assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("runtime", ["opencode", "kilo"])
async def test_port_reuse_between_a_check_and_a_connection_delivers_nothing(tmp_path, monkeypatch, runtime, backend):
    # After its first status answer the server stops listening and its child
    # (knowing the password) takes over the very same port.
    _install_adversary(tmp_path, runtime, attack="port_reuse_after", after_gets=1, connect_delay=1.0)
    _on_path(monkeypatch, tmp_path)
    with pytest.raises(McpNotReady) as err:
        await _gate(runtime, tmp_path, backend, ready_timeout_s=15)
    assert err.value.reason == "unverified-server"
    assert (tmp_path / "impostor.port").read_text() == (tmp_path / "server.port").read_text()
    assert not (tmp_path / "task.json").exists()
    assert _nothing_reached_the_impostor(tmp_path)
    assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("runtime", ["opencode", "kilo"])
async def test_a_so_reuseport_hijacker_on_the_same_port_gets_no_byte(tmp_path, monkeypatch, runtime):
    # Linux load-balances connections between both listeners; any connection the
    # impostor accepts must carry nothing, and the run is refused if one did.
    _install_adversary(tmp_path, runtime, attack="reuseport", connect_delay=0.5)
    _on_path(monkeypatch, tmp_path)
    for _ in range(3):
        for name in ("task.json", "impostor.log", "server.log", "impostor.port"):
            (tmp_path / name).unlink(missing_ok=True)
        try:
            await _gate(runtime, tmp_path)
            refused = False
        except McpNotReady as err:
            assert err.reason == "unverified-server"
            refused = True
        assert (tmp_path / "impostor.port").read_text() == (tmp_path / "server.port").read_text()
        assert _nothing_reached_the_impostor(tmp_path)
        assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_kilo_reconnect_cannot_reach_a_different_listener(tmp_path, monkeypatch, backend):
    # The connection is reported lost; while AURA asks for the one reconnect,
    # the port has been taken over by the impostor.
    _install_adversary(tmp_path, "kilo", lose_once=True, attack="port_reuse_after", after_gets=2)
    _on_path(monkeypatch, tmp_path)
    with pytest.raises(McpNotReady) as err:
        await _gate("kilo", tmp_path, backend, ready_timeout_s=15)
    assert err.value.reason == "unverified-server"
    log = [json.loads(line) for line in (tmp_path / "server.log").read_text().splitlines()]
    assert not any(e["path"].endswith("/connect") for e in log)  # the reconnect never reached anyone
    assert not (tmp_path / "task.json").exists()
    assert _nothing_reached_the_impostor(tmp_path)
    assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("attack", [None, "forge_first"])
async def test_an_npm_node_launcher_is_followed_to_the_one_server_it_starts(tmp_path, monkeypatch, attack):
    # Kilo's bin/kilo is a node script that spawns exactly one native binary.
    _install_adversary(tmp_path, "kilo", wrapper="node", attack=attack, attack_delay=1.0)
    _on_path(monkeypatch, tmp_path)
    _, mcp = await _gate("kilo", tmp_path, ready_timeout_s=15)
    assert mcp == "connected" and _task_after_connected(tmp_path)
    assert _impostor_traffic(tmp_path) == (0, 0)
    assert await _gone(tmp_path)


@posix
async def test_a_launcher_that_starts_more_than_one_process_is_refused(tmp_path, monkeypatch):
    _install_adversary(tmp_path, "kilo", wrapper="node-two")
    _on_path(monkeypatch, tmp_path)
    with pytest.raises(McpNotReady) as err:
        await _gate("kilo", tmp_path, ready_timeout_s=10)
    assert err.value.reason == "unverified-server" and "cannot be identified" in str(err.value)
    assert not (tmp_path / "server.log").exists() and not (tmp_path / "task.json").exists()


@posix
@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_dual_stack_server_is_verified_through_its_ipv4_mapped_socket(tmp_path, monkeypatch, backend):
    _install_adversary(tmp_path, "kilo", dual_stack=True)
    _on_path(monkeypatch, tmp_path)
    _, mcp = await _gate("kilo", tmp_path, backend)
    assert mcp == "connected" and _task_after_connected(tmp_path)
    assert await _gone(tmp_path)


@posix
async def test_an_ipv6_only_listener_is_never_contacted(tmp_path, monkeypatch):
    _install_adversary(tmp_path, "kilo", ipv6_only=True)
    _on_path(monkeypatch, tmp_path)
    with pytest.raises(McpNotReady) as err:
        await _gate("kilo", tmp_path, ready_timeout_s=2)
    assert err.value.reason == "timeout" and "not listening" in str(err.value)
    assert not (tmp_path / "server.log").exists() and not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


@posix
@pytest.mark.parametrize("runtime", ["opencode", "kilo"])
async def test_cancellation_while_identifying_the_server_sends_nothing_and_cleans_up(tmp_path, monkeypatch, runtime):
    _install_adversary(tmp_path, runtime, attack="no_listen")
    _on_path(monkeypatch, tmp_path)
    cancel = asyncio.Event()
    pending = asyncio.ensure_future(_gate(runtime, tmp_path, cancel=cancel))
    end = time.monotonic() + 5
    while time.monotonic() < end and not (tmp_path / "grandchild.pid").exists():
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    cancel.set()
    with pytest.raises(McpNotReady) as err:
        await pending
    assert err.value.reason == "cancelled"
    assert not (tmp_path / "task.json").exists()
    assert await _gone(tmp_path)


@posix
async def test_a_server_that_dies_while_receiving_the_task_is_cleaned_up_and_reported(tmp_path, monkeypatch):
    _install_adversary(tmp_path, "kilo", exit_on_task=True)
    _on_path(monkeypatch, tmp_path)
    res, mcp = await _gate("kilo", tmp_path)
    assert mcp == "connected" and res.code != 0           # the CLI saw the server go away
    assert (tmp_path / "task.json").exists()               # it reached only the real server
    assert _impostor_traffic(tmp_path) == (0, 0)
    assert await _gone(tmp_path)


@posix
@linux
async def test_unreadable_socket_ownership_refuses_the_run(tmp_path, monkeypatch):
    real_listdir = os.listdir

    def denied(path):
        if str(path).startswith("/proc/") and str(path).endswith("/fd") and "/self/" not in str(path):
            raise PermissionError(13, "Permission denied", str(path))
        return real_listdir(path)

    monkeypatch.setattr(ident.os, "listdir", denied)
    _install_adversary(tmp_path, "kilo")
    _on_path(monkeypatch, tmp_path)
    with pytest.raises(McpNotReady) as err:
        await _gate("kilo", tmp_path)
    assert err.value.reason == "identity-unavailable"
    assert not (tmp_path / "server.log").exists() and not (tmp_path / "task.json").exists()
    assert await _no_process_left(tmp_path)


async def test_a_platform_without_verification_refuses_before_starting_anything(monkeypatch):
    monkeypatch.setattr(ident.sys, "platform", "win32")
    s = _Script([CONNECTED])
    with pytest.raises(McpNotReady) as err:
        await run_opencode(s.run_agent, TASK, "/p", 60_000, start_server=s.start_server)
    assert err.value.reason == "identity-unavailable" and "win32" in str(err.value)
    assert s.started is False and s.task_calls() == []
    k = _KiloScript([K_CONNECTED])
    with pytest.raises(McpNotReady) as err:
        await run_kilo(k.run_agent, KILO_TASK, "/p", 60_000, start_server=k.start_server, http=k.http)
    assert err.value.reason == "identity-unavailable" and k.started is False and k.requests == []


def test_missing_lsof_is_reported_unavailable_not_skipped():
    backend = ident.Lsof()
    backend.lsof = None
    ok, why = backend.available()
    assert ok is False and "lsof" in why


# ── identity primitives against real processes and sockets ─────────────────

def _spawn_listener():
    code = ("import socket,sys,time;s=socket.socket();s.bind(('127.0.0.1',0));s.listen(8);"
            "print(s.getsockname()[1],flush=True);c=s.accept()[0];time.sleep(30)")
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    return proc, int(proc.stdout.readline())


@posix
@pytest.mark.parametrize("backend", BACKENDS)
async def test_connection_ownership_names_exactly_the_process_holding_the_server_side(backend):
    import socket

    b = _backend(backend)
    proc, port = _spawn_listener()
    try:
        owner = ident.ServerProcess(proc.pid, b.start_time(proc.pid))
        assert ident.resolve_server(b, proc.pid) == owner
        assert b.listen_ports(owner) == {port}
        client = socket.create_connection(("127.0.0.1", port))
        cport = client.getsockname()[1]
        end = time.monotonic() + 5
        while ident.owns_connection(b, owner, port, cport) is not True and time.monotonic() < end:
            await asyncio.sleep(0.02)
        assert ident.owns_connection(b, owner, port, cport) is True
        # Another live process (this test) does not hold that socket.
        me = ident.ServerProcess(os.getpid(), b.start_time(os.getpid()))
        assert ident.owns_connection(b, me, port, cport) is not True
        # A reused PID: same number, different start time — never the server.
        reused = ident.ServerProcess(proc.pid, "0")
        assert ident.still_running(b, reused) is False
        assert ident.owns_connection(b, reused, port, cport) is False
        client.close()
    finally:
        proc.kill()
        proc.wait()
    # An exited process is never the server.
    assert ident.still_running(b, owner) is False
    assert ident.owns_connection(b, owner, port, 1) is False


@posix
@linux
def test_procfs_reads_ipv4_and_ipv4_mapped_rows(tmp_path):
    (tmp_path / "net").mkdir()
    header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    (tmp_path / "net" / "tcp").write_text(header + "   0: 0100007F:1F90 0100007F:C350 01 0:0 0:0 0 1000 0 111\n")
    (tmp_path / "net" / "tcp6").write_text(
        header + "   0: 0000000000000000FFFF00000100007F:1F91 0000000000000000FFFF00000100007F:C351 01 0:0 0:0 0 1000 0 222\n"
        "   1: 00000000000000000000000001000000:1F92 00000000000000000000000001000000:C352 01 0:0 0:0 0 1000 0 333\n")
    (tmp_path / "7" / "fd").mkdir(parents=True)
    for n, inode in enumerate(["111", "222", "333"]):
        os.symlink(f"socket:[{inode}]", tmp_path / "7" / "fd" / str(n))
    (tmp_path / "7" / "stat").write_text("7 (x) S 1 " + " ".join(["0"] * 17) + " 4242 0 0\n")  # field 22: starttime
    b = ident.Procfs(str(tmp_path))
    p = ident.ServerProcess(7, "4242")
    assert b.start_time(7) == "4242"
    assert ident.owns_connection(b, p, 0x1F90, 0xC350) is True   # 127.0.0.1
    assert ident.owns_connection(b, p, 0x1F91, 0xC351) is True   # ::ffff:127.0.0.1
    assert ident.owns_connection(b, p, 0x1F92, 0xC352) is None   # ::1 is not the loopback the relay uses


def test_launcher_resolution_follows_exactly_one_child_and_refuses_ambiguity():
    class Tree:
        def __init__(self, procs):
            self.procs = procs  # pid -> (exe, children)

        def exe_name(self, pid):
            return self.procs.get(pid, (None, []))[0]

        def children(self, pid):
            return self.procs[pid][1]

        def start_time(self, pid):
            return f"t{pid}" if pid in self.procs else None

    assert ident.resolve_server(Tree({1: ("opencode", [2])}), 1) == ident.ServerProcess(1, "t1")
    assert ident.resolve_server(Tree({1: ("node", [2]), 2: (".kilo", [3]), 3: ("node", [])}), 1) == \
        ident.ServerProcess(2, "t2")                            # the server's own node child is not followed
    assert ident.resolve_server(Tree({1: ("cmd.exe", [2]), 2: ("node.exe", [3]), 3: ("kilo.exe", [])}), 1) == \
        ident.ServerProcess(3, "t3")
    assert ident.resolve_server(Tree({1: ("node", [])}), 1) is None    # not started yet
    with pytest.raises(ident.IdentityMismatch):
        ident.resolve_server(Tree({1: ("node", [2, 3]), 2: ("kilo", []), 3: ("evil", [])}), 1)
    with pytest.raises(ident.IdentityMismatch):
        ident.resolve_server(Tree({1: ("node", [2]), 2: ("node", [3]), 3: ("node", [4]), 4: ("node", [5]),
                                   5: ("kilo", [])}), 1)
