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
        """
        journal = getattr(self, "_starts", None)
        if journal is None:
            journal = AuditStore(self._file.with_name(STARTS_FILE))
            self._starts = journal
        return journal


#: The start journal's file name, beside the trail it belongs to.
STARTS_FILE = "started.jsonl"
UNSETTLED = "unsettled-after-restart"


def _pid_alive(pid: Any) -> bool:
    """Is a process with this id running? Never signals or affects it."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) TERMINATES the process on Windows; query instead.
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False
    return True


def reconcile_unsettled_starts(trail: "AuditStore", *, now: str | None = None,
                               pid_alive=_pid_alive) -> list[str]:
    """Mark started-but-never-settled invocations of dead processes, once.

    After an unexpected termination the trail has no record for an action
    that was in flight, while the start journal does. Each such start gets
    one ``unsettled-after-restart`` marker in the start journal: it was
    authorized and started, and no outcome was recorded. Starts of a live
    process (still running elsewhere), already-settled starts and starts
    already marked are left alone. A start older than everything the
    trail still holds is skipped: its settlement may have been trimmed.
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
                or r.get("pid") == os.getpid() or pid_alive(r.get("pid"))):
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
