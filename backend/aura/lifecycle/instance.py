"""Instance lock: proof that an AURA process is alive (issue #112).

Every AURA process holds an exclusive OS lock on
``$AURA_HOME/run/instances/<instance-id>.lock`` for its whole life. The
operating system releases it however the process ends (exit, crash,
SIGKILL, OOM kill, TerminateProcess), so:

* ``held``    — some live process owns it;
* ``free``    — nobody does: its owner is gone;
* ``absent``  — no such lock file (another home, already cleaned up);
* ``unknown`` — the lock could not be probed.

Liveness is decided by actually trying the lock from a separate handle,
never by whether the file exists. Only ``free`` allows cleanup; every
other state means "leave it alone".
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .procident import start_identity

HELD, FREE, ABSENT, UNKNOWN = "held", "free", "absent", "unknown"
LABEL_INSTANCE = "aura.sandbox.instance"
LABEL_HOME = "aura.sandbox.home"


def instances_dir(home: str | Path) -> Path:
    return Path(home) / "run" / "instances"


def home_tag(home: str | Path) -> str:
    """A short, stable label for an AURA home (never the path itself)."""
    real = os.path.realpath(str(home))
    return hashlib.sha256(real.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _try_lock(fd: int) -> None:
    """Exclusive, non-blocking. Raises BlockingIOError/PermissionError when held."""
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


def _is_held_error(exc: OSError) -> bool:
    return isinstance(exc, BlockingIOError) or exc.errno in (
        errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES, errno.EDEADLK)


def lock_state(path: str | Path) -> str:
    """Probe a lock file from a fresh handle. Never takes it for longer than the probe."""
    path = Path(path)
    if not path.exists():
        return ABSENT
    try:
        fd = os.open(str(path), os.O_RDWR)
    except FileNotFoundError:
        return ABSENT
    except OSError:
        return UNKNOWN
    try:
        try:
            _try_lock(fd)
        except OSError as exc:
            return HELD if _is_held_error(exc) else UNKNOWN
        try:
            _unlock(fd)
        except OSError:
            pass
        return FREE
    finally:
        os.close(fd)


def instance_state(home: str | Path, instance_id: str) -> str:
    if not instance_id or not all(c in "0123456789abcdef" for c in instance_id):
        return UNKNOWN
    return lock_state(instances_dir(home) / f"{instance_id}.lock")


@dataclass
class Instance:
    id: str
    home: str
    lock_path: Path
    verified: bool
    _fd: int

    @property
    def tag(self) -> str:
        return home_tag(self.home)


_current: Instance | None = None
_guard = threading.Lock()


def acquire(home: str | Path) -> Instance:
    """This process's instance lock for ``home``; created once, held for life."""
    global _current
    with _guard:
        if _current is not None and os.path.realpath(_current.home) == os.path.realpath(str(home)):
            return _current
        d = instances_dir(home)
        d.mkdir(parents=True, exist_ok=True)
        iid = uuid.uuid4().hex
        path = d / f"{iid}.lock"
        fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, b"\0")
        _try_lock(fd)  # a brand-new file: nobody else can hold it
        # Verify actual ownership: a second handle must now be refused.
        verified = lock_state(path) == HELD
        meta = {"instance": iid, "pid": os.getpid(), "startIdentity": start_identity(os.getpid()),
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "verified": verified}
        (d / f"{iid}.json").write_text(json.dumps(meta), encoding="utf-8")
        _current = Instance(iid, str(home), path, verified, fd)
        return _current


def current() -> Instance | None:
    return _current


def _reset_for_tests() -> None:
    """Release this process's lock (tests only)."""
    global _current
    with _guard:
        if _current is not None:
            try:
                _unlock(_current._fd)
            except OSError:
                pass
            os.close(_current._fd)
        _current = None
