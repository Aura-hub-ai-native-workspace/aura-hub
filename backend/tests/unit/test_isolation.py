"""
Unit tests for worktree isolation — REAL git repositories.
=======================================================
Every test builds a throwaway git project, so the safety rules are
proven against git itself: worktrees are created without touching the
user's checkout, changed-file collection matches reality, conflicting
changes are detected and never silently overwritten, cleanup removes
only AURA-created paths, and a dirty user tree survives everything.

Run with: cd backend && python3 -m pytest tests/unit/test_isolation.py -q
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from aura.central_agent.isolation import (
    IsolationManager,
    conflict_scan,
)


@pytest.fixture(autouse=True)
def _aura_home(tmp_path, monkeypatch):
    """Isolation worktrees land under AURA_HOME — point it at the test
    tree so tests never create anything under the real ~/.aura."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura-home"))


def _git(repo: Path, *argv: object) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *[str(a) for a in argv]], cwd=repo,
        capture_output=True, text=True, check=False)


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    """A real git project with one commit and a README."""
    repo = tmp_path / "proj"
    (repo / "src").mkdir(parents=True)
    (repo / "README.md").write_text("# project\n")
    _git(repo, "init", "-q")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t",
         "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-qm", "init")
    return repo


class TestCreate:
    def test_worktree_created_without_touching_user_tree(self, project):
        before = _git(project, "status", "--porcelain").stdout
        mgr = IsolationManager(str(project))
        wt = mgr.create("t1", "claude-code")
        assert Path(wt.path).is_dir()
        assert wt.branch.startswith("aura/")
        assert wt.base_commit
        # the user's tree is exactly as it was (no branch checked out,
        # no new files, no status change)
        after = _git(project, "status", "--porcelain").stdout
        assert after == before
        assert _git(project, "branch", "--show-current").stdout.strip() in (
            "", "main", "master")

    def test_dirty_user_tree_is_untouched_and_invisible(self, project):
        (project / "src" / "user-edit.txt").write_text("user wip\n")
        mgr = IsolationManager(str(project))
        wt = mgr.create("t1", "claude-code")
        # the worktree starts from the COMMIT: user WIP is not in it
        assert not (Path(wt.path) / "src" / "user-edit.txt").exists()
        # and the user's file still exists, untracked, in their tree
        assert (project / "src" / "user-edit.txt").exists()

    def test_non_git_project_is_refused(self, tmp_path):
        (tmp_path / "plain").mkdir()
        mgr = IsolationManager(str(tmp_path / "plain"))
        with pytest.raises(RuntimeError, match="git"):
            mgr.create("t1", "claude-code")


class TestCollect:
    def test_changed_files_reports_worker_edits(self, project):
        mgr = IsolationManager(str(project))
        wt = mgr.create("t1", "claude-code")
        target = Path(wt.path) / "src" / "util.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("def f():\n    return 1\n")
        assert mgr.changed_files("t1") == ["src/util.py"]

    def test_file_blobs_carry_content(self, project):
        mgr = IsolationManager(str(project))
        wt = mgr.create("t1", "claude-code")
        target = Path(wt.path) / "src" / "util.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("CONTENT-1\n")
        assert mgr.file_blobs("t1")["src/util.py"] == "CONTENT-1\n"


class TestIntegrate:
    def test_disjoint_changes_both_applied(self, project):
        mgr = IsolationManager(str(project))
        a = mgr.create("t1", "claude-code")
        b = mgr.create("t2", "opencode")
        for wt, name, content in ((a, "slug.py", "A\n"), (b, "norm.py", "B\n")):
            p = Path(wt.path) / "src" / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        result = mgr.integrate(["t1", "t2"])
        assert result["conflicts"] == []
        integ = Path(result["integrationPath"])
        assert (integ / "src" / "slug.py").read_text() == "A\n"
        assert (integ / "src" / "norm.py").read_text() == "B\n"

    def test_conflicting_change_never_overwrites_first_writer(self, project):
        mgr = IsolationManager(str(project))
        a = mgr.create("t1", "claude-code")
        b = mgr.create("t2", "opencode")
        for wt, content in ((a, "FROM-A\n"), (b, "FROM-B\n")):
            p = Path(wt.path) / "src" / "shared.py"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        result = mgr.integrate(["t1", "t2"])
        integ = Path(result["integrationPath"])
        # first writer wins VISIBLY: the conflict is named, nothing is
        # silently overwritten
        assert (integ / "src" / "shared.py").read_text() == "FROM-A\n"
        assert len(result["conflicts"]) == 1
        assert result["conflicts"][0]["path"] == "src/shared.py"
        assert set(result["conflicts"][0]["tasks"]) == {"t1", "t2"}


class TestConflictScan:
    def test_overlapping_paths_named_with_both_owners(self):
        assert conflict_scan({
            "t1": ["src/a.py", "src/c.py"],
            "t2": ["src/b.py", "src/c.py"],
        }) == [{"path": "src/c.py", "tasks": ["t1", "t2"]}]

    def test_disjoint_changes_have_no_conflicts(self):
        assert conflict_scan({"t1": ["src/a.py"], "t2": ["src/b.py"]}) == []


class TestCleanup:
    def test_removes_only_aura_created_worktrees(self, project):
        mgr = IsolationManager(str(project))
        wt = mgr.create("t1", "claude-code")
        user_file = Path(wt.path) / "worker-output.txt"
        user_file.write_text("worker made this\n")
        mgr.cleanup()
        assert not Path(wt.path).exists()
        # the branch it created is gone too
        assert _git(project, "rev-parse", "--verify",
                    wt.branch).returncode != 0
        # the user's tree still has its own files and no aura branches
        assert (project / "README.md").exists()
        branches = _git(project, "branch", "--list", "aura/*").stdout
        assert "t1" not in branches

    def test_refuses_to_remove_paths_outside_its_root(self, project, tmp_path):
        mgr = IsolationManager(str(project))
        outside = tmp_path / "not-ours"
        outside.mkdir()
        mgr.remove_worktree(str(outside))  # must not raise OR delete
        assert outside.exists()

    def test_second_manager_cannot_delete_first_ones_worktrees(self, project):
        first = IsolationManager(str(project))
        wt = first.create("t1", "claude-code")
        second = IsolationManager(str(project))
        second.cleanup()
        assert Path(wt.path).exists()  # another run's resources are not ours
