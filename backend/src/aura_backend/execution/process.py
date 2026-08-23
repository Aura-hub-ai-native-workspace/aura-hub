"""The single process-spawn primitive.

A port of packages/ai-service/src/exec/process.ts.

Nothing here decides whether an action is *permitted* — that is the policy
engine's job. This module only guarantees that whatever runs, runs safely
bounded. There is exactly one place a process outcome is decided
(`settle`), because that is the one place it was previously decided
wrongly.

Python is not Node, and this module is where that matters most:

  * Node reports a killed child with a signal NAME and a null exit code;
    Python reports `returncode == -N`. Timeout and a self-inflicted
    SIGTERM are indistinguishable by return code alone, so whether *we*
    killed it is tracked explicitly rather than inferred.
  * Node's `execFile` enforces `maxBuffer`; Python has no equivalent, so
    the cap is implemented here.
  * `subprocess` makes unsafe shell execution easier than the safe form.
    There is no code path in this module that accepts a command string for
    the shell: every spawn passes an argv list with `shell=False`.

The observed Node behavior these rules reproduce was measured against a
running Node, not assumed — see tests/test_execution_parity.py.
"""

from __future__ import annotations

import errno
import os
import selectors
import signal as signalmod
import subprocess
import threading
import time
from dataclasses import dataclass

from .allowlists import parse_command, resolve_agent_binary, resolve_installer_binary
from .which import launch_spec

GIT_TIMEOUT_MS = 20_000
SHELL_TIMEOUT_MS = 30_000
# Agents plan, read and edit across several model round-trips.
AGENT_TIMEOUT_MS = 10 * 60_000
# Installers fetch over the network and may compile. Bounded, not generous.
INSTALL_TIMEOUT_MS = 5 * 60_000
MAX_BUFFER = 4 * 1024 * 1024

# Conventional status for "ran out of time" (matches timeout(1)).
TIMEOUT_EXIT_CODE = 124
# POSIX convention: a process ended by signal N reports 128 + N.
SIGNAL_EXIT_BASE = 128
SIGNAL_NUMBERS: dict[str, int] = {
    "SIGHUP": 1,
    "SIGINT": 2,
    "SIGQUIT": 3,
    "SIGKILL": 9,
    "SIGTERM": 15,
}

# How long to wait for a child to honour SIGTERM before escalating.
# See `_terminate` — a deliberate, documented difference from the reference.
_SIGKILL_GRACE_S = 5.0
# How long to keep draining the pipes once the child is gone. A detached
# grandchild holding the inherited pipe would otherwise block us for its
# whole lifetime.
_DRAIN_GRACE_S = 2.0


class ProcessRefused(Exception):
    """The command was refused before anything was spawned."""


class ProcessNotInstalled(Exception):
    """The named binary does not exist on this machine."""


@dataclass
class ProcessOutput:
    out: str
    code: int
    # Killed rather than exited — timeout, or a signal from outside.
    killed: bool = False
    # The signal that ended it, when the OS reported one.
    signal: str | None = None
    # Killed specifically because it exceeded its timeout.
    timed_out: bool = False


@dataclass
class SpawnError:
    """Mirrors the error object Node's `execFile` hands its callback.

    Shapes confirmed by probing Node directly:
        timeout       code=None  killed=True   signal='SIGTERM'
        exit non-zero code=<int> killed=False  signal=None
        self-signal   code=None  killed=False  signal='SIGTERM'
        maxBuffer     code='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        missing file  code='ENOENT'
    """

    code: int | str | None = None
    killed: bool = False
    signal: str | None = None
    message: str = ""


def settle(
    err: SpawnError | None, stdout: str, stderr: str, timeout_ms: int
) -> ProcessOutput:
    """Turn a spawn result into a truthful outcome.

    This is the one place exit status is decided. The rules, for every
    caller:

        exited 0            -> 0
        exited non-zero     -> that code
        killed by timeout   -> 124, timed_out
        killed by signal    -> 128 + signal, killed + signal
        errored otherwise   -> 1, never 0

    A non-zero code is never invented for a process that genuinely
    succeeded, and 0 is never reported for one that did not. Reporting 0
    for a killed child is what produced false successes before: a
    ten-minute agent run cut short by its timeout came back as
    "succeeded".
    """
    out = (stdout + (f"\n{stderr}" if stderr else "")).strip()
    if err is None:
        return ProcessOutput(out=out, code=0)

    sig = err.signal if isinstance(err.signal, str) else None

    # Set when WE killed the child, which for these callers means timeout.
    if err.killed is True:
        suffix = f"[timed out after {timeout_ms}ms{f' ({sig})' if sig else ''}]"
        return ProcessOutput(
            out=f"{out}{chr(10) if out else ''}{suffix}",
            code=TIMEOUT_EXIT_CODE,
            killed=True,
            timed_out=True,
            signal=sig,
        )

    if sig:
        return ProcessOutput(
            out=f"{out}{chr(10) if out else ''}[terminated by {sig}]",
            code=SIGNAL_EXIT_BASE + SIGNAL_NUMBERS.get(sig, 0),
            killed=True,
            signal=sig,
        )

    if isinstance(err.code, int) and not isinstance(err.code, bool):
        return ProcessOutput(out=out, code=err.code)

    # An error with no numeric status is still a failure. Reporting 0 here
    # is what produced false successes before.
    return ProcessOutput(out=out or (err.message or "failed"), code=1)


def _signal_name(number: int) -> str | None:
    try:
        return signalmod.Signals(number).name
    except ValueError:
        return None


def _terminate(proc: subprocess.Popen) -> None:
    """Stop a child that is still running.

    Node's `execFile` sends its kill signal (SIGTERM) exactly once and then
    waits. A child that ignores SIGTERM hangs Node forever; escalating to
    SIGKILL after a grace period is a DELIBERATE difference from the
    reference, recorded in the migration map. A wedged backend is a worse
    failure than a divergence here.
    """
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=_SIGKILL_GRACE_S)
        return
    except subprocess.TimeoutExpired:
        pass
    proc.kill()
    try:
        proc.wait(timeout=_SIGKILL_GRACE_S)
    except subprocess.TimeoutExpired:
        pass


def _drain(
    proc: subprocess.Popen,
    *,
    timeout_ms: int,
    cancel: threading.Event | None,
    max_buffer: int,
) -> tuple[bytes, bytes, bool, bool, bool]:
    """Read both pipes to completion, bounded in every direction.

    Returns (stdout, stderr, timed_out, cancelled, overflowed).

    This uses a selector rather than reader threads on purpose. With
    threads, a child that exits while a detached grandchild still holds the
    inherited pipe leaves a reader blocked in `read()` — and closing that
    stream from another thread acquires the same buffer lock, so the
    *close* blocks too. The caller then hangs for the grandchild's entire
    lifetime. Selecting on the raw descriptors keeps every wait bounded and
    lets us stop reading on our own terms.
    """
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []
    totals = {"out": 0, "err": 0}
    chunks = {"out": out_chunks, "err": err_chunks}

    selector = selectors.DefaultSelector()
    open_fds: set[int] = set()
    for label, stream in (("out", proc.stdout), ("err", proc.stderr)):
        if stream is None:
            continue
        fd = stream.fileno()
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ, label)
        open_fds.add(fd)

    timed_out = False
    cancelled = False
    overflowed = False
    grace_end: float | None = None
    hard_deadline = time.monotonic() + (timeout_ms / 1000.0)

    try:
        while True:
            if not open_fds and proc.poll() is not None:
                break
            now = time.monotonic()

            if grace_end is not None:
                if now >= grace_end:
                    break
            else:
                if overflowed or cancelled or now >= hard_deadline:
                    if not overflowed and not cancelled:
                        timed_out = True
                    _terminate(proc)
                    grace_end = time.monotonic() + _DRAIN_GRACE_S
                    continue
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    continue
                if proc.poll() is not None and open_fds:
                    # The process is gone but something still holds the pipe
                    # — a detached grandchild. Drain briefly, then stop and
                    # report the status the process actually exited with.
                    grace_end = time.monotonic() + _DRAIN_GRACE_S
                    continue

            for key, _events in selector.select(timeout=0.05):
                fd = key.fd
                label = key.data
                try:
                    data = os.read(fd, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(fd)
                    open_fds.discard(fd)
                    continue
                if totals[label] < max_buffer:
                    chunks[label].append(data[: max_buffer - totals[label]])
                totals[label] += len(data)
                if totals[label] > max_buffer and not overflowed:
                    overflowed = True
    finally:
        selector.close()

    return b"".join(out_chunks), b"".join(err_chunks), timed_out, cancelled, overflowed


def _spawn(
    bin_name: str,
    args: list[str],
    *,
    cwd: str | None,
    timeout_ms: int,
    close_stdin: bool,
    cancel: threading.Event | None = None,
    max_buffer: int = MAX_BUFFER,
) -> tuple[SpawnError | None, str, str]:
    """Spawn an allow-listed binary by name, on whichever OS is running.

    Every spawn in this module goes through here. The name is resolved to
    a real file first, which is what makes Windows work at all: PATH is
    split with `;` there, executables carry a PATHEXT extension, and an
    npm-installed tool is a `.cmd` shim.

    Arguments are always an argv list. They are never joined into a
    string, so a task description containing shell metacharacters is data,
    not syntax.
    """
    spec = launch_spec(bin_name, args)
    argv = [spec.target.file, *spec.target.args]

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL if close_stdin else subprocess.PIPE,
            shell=False,
        )
    except FileNotFoundError:
        return SpawnError(code="ENOENT", message=f"{bin_name} is not installed"), "", ""
    except PermissionError:
        return SpawnError(code="EACCES", message=f"{bin_name} is not executable"), "", ""
    except OSError as exc:
        name = errno.errorcode.get(exc.errno or 0, "EUNKNOWN")
        return SpawnError(code=name, message=str(exc)), "", ""

    try:
        raw_out, raw_err, timed_out, cancelled, overflow = _drain(
            proc, timeout_ms=timeout_ms, cancel=cancel, max_buffer=max_buffer
        )
    finally:
        _terminate(proc)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        # Reap, so a finished child never lingers as a zombie.
        try:
            proc.wait(timeout=_SIGKILL_GRACE_S)
        except subprocess.TimeoutExpired:
            pass

    stdout = raw_out.decode("utf-8", errors="replace")
    stderr = raw_err.decode("utf-8", errors="replace")
    code = proc.returncode

    # Precedence matches Node: an overflow is reported as an overflow even
    # though the child was then killed by a signal.
    if overflow:
        return (
            SpawnError(
                code="ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                message="stdout maxBuffer length exceeded",
            ),
            stdout,
            stderr,
        )

    if timed_out:
        return SpawnError(code=None, killed=True, signal="SIGTERM"), stdout, stderr

    if cancelled:
        # A caller-requested abort is a kill from outside, not a timeout.
        return SpawnError(code=None, killed=False, signal="SIGTERM"), stdout, stderr

    if code is None:
        return SpawnError(code=None, message="process did not report a status"), stdout, stderr

    if code < 0:
        # The child died by signal it did not ask us for.
        return SpawnError(code=None, signal=_signal_name(-code)), stdout, stderr

    if code != 0:
        return SpawnError(code=code), stdout, stderr

    return None, stdout, stderr


@dataclass(frozen=True)
class SpawnOptions:
    cwd: str
    cancel: threading.Event | None = None
    timeout_ms: int | None = None


def git(args: list[str], opts: SpawnOptions) -> ProcessOutput:
    """Real `git` in a project directory."""
    timeout = opts.timeout_ms if opts.timeout_ms is not None else GIT_TIMEOUT_MS
    err, stdout, stderr = _spawn(
        "git", args, cwd=opts.cwd, timeout_ms=timeout, close_stdin=False, cancel=opts.cancel
    )
    if err is not None and err.code == "ENOENT":
        raise ProcessNotInstalled("git is not installed")
    return settle(err, stdout, stderr, timeout)


def safe_shell(command: str, opts: SpawnOptions) -> str:
    """Allow-listed, argument-only execution. No shell interpretation."""
    parsed = parse_command(command)
    if not parsed.ok:
        raise ProcessRefused(parsed.reason)
    timeout = opts.timeout_ms if opts.timeout_ms is not None else SHELL_TIMEOUT_MS
    err, stdout, stderr = _spawn(
        parsed.bin,
        parsed.args,
        cwd=opts.cwd,
        timeout_ms=timeout,
        close_stdin=False,
        cancel=opts.cancel,
    )
    settled = settle(err, stdout, stderr, timeout)
    # A killed process is a failure even when it printed something first —
    # returning its partial output as the value would let a caller treat a
    # truncated run as a completed one.
    if settled.killed:
        raise ProcessRefused(settled.out)
    if err is not None and not stdout and not stderr:
        raise ProcessRefused(err.message or settled.out)
    return settled.out


def safe_shell_with_code(command: str, opts: SpawnOptions) -> ProcessOutput:
    """Like `safe_shell`, but surfaces the exit code instead of raising.

    The Fabric verifies `terminal.execute` by exit code, so it needs the
    number, not an exception.
    """
    parsed = parse_command(command)
    if not parsed.ok:
        raise ProcessRefused(parsed.reason)
    timeout = opts.timeout_ms if opts.timeout_ms is not None else SHELL_TIMEOUT_MS
    err, stdout, stderr = _spawn(
        parsed.bin,
        parsed.args,
        cwd=opts.cwd,
        timeout_ms=timeout,
        close_stdin=False,
        cancel=opts.cancel,
    )
    if err is not None and err.code == "ENOENT":
        raise ProcessNotInstalled(f"{parsed.bin} is not installed")
    return settle(err, stdout, stderr, timeout)


def run_agent(bin_name: str, args: list[str], opts: SpawnOptions) -> ProcessOutput:
    """Run a coding agent with pre-built arguments.

    stdin is closed immediately. A CLI that reads stdin — which coding
    agents do, to accept piped context — otherwise waits for input a
    headless caller will never send, and the run hangs until the timeout
    kills it. Signalling EOF up front is what makes "non-interactive"
    actually non-interactive.
    """
    resolved = resolve_agent_binary(bin_name)
    if not resolved.ok:
        raise ProcessRefused(resolved.reason)
    timeout = opts.timeout_ms if opts.timeout_ms is not None else AGENT_TIMEOUT_MS
    # An UnsafeArgumentError from Windows quoting propagates untouched: the
    # task text carried something cmd.exe would reinterpret, and refusing is
    # the only honest option — a rewritten task is not the task that was
    # asked for.
    err, stdout, stderr = _spawn(
        resolved.bin,
        args,
        cwd=opts.cwd,
        timeout_ms=timeout,
        close_stdin=True,
        cancel=opts.cancel,
    )
    if err is not None and err.code == "ENOENT":
        raise ProcessNotInstalled(f"{resolved.bin} is not installed")
    return settle(err, stdout, stderr, timeout)


def run_installer(bin_name: str, args: list[str], opts: SpawnOptions) -> ProcessOutput:
    """Run an installer with pre-built arguments.

    Arguments arrive as a list from the catalogue's install spec and go
    straight to the spawner — never joined into a string, never
    shell-parsed. stdin is closed for the same reason it is for agents: an
    installer that stops to ask a question must fail fast, not stall.
    """
    resolved = resolve_installer_binary(bin_name)
    if not resolved.ok:
        raise ProcessRefused(resolved.reason)
    timeout = opts.timeout_ms if opts.timeout_ms is not None else INSTALL_TIMEOUT_MS
    err, stdout, stderr = _spawn(
        resolved.bin, args, cwd=opts.cwd, timeout_ms=timeout, close_stdin=True, cancel=opts.cancel
    )
    if err is not None and err.code == "ENOENT":
        raise ProcessNotInstalled(f"{resolved.bin} is not installed")
    return settle(err, stdout, stderr, timeout)
