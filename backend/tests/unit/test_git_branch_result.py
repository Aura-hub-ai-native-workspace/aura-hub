"""F-12: git.branch must propagate its real result, not drop it.

Covers inspection (no name), creation (checkout -b) and switching
(checkout), success and failure, using isolated temporary repositories.
No destructive operation touches the real working tree.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

import aura.executors as ex
from aura.executors import git_branch

execmod = ex


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    assert _git(repo, "init", "-q").returncode == 0
    assert _git(repo, "config", "user.email", "t@t.com").returncode == 0
    assert _git(repo, "config", "user.name", "t").returncode == 0
    (repo / "a.txt").write_text("x")
    assert _git(repo, "add", "a.txt").returncode == 0
    assert _git(repo, "commit", "-q", "-m", "init").returncode == 0
    return repo


def _inv(repo: Path, **inputs) -> dict:
    return {"context": {"cwd": str(repo)}, "input": inputs}


def test_inspect_returns_real_branch_name(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "checkout", "-q", "-b", "feature/x")
    res = asyncio.run(git_branch(_inv(repo)))
    assert res["ok"] is True
    assert "feature/x" in res["detail"]
    out = res.get("output")
    assert isinstance(out, dict)
    assert out.get("stdout", "").strip() == "feature/x"
    assert out.get("exitCode") == 0


def test_inspect_failure_is_reported(tmp_path):
    # Not a git repo -> git_not_a_repo path.
    empty = tmp_path / "empty"
    empty.mkdir()
    res = asyncio.run(git_branch(_inv(empty)))
    assert res["ok"] is False


def test_create_branch_success_propagates(tmp_path):
    repo = _repo(tmp_path)
    res = asyncio.run(git_branch(_inv(repo, name="new-branch")))
    assert res["ok"] is True
    assert "Created and switched" in res["detail"] or "Switched" in res["detail"]
    out = res.get("output")
    assert isinstance(out, dict)
    assert out.get("branch") == "new-branch"
    assert out.get("exitCode") == 0
    # HEAD actually moved.
    head = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert head == "new-branch"


def test_switch_branch_success(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "branch", "other")
    res = asyncio.run(git_branch(_inv(repo, name="other")))
    assert res["ok"] is True
    assert "Switched" in res["detail"]
    head = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert head == "other"


def test_branch_name_flag_refused(tmp_path):
    repo = _repo(tmp_path)
    res = asyncio.run(git_branch(_inv(repo, name="--help")))
    assert res["ok"] is False
    assert "flag" in res["detail"].lower() or "refused" in res["detail"].lower() or "invalid" in res["detail"].lower()


def test_failed_checkout_reported(tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    # Force run_git to fail on the checkout step by monkeypatching.
    real_run = ex.run_git

    async def fake_run_git(args, cwd):
        if args and args[0] == "checkout":
            class R:
                out = "error: pathspec 'nope' did not match"
                code = 1
            return R()
        return await real_run(args, cwd)

    monkeypatch.setattr(ex, "run_git", fake_run_git)
    res = asyncio.run(git_branch(_inv(repo, name="nope")))
    assert res["ok"] is False
    out = res.get("output")
    assert isinstance(out, dict)
    assert out.get("exitCode") == 1
    assert "did not match" in (out.get("stdout") or "")
