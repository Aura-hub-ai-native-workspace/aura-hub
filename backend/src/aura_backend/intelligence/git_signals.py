"""Whole-repository git status and recent commits.

A port of packages/ai-service/src/mission/gitSignals.ts.

Read-only, and it **never raises**: any failure — not a repository, git
missing — comes back as an honest `available: False` with a reason rather
than taking down whatever asked. Same spawn discipline as everywhere
else: an argv list, an allow-listed binary, a bounded timeout, no shell.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..execution import ProcessNotInstalled, SpawnOptions
from ..execution import git as run_git

RECENT_COMMIT_LIMIT = 8
# The reference formats with \x1f separators so a subject containing any
# ordinary punctuation cannot split the record.
_SEP = "\x1f"


@dataclass
class GitStatusSignal:
    available: bool
    branch: str = ""
    dirty: bool = False
    changed_files: int = 0
    reason: str = ""


def gather_git_status(project_path: str) -> GitStatusSignal:
    try:
        branch = run_git(["branch", "--show-current"], SpawnOptions(cwd=project_path))
        status = run_git(["status", "--porcelain"], SpawnOptions(cwd=project_path))
    except (ProcessNotInstalled, OSError) as exc:
        return GitStatusSignal(available=False, reason=str(exc))

    if branch.code != 0 and status.code != 0:
        return GitStatusSignal(available=False, reason="not a git repository")

    changed = len([line for line in status.out.split("\n") if line]) if status.out else 0
    return GitStatusSignal(
        available=True,
        branch=branch.out or "(detached)",
        dirty=changed > 0,
        changed_files=changed,
    )


def gather_recent_commits(
    project_path: str, limit: int = RECENT_COMMIT_LIMIT
) -> list[dict[str, str]]:
    try:
        result = run_git(
            ["log", "-n", str(limit), f"--pretty=format:%H{_SEP}%aI{_SEP}%s"],
            SpawnOptions(cwd=project_path),
        )
    except (ProcessNotInstalled, OSError):
        return []
    if result.code != 0 or not result.out.strip():
        return []

    commits: list[dict[str, str]] = []
    for line in result.out.split("\n"):
        if not line:
            continue
        parts = line.split(_SEP)
        commits.append({
            "hash": (parts[0] if len(parts) > 0 else "")[:10],
            "date": parts[1] if len(parts) > 1 else "",
            "subject": parts[2] if len(parts) > 2 else "",
        })
    return commits
