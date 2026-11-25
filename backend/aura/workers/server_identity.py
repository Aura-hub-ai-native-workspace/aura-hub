"""Bind every connection to the private runtime server to the process AURA started.

The readiness gate (``opencode_mcp``) must never send the server's one-time
password, a status request or a task to a listener other than the private
server it launched. Neither runtime can receive an inherited socket, listen on
a Unix socket or speak over a parent-owned pipe (OpenCode 2.3.2 ``serve
--stdio`` only prints a TCP URL; Kilo 7.5.14 has no such option), so the
connection is TCP on loopback, and text on stdout is not evidence of who
listens: the server's children share that pipe.

This module therefore relies on what the operating system says, not on what a
process prints:

1. **Server identity** — the process AURA spawned, or, when that process is a
   known launcher (the npm ``node`` wrapper; ``cmd.exe``) with exactly one
   child, that child (Kilo's wrapper starts exactly one native binary). The
   identity is pinned as ``(pid, start time)`` so a reused PID never matches.
2. **Per-connection ownership** — AURA runs a loopback relay that the runtime
   CLIs and the gate talk to instead of the server. For every relayed
   connection AURA opens its own upstream connection, then waits until the
   OS shows the *server side of that exact connection* (local server port,
   remote = AURA's ephemeral port) held by the pinned process. Only then is a
   single byte forwarded. Ownership is checked on the connection that carries
   the data, so a listener that changes between a check and a connect (port
   reuse, a child binding the same port, ``SO_REUSEPORT``) cannot receive
   anything: there is no separate check to race.

Linux reads ``/proc`` (``/proc/net/tcp{,6}`` and ``/proc/<pid>/fd``); macOS
uses ``lsof`` and ``ps``. Windows is not supported yet: it is reported as
unavailable and the gate refuses the run instead of degrading silently.

What this is NOT: authentication of code. A malicious plugin running inside
the server process, a compromised runtime, or a same-user process able to
ptrace the server or read ``/proc/<pid>/environ`` is indistinguishable from
the server to the OS, and is out of scope. See
docs/COMMON_CONTEXT_GATE_SECURITY.md.

Mirrors ``packages/ai-service/src/fabric/serverIdentity.ts``.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
from dataclasses import dataclass

# Processes that only start the real server: the npm `node` wrapper of Kilo
# (bin/kilo spawns exactly one native binary) and cmd.exe for a .cmd shim.
LAUNCHER = re.compile(r"^(node|nodejs|node\d+)(\.exe)?$|^cmd\.exe$", re.IGNORECASE)
MAX_LAUNCHER_HOPS = 3
VERIFY_TIMEOUT_S = 5.0
VERIFY_POLL_S = 0.01


class IdentityUnavailable(RuntimeError):
    """The OS cannot be asked (unsupported platform, missing tool, permission denied)."""


class IdentityMismatch(RuntimeError):
    """The OS answered, and the answer does not identify the server AURA started."""


@dataclass(frozen=True)
class ServerProcess:
    pid: int
    start: str  # opaque start time: a reused PID has a different one


# ── Linux: /proc ──────────────────────────────────────────────────────────────

_V4_LOOPBACK = "0100007F"                               # 127.0.0.1, little-endian
_V6_MAPPED_LOOPBACK = "0000000000000000FFFF00000100007F"  # ::ffff:127.0.0.1
_LOOPBACK = {_V4_LOOPBACK, _V6_MAPPED_LOOPBACK}
_WILDCARD = {"00000000", "0" * 32}
_LISTEN, _ESTABLISHED = "0A", "01"


class Procfs:
    name = "procfs"

    def __init__(self, root: str = "/proc"):
        self.root = root

    def available(self) -> tuple[bool, str]:
        try:
            os.listdir(f"{self.root}/self/fd")
            with open(f"{self.root}/net/tcp"):
                pass
        except OSError as exc:
            return False, f"/proc cannot be read ({exc.strerror or type(exc).__name__})"
        return True, "Linux /proc socket ownership"

    def _stat(self, pid: int) -> list[str] | None:
        try:
            with open(f"{self.root}/{pid}/stat") as fh:
                text = fh.read()
        except FileNotFoundError:
            return None
        except PermissionError as exc:
            raise IdentityUnavailable(f"process {pid} cannot be inspected") from exc
        # The command name is in parentheses and may itself contain spaces or ')'.
        return text.rsplit(")", 1)[1].split()

    def start_time(self, pid: int) -> str | None:
        fields = self._stat(pid)
        return fields[19] if fields and len(fields) > 19 else None   # field 22: starttime

    def exe_name(self, pid: int) -> str | None:
        try:
            return os.path.basename(os.readlink(f"{self.root}/{pid}/exe"))
        except FileNotFoundError:
            return None
        except PermissionError as exc:
            raise IdentityUnavailable(f"the executable of process {pid} cannot be inspected") from exc
        except OSError:
            return None

    def children(self, pid: int) -> list[int]:
        found = []
        for entry in os.listdir(self.root):
            if not entry.isdigit():
                continue
            try:
                fields = self._stat(int(entry))
            except IdentityUnavailable:
                continue  # another user's process: never one of ours
            if fields and fields[1] == str(pid):
                found.append(int(entry))
        return found

    def _inodes(self, pid: int) -> set[str]:
        try:
            names = os.listdir(f"{self.root}/{pid}/fd")
        except FileNotFoundError:
            return set()
        except PermissionError as exc:
            raise IdentityUnavailable(f"the sockets of process {pid} cannot be inspected") from exc
        inodes = set()
        for name in names:
            try:
                target = os.readlink(f"{self.root}/{pid}/fd/{name}")
            except OSError:
                continue
            if target.startswith("socket:["):
                inodes.add(target[8:-1])
        return inodes

    def _rows(self):
        for table in ("tcp", "tcp6"):
            try:
                with open(f"{self.root}/net/{table}") as fh:
                    lines = fh.read().splitlines()[1:]
            except FileNotFoundError:
                continue
            except PermissionError as exc:
                raise IdentityUnavailable("the TCP socket table cannot be read") from exc
            for line in lines:
                cols = line.split()
                if len(cols) < 10:
                    continue
                (lip, lport), (rip, rport) = cols[1].split(":"), cols[2].split(":")
                yield lip, int(lport, 16), rip, int(rport, 16), cols[3], cols[9]

    def listen_ports(self, proc: ServerProcess) -> set[int]:
        inodes = self._inodes(proc.pid)
        return {lport for lip, lport, _, _, st, inode in self._rows()
                if st == _LISTEN and inode in inodes and (lip in _LOOPBACK or lip in _WILDCARD)}

    def connection_owner(self, proc: ServerProcess, server_port: int, client_port: int) -> bool | None:
        """True: the server side of this exact connection is held by ``proc``.
        False: someone else holds it. None: not accepted yet (no owner yet)."""
        for lip, lport, rip, rport, st, inode in self._rows():
            if (lport == server_port and rport == client_port and st == _ESTABLISHED
                    and lip in _LOOPBACK and rip in _LOOPBACK):
                if inode == "0":
                    return None          # still in the accept queue
                return inode in self._inodes(proc.pid)
        return None


# ── macOS (and any system with lsof + ps) ─────────────────────────────────────

_LSOF_LOOPBACK = re.compile(r"^(?:127\.0\.0\.1|\[::ffff:127\.0\.0\.1\])$")
_LSOF_ANY = re.compile(r"^(?:\*|0\.0\.0\.0|\[::\])$")


class Lsof:
    name = "lsof"

    def __init__(self, lsof: str | None = None, ps: str | None = None):
        self.lsof = lsof or shutil.which("lsof")
        self.ps = ps or shutil.which("ps")

    def available(self) -> tuple[bool, str]:
        if not self.lsof or not self.ps:
            return False, "lsof and ps are required to inspect socket ownership"
        return True, "lsof socket ownership"

    def _run(self, *args: str) -> str:
        # Through the process boundary (sanitized environment, closed stdin,
        # bounded time and output). lsof and ps exit 1 when nothing matched:
        # that is an answer; only a command that did not run is "unavailable".
        from ..environment.procexec import ExecStatus, run_argv

        done = run_argv(list(args), timeout_ms=10_000)
        if done.status not in (ExecStatus.OK, ExecStatus.FAILED):
            raise IdentityUnavailable(f"{os.path.basename(args[0])} could not be run ({done.status.value})")
        return done.stdout

    def start_time(self, pid: int) -> str | None:
        out = self._run(self.ps, "-o", "lstart=", "-p", str(pid)).strip()
        return out or None

    def exe_name(self, pid: int) -> str | None:
        out = self._run(self.ps, "-o", "comm=", "-p", str(pid)).strip()
        return os.path.basename(out) if out else None

    def children(self, pid: int) -> list[int]:
        found = []
        for line in self._run(self.ps, "-A", "-o", "pid=,ppid=").splitlines():
            cols = line.split()
            if len(cols) == 2 and cols[1] == str(pid) and cols[0].isdigit():
                found.append(int(cols[0]))
        return found

    def _names(self, pid: int, *selector: str) -> list[str]:
        out = self._run(self.lsof, "-nP", "-a", "-p", str(pid), *selector, "-Fn")
        return [line[1:] for line in out.splitlines() if line.startswith("n")]

    def listen_ports(self, proc: ServerProcess) -> set[int]:
        ports = set()
        for name in self._names(proc.pid, "-iTCP", "-sTCP:LISTEN"):
            host, _, port = name.rpartition(":")
            if port.isdigit() and (_LSOF_LOOPBACK.match(host) or _LSOF_ANY.match(host)):
                ports.add(int(port))
        return ports

    def connection_owner(self, proc: ServerProcess, server_port: int, client_port: int) -> bool | None:
        # lsof cannot cheaply say who else holds a socket; "not seen under the
        # server" stays None and the caller's deadline turns it into a refusal.
        for name in self._names(proc.pid, f"-iTCP:{server_port}", "-sTCP:ESTABLISHED"):
            local, _, remote = name.partition("->")
            lhost, _, lport = local.rpartition(":")
            rhost, _, rport = remote.rpartition(":")
            if (lport == str(server_port) and rport == str(client_port)
                    and _LSOF_LOOPBACK.match(lhost) and _LSOF_LOOPBACK.match(rhost)):
                return True
        return None


class Unsupported:
    name = "unsupported"

    def __init__(self, why: str):
        self.why = why

    def available(self) -> tuple[bool, str]:
        return False, self.why


def default_backend():
    """The inspection method for this platform. Never a weaker fallback."""
    if sys.platform.startswith("linux"):
        return Procfs()
    if sys.platform == "darwin":
        return Lsof()
    return Unsupported(f"socket ownership verification is not implemented on {sys.platform}")


# ── identity ─────────────────────────────────────────────────────────────────

def resolve_server(backend, spawned_pid: int) -> ServerProcess | None:
    """The process that is the server, or None while it does not exist yet.

    The spawned process is the server unless it is a known launcher; a
    launcher must have exactly one child, which is followed. A launcher with
    several children is ambiguous and refused, never guessed.
    """
    pid = spawned_pid
    for _ in range(MAX_LAUNCHER_HOPS + 1):
        name = backend.exe_name(pid)
        if name is None:
            return None
        if not LAUNCHER.match(name):
            start = backend.start_time(pid)
            return ServerProcess(pid, start) if start else None
        kids = backend.children(pid)
        if not kids:
            return None                      # the launcher has not started it yet
        if len(kids) > 1:
            raise IdentityMismatch(f"the launcher {name} started {len(kids)} processes; "
                                   "the server cannot be identified unambiguously")
        pid = kids[0]
    raise IdentityMismatch("the server is hidden behind too many launcher processes")


def still_running(backend, proc: ServerProcess) -> bool:
    return backend.start_time(proc.pid) == proc.start


def owns_connection(backend, proc: ServerProcess, server_port: int, client_port: int) -> bool | None:
    if not still_running(backend, proc):
        return False
    return backend.connection_owner(proc, server_port, client_port)


# ── the relay ────────────────────────────────────────────────────────────────

class Violation(RuntimeError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


class VerifiedRelay:
    """A loopback listener owned by AURA that forwards each connection to the
    server only after the OS confirms the server side of that connection
    belongs to ``proc``. Nothing from the client is read before that.

    AURA holds this listener for the whole run (no ``SO_REUSEPORT``), so no
    other process can take its port while URLs pointing at it are in use.
    """

    def __init__(self, backend, proc: ServerProcess, server_port: int,
                 verify_timeout_s: float = VERIFY_TIMEOUT_S):
        self.backend, self.proc, self.server_port = backend, proc, server_port
        self.verify_timeout_s = verify_timeout_s
        self.violations: list[Violation] = []
        self._server: asyncio.base_events.Server | None = None
        self._tasks: set[asyncio.Task] = set()
        self._writers: set[asyncio.StreamWriter] = set()
        self.url = ""

    async def start(self) -> str:
        self._server = await asyncio.start_server(self._accept, "127.0.0.1", 0, reuse_address=False)
        port = self._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        return self.url

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.ensure_future(self._relay(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _verify(self, client_port: int) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.verify_timeout_s
        while True:
            try:
                owned = await asyncio.to_thread(
                    owns_connection, self.backend, self.proc, self.server_port, client_port)
            except IdentityUnavailable as exc:
                raise Violation("identity-unavailable", f"the server's socket ownership could not be checked ({exc})") from exc
            if owned is True:
                return
            if owned is False or loop.time() >= deadline:
                raise Violation("unverified-server",
                                f"a connection to port {self.server_port} was not accepted by the server process "
                                f"AURA started (pid {self.proc.pid}); nothing was sent over it")
            await asyncio.sleep(VERIFY_POLL_S)

    async def _relay(self, creader, cwriter) -> None:
        self._writers.add(cwriter)
        uwriter = None
        try:
            try:
                ureader, uwriter = await asyncio.open_connection("127.0.0.1", self.server_port)
            except OSError:
                return                     # nothing listens: the client sees a closed connection
            self._writers.add(uwriter)
            try:
                await self._verify(uwriter.get_extra_info("sockname")[1])
            except Violation as violation:
                self.violations.append(violation)
                return
            await asyncio.gather(_pipe(creader, uwriter), _pipe(ureader, cwriter))
        finally:
            for w in (cwriter, uwriter):
                if w is not None:
                    self._writers.discard(w)
                    w.close()

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
        for writer in list(self._writers):
            writer.close()
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._server is not None:
            try:
                await asyncio.wait_for(self._server.wait_closed(), 2)
            except (TimeoutError, OSError):
                pass


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except (OSError, RuntimeError):
        writer.close()
