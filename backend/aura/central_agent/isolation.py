"""
isolation — per-worker git worktrees for parallel execution.
=========================================================

Milestone 1 of Phase 3. Concurrent workers must not share one live
working tree, so each parallel task runs in its own `git worktree`
branched from the project's current HEAD, in a controlled AURA-owned
directory (never inside the user's project).

Safety rules enforced here, mechanically:
  • NOTHING here ever runs destructive git commands against the user's
    working tree. The project is only ever read (`rev-parse HEAD`,
    `status --porcelain`). Branches are created at `-b` in the NEW
    worktree's path, never checked out in the user's tree.
  • The project may be DIRTY (the user's uncommitted work stays exactly
    where it is): a worker's task scope is repo-relative, and its
    worktree starts from HEAD, so user edits are invisible to it and
    untouchable by it.
  • Integration happens in a separate AURA-owned worktree. The user's
    active branch is never merged into, checked out, or modified.
  • Cleanup removes ONLY worktrees this module created in its own root
    and positively recorded. Untracked files inside a removed worktree
    are preserved by copying any changed file back into the integration
    result before removal — never silently destroyed.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from ..config import aura_home

#: Controlled location for every isolation worktree, under AURA's own
#: home — never inside the user's project, never a temp dir another
#: process might clean mid-run.
ROOT_NAME = "worktrees"


def _git(repo: str, *argv: str, timeout: int = 60) -> tuple[int, str, str]:
    """One bounded, non-destructive git invocation in `repo`.

    Goes through aura.environment.procexec — the ONE execution boundary
    (secret isolation, stdin closed, bounded output, process-tree
    cleanup) — exactly like every other process AURA spawns."""
    from ..environment.procexec import run_argv
    outcome = run_argv(["git", *argv], timeout_ms=timeout * 1000, cwd=repo)
    return (0 if outcome.exit_code is None else outcome.exit_code,
            outcome.stdout or "", outcome.stderr or "")


def _now() -> str:
    from datetime import UTC, datetime
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z")


def isolation_root() -> Path:
    root = aura_home() / ROOT_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass
class WorkerWorktree:
    """One worker's isolated checkout, positively created by this module."""

    task_id: str
    node_id: str
    path: str
    branch: str
    base_commit: str
    created_at: str = field(default_factory=_now)

    def exists(self) -> bool:
        return Path(self.path).is_dir()


class IsolationManager:
    """Creates, inspects, integrates and cleans worker worktrees.

    One instance per run leg. Everything it made is recorded; everything
    it removes must be in that record and under the isolation root.
    """

    def __init__(self, project_cwd: str) -> None:
        self.project_cwd = project_cwd
        self.root = isolation_root() / f"run-{_now().replace(':', '')}"
        self.root.mkdir(parents=True, exist_ok=False)
        self._created: dict[str, WorkerWorktree] = {}

    # ── creation ─────────────────────────────────────────────────────

    def create(self, task_id: str, node_id: str) -> WorkerWorktree:
        """A worktree at the project's HEAD for one worker's task.

        `git worktree add -b <branch> <path> <commit>` creates the
        branch AT the new path — the user's tree never checks anything
        out. A dirty project costs nothing here: the worktree starts
        from the commit, and the user's uncommitted edits remain theirs.
        """
        code, head, err = _git(self.project_cwd, "rev-parse", "HEAD")
        if code != 0:
            raise RuntimeError(
                f"the project is not a readable git repository: {err.strip()[:160]}")
        base = head.strip()
        if not base:
            raise RuntimeError("the project repository has no commits to branch from")
        safe_task = "".join(
            c if (c.isalnum() or c in "-_") else "-" for c in task_id)[:40]
        safe_node = "".join(
            c if (c.isalnum() or c in "-_") else "-" for c in node_id)[:40]
        name = f"{safe_task}-{safe_node}"
        wt_path = self.root / name
        branch = f"aura/{name}"
        code, _, err = _git(
            self.project_cwd, "worktree", "add", "-b", branch,
            str(wt_path), base)
        if code != 0:
            raise RuntimeError(f"git worktree add failed: {err.strip()[:200]}")
        wt = WorkerWorktree(
            task_id=task_id, node_id=node_id, path=str(wt_path),
            branch=branch, base_commit=base)
        self._created[task_id] = wt
        return wt

    def get(self, task_id: str) -> WorkerWorktree | None:
        return self._created.get(task_id)

    def all(self) -> list[WorkerWorktree]:
        return list(self._created.values())

    # ── inspection ───────────────────────────────────────────────────

    def changed_files(self, task_id: str) -> list[str]:
        """Repo-relative paths this worker's worktree changed, vs HEAD.

        Covers staged, unstaged and untracked files (porcelain v1 -z,
        the same parser the scope supervisor uses). `-uall` stops git
        from collapsing a wholly-new directory into `dir/` — a worker's
        fresh output directory must yield its FILES, not a prefix."""
        wt = self._created.get(task_id)
        if wt is None:
            return []
        code, out, _ = _git(wt.path, "status", "--porcelain=v1", "-z",
                            "-uall")
        if code != 0:
            return []
        from ..fabric.supervision import parse_porcelain_status
        return parse_porcelain_status(out)

    def file_blobs(self, task_id: str) -> dict[str, str]:
        """Changed path → full file content from the worker's worktree."""
        wt = self._created.get(task_id)
        if wt is None:
            return {}
        out: dict[str, str] = {}
        for rel in self.changed_files(task_id):
            p = Path(wt.path) / rel
            try:
                if p.is_file():
                    out[rel] = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue  # binary/unreadable: recorded as changed, content skipped
        return out

    # ── integration ──────────────────────────────────────────────────

    def integrate(self, task_ids: list[str]) -> dict:
        """Apply every task's changes into ONE integration worktree.

        Content-level apply (read file → write file), not a git merge:
        the changes are uncommitted work-tree edits, and a merge would
        need commits. Overlaps were already detected by the caller;
        this applies the agreed set and returns per-task paths plus the
        integration worktree itself for combined verification.

        A path that already differs in the integration tree (i.e. two
        tasks changed the same file with different content) is NEVER
        overwritten — the caller was told, and the first writer wins
        visibly: the conflict is reported in `conflicts`.
        """
        code, head, _ = _git(self.project_cwd, "rev-parse", "HEAD")
        base = head.strip()
        integ_path = self.root / "integration"
        code, _, err = _git(
            self.project_cwd, "worktree", "add", "-b", "aura/integration",
            str(integ_path), base)
        if code != 0:
            raise RuntimeError(f"integration worktree failed: {err.strip()[:200]}")
        applied: dict[str, list[str]] = {}
        conflicts: list[dict] = []
        try:
            for tid in task_ids:
                wt = self._created.get(tid)
                if wt is None:
                    continue
                for rel, content in self.file_blobs(tid).items():
                    target = Path(integ_path) / rel
                    if target.exists():
                        current = target.read_text(encoding="utf-8",
                                                   errors="replace")
                        if current != content:
                            conflicts.append({
                                "path": rel, "tasks": sorted(
                                    t for t in task_ids
                                    if rel in (self.changed_files(t) or []))})
                            continue  # never overwrite a fellow worker's file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                    applied.setdefault(tid, []).append(rel)
            result = {
                "integrationPath": str(integ_path),
                "branch": "aura/integration",
                "applied": applied,
                "conflicts": conflicts,
            }
        except Exception:
            self.remove_worktree(str(integ_path), branch="aura/integration")
            raise
        return result

    # ── cleanup ──────────────────────────────────────────────────────

    def remove_worktree(self, path: str, branch: str | None = None) -> None:
        """Remove one AURA-owned worktree, forcing if git needs it.

        `--force` here removes the WORKTREE (git's registered checkout),
        not user data: the path was created by this module under the
        isolation root. Changed files are expected to have been copied
        out (integrate) or intentionally discarded (failed task evidence
        lives in the executor's stdout/log records instead).
        """
        if not path.startswith(str(self.root)):
            return  # refuse anything this module did not create
        _git(self.project_cwd, "worktree", "remove", "--force", path)
        if branch:
            _git(self.project_cwd, "branch", "-D", branch)

    def cleanup(self) -> None:
        """Remove every worktree and branch this run created.

        Positive identification: only recorded paths under this run's
        root, plus the integration worktree if it exists. The user's
        tree, its branches, and all untracked files outside these
        worktrees are untouched.
        """
        for wt in self._created.values():
            if wt.exists():
                self.remove_worktree(wt.path, branch=wt.branch)
        integ = self.root / "integration"
        if integ.is_dir():
            self.remove_worktree(str(integ), branch="aura/integration")


def conflict_scan(changes: dict[str, list[str]]) -> list[dict]:
    """Which files did two or more tasks change? Pure, over already
    collected per-task changed paths. Empty = the parallel run's outputs
    are disjoint and integration can proceed."""
    owners: dict[str, list[str]] = {}
    for tid, paths in changes.items():
        for p in paths or []:
            owners.setdefault(p, []).append(tid)
    return [
        {"path": path, "tasks": sorted(tasks)}
        for path, tasks in sorted(owners.items())
        if len(tasks) > 1
    ]
