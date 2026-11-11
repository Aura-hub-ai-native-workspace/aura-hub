"""Restore points: the project as it was before an agent changed it.

An autonomous run edits real files with nobody watching. Before each task
that may change a git project, AURA records the whole working tree (tracked
and untracked files, honouring .gitignore) as a commit object under
``refs/aura/restore/<label>``. Nothing the user sees changes: the branch,
the index, the stash and the working tree are untouched, because the
snapshot is written through a private, temporary index.

``restore`` puts the working tree back to a restore point: files are
returned to their recorded content and files created after it are removed.
Ignored files (dependencies, build output, secrets) are never touched.

Only the newest ``KEEP`` restore points are kept per project.
"""
from __future__ import annotations

import os
import re
import tempfile
import time

from ..environment.procexec import ExecStatus, run_argv

REF_PREFIX = "refs/aura/restore/"
KEEP = 50
#: Untracked, non-ignored content above this is not copied into .git; the
#: point is skipped instead (a dataset or a video next to the code would
#: otherwise be duplicated on every task).
MAX_UNTRACKED_BYTES = 200 * 1024 * 1024
_LABEL = re.compile(r"[^A-Za-z0-9._-]+")
_SHA = re.compile(r"^[0-9a-f]{40}$")
#: File lists of a large project; a truncated list must fail, never act on a part.
_MAX_OUTPUT = 32 * 1024 * 1024


def _git(cwd: str, *args: str, env: dict | None = None, check: bool = True) -> str:
    """Run git through AURA's one execution boundary (procexec)."""
    out = run_argv(["git", *args], timeout_ms=120_000, cwd=cwd,
                   path=os.environ.get("PATH"), env_extra=env, max_output=_MAX_OUTPUT)
    if check and (out.status is not ExecStatus.OK or out.truncated):
        raise RuntimeError(out.stderr.strip() or out.error or f"git {args[0]} failed ({out.status.value})")
    return out.stdout.strip()


def _is_repo(cwd: str | None) -> bool:
    if not cwd or not os.path.isdir(cwd):
        return False
    try:
        return _git(cwd, "rev-parse", "--is-inside-work-tree", check=False) == "true"
    except OSError:
        return False


def _tree_of_worktree(cwd: str) -> str:
    """The working tree as a tree object, via a throwaway index."""
    fd, index = tempfile.mkstemp(prefix="aura-restore-index-")
    os.close(fd)
    os.unlink(index)  # git creates it; an empty file is not a valid index
    env = {"GIT_INDEX_FILE": index}
    try:
        _git(cwd, "add", "-A", ".", env=env)
        return _git(cwd, "write-tree", env=env)
    finally:
        if os.path.exists(index):
            os.unlink(index)


def _untracked_bytes(cwd: str) -> int:
    total = 0
    for rel in _git(cwd, "ls-files", "-o", "--exclude-standard", "-z", check=False).split("\0"):
        if rel:
            try:
                total += os.lstat(os.path.join(cwd, rel)).st_size
            except OSError:
                pass
    return total


def create(cwd: str | None, label: str) -> str | None:
    """Record a restore point. Returns its commit id, or None when the
    folder is not a git project or git is unavailable. Never raises."""
    if not _is_repo(cwd):
        return None
    try:
        if _untracked_bytes(cwd) > MAX_UNTRACKED_BYTES:
            return None
        tree = _tree_of_worktree(cwd)
        env = {"GIT_AUTHOR_NAME": "AURA Hub", "GIT_AUTHOR_EMAIL": "restore@aura.local",
               "GIT_COMMITTER_NAME": "AURA Hub", "GIT_COMMITTER_EMAIL": "restore@aura.local"}
        head = _git(cwd, "rev-parse", "--verify", "-q", "HEAD", check=False)
        parents = ["-p", head] if head else []
        sha = _git(cwd, "commit-tree", tree, *parents, "-m", f"AURA restore point: {label}", env=env)
        name = _LABEL.sub("-", label).strip("-")[:120] or "point"
        # A millisecond prefix orders points exactly (commit dates have
        # one-second resolution) and keeps two points with one label apart.
        _git(cwd, "update-ref", f"{REF_PREFIX}{time.time_ns() // 1_000_000:013d}-{name}", sha)
        _prune(cwd)
        return sha
    except (OSError, RuntimeError):
        return None


def _prune(cwd: str) -> None:
    refs = _git(cwd, "for-each-ref", "--sort=-refname", "--format=%(refname)", REF_PREFIX,
                check=False).splitlines()
    for ref in refs[KEEP:]:
        _git(cwd, "update-ref", "-d", ref, check=False)


def list_points(cwd: str | None) -> list[dict]:
    if not _is_repo(cwd):
        return []
    rows = _git(cwd, "for-each-ref", "--sort=-refname",
                "--format=%(objectname) %(committerdate:iso-strict) %(refname)", REF_PREFIX,
                check=False).splitlines()
    out = []
    for row in rows:
        sha, when, ref = row.split(" ", 2)
        name = ref[len(REF_PREFIX):]
        out.append({"id": sha, "at": when, "label": name.split("-", 1)[1] if "-" in name else name})
    return out


def restore(cwd: str | None, sha: str) -> dict:
    """Put the working tree back to restore point ``sha``.

    Only a commit recorded as a restore point of this project is accepted.
    Returns ``{"restored": n, "removed": [paths]}``; raises ValueError for an
    unknown point and RuntimeError when git fails."""
    if not _is_repo(cwd):
        raise ValueError("This project is not a git repository, so it has no restore points.")
    if not _SHA.match(sha or "") or sha not in {p["id"] for p in list_points(cwd)}:
        raise ValueError("That is not a restore point of this project.")
    # A restore point of the state being replaced, so a restore can be undone too.
    create(cwd, f"before-restore-{sha[:12]}")
    now = _tree_of_worktree(cwd)
    added = _git(cwd, "diff-tree", "-r", "--name-only", "--diff-filter=A", "-z", f"{sha}^{{tree}}", now)
    removed = [p for p in added.split("\0") if p]
    for rel in removed:
        path = os.path.join(cwd, rel)
        if os.path.lexists(path) and not os.path.isdir(path):
            os.remove(path)
    _git(cwd, "restore", f"--source={sha}", "--worktree", "--", ".")
    changed = _git(cwd, "diff-tree", "-r", "--name-only", "-z", f"{sha}^{{tree}}", now)
    return {"restored": len([p for p in changed.split("\0") if p]), "removed": removed}


__all__ = ["create", "list_points", "restore", "REF_PREFIX", "KEEP"]
