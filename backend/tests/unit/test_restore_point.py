"""Restore points: record before an agent edits, put the project back after."""
import os
import subprocess

import pytest

from aura.central_agent import restore_point as rp


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.email", "t@t")
    git(tmp_path, "config", "user.name", "t")
    (tmp_path / "app.py").write_text("print('v1')\n")
    (tmp_path / ".gitignore").write_text("node_modules/\n.env\n")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-qm", "init")
    (tmp_path / "notes.txt").write_text("my uncommitted note\n")  # untracked user work
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("x")
    (tmp_path / ".env").write_text("SECRET=1\n")
    return tmp_path


def test_creating_a_point_changes_nothing_the_user_sees(repo):
    status = git(repo, "status", "--porcelain")
    stash = git(repo, "stash", "list")
    sha = rp.create(str(repo), "s1-t1")
    assert sha and len(sha) == 40
    assert git(repo, "status", "--porcelain") == status
    assert git(repo, "stash", "list") == stash
    assert git(repo, "log", "--oneline").count("\n") == 0  # still one commit on the branch
    assert [p["label"] for p in rp.list_points(str(repo))] == ["s1-t1"]


def test_restore_undoes_an_agents_edits_and_keeps_ignored_files(repo):
    sha = rp.create(str(repo), "s1-t1")
    (repo / "app.py").write_text("print('broken by agent')\n")
    (repo / "notes.txt").unlink()
    (repo / "junk.py").write_text("agent leftovers\n")
    (repo / ".env").write_text("SECRET=2\n")  # ignored: never touched by a restore

    result = rp.restore(str(repo), sha)

    assert (repo / "app.py").read_text() == "print('v1')\n"
    assert (repo / "notes.txt").read_text() == "my uncommitted note\n"
    assert not (repo / "junk.py").exists()
    assert result["removed"] == ["junk.py"]
    assert (repo / ".env").read_text() == "SECRET=2\n"
    assert (repo / "node_modules" / "dep.js").exists()


def test_a_restore_can_itself_be_undone(repo):
    sha = rp.create(str(repo), "s1-t1")
    (repo / "app.py").write_text("print('v2')\n")
    rp.restore(str(repo), sha)
    before = [p for p in rp.list_points(str(repo)) if p["label"].startswith("before-restore")]
    assert before
    rp.restore(str(repo), before[0]["id"])
    assert (repo / "app.py").read_text() == "print('v2')\n"


def test_only_this_projects_restore_points_are_accepted(repo):
    rp.create(str(repo), "s1-t1")
    head = git(repo, "rev-parse", "HEAD")
    with pytest.raises(ValueError):
        rp.restore(str(repo), head)
    with pytest.raises(ValueError):
        rp.restore(str(repo), "../../etc")


def test_not_a_repository_means_no_point_and_no_error(tmp_path):
    assert rp.create(str(tmp_path), "x") is None
    assert rp.create(None, "x") is None
    assert rp.list_points(str(tmp_path)) == []


def test_old_points_are_pruned(repo, monkeypatch):
    monkeypatch.setattr(rp, "KEEP", 3)
    for i in range(5):
        (repo / "app.py").write_text(f"print({i})\n")
        rp.create(str(repo), f"s-{i}")
    assert [p["label"] for p in rp.list_points(str(repo))] == ["s-4", "s-3", "s-2"]


def test_large_untracked_content_skips_the_point(repo, monkeypatch):
    monkeypatch.setattr(rp, "MAX_UNTRACKED_BYTES", 10)
    (repo / "big.bin").write_bytes(b"x" * 100)
    assert rp.create(str(repo), "s1") is None
    assert rp.list_points(str(repo)) == []
