"""Process identity that survives PID reuse (issue #112).

``pid_state`` says whether a process id is ``alive``, ``dead`` or
``unknown`` and never signals the process. ``start_identity`` returns a
string that names one particular process: the same pid with a different
start identity is a different process (the pid was reused). Unknown is
never treated as dead, and a missing identity is never treated as a match.
"""

from __future__ import annotations

import os
import sys
from typing import Any

ALIVE, DEAD, UNKNOWN = "alive", "dead", "unknown"

_WIN_ERROR_INVALID_PARAMETER = 87
_WIN_STILL_ACTIVE = 259
_WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _kernel32():
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k.GetExitCodeProcess.restype = wintypes.BOOL
    k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k.GetProcessTimes.restype = wintypes.BOOL
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.CloseHandle.restype = wintypes.BOOL
    return k, ctypes, wintypes


def pid_state(pid: Any) -> str:
    """``alive`` | ``dead`` | ``unknown``. Only ``dead`` is proof."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return UNKNOWN
    if os.name == "nt":
        try:
            k, ctypes, wintypes = _kernel32()
            h = k.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                return DEAD if ctypes.get_last_error() == _WIN_ERROR_INVALID_PARAMETER else UNKNOWN
            try:
                code = wintypes.DWORD()
                if not k.GetExitCodeProcess(h, ctypes.byref(code)):
                    return UNKNOWN
                return ALIVE if code.value == _WIN_STILL_ACTIVE else DEAD
            finally:
                k.CloseHandle(h)
        except Exception:  # noqa: BLE001
            return UNKNOWN
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return DEAD
    except PermissionError:
        return ALIVE
    except OSError:
        return UNKNOWN
    # A zombie has exited; only its exit status is still waiting to be read.
    return DEAD if _is_zombie(pid) else ALIVE


def _is_zombie(pid: int) -> bool:
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as fh:
                stat = fh.read()
            return stat[stat.rindex(")") + 2:].split()[0] == "Z"
        except (OSError, ValueError, IndexError):
            return False
    if sys.platform == "darwin":
        out = _ps(["-o", "stat=", "-p", str(pid)])
        return bool(out) and out.startswith("Z")
    return False


def _ps(args: list[str]) -> str | None:
    """`ps` through AURA's one execution boundary (macOS). None on any failure."""
    try:
        from ..environment.procexec import ExecStatus, run_argv

        out = run_argv(["ps", *args], timeout_ms=5000, env_extra={"LC_ALL": "C"})
    except Exception:  # noqa: BLE001
        return None
    if out.status is not ExecStatus.OK or out.exit_code != 0:
        return None
    return out.stdout.strip() or None


def _linux_identity(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as fh:
            stat = fh.read()
        # comm may contain spaces and parentheses: fields start after the last ")".
        fields = stat[stat.rindex(")") + 2:].split()
        start_ticks = fields[19]  # field 22 overall: starttime
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as fh:
            boot = fh.read().strip()
        return f"linux:{boot}:{pid}:{start_ticks}"
    except (OSError, ValueError, IndexError):
        return None


def _darwin_identity(pid: int) -> str | None:
    text = _ps(["-o", "lstart=", "-p", str(pid)])
    return f"darwin:{pid}:{text}" if text else None


def _windows_identity(pid: int) -> str | None:
    try:
        k, ctypes, wintypes = _kernel32()
        h = k.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            created, exited, kern, user = (wintypes.FILETIME() for _ in range(4))
            if not k.GetProcessTimes(h, ctypes.byref(created), ctypes.byref(exited),
                                     ctypes.byref(kern), ctypes.byref(user)):
                return None
            return f"nt:{pid}:{(created.dwHighDateTime << 32) | created.dwLowDateTime}"
        finally:
            k.CloseHandle(h)
    except Exception:  # noqa: BLE001
        return None


def start_identity(pid: Any) -> str | None:
    """A string naming this exact process (pid + when it started), or None."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if sys.platform.startswith("linux"):
        return _linux_identity(pid)
    if sys.platform == "darwin":
        return _darwin_identity(pid)
    if os.name == "nt":
        return _windows_identity(pid)
    return None
