"""Worker supervision — deterministic boundaries around agent.delegate.

Every test here exercises BEHAVIOR, not source text: scope contracts are
validated and enforced through real runs against real (temporary) git
repositories, and refusal paths assert that nothing spawned.

Security invariants under test:
  - scope travels in the approved input (fingerprint-bound), never in free context;
  - malformed scope refuses BEFORE any process spawns;
  - changed files outside the scope park the run (scopeDeviation), never success;
  - nothing is ever silently reverted;
  - cancellation and timeouts kill the whole process tree.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time

import pytest

from aura.fabric.supervision import (
    check_scope_paths,
    check_worker_scope,
    parse_porcelain_status,
    validate_scope_paths,
)

# ── scope-path validation ─────────────────────────────────────────────


class TestValidateScopePaths:
    def test_absent_means_no_contract(self):
        ok, paths, reason = validate_scope_paths(None)
        assert ok is True
        assert paths == []
        assert reason == ""

    def test_valid_paths_canonicalize(self):
        ok, paths, _ = validate_scope_paths(["src/auth/", "tests/auth/**", "README.md"])
        assert ok is True
        assert paths == ["src/auth", "tests/auth", "README.md"]

    def test_non_list_is_refused(self):
        ok, _, reason = validate_scope_paths("src/auth")
        assert ok is False
        assert reason

    def test_traversal_is_refused(self):
        for hostile in (["../etc"], ["src/../../x"], ["a/../b"], [""], ["   "], ["."]):
            ok, _, reason = validate_scope_paths(hostile)
            assert ok is False, f"{hostile} was accepted"
            assert reason

    def test_absolute_and_backslash_are_refused_or_contained(self):
        # A leading slash is treated as a repo-relative typo; anything that
        # could still escape (.. or backslash) is refused outright.
        ok, paths, _ = validate_scope_paths(["/src/auth"])
        assert ok is True
        assert paths == ["src/auth"]
        ok, _, _ = validate_scope_paths(["src\\auth"])
        assert ok is False

    def test_empty_list_is_refused(self):
        ok, _, reason = validate_scope_paths([])
        assert ok is False
        assert reason

    def test_duplicates_collapse(self):
        ok, paths, _ = validate_scope_paths(["a", "a/", "a/**"])
        assert ok is True
        assert paths == ["a"]

    def test_bound_is_enforced(self):
        ok, _, reason = validate_scope_paths([f"d{i}" for i in range(33)])
        assert ok is False
        assert reason


# ── porcelain parsing ─────────────────────────────────────────────────


class TestParsePorcelain:
    def test_modified_and_untracked(self):
        out = " M src/auth/login.py\n?? tests/auth/new_test.py\n"
        assert parse_porcelain_status(out) == [
            "src/auth/login.py", "tests/auth/new_test.py"]

    def test_rename_reports_new_path(self):
        out = "R  old/name.py -> src/auth/name.py\n"
        assert parse_porcelain_status(out) == ["src/auth/name.py"]

    def test_empty_is_empty(self):
        assert parse_porcelain_status("") == []
        assert parse_porcelain_status("\n") == []

    def test_nul_separated(self):
        out = " M src/a.py\x00?? src/b.py\x00"
        assert parse_porcelain_status(out) == ["src/a.py", "src/b.py"]


# ── scope partitioning ────────────────────────────────────────────────


class TestCheckScopePaths:
    def test_inside_scope_passes(self):
        check = check_scope_paths(
            ["src/auth/login.py", "tests/auth/login_test.py"],
            ["src/auth", "tests/auth"])
        assert check.supported is True
        assert check.allowed is True
        assert check.outside == []

    def test_outside_scope_parks(self):
        check = check_scope_paths(
            ["src/auth/login.py", "debug/random_test.py", "unrelated_feature/x.py"],
            ["src/auth", "tests/auth"])
        assert check.supported is True
        assert check.allowed is False
        assert sorted(check.outside) == ["debug/random_test.py", "unrelated_feature/x.py"]
        assert check.detail

    def test_prefix_boundary_is_exact(self):
        # src/auth must NOT cover src/authx.
        check = check_scope_paths(["src/authx/e.py"], ["src/auth"])
        assert check.allowed is False

    def test_single_file_scope(self):
        assert check_scope_paths(["a/b.txt"], ["a/b.txt"]).allowed is True
        assert check_scope_paths(["a/c.txt"], ["a/b.txt"]).allowed is False


# ── snapshot / delta scope checks ───────────────────────────────────────


class TestSnapshotDelta:
    def test_clean_tree_yields_empty_delta(self, git_repo):
        import asyncio

        from aura.fabric.supervision import (
            delta_since,
            hash_paths,
            parse_porcelain_status,
            snapshot_worktree,
        )

        async def main():
            before = await snapshot_worktree(git_repo)
            assert before is not None
            assert before.capped is False
            res_after = await _status(git_repo)
            after_hashes = await hash_paths(
                git_repo, parse_porcelain_status(res_after))
            return delta_since(before, parse_porcelain_status(res_after),
                               after_hashes)

        assert asyncio.run(main()) == []

    def test_new_file_is_delta(self, git_repo):
        import asyncio

        from aura.fabric.supervision import (
            delta_since,
            hash_paths,
            parse_porcelain_status,
            snapshot_worktree,
        )

        async def main():
            before = await snapshot_worktree(git_repo)
            with open(os.path.join(git_repo, "brand-new.py"), "w") as fh:
                fh.write("x = 1\n")
            res_after = await _status(git_repo)
            after_changed = parse_porcelain_status(res_after)
            after_hashes = await hash_paths(git_repo, after_changed)
            return delta_since(before, after_changed, after_hashes)

        assert asyncio.run(main()) == ["brand-new.py"]

    def test_pre_dirty_unchanged_is_grandfathered(self, git_repo):
        import asyncio

        from aura.fabric.supervision import (
            delta_since,
            hash_paths,
            parse_porcelain_status,
            snapshot_worktree,
        )

        with open(os.path.join(git_repo, "legacy.py"), "w") as fh:
            fh.write("old = True\n")

        async def main():
            before = await snapshot_worktree(git_repo)
            with open(os.path.join(git_repo, "fresh.py"), "w") as fh:
                fh.write("new = True\n")
            res_after = await _status(git_repo)
            after_changed = parse_porcelain_status(res_after)
            after_hashes = await hash_paths(git_repo, after_changed)
            return delta_since(before, after_changed, after_hashes)

        assert asyncio.run(main()) == ["fresh.py"]

    def test_pre_dirty_modified_counts(self, git_repo):
        import asyncio

        from aura.fabric.supervision import (
            delta_since,
            hash_paths,
            parse_porcelain_status,
            snapshot_worktree,
        )

        target = os.path.join(git_repo, "legacy.py")
        with open(target, "w") as fh:
            fh.write("v1 = True\n")

        async def main():
            before = await snapshot_worktree(git_repo)
            with open(target, "w") as fh:
                fh.write("v2 = True\n")
            res_after = await _status(git_repo)
            after_changed = parse_porcelain_status(res_after)
            after_hashes = await hash_paths(git_repo, after_changed)
            return delta_since(before, after_changed, after_hashes)

        assert asyncio.run(main()) == ["legacy.py"]

    def test_non_repo_snapshot_is_none(self, tmp_path):
        import asyncio

        from aura.fabric.supervision import snapshot_worktree

        assert asyncio.run(snapshot_worktree(str(tmp_path))) is None


async def _status(cwd: str) -> str:
    from aura.exec_ import git as run_git

    res = await run_git(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd, None)
    assert res.code == 0
    return res.out


# ── git-backed scope checks ───────────────────────────────────────────


def _git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, timeout=30)


@pytest.fixture()
def git_repo(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _git(str(root), "init", "-q")
    _git(str(root), "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init")
    (root / "src" / "auth").mkdir(parents=True)
    (root / "src" / "auth" / "login.py").write_text("x = 1\n")
    _git(str(root), "add", "-A")
    _git(str(root), "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "-m", "base")
    return str(root)


class TestCheckWorkerScope:
    def test_non_git_directory_reports_unsupported(self, tmp_path):
        check = asyncio.run(check_worker_scope(str(tmp_path), ["src"]))
        assert check.supported is False
        # Unsupported is honesty, not failure: nothing claims verification.
        assert check.allowed is True
        assert "not a git" in check.detail

    def test_clean_tree_inside_scope(self, git_repo):
        check = asyncio.run(check_worker_scope(git_repo, ["src/auth"]))
        assert check.supported is True
        assert check.allowed is True
        assert check.changed == []

    def test_new_file_outside_scope_parks(self, git_repo):
        with open(os.path.join(git_repo, "debug_evil.py"), "w") as fh:
            fh.write("print('hi')\n")
        check = asyncio.run(check_worker_scope(git_repo, ["src/auth"]))
        assert check.supported is True
        assert check.allowed is False
        assert check.outside == ["debug_evil.py"]

    def test_new_file_inside_scope_passes(self, git_repo):
        with open(os.path.join(git_repo, "src", "auth", "helper.py"), "w") as fh:
            fh.write("y = 2\n")
        check = asyncio.run(
            check_worker_scope(git_repo, ["src/auth", "tests/auth"]))
        assert check.allowed is True
        assert check.outside == []


# ── executor wiring ───────────────────────────────────────────────────


def _agent_inv(node_id="opencode", cwd="/tmp"):
    return {
        "input": {"task": "do the thing"},
        "context": {"cwd": cwd, "actor": {"kind": "agent", "id": "t"}},
        "node": {"id": node_id, "name": "OpenCode", "binary": "opencode"},
    }


class FakeOut:
    def __init__(self, out="", code=0, timed_out=False, signal=None):
        self.out = out
        self.code = code
        self.timedOut = timed_out
        self.signal = signal


class TestAgentDelegateContract:
    def test_malformed_scope_refuses_before_spawn(self, monkeypatch):
        import aura.executors as ex

        called = []

        async def fake_run(*a, **k):
            called.append(True)
            return FakeOut()

        monkeypatch.setattr(ex, "run_agent", fake_run)
        inv = _agent_inv()
        inv["input"]["scopePaths"] = ["../escape"]
        out = asyncio.run(ex.agent_delegate_run(inv))
        assert out["ok"] is False
        assert "contract was refused" in out["detail"]
        assert called == [], "refused contract must never spawn"

    def test_valid_scope_travels_in_output(self, monkeypatch, git_repo):
        import aura.executors as ex

        async def fake_run(bin_name, args, cwd, timeout_ms=None):
            return FakeOut(out="done", code=0)

        monkeypatch.setattr(ex, "run_agent", fake_run)
        inv = _agent_inv(cwd=git_repo)
        inv["input"]["scopePaths"] = ["src/auth"]
        out = asyncio.run(ex.agent_delegate_run(inv))
        assert out["ok"] is True, out
        assert out["output"].get("scopePaths") == ["src/auth"]
        assert out["output"].get("scopeCheck", {}).get("allowed") is True

    def test_scope_deviation_parks_never_succeeds(self, monkeypatch, git_repo):
        import aura.executors as ex

        async def fake_run(bin_name, args, cwd, timeout_ms=None):
            with open(os.path.join(cwd, "rogue.py"), "w") as fh:
                fh.write("x = 1\n")
            return FakeOut(out="done", code=0)

        monkeypatch.setattr(ex, "run_agent", fake_run)
        inv = _agent_inv(cwd=git_repo)
        inv["input"]["scopePaths"] = ["src/auth"]
        out = asyncio.run(ex.agent_delegate_run(inv))
        assert out["ok"] is False, out
        assert out["output"].get("scopeDeviation") is True
        assert "rogue.py" in out["detail"]
        # Nothing was reverted: the file is evidence, still on disk.
        assert os.path.exists(os.path.join(git_repo, "rogue.py"))

    def test_sequential_legs_do_not_bill_earlier_work(self, monkeypatch, git_repo):
        # Leg A leaves an uncommitted file; leg B with a disjoint scope must
        # still pass — only B's own delta is judged.
        import aura.executors as ex

        async def fake_run(bin_name, args, cwd, timeout_ms=None):
            with open(os.path.join(cwd, "leg-b.txt"), "w") as fh:
                fh.write("b\n")
            return FakeOut(out="done", code=0)

        monkeypatch.setattr(ex, "run_agent", fake_run)
        with open(os.path.join(git_repo, "leg-a.txt"), "w") as fh:
            fh.write("a\n")
        inv = _agent_inv(cwd=git_repo)
        inv["input"]["scopePaths"] = ["leg-b.txt"]
        out = asyncio.run(ex.agent_delegate_run(inv))
        assert out["ok"] is True, out
        check = out["output"].get("scopeCheck") or {}
        assert check.get("changed") == ["leg-b.txt"]

    def test_unknown_node_is_refused(self):
        import asyncio

        import aura.executors as ex

        inv = _agent_inv(node_id="nope")
        inv["node"] = {"id": "nope", "name": "Nope"}
        out = asyncio.run(ex.agent_delegate_run(inv))
        assert out["ok"] is False

    def test_verify_fails_scope_deviation(self):
        import asyncio

        import aura.executors as ex

        bad = {"output": {"exitCode": 0, "scopeDeviation": True,
                          "scopeCheck": {"outside": ["rogue.py"]}}}
        assert asyncio.run(ex.agent_delegate_verify({}, bad))["passed"] is False
        good = {"output": {"exitCode": 0}}
        assert asyncio.run(ex.agent_delegate_verify({}, good))["passed"] is True
        failed = {"output": {"exitCode": 3}}
        assert asyncio.run(ex.agent_delegate_verify({}, failed))["passed"] is False


# ── contract schema + approval binding ────────────────────────────────


class TestContractSchema:
    def test_manifest_declares_optional_scope_paths(self):
        import json
        from pathlib import Path

        manifest = json.loads(
            (Path(__file__).resolve().parents[2]
             / "aura" / "fabric" / "manifest.json").read_text())
        caps = manifest if isinstance(manifest, list) else manifest["capabilities"]
        delegate = next(c for c in caps if c["id"] == "agent.delegate")
        field = next(f for f in delegate["input"] if f["name"] == "scopePaths")
        assert field["type"] == "string[]"
        assert field["required"] is False

    def test_validator_accepts_string_lists(self):
        from aura.fabric.invoke import validate_input

        cap = {"input": [{"name": "scopePaths", "type": "string[]",
                          "required": False}]}
        assert validate_input(cap, {}) is None
        assert validate_input(cap, {"scopePaths": ["a", "b"]}) is None
        bad = validate_input(cap, {"scopePaths": ["a", 3]})
        assert bad is not None and "scopePaths" in bad
        bad2 = validate_input(cap, {"scopePaths": "a,b"})
        assert bad2 is not None

    def test_scope_is_approval_bound(self):
        # scopePaths travels in INPUT (fingerprinted), not free context:
        # an approval granted for scope A cannot authorize scope B.
        from aura.canonical import fingerprint_invocation

        a = fingerprint_invocation(
            "agent.delegate",
            {"task": "t", "scopePaths": ["src/auth"]}, {"projectId": "p"})
        b = fingerprint_invocation(
            "agent.delegate",
            {"task": "t", "scopePaths": ["src/auth", "etc"]}, {"projectId": "p"})
        assert a != b


# ── cancellation / timeout behavior ───────────────────────────────────


class TestWorkerLifecycle:
    def test_cancel_kills_the_tree(self):
        import asyncio

        from aura.exec_ import run_file

        async def main():
            cancel = asyncio.Event()

            async def fire():
                await asyncio.sleep(0.4)
                cancel.set()

            task = asyncio.ensure_future(fire())
            started = time.monotonic()
            out = await run_file(
                ["sleep", "30"], "/tmp", 20_000, cancel)
            elapsed = time.monotonic() - started
            await task
            return out, elapsed

        out, elapsed = asyncio.run(main())
        assert elapsed < 10, f"cancel took too long: {elapsed:.1f}s"
        assert out.code != 0

    def test_timeout_is_honest(self):
        import asyncio

        from aura.exec_ import run_file

        async def main():
            started = time.monotonic()
            out = await run_file(["sleep", "30"], "/tmp", 800)
            return out, time.monotonic() - started

        out, elapsed = asyncio.run(main())
        assert elapsed < 10, f"timeout took too long: {elapsed:.1f}s"
        assert out.code != 0
        assert out.timedOut is True
