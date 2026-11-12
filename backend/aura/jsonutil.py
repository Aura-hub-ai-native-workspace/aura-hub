"""Node-compatible JSON serialization — the byte-level backbone of parity.

Frozen by docs/migration/persisted-formats.md §2:
  - stores:   JSON.stringify(value, null, 2) → pretty, indent 2, NO trailing newline
  - digests:  JSON.stringify(value)         → compact, no spaces, raw UTF-8
  - audit:    one JSON.stringify(record) per line + "\\n" (append-only)

Python's json module matches Node byte-for-byte for these modes when:
  separators are pinned, ensure_ascii=False, and NaN/Infinity never occur in
  contract data (they cannot come from JSON.parse on either side).
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

__all__ = [
    "append_jsonl",
    "dumps_compact",
    "dumps_pretty",
    "loads_tolerant",
    "read_json_file",
    "read_jsonl",
    "write_json_file",
]


# TS-parity name for the atomic writer (persist.ts calls it writeJsonFile).
def write_json_file(file: str | Path, value: Any) -> None:
    """Alias of write_json_atomic — matches persist.ts naming."""
    write_json_atomic(file, value)


def dumps_compact(value: Any) -> str:
    """JSON.stringify(value) equivalent."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def dumps_pretty(value: Any) -> str:
    """JSON.stringify(value, null, 2) equivalent — indent 2, no trailing newline."""
    return json.dumps(value, indent=2, ensure_ascii=False)


def loads_tolerant(text: str | bytes, fallback: Any) -> Any:
    """Mirror readJsonFile: missing/corrupt input degrades to fallback, never raises."""
    try:
        return json.loads(text)
    except Exception:
        return fallback


def replace_with_retry(tmp: str | Path, dest: str | Path) -> None:
    """``os.replace`` that survives another writer replacing ``dest`` at that instant.

    On Windows a rename onto a file being replaced by another thread fails with
    ``PermissionError`` for a few milliseconds; the write is still correct, so it is
    retried briefly. Any other failure, and one that outlasts the retries, is raised.
    """
    import time

    delay = 0.005
    for attempt in range(12):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 11:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.25)


def write_json_atomic(file: str | Path, value: Any, *, pid: int | None = None) -> None:
    """Mirror persist.ts writeJsonFile: write a temp file, then rename.

    The temp name is unique per call (pid, thread, random token), so two
    threads in one process writing the same store can never share a temp
    file. A shared name let one writer's rename move the other's file,
    which raised FileNotFoundError and could tear a write. ``O_EXCL`` makes
    creation fail rather than reuse a file. Inside the data folder the file
    is created 0600; elsewhere mode 0o666 gives the same umask-governed
    permissions as ``open(..., "w")``. Content is
    dumps_pretty bytes; rename is atomic on POSIX; parent dirs are created
    on demand exactly like the TS writer. On failure the temp file is
    removed and the error re-raised, so the target is never half-written.
    """
    from .config import inside_aura_home, protect_aura_home

    path = Path(file)
    # Stores in the data folder are owner-only (0600); files elsewhere keep
    # the usual umask-governed permissions.
    owner_only = os.name != "nt" and inside_aura_home(path)
    if owner_only:
        protect_aura_home()
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = pid if pid is not None else os.getpid()
    data = dumps_pretty(value).encode("utf-8")
    while True:
        tmp = f"{path}.{owner}.{uuid.uuid4().hex}.tmp"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if owner_only else 0o666)
            break
        except FileExistsError:  # astronomically rare; retry with a new token
            continue
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        replace_with_retry(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json_file(file: str | Path, fallback: Any) -> Any:
    """Mirror persist.ts readJsonFile."""
    try:
        return loads_tolerant(Path(file).read_text(encoding="utf-8"), fallback)
    except OSError:
        return fallback


def append_jsonl(file: str | Path, record: Any) -> None:
    """One compact JSON line + newline. Append-only (audit store semantics)."""
    path = Path(file)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(dumps_compact(record) + "\n")


def read_jsonl(file: str | Path) -> list[Any]:
    """Parse all usable lines; skip blanks and unparseable tails (never fatal)."""
    out: list[Any] = []
    try:
        raw = Path(file).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in raw.split("\n"):
        if not line.strip():
            continue
        parsed = loads_tolerant(line, None)
        if parsed is not None:
            out.append(parsed)
    return out
