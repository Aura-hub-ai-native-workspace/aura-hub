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
            for r in kept:
                fh.write(dumps_compact(r) + "\n")
        os.replace(tmp, self._file)
