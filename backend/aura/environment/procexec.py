"""Bounded, isolated subprocess execution for environment probing.

Every command AURA runs while measuring the machine goes through
:func:`run_argv`. Nothing in ``aura.environment`` may call ``subprocess``
directly, because the guarantees this module provides are the ones that make
scanning safe:

  * **argv only** — never a shell, never a string, never caller-supplied text.
  * **stdin is closed** — a probed tool can never prompt for a password, read
    the operator's terminal, or block waiting for input it will not get.
  * **the environment is minimal** — probes receive ``PATH``/``HOME``/locale
    and nothing else, so an API key in the parent process is not handed to a
    binary merely because AURA measured it.
  * **output is bounded** — a tool that writes gigabytes to stdout costs a
    fixed number of bytes here, not a fixed fraction of available memory.
  * **the whole process tree is killed** — the child runs in its own process
    group, so a probe that spawns daemons does not leave them behind.

The result is a total function: :class:`ExecOutcome` describes what happened
including the failure modes, and callers branch on :class:`ExecStatus` rather
than on the presence of output.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from enum import Enum

from .hostplatform import is_windows
from .pathsec import FileIdentity, file_identity

#: Hard ceiling on captured stdout+stderr per probe.
MAX_OUTPUT_BYTES = 64 * 1024

#: Environment variables that are safe, and necessary, to hand to a child.
#: Everything else in the parent environment is withheld. This is an allow
#: list on purpose: a deny list of "things that look like secrets" fails open
#: the first time somebody invents a new name for a credential.
_ENV_ALLOW = (
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TZ",
    "TERM",
    # Windows needs these to load system DLLs at all.
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
)

#: Handed to every child so version checks stay offline and non-interactive.
#: These are hints, not enforcement — the sandbox above is the enforcement.
_ENV_FORCE = {
    "CI": "1",
    "NO_COLOR": "1",
    "TERM": "dumb",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "",
    "SSH_ASKPASS": "",
    "npm_config_yes": "true",
    "DO_NOT_TRACK": "1",
    "CHECKPOINT_DISABLE": "1",  # Terraform's upstream version check
    "SCARF_ANALYTICS": "false",
    "ADBLOCK": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
}


class ExecStatus(str, Enum):
    """What became of a command. Distinct causes stay distinct."""

    OK = "ok"
    """Ran to completion and exited zero."""

    FAILED = "failed"
    """Ran to completion and exited non-zero."""

    TIMEOUT = "timeout"
    """Exceeded its budget and was killed. Says nothing about presence."""

    NOT_FOUND = "not-found"
    """No such executable."""

    DENIED = "denied"
    """Found, but the OS refused to execute it."""

    ERROR = "error"
    """Anything else — recorded rather than raised."""

    TAMPERED = "tampered"
    """The file changed between being vetted and being run. Nothing ran."""


@dataclass(frozen=True)
class ExecOutcome:
    status: ExecStatus
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    truncated: bool = False
    error: str = ""
    #: How the executable was bound to the file that was vetted:
    #: ``pinned`` (ran the exact inode, tampering prevented),
    #: ``verified`` (identity re-checked either side, tampering detected),
    #: ``unpinned`` (caller supplied no identity).
    pin_mode: str = "unpinned"

    @property
    def output(self) -> str:
        """stdout and stderr joined — many tools print versions to stderr."""
        parts = [p for p in (self.stdout.strip(), self.stderr.strip()) if p]
        return "\n".join(parts)


def sanitized_env(path: str | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build the minimal environment a probe is allowed to see.

    Only :data:`_ENV_ALLOW` names survive from the parent. ``PATH`` is
    overridden when supplied so probes resolve against the effective PATH
    without the parent's secrets riding along.
    """
    env: dict[str, str] = {}
    for name in _ENV_ALLOW:
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    env.update(_ENV_FORCE)
    if path is not None:
        env["PATH"] = path
    env.setdefault("PATH", os.defpath)
    if extra:
        env.update(extra)
    return env


def _decode(raw: bytes | None) -> str:
    if not raw:
        return ""
    return raw.decode("utf-8", errors="replace")


class _BoundedReader(threading.Thread):
    """Drain a pipe while retaining at most ``cap`` bytes.

    ``Popen.communicate`` would buffer the whole stream before anyone could
    truncate it, so a tool that prints 50 MB costs 50 MB of resident memory
    per concurrent probe. This keeps a fixed ceiling while still draining, so
    the child never blocks on a full pipe and the timeout stays authoritative.
    """

    def __init__(self, stream, cap: int) -> None:
        super().__init__(daemon=True)
        self._stream = stream
        self._cap = cap
        self.buf = bytearray()
        self.total = 0

    def run(self) -> None:
        try:
            while True:
                chunk = self._stream.read(65536)
                if not chunk:
                    break
                self.total += len(chunk)
                room = self._cap - len(self.buf)
                if room > 0:
                    self.buf.extend(chunk[:room])
        except Exception:
            pass
        finally:
            try:
                self._stream.close()
            except Exception:
                pass


def _terminate_tree(proc: subprocess.Popen[bytes]) -> None:
    """Kill the child *and* anything it spawned.

    ``Popen.kill`` signals one process. A probe that forked a daemon would
    otherwise leave it running for as long as the machine is up, and repeated
    scans would accumulate them.
    """
    if proc.poll() is not None:
        return
    if is_windows():
        # taskkill is the only reliable way to reach a whole Windows tree.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        return

    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except Exception:
                pass
            return
        try:
            proc.wait(timeout=1.0)
            return
        except subprocess.TimeoutExpired:
            continue


def _is_shebang_script(path: str) -> bool:
    """True when the kernel will hand this file to an interpreter."""
    try:
        with open(path, "rb") as handle:
            return handle.read(2) == b"#!"
    except OSError:
        return False


def _pin_executable(argv: list[str], pin: FileIdentity) -> tuple[str | None, int | None, str]:
    """Bind execution to the file that was actually vetted.

    Returns ``(executable_override, fd_to_keep_open, mode)``.

    ``pinned`` — the strongest guarantee, used for real binaries on Linux.
    The file is opened once and run through ``/proc/self/fd/<n>``, which
    names the open file description rather than the path, so replacing the
    path afterwards cannot change what runs. ``argv[0]`` still carries the
    real path, because a program that resolves its own resources from
    ``argv[0]`` must keep working.

    ``verified`` — the file is a ``#!`` script, or there is no ``/proc``
    (macOS, Windows, hardened containers). The kernel hands a script's *own*
    path to its interpreter, and an interpreter given ``/proc/self/fd/<n>``
    resolves its modules from there; Node, for one, then fails outright.
    Pinning a script would trade a rare attack for a common breakage, so the
    identity is checked before and after instead. That detects tampering
    rather than preventing it, and the distinction is reported rather than
    glossed — see ``ExecOutcome.pin_mode``.

    Either way a mismatch means nothing runs, or nothing is believed.
    """
    target = argv[0]
    if not pin.matches(file_identity(target)):
        return None, None, "changed"

    if is_windows() or not os.path.isdir("/proc/self/fd"):
        return None, None, "verified"
    if _is_shebang_script(target):
        return None, None, "verified"

    try:
        fd = os.open(target, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return None, None, "verified"

    try:
        if not pin.matches(FileIdentity.of(os.fstat(fd))):
            os.close(fd)
            return None, None, "changed"
    except OSError:
        os.close(fd)
        return None, None, "verified"

    os.set_inheritable(fd, True)
    return f"/proc/self/fd/{fd}", fd, "pinned"


def run_argv(
    argv: list[str],
    *,
    timeout_ms: int,
    cwd: str | None = None,
    path: str | None = None,
    max_output: int = MAX_OUTPUT_BYTES,
    env_extra: dict[str, str] | None = None,
    pin: FileIdentity | None = None,
) -> ExecOutcome:
    """Run ``argv`` under every guarantee described in the module docstring.

    ``pin`` is the identity a caller established the file's trustworthiness
    against. When supplied, the command either runs that exact file or does
    not run at all.

    Never raises for anything the child does; failure modes come back as an
    :class:`ExecStatus`.
    """
    if not argv:
        return ExecOutcome(status=ExecStatus.ERROR, error="empty argv")

    started = time.monotonic()
    env = sanitized_env(path=path, extra=env_extra)

    pinned_fd: int | None = None
    pin_mode = "unpinned"
    executable_override: str | None = None
    if pin is not None:
        executable_override, pinned_fd, pin_mode = _pin_executable(argv, pin)
        if pin_mode == "changed":
            return ExecOutcome(
                status=ExecStatus.TAMPERED,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=(
                    "the file changed between being checked and being run, "
                    "so AURA did not run it"
                ),
            )

    popen_kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "cwd": cwd,
        "env": env,
        "close_fds": True,
    }
    if pinned_fd is not None:
        # The child must keep the descriptor, or /proc/self/fd/<n> is not
        # resolvable at exec time. `executable` runs that inode while argv[0]
        # keeps naming the real file.
        popen_kwargs["pass_fds"] = (pinned_fd,)
        popen_kwargs["executable"] = executable_override
    if is_windows():
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        # Its own session, so killpg reaches every descendant.
        popen_kwargs["start_new_session"] = True

    def _close_pin() -> None:
        if pinned_fd is not None:
            try:
                os.close(pinned_fd)
            except OSError:
                pass

    try:
        proc = subprocess.Popen(argv, **popen_kwargs)  # type: ignore[arg-type]
    except FileNotFoundError:
        _close_pin()
        return ExecOutcome(
            status=ExecStatus.NOT_FOUND,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except PermissionError:
        _close_pin()
        return ExecOutcome(
            status=ExecStatus.DENIED,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except OSError as exc:
        # Exec-format errors, ENOEXEC on a data file, and similar.
        _close_pin()
        return ExecOutcome(
            status=ExecStatus.ERROR,
            duration_ms=int((time.monotonic() - started) * 1000),
            error=str(exc),
        )

    # The child holds its own inherited descriptor from here on, so the
    # parent's copy is no longer needed. Popen has already waited for the
    # exec to succeed or fail, so this cannot race the resolution of
    # /proc/self/fd/<n>.
    _close_pin()

    out_reader = _BoundedReader(proc.stdout, max_output)
    err_reader = _BoundedReader(proc.stderr, max_output)
    out_reader.start()
    err_reader.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        _terminate_tree(proc)
    except Exception as exc:
        _terminate_tree(proc)
        return ExecOutcome(
            status=ExecStatus.ERROR,
            duration_ms=int((time.monotonic() - started) * 1000),
            error=str(exc),
        )

    # The readers exit when the pipes close. If a leaked grandchild still
    # holds one open, we abandon the (daemon) thread rather than hang: the
    # tree has already been killed and the scan must not wait on a straggler.
    out_reader.join(timeout=2.0)
    err_reader.join(timeout=2.0)

    duration_ms = int((time.monotonic() - started) * 1000)
    truncated = out_reader.total > max_output or err_reader.total > max_output
    stdout = _decode(bytes(out_reader.buf))
    stderr = _decode(bytes(err_reader.buf))

    if pin is not None and pin_mode == "verified":
        # No /proc to pin through, so the best available guarantee is to
        # notice. If the file moved under us, the output describes some other
        # program and must not be believed.
        if not pin.matches(file_identity(argv[0])):
            return ExecOutcome(
                status=ExecStatus.TAMPERED,
                duration_ms=duration_ms,
                error=(
                    "the file changed while it was running, so its output "
                    "cannot be attributed to the program that was checked"
                ),
            )

    if timed_out:
        return ExecOutcome(
            status=ExecStatus.TIMEOUT,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            truncated=truncated,
            pin_mode=pin_mode,
        )

    code = proc.returncode
    return ExecOutcome(
        status=ExecStatus.OK if code == 0 else ExecStatus.FAILED,
        exit_code=code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        truncated=truncated,
        pin_mode=pin_mode,
    )
