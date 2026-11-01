"""Portable process checks for tests: /proc where it exists (Linux), `ps` elsewhere (macOS)."""
from __future__ import annotations

import os
import shutil
import subprocess


def _state(pid: int) -> str | None:
    """The process state letters (for example 'S', 'Z'), or None when unknown."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return fh.read().split()[2]
    except OSError:
        pass
    ps = shutil.which("ps")
    if ps:
        out = subprocess.run([ps, "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
        return out.stdout.strip() or None
    return None


def alive(pid: int) -> bool:
    """True while the process runs. A zombie still answers kill(0) until reaped, so it counts as gone."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    state = _state(pid)
    return not (state and state.startswith("Z"))


def survivors(project, script: str) -> list[int]:
    """Live processes running `script` from the project directory (any directory where /proc is absent)."""
    found: list[int] = []
    if os.path.isdir("/proc"):
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                continue
            if script.encode() in argv and cwd == str(project):
                found.append(int(pid))
        return found
    ps = shutil.which("ps")
    if not ps:
        return found
    listing = subprocess.run([ps, "-Ao", "pid=,stat=,command="], capture_output=True, text=True).stdout
    for line in listing.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and not parts[1].startswith("Z") and script in parts[2].split() \
                and int(parts[0]) != os.getpid():
            found.append(int(parts[0]))
    return found
