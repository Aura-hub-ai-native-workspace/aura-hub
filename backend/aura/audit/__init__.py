"""Audit store — port of ai-service/src/fabric/auditStore.ts (98 lines).

Append-only JSONL; keep 5000, trim only past 6000 dropping the OLDEST,
trim check every 1000 appends of this process; truncated final line from an
interrupted append is skipped, never fatal; a record is usable only if it can
still answer the audit question (non-empty invocationId/capabilityId/at).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..jsonutil import dumps_compact, read_jsonl

MAX_RECORDS = 5000
TRIM_TRIGGER = MAX_RECORDS + 1000
TRIM_CHECK_EVERY = 1000


def _usable(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and isinstance(value.get("invocationId"), str) and value["invocationId"]
        and isinstance(value.get("capabilityId"), str) and value["capabilityId"]
        and isinstance(value.get("at"), str) and value["at"]
    )


class AuditStore:
    def __init__(self, file: str | Path) -> None:
        self._file = Path(file)
        self._since_trim = 0

    def load(self) -> list[dict[str, Any]]:
        all_records = [r for r in read_jsonl(self._file) if _usable(r)]
        return all_records[-MAX_RECORDS:]

    def append(self, record: dict[str, Any]) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        with open(self._file, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(dumps_compact(record) + "\n")
        self._since_trim += 1
        # Amortised: counts appends made by THIS process only.
        if self._since_trim < TRIM_CHECK_EVERY:
            return
        self._since_trim = 0
        all_records = read_jsonl(self._file)
        if len(all_records) <= TRIM_TRIGGER:
            return
        kept = [r for r in all_records[-MAX_RECORDS:] if _usable(r)]
        tmp = f"{self._file}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.writelines(dumps_compact(r) + "\n" for r in kept)
        os.replace(tmp, self._file)

    def starts(self) -> "AuditStore":
        """The start journal beside this trail (``started.jsonl``).

        The trail keeps one record per *settled* invocation (invariants §3),
        written when the action ends. The start journal records that an
        action was authorized and is about to run, before it runs, so a
        process that dies mid-action still leaves that on disk. Same
        append-only format, bounds and usability gate as the trail. One
        instance per trail, so trimming is counted per process.

        Durability: each record is written and the file closed before the
        action runs, so it survives the process being killed. It is NOT
        guaranteed to survive an operating-system crash or power loss (no
        fsync). If the record cannot be written, only low-risk actions run
        (flagged); anything else is blocked (CapabilityFabric).
        """
        journal = getattr(self, "_starts", None)
        if journal is None:
            journal = AuditStore(self._file.with_name(STARTS_FILE))
            self._starts = journal
        return journal


#: The start journal's file name, beside the trail it belongs to.
STARTS_FILE = "started.jsonl"
UNSETTLED = "unsettled-after-restart"


#: Process states. Only DEAD is proof; UNKNOWN never counts as dead.
ALIVE, DEAD, UNKNOWN = "alive", "dead", "unknown"

_WIN_ERROR_ACCESS_DENIED = 5
_WIN_ERROR_INVALID_PARAMETER = 87  # OpenProcess: no process has this id
_WIN_STILL_ACTIVE = 259
_WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class _WinProcessApi:
    """The three kernel32 calls the Windows check needs, with declared types.

    Separate so the decision logic (``_pid_state_windows``) can be tested
    on every platform with a fake; this class only runs on Windows.
    """

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        self._k, self._ctypes, self._wt = k, ctypes, wintypes

    def open(self, pid: int):
        return self._k.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)

    def last_error(self) -> int:
        return self._ctypes.get_last_error()

    def exit_code(self, handle) -> int | None:
        code = self._wt.DWORD()
        if not self._k.GetExitCodeProcess(handle, self._ctypes.byref(code)):
            return None
        return int(code.value)

    def close(self, handle) -> None:
        self._k.CloseHandle(handle)


def _pid_state_windows(pid: int, api) -> str:
    handle = api.open(pid)
    if not handle:
        err = api.last_error()
        if err == _WIN_ERROR_INVALID_PARAMETER:
            return DEAD
        # Access denied means the process exists but may not be opened (for
        # example an elevated one). It is never evidence of death; nor is
        # any other failure.
        return UNKNOWN
    try:
        code = api.exit_code(handle)
        if code is None:
            return UNKNOWN
        # STILL_ACTIVE; a process that really exited with 259 reads as alive,
        # which errs on the side of leaving its record alone.
        return ALIVE if code == _WIN_STILL_ACTIVE else DEAD
    finally:
        api.close(handle)


def pid_state(pid: Any, *, _win_api=None) -> str:
    """``alive``, ``dead`` or ``unknown`` for a process id. Never signals it.

    POSIX: ``os.kill(pid, 0)`` — no such process is DEAD, EPERM is ALIVE
    (exists, owned by someone else), anything else is UNKNOWN. Windows:
    ``os.kill`` would TERMINATE the process, so the state is queried with
    ``OpenProcess``/``GetExitCodeProcess``; only "no such process" is DEAD.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return UNKNOWN
    if os.name == "nt":
        try:
            return _pid_state_windows(pid, _win_api or _WinProcessApi())
        except Exception:  # noqa: BLE001 — an unusable API proves nothing
            return UNKNOWN
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return DEAD
    except PermissionError:
        return ALIVE
    except OSError:
        return UNKNOWN
    return ALIVE


def reconcile_unsettled_starts(trail: "AuditStore", *, now: str | None = None,
                               pid_state=pid_state,
                               undetermined: list | None = None) -> list[str]:
    """Mark started-but-never-settled invocations of dead processes, once.

    After an unexpected termination the trail has no record for an action
    that was in flight, while the start journal does. Each such start gets
    one ``unsettled-after-restart`` marker in the start journal: it was
    authorized and started, and no outcome was recorded. Only a start whose
    process is confirmed DEAD is marked. A live process, or one whose state
    cannot be established (for example access denied on Windows), is left
    alone and its start record is preserved untouched; the latter is
    appended to ``undetermined`` (when given) so it can be reported. Already
    settled or marked starts, and starts older than everything the trail
    still holds (their settlement may have been trimmed), are skipped.
    Returns the invocation ids it marked.
    """
    from datetime import datetime, timezone

    journal = trail.starts()
    entries = journal.load()
    marked = {r["invocationId"] for r in entries if r.get("phase") == UNSETTLED}
    settled_records = [r for r in read_jsonl(trail._file) if _usable(r)]  # noqa: SLF001
    settled = {r["invocationId"] for r in settled_records}
    oldest = (min(r["at"] for r in settled_records)
              if len(settled_records) >= MAX_RECORDS else None)
    stamp = now or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    out: list[str] = []
    for r in entries:
        inv = r["invocationId"]
        if (r.get("phase") != "started" or inv in settled or inv in marked
                or (oldest is not None and r["at"] < oldest)
                or r.get("pid") == os.getpid()):
            continue
        state = pid_state(r.get("pid"))
        if state != DEAD:
            if state == UNKNOWN and undetermined is not None:
                undetermined.append(inv)
            continue
        marker = {
            "invocationId": inv, "capabilityId": r["capabilityId"], "at": stamp,
            "phase": UNSETTLED, "startedAt": r["at"],
            **{k: r[k] for k in ("sessionId", "taskId", "missionId", "requestId",
                                 "projectId", "pid") if r.get(k) is not None},
            "detail": ("Authorized and started; no outcome was recorded because "
                       "the process ended before the action settled."),
        }
        journal.append(marker)
        marked.add(inv)
        out.append(inv)
    return out
