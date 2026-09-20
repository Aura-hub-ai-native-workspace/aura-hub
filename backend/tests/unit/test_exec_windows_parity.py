"""Windows execution parity for the agent/project command boundary.

Regression: aura.exec_ is the boundary every project command crosses, but
it assumed POSIX — .cmd/.bat shims failed with WinError 193, only the
direct child was signalled on timeout/cancel, `npm install foo` (local)
slipped past the install-verb guard, git names could inject flags, and
garbage timeoutMs values broke settling. Mirrors the guarantees
aura.environment.procexec already provides for the scan path.
"""
from __future__ import annotations

import asyncio
import os

import pytest

import aura.exec_ as execmod
from aura import executors as ex
from aura.exec_ import parse_command


class TestInstallVerbsBlocked:
    @pytest.mark.parametrize("cmd", [
        "npm install foo",
        "npm i foo",
        "npm add foo",
        "npm ci",
        "npm clean-install",
        "npm install -g foo",
    ])
    def test_npm_install_verbs_refused(self, cmd):
        parsed = parse_command(cmd)
        assert parsed.ok is False
        assert "system.install" in parsed.reason

    @pytest.mark.parametrize("cmd", [
        "npm run build",
        "npm test",
        "npm ls",
        "node server.js",
    ])
    def test_non_install_commands_allowed(self, cmd):
        assert parse_command(cmd).ok is True


class TestCmdShimRouting:
    def test_cmd_shim_goes_through_cmd_exe(self, monkeypatch, tmp_path):
        shim = tmp_path / "npm.cmd"
        shim.write_text("@echo off\n")
        monkeypatch.setattr(os, "name", "nt")
        monkeypatch.setattr(execmod, "_which", lambda exe: str(shim))

        seen = {}

        class FakeProc:
            pid = 4242
            returncode = 0

            async def communicate(self):
                return (b"10.0.0\n", b"")

        async def fake_spawn(*argv, **kw):
            seen["argv"] = list(argv)
            assert kw["stdin"] is asyncio.subprocess.DEVNULL
            return FakeProc()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
        out = asyncio.run(
            execmod.run_file(["npm", "--version"], str(tmp_path), 5000))
        assert out.code == 0
        assert seen["argv"][0].lower().endswith("cmd.exe")
        assert seen["argv"][1:4] == ["/d", "/s", "/c"]

    def test_unsafe_cmd_arg_refused(self, monkeypatch, tmp_path):
        shim = tmp_path / "npm.cmd"
        shim.write_text("@echo off\n")
        monkeypatch.setattr(os, "name", "nt")
        monkeypatch.setattr(execmod, "_which", lambda exe: str(shim))
        with pytest.raises(RuntimeError, match="cmd.exe"):
            asyncio.run(
                execmod.run_file(["npm", "%APPDATA%"], str(tmp_path), 5000))


class TestWindowsTreeKill:
    def test_taskkill_reaches_tree(self, monkeypatch):
        import subprocess as sp

        calls = []
        monkeypatch.setattr(os, "name", "nt")
        monkeypatch.setattr(
            sp, "run",
            lambda argv, **kw: calls.append(list(argv)) or
            type("R", (), {"returncode": 0})())

        class FakeProc:
            pid = 7777

            def kill(self):
                calls.append(["kill-direct"])

        execmod._signal_tree(FakeProc(), "KILL")
        assert ["taskkill", "/F", "/T", "/PID", "7777"] in calls
        assert ["kill-direct"] in calls


class TestGitFlagRejection:
    def _inv(self, tmp_path, **inputs):
        return {"context": {"cwd": str(tmp_path)}, "input": inputs}

    def test_branch_flag_name_refused(self, monkeypatch, tmp_path):
        async def fail(*a, **k):
            raise AssertionError("git must not run")

        async def is_repo(cwd):
            return True

        monkeypatch.setattr(execmod, "git_is_repo", is_repo)
        monkeypatch.setattr(ex, "run_git", fail)
        result = asyncio.run(
            ex.git_branch(self._inv(tmp_path, name="--help")))
        assert result["ok"] is False
        assert "flag" in result["detail"]

    def test_push_flag_remote_refused(self, monkeypatch, tmp_path):
        async def fail(*a, **k):
            raise AssertionError("git must not run")

        async def is_repo(cwd):
            return True

        monkeypatch.setattr(execmod, "git_is_repo", is_repo)
        monkeypatch.setattr(ex, "run_git", fail)
        result = asyncio.run(
            ex.git_push(self._inv(tmp_path, remote="--upload-pack=evil")))
        assert result["ok"] is False
        assert "flag" in result["detail"]


class TestTimeoutClamp:
    def test_garbage_falls_back(self):
        assert ex._timeout_ms({"timeoutMs": "abc"}, 30000) == 30000
        assert ex._timeout_ms({}, 30000) == 30000
        assert ex._timeout_ms(None, 30000) == 30000

    def test_bounds(self):
        assert ex._timeout_ms({"timeoutMs": 0}, 30000) == 1_000
        assert ex._timeout_ms({"timeoutMs": -5}, 30000) == 1_000
        assert ex._timeout_ms({"timeoutMs": 10 ** 12}, 30000) == 3_600_000
        assert ex._timeout_ms({"timeoutMs": 45000}, 30000) == 45000


class TestHttpRequestValidation:
    def test_bad_method_refused_without_network(self, monkeypatch):
        async def fail(*a, **k):
            raise AssertionError("no network may happen")

        monkeypatch.setattr("urllib.request.urlopen", fail)
        result = asyncio.run(ex.http_request(
            {"context": {}, "input": {"url": "https://example.com/",
                                      "method": "TRACE"}}))
        assert result["ok"] is False
        assert "TRACE" in result["detail"]

    def test_dict_body_refused(self, monkeypatch):
        async def fail(*a, **k):
            raise AssertionError("no network may happen")

        monkeypatch.setattr("urllib.request.urlopen", fail)
        result = asyncio.run(ex.http_request(
            {"context": {}, "input": {"url": "https://example.com/",
                                      "body": {"a": 1}}}))
        assert result["ok"] is False
        assert "text" in result["detail"]

    def test_metadata_address_refused(self, monkeypatch):
        async def fail(*a, **k):
            raise AssertionError("metadata must never be fetched")

        monkeypatch.setattr("urllib.request.urlopen", fail)
        result = asyncio.run(ex.http_request(
            {"context": {}, "input": {"url": "http://169.254.169.254/"}}))
        assert result["ok"] is False
        assert "metadata" in result["detail"]
