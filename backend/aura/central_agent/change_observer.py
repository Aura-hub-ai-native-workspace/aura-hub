"""What actually changed on disk while a task ran.

A worker reports the files it says it changed; that is a claim. This module
measures the project folder before and after a project-mutating task and
reports the difference — created, modified, deleted — so the Workspace can
show *observed* changes and mark them apart from anything merely proposed.

It is a snapshot of ``(size, mtime_ns, digest)`` per file. The digest exists only
for small files and only so that a file rewritten with IDENTICAL content is not
reported as changed (a new mtime alone is not a change); no content is kept. Dependency and
build folders, version-control internals and AURA's own ``.aura`` folder are
skipped, and the walk is bounded: a project too large to observe completely
says so instead of reporting a partial diff as complete.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from ..fabric.supervision import IGNORED_CONTENT_DIRS

#: Directories that hold no authored project content. The SAME list the
#: scope check uses (fabric.supervision.IGNORED_CONTENT_DIRS), so a path
#: the Workspace calls "not a change" is not a scope violation either.
IGNORED_DIRS = IGNORED_CONTENT_DIRS
MAX_FILES = 8000
MAX_DEPTH = 12
#: Files up to this size also get a content digest (see module docstring).
DIGEST_MAX_BYTES = 64 * 1024


class Snapshot:
    def __init__(self, files: dict[str, tuple], complete: bool) -> None:
        self.files = files
        self.complete = complete


def snapshot(root: str | Path) -> Snapshot | None:
    """The folder's files, or None when there is no readable folder."""
    base = Path(root)
    if not base.is_dir():
        return None
    files: dict[str, tuple] = {}
    complete = True
    stack: list[tuple[Path, int]] = [(base, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            with os.scandir(directory) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue  # never follow a link out of the project
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in IGNORED_DIRS:
                                continue
                            if depth + 1 > MAX_DEPTH:
                                complete = False
                                continue
                            stack.append((Path(entry.path), depth + 1))
                        elif entry.is_file(follow_symlinks=False):
                            if len(files) >= MAX_FILES:
                                complete = False
                                continue
                            st = entry.stat(follow_symlinks=False)
                            digest = None
                            if st.st_size <= DIGEST_MAX_BYTES:
                                try:
                                    with open(entry.path, "rb") as fh:
                                        digest = hashlib.blake2b(fh.read(), digest_size=16).hexdigest()
                                except OSError:
                                    digest = None
                            files[os.path.relpath(entry.path, base)] = (st.st_size, st.st_mtime_ns, digest)
                    except OSError:
                        complete = False
        except OSError:
            complete = False
    return Snapshot(files, complete)


def diff(before: Snapshot | None, after: Snapshot | None) -> tuple[list[dict], bool]:
    """Changes between two snapshots as ``[{"path", "op"}]`` and whether the
    observation covered everything."""
    if before is None or after is None:
        return [], False
    changes: list[dict] = []
    for path, sig in after.files.items():
        old = before.files.get(path)
        if old is None:
            changes.append({"path": path.replace(os.sep, "/"), "op": "created"})
        elif old != sig:
            if old[2] is not None and old[2] == sig[2]:
                continue  # rewritten with identical content: not a change
            changes.append({"path": path.replace(os.sep, "/"), "op": "modified"})
    for path in before.files:
        if path not in after.files:
            changes.append({"path": path.replace(os.sep, "/"), "op": "deleted"})
    changes.sort(key=lambda c: c["path"])
    return changes, before.complete and after.complete


__all__ = ["Snapshot", "diff", "snapshot"]
