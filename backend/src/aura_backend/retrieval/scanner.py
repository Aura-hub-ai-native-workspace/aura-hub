"""Real recursive filesystem traversal.

A port of packages/knowledge-coding/src/scanner.ts.

Walks a workspace depth-first applying ignore rules, guards against
symlink loops by real path, tolerates permission errors per entry rather
than aborting, and supports cooperative cancellation.
"""

from __future__ import annotations

import errno as _errno
import os
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event

from .ignore import IgnoreRules
from .types import FileError, ScanEntry


class ScanCancelled(Exception):
    """Cooperative cancellation, matching the reference's AbortError."""


@dataclass
class ScanResult:
    entries: list[ScanEntry] = field(default_factory=list)
    scanned_dirs: int = 0
    skipped: int = 0
    errors: list[FileError] = field(default_factory=list)


def _mtime_ms(stat: os.stat_result) -> float:
    """Modification time in milliseconds, the way Node reports it.

    Node's `mtimeMs` is derived from nanoseconds (`tv_sec * 1000 +
    tv_nsec / 1e6`). Python's `st_mtime` is already a lossy float in
    seconds, so multiplying it by 1000 gives different low bits — and
    this value feeds both the recency score and the incremental
    fast-path equality check.
    """
    return stat.st_mtime_ns / 1e6


def _errno_name(exc: OSError, fallback: str) -> str:
    return _errno.errorcode.get(exc.errno or 0, fallback)


class WorkspaceScanner:
    def __init__(self, rules: IgnoreRules) -> None:
        self._rules = rules

    def scan(self, root: str, cancel: Event | None = None) -> ScanResult:
        abs_root = Path(root).resolve()
        result = ScanResult()
        visited: set[str] = set()

        def check_cancel() -> None:
            if cancel is not None and cancel.is_set():
                raise ScanCancelled("Scan cancelled")

        def walk(directory: Path) -> None:
            check_cancel()
            try:
                # Sorted, matching Node's readdir. Walk order is observable
                # through the manifest and through which files survive a
                # truncated scan.
                dirents = sorted(os.scandir(directory), key=lambda e: e.name)
            except OSError as exc:
                rel = os.path.relpath(directory, abs_root)
                result.errors.append(
                    FileError(rel_path=rel if rel != "." else ".",
                              code=_errno_name(exc, "EDIR"), message=str(exc))
                )
                return
            result.scanned_dirs += 1

            for dirent in dirents:
                check_cancel()
                abs_path = Path(dirent.path)
                rel = os.path.relpath(abs_path, abs_root)

                if dirent.is_symlink():
                    # Resolve once; skip if it lands in an already-visited
                    # real directory, which is what breaks symlink loops.
                    try:
                        if abs_path.is_dir():
                            real = str(abs_path.resolve())
                            if real not in visited and self._rules.allow_dir(dirent.name):
                                visited.add(real)
                                walk(abs_path)
                        elif abs_path.is_file() and self._rules.allow_file(dirent.name, rel):
                            stat = abs_path.stat()
                            result.entries.append(
                                ScanEntry(str(abs_path), rel, stat.st_size,
                                          _mtime_ms(stat))
                            )
                        else:
                            result.skipped += 1
                    except OSError:
                        result.skipped += 1
                    continue

                if dirent.is_dir(follow_symlinks=False):
                    if not self._rules.allow_dir(dirent.name):
                        result.skipped += 1
                        continue
                    walk(abs_path)
                elif dirent.is_file(follow_symlinks=False):
                    if not self._rules.allow_file(dirent.name, rel):
                        result.skipped += 1
                        continue
                    try:
                        stat = dirent.stat()
                        result.entries.append(
                            ScanEntry(str(abs_path), rel, stat.st_size,
                                      _mtime_ms(stat))
                        )
                    except OSError as exc:
                        result.errors.append(
                            FileError(rel_path=rel, code=_errno_name(exc, "ESTAT"),
                                      message=str(exc))
                        )

        walk(abs_root)
        return result
