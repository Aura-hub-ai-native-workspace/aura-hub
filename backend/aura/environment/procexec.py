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
import sys
import threading
import time
from dataclasses import dataclass
from enum import Enum

IS_WINDOWS = sys.platform == "win32"

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


@dataclass(frozen=True)
class ExecOutcome:
    status: ExecStatus
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    truncated: bool = False
    error: str = ""

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
    if IS_WINDOWS:
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


def run_argv(
    argv: list[str],
    *,
    timeout_ms: int,
    cwd: str | None = None,
    path: str | None = None,
    max_output: int = MAX_OUTPUT_BYTES,
    env_extra: dict[str, str] | None = None,
) -> ExecOutcome:
    """Run ``argv`` under every guarantee described in the module docstring.

    Never raises for anything the child does; failure modes come back as an
    :class:`ExecStatus`.
    """
    if not argv:
        return ExecOutcome(status=ExecStatus.ERROR, error="empty argv")

    started = time.monotonic()
    env = sanitized_env(path=path, extra=env_extra)

    popen_kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "cwd": cwd,
        "env": env,
        "close_fds": True,
    }
    if IS_WINDOWS:
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        # Its own session, so killpg reaches every descendant.
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen(argv, **popen_kwargs)  # type: ignore[arg-type]
    except FileNotFoundError:
        return ExecOutcome(
            status=ExecStatus.NOT_FOUND,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except PermissionError:
        return ExecOutcome(
            status=ExecStatus.DENIED,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except OSError as exc:
        # Exec-format errors, ENOEXEC on a data file, and similar.
        return ExecOutcome(
            status=ExecStatus.ERROR,
            duration_ms=int((time.monotonic() - started) * 1000),
            error=str(exc),
        )

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

    if timed_out:
        return ExecOutcome(
            status=ExecStatus.TIMEOUT,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            truncated=truncated,
        )

    code = proc.returncode
    return ExecOutcome(
        status=ExecStatus.OK if code == 0 else ExecStatus.FAILED,
        exit_code=code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        truncated=truncated,
    )
