"""Git installation vs repository distinction for inventory and executors.

Three different questions are routinely conflated:

* Is Git *installed*? Answered by ``git --version`` from any directory —
  never requires a repository.
* Is this directory *inside a repository*? Answered by
  ``git rev-parse --is-inside-work-tree`` run with ``cwd`` set to that
  directory.
* What is the repository state? Only meaningful when the previous answer
  is yes.

Running repository commands (``status``, ``log``, ``diff``) from an
arbitrary working directory (e.g. the scan's home-directory cwd) produces
``fatal: not a git repository`` — the exact user-visible symptom of this
bug. Those errors must never be interpreted as "Git is not installed".

All probes here go through :mod:`aura.environment.procexec` (argv-only,
stdin closed, minimal env, bounded output, tree-kill, timeout), never a
shell, and never from a repository-dependent cwd unless the caller named
that directory explicitly.
"""
from __future__ import annotations

import os
from typing import Any

from .procexec import ExecStatus, run_argv

#: Repository checks are cheap and must never hang a scan.
GIT_REPO_TIMEOUT_MS = 5000

NOT_A_REPO_MESSAGE = (
    "Git is installed, but the selected directory is not a Git repository."
)


def is_git_repository(path: str | None) -> bool:
    """True when ``path`` is inside a Git working tree.

    Returns False (rather than raising) for missing paths, missing binaries,
    timeouts, and every other failure mode — "could not establish" is not
    "is".
    """
    if not path or not isinstance(path, str):
        return False
    try:
        if not os.path.isdir(path):
            return False
    except OSError:
        return False
    outcome = run_argv(
        ["git", "rev-parse", "--is-inside-work-tree"],
        timeout_ms=GIT_REPO_TIMEOUT_MS,
        cwd=path,
    )
    if outcome.status is not ExecStatus.OK:
        return False
    return outcome.output.strip().lower() == "true"


def git_install_probe(cwd: str | None = None) -> dict[str, Any]:
    """Probe Git installation only — never requires a repository.

    Always runs from the home directory (never a project directory), so the
    result cannot depend on whether some unrelated folder is a repo.
    """
    home = os.path.expanduser("~")
    outcome = run_argv(
        ["git", "--version"],
        timeout_ms=GIT_REPO_TIMEOUT_MS,
        cwd=cwd or home,
    )
    if outcome.status is ExecStatus.OK:
        from .discovery import extract_version

        version = extract_version(outcome.output)
        return {
            "installed": True,
            "version": version,
            "detail": f"Found Git {version}." if version else "Found Git.",
        }
    if outcome.status is ExecStatus.NOT_FOUND:
        return {"installed": False, "detail": "git is not on PATH."}
    return {
        "installed": False,
        "detail": f"Git did not answer the version check ({outcome.status.value}).",
    }


def git_repository_status(path: str | None) -> dict[str, Any]:
    """Structured install-vs-repository answer for one directory.

    Returns ``{"installed": bool, "repository": bool, "message": str}`` plus
    ``version`` when the install probe established one. Never raises for
    machine state — missing Git, missing directory, and non-repositories all
    come back as data.
    """
    install = git_install_probe()
    installed = bool(install.get("installed"))
    version = install.get("version")
    if not installed:
        return {
            "installed": False,
            "repository": False,
            "version": None,
            "message": str(install.get("detail") or "Git is not installed."),
        }
    if not path:
        return {
            "installed": True,
            "repository": False,
            "version": version,
            "message": "Git is installed, but no directory was selected.",
        }
    if is_git_repository(path):
        return {
            "installed": True,
            "repository": True,
            "version": version,
            "message": "Git is installed and the selected directory is a Git repository.",
        }
    return {
        "installed": True,
        "repository": False,
        "version": version,
        "message": NOT_A_REPO_MESSAGE,
    }
