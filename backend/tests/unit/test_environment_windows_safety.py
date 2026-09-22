"""Windows Connected Environment safety — no GUI launched during scans.

Regression suite for the observed Windows bug:

* "Scan this machine" opened Git GUI (``fatal: not a git repository``),
  NVIDIA Nsight Compute (``cupti64_*.dll was not found``,
  ``Unknown option version``), and other application windows.

Safety boundary under test (see ``aura.environment.safeprobe``):

* Inspecting an executable / reading registry / package DB: always allowed.
* Running a version probe: ONLY allowlisted CLI basenames with exact args.
* APPLICATION-kind items and known GUI launchers (git-gui, gitk, ncu-ui,
  nsys-ui, Nsight, cupti*): never executed — inventoried from metadata.
* Git install detection (``git --version`` from home) never requires a repo;
  repository inspection only runs ``rev-parse --is-inside-work-tree`` for an
  explicitly named directory and returns a structured non-repo answer.
* ``.ps1`` never executed; ``.cmd``/``.bat`` shims only via
  ``cmd.exe /d /s /c`` with safe quoting.

Every test uses fixtures/doubles and ``hostplatform.simulate`` — no real GUI
application is ever opened. MOCK VERIFIED, not NATIVE VERIFIED for the
Windows-only branches (same convention as test_inventory_cross_platform).
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from aura.environment.hostplatform import Platform, simulate
from aura.environment.safeprobe import (
    allowed_to_probe,
    is_never_probe,
    is_windows_probeable_file,
    normalize_basename,
    safe_probe_args,
)


@pytest.fixture(autouse=True)
def _simulate_windows():
    with simulate(Platform.WINDOWS):
        yield


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ-fake")
    return path


# 1. Scanning Windows does not launch Git GUI.
def test_scanning_windows_does_not_launch_git_gui():
    assert safe_probe_args("git.exe") == ["--version"]
    assert safe_probe_args("git") == ["--version"]
    for gui in ("git-gui.exe", "git-gui", "gitk", "gitk.exe", "git-citool.exe"):
        assert safe_probe_args(gui) is None, gui
        assert is_never_probe(gui), gui
        allowed, reason = allowed_to_probe(gui)
        assert not allowed, gui
        assert reason, gui


# 2. Scanning Windows does not launch Nsight Compute.
def test_scanning_windows_does_not_launch_nsight():
    for exe in (
        "ncu.exe",
        "ncu-ui.exe",
        "nsys.exe",
        "nsys-ui.exe",
        "nsight-compute.exe",
        "nsight-systems.exe",
        "cupti64_2020.3.1.dll",
        "ncu",
    ):
        assert safe_probe_args(exe) is None, exe
        assert is_never_probe(exe), exe
        allowed, _ = allowed_to_probe(exe)
        assert not allowed, exe


# 3. Scanning Windows does not launch any arbitrary GUI application.
def test_scanning_windows_does_not_launch_arbitrary_gui():
    for exe in ("myapp.exe", "PhotoEditor.exe", "RandomTool.exe"):
        assert safe_probe_args(exe) is None, exe
        allowed, reason = allowed_to_probe(exe)
        assert not allowed, exe
        assert "allowlisted" in reason
    # APPLICATION kind is never executed even when the basename is known.
    allowed, reason = allowed_to_probe("git.exe", kind="APPLICATION")
    assert not allowed
    assert "application" in reason.lower()


def test_discovery_probe_tool_never_runs_gui(monkeypatch, tmp_path):
    """_probe_tool must not spawn GUI exes even when trusted+claimed."""
    from aura.environment import discovery as disc
    from aura.environment.pathsec import LocationTrust
    from aura.environment.provenance import Origin, Provenance

    bindir = tmp_path / "bin"
    bindir.mkdir()
    gui = _touch(bindir / "git-gui.exe")

    calls: list[list[str]] = []

    def fake_run_argv(argv, **kw):
        calls.append(list(argv))
        raise AssertionError(f"must not execute {argv}")

    monkeypatch.setattr(disc, "run_argv", fake_run_argv)

    candidate = disc._Candidate(
        name="git-gui",
        path=str(gui),
        real_path=str(gui),
        provenance=Provenance(
            origin=Origin.OS_PACKAGE, package="git", manager="winget",
            detail="claimed",
        ),
        trust=LocationTrust.TRUSTED,
        trust_reason="",
        identity=None,
    )
    tool = disc._probe_tool(candidate, path=str(bindir), cwd=str(tmp_path))
    assert calls == []
    assert tool.executed is False
    assert tool.present is False
    assert tool.status in (disc.ToolStatus.BLOCKED, disc.ToolStatus.UNVERIFIED)


def test_discovery_probes_allowlisted_cli(monkeypatch, tmp_path):
    """Allowlisted CLIs (git) still verify — accuracy is preserved."""
    from aura.environment import discovery as disc
    from aura.environment.pathsec import LocationTrust
    from aura.environment.procexec import ExecOutcome, ExecStatus
    from aura.environment.provenance import Origin, Provenance

    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = _touch(bindir / "git.exe")

    seen: list[list[str]] = []

    def fake_run_argv(argv, **kw):
        seen.append(list(argv))
        assert argv[0] == str(exe)
        assert argv[1:] == ["--version"]
        return ExecOutcome(status=ExecStatus.OK, exit_code=0, stdout="git version 2.45.0\n")

    monkeypatch.setattr(disc, "run_argv", fake_run_argv)

    candidate = disc._Candidate(
        name="git",
        path=str(exe),
        real_path=str(exe),
        provenance=Provenance(
            origin=Origin.OS_PACKAGE, package="git", manager="winget",
            detail="claimed",
        ),
        trust=LocationTrust.TRUSTED,
        trust_reason="",
        identity=None,
    )
    tool = disc._probe_tool(candidate, path=str(bindir), cwd=str(tmp_path))
    assert len(seen) == 1
    assert tool.executed is True
    assert tool.present is True
    assert tool.version == "2.45.0"
    assert tool.probe_command == "git --version"


# 4. Git installation detection works outside a repository.
def test_git_install_detection_works_outside_repository(monkeypatch, tmp_path):
    from aura.environment import gitstatus
    from aura.environment.procexec import ExecOutcome, ExecStatus

    def fake_run_argv(argv, **kw):
        assert argv[:2] == ["git", "--version"]
        return ExecOutcome(status=ExecStatus.OK, exit_code=0, stdout="git version 2.45.1\n")

    monkeypatch.setattr(gitstatus, "run_argv", fake_run_argv)
    result = gitstatus.git_install_probe()
    assert result["installed"] is True
    assert result["version"] == "2.45.1"


# 5. Git repository inspection works inside a valid repository.
def test_git_repo_inspection_inside_valid_repo(monkeypatch, tmp_path):
    from aura.environment import gitstatus
    from aura.environment.procexec import ExecOutcome, ExecStatus

    repo = tmp_path / "repo"
    repo.mkdir()

    def fake_run_argv(argv, **kw):
        if argv[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
            assert kw.get("cwd") == str(repo)
            return ExecOutcome(status=ExecStatus.OK, exit_code=0, stdout="true\n")
        assert argv[:2] == ["git", "--version"]
        return ExecOutcome(status=ExecStatus.OK, exit_code=0, stdout="git version 2.45.1\n")

    monkeypatch.setattr(gitstatus, "run_argv", fake_run_argv)
    assert gitstatus.is_git_repository(str(repo)) is True
    status = gitstatus.git_repository_status(str(repo))
    assert status == {
        "installed": True,
        "repository": True,
        "version": "2.45.1",
        "message": "Git is installed and the selected directory is a Git repository.",
    }


# 6. Non-repository Git inspection returns a structured result.
def test_non_repository_git_returns_structured_result(monkeypatch, tmp_path):
    from aura.environment import gitstatus
    from aura.environment.procexec import ExecOutcome, ExecStatus

    plain = tmp_path / "plain"
    plain.mkdir()

    def fake_run_argv(argv, **kw):
        if argv[:2] == ["git", "rev-parse"]:
            return ExecOutcome(status=ExecStatus.FAILED, exit_code=128,
                               stdout="", stderr="fatal: not a git repository\n")
        return ExecOutcome(status=ExecStatus.OK, exit_code=0, stdout="git version 2.45.1\n")

    monkeypatch.setattr(gitstatus, "run_argv", fake_run_argv)
    status = gitstatus.git_repository_status(str(plain))
    assert status["installed"] is True
    assert status["repository"] is False
    assert status["message"] == (
        "Git is installed, but the selected directory is not a Git repository."
    )
    assert status["version"] == "2.45.1"


def test_git_executors_refuse_non_repo_without_running_status(monkeypatch, tmp_path):
    """git.status from a non-repo returns the structured answer, no status run."""
    from aura import executors as ex

    plain = tmp_path / "plain"
    plain.mkdir()

    async def fake_is_repo(cwd):
        assert cwd == str(plain)
        return False

    async def fail_if_run(*a, **k):
        raise AssertionError("repository command must not run outside a repo")

    # git_is_repo lives in aura.exec_; executors imports it lazily per call.
    import aura.exec_ as execmod

    monkeypatch.setattr(execmod, "git_is_repo", fake_is_repo)
    monkeypatch.setattr(execmod, "git", fail_if_run)

    inv = {"context": {"cwd": str(plain)}, "input": {}}
    result = asyncio.run(ex.git_status(inv))
    assert result["ok"] is False
    assert result["output"]["installed"] is True
    assert result["output"]["repository"] is False
    assert "not a Git repository" in result["detail"]


# 7. Missing NVIDIA DLLs do not produce GUI startup errors.
def test_missing_nvidia_dlls_no_gui_errors(tmp_path):

    assert is_windows_probeable_file("cupti64_2020.3.1.dll") is False
    assert is_windows_probeable_file("ncu-ui.exe") is True  # file-shaped, but never probed
    # _probe_target refuses GUI / unlisted files: nothing to execute.
    assert safe_probe_args("cupti64_2020.3.1.dll") is None
    assert safe_probe_args("ncu-ui.exe") is None


# 8. Unsupported version arguments are not passed to arbitrary executables.
def test_unsupported_version_args_not_passed(monkeypatch, tmp_path):
    from aura.environment import discovery as disc
    from aura.environment.pathsec import LocationTrust
    from aura.environment.provenance import Origin, Provenance

    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = _touch(bindir / "weirdtool.exe")

    def fail(argv, **kw):
        raise AssertionError(f"must not run {argv}")

    monkeypatch.setattr(disc, "run_argv", fail)
    candidate = disc._Candidate(
        name="weirdtool",
        path=str(exe),
        real_path=str(exe),
        provenance=Provenance(origin=Origin.OS_PACKAGE, package="weird", manager="winget",
                              detail="claimed"),
        trust=LocationTrust.TRUSTED,
        trust_reason="",
        identity=None,
    )
    tool = disc._probe_tool(candidate, path=str(bindir), cwd=str(tmp_path))
    assert tool.executed is False
    assert tool.probe_command is None


# 9. Windows .cmd shims are handled correctly.
def test_windows_cmd_shims_handled():
    from aura.environment.procexec import ExecStatus, _windows_cmd_wrapper, run_argv

    # npm.cmd routes through cmd.exe as ONE pre-quoted command line.
    # A list is unrepresentable here: joining re-escapes cmd's quotes
    # C-runtime-style and the remainder arrives truncated. `call` keeps
    # the remainder from starting with a quote, which is what /s strips.
    wrapped = _windows_cmd_wrapper(["C:\\npm\\npm.cmd", "--version"])
    assert isinstance(wrapped, str)
    assert wrapped.endswith(" /d /s /c call C:\\npm\\npm.cmd --version"), wrapped
    # A spaced target is quoted in place; the line still starts the
    # remainder with `call`, never with a quote (which /s would strip).
    spaced = _windows_cmd_wrapper(["C:\\Program Files\\x\\tool.cmd", "--version"])
    assert isinstance(spaced, str) and spaced.endswith(
        ' /d /s /c call "C:\\Program Files\\x\\tool.cmd" --version'), spaced
    # .ps1 is never executed during inventory.
    assert _windows_cmd_wrapper(["C:\\x\\tool.ps1", "--version"]) is None
    outcome = run_argv(["C:\\x\\tool.ps1", "--version"], timeout_ms=1000)
    assert outcome.status is ExecStatus.ERROR
    assert "PowerShell" in outcome.error
    # basename allowlist survives the .cmd extension (npm.cmd -> npm).
    assert normalize_basename("npm.cmd") == "npm"
    assert safe_probe_args("npm.cmd") == ["--version"]
    # Unsafe cmd metacharacters are refused, not guessed at.
    bad = run_argv(["C:\\npm\\npm.cmd", "%APPDATA%"], timeout_ms=1000)
    assert bad.status is ExecStatus.ERROR


def test_windows_is_program_filter(tmp_path):
    # .dll / .ps1 / data files are not programs, even on Windows.
    assert is_windows_probeable_file("git.exe") is True
    assert is_windows_probeable_file("npm.cmd") is True
    assert is_windows_probeable_file("tool.bat") is True
    assert is_windows_probeable_file("cupti64_2020.3.1.dll") is False
    assert is_windows_probeable_file("script.ps1") is False
    assert is_windows_probeable_file("notes.txt") is False
    assert is_windows_probeable_file(".hidden") is False


def test_windows_git_dot_suffix_version_parses():
    """`git version 2.53.0.windows.2` must yield a version, not UNVERIFIED."""
    from aura.environment.discovery import extract_version

    assert extract_version("git version 2.53.0.windows.2\n") == "2.53.0.windows.2"
    # Pre-existing behavior is unchanged for all other shapes.
    assert extract_version("git version 2.45.1\n") == "2.45.1"
    assert extract_version("go version go1.22.0 linux/amd64\n") == "1.22.0"
    assert extract_version("v24.7.0\n") == "24.7.0"
    assert extract_version("Usage: sometool <cmd>\n") is None


# 11. Windows prefers runnable suffixed twins over extensionless shims.
def test_windows_prefers_cmd_over_extensionless_shim(tmp_path):
    """npm's `opencode` (sh script) must not shadow `opencode.cmd`.

    Live-reproduced: resolve_executable tried "" first and returned the
    extensionless shim, whose probe died with WinError 193 — reporting
    OpenCode, npm, VS Code and Flutter as broken/missing while all four
    were installed and healthy.
    """
    from aura.environment import pathsec

    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "opencode").write_bytes(b"#!/bin/sh\n")
    (bindir / "opencode.cmd").write_bytes(b"@echo off\n")
    got = pathsec.resolve_executable("opencode", str(bindir))
    assert got is not None and got.lower().endswith("opencode.cmd"), got


def test_windows_exact_suffixed_name_still_resolves(tmp_path):
    from aura.environment import pathsec

    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "node.exe").write_bytes(b"MZ-fake")
    got = pathsec.resolve_executable("node.exe", str(bindir))
    assert got is not None and got.lower().endswith("node.exe"), got


# 12. Windows Store alias stubs are skipped for real fallbacks.
def test_store_alias_stub_recognized(tmp_path, monkeypatch):
    from aura.environment import probe as probe_mod

    local = tmp_path / "Local"
    stubs = local / "Microsoft" / "WindowsApps"
    stubs.mkdir(parents=True)
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    assert probe_mod._is_store_alias_stub(
        str(stubs / "python3.EXE")) is True
    assert probe_mod._is_store_alias_stub(
        str(tmp_path / "tools" / "python.exe")) is False


def test_stub_failure_falls_through_to_real_candidate(tmp_path, monkeypatch):
    """A failed probe from a WindowsApps stub must try the next catalogue
    candidate instead of reporting the stub's failure. The stub itself
    must never be executed when a later candidate resolves."""
    import aura.environment.probe as probe_mod
    from aura.environment.catalog import CatalogEntry, ProbeSpec
    from aura.environment.procexec import ExecOutcome, ExecStatus

    local = tmp_path / "Local"
    stubs = local / "Microsoft" / "WindowsApps"
    stubs.mkdir(parents=True)
    (stubs / "python3.exe").write_bytes(b"stub")
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "python.exe").write_bytes(b"real")
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setenv("PATH", os.pathsep.join([str(stubs), str(tools)]))

    calls: list[str] = []

    def fake_run_argv(argv, **kw):
        calls.append(argv[0])
        if argv[0].lower().endswith("python3.exe"):
            return ExecOutcome(status=ExecStatus.FAILED, exit_code=1,
                               stdout="", stderr="nope")
        return ExecOutcome(status=ExecStatus.OK, exit_code=0,
                           stdout="Python 3.14.7\n")

    monkeypatch.setattr(probe_mod, "run_argv", fake_run_argv)
    entry = CatalogEntry(
        id="python", name="Python", category="development",
        capabilities=[], transport="local-process", auth="none",
        license="open-source", cross_platform=True, maintained=True,
        summary="", homepage="",
        probe=ProbeSpec("python3", ["--version"], fallbacks=("python",)),
    )
    result = probe_mod._run_probe(entry)
    assert result.present is True
    assert result.version == "3.14.7"
    assert all(not c.lower().endswith("python3.exe") for c in calls), calls


# 12b. A stub with no real alternative reports its failure, not absence.
def test_stub_only_reports_failed_not_not_found(tmp_path, monkeypatch):
    import aura.environment.probe as probe_mod
    from aura.environment.catalog import CatalogEntry, ProbeSpec
    from aura.environment.procexec import ExecOutcome, ExecStatus

    local = tmp_path / "Local"
    stubs = local / "Microsoft" / "WindowsApps"
    stubs.mkdir(parents=True)
    (stubs / "python3.exe").write_bytes(b"stub")
    (stubs / "python.exe").write_bytes(b"stub")
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setenv("PATH", str(stubs))

    def fake_run_argv(argv, **kw):
        return ExecOutcome(status=ExecStatus.FAILED, exit_code=9009,
                           stdout="", stderr="")

    monkeypatch.setattr(probe_mod, "run_argv", fake_run_argv)
    entry = CatalogEntry(
        id="python", name="Python", category="development",
        capabilities=[], transport="local-process", auth="none",
        license="open-source", cross_platform=True, maintained=True,
        summary="", homepage="",
        probe=ProbeSpec("python3", ["--version"], fallbacks=("python",)),
    )
    result = probe_mod._run_probe(entry)
    assert result.present is False
    # Honest: the alias exists but cannot run — not "not on PATH".
    from aura.environment.probe import ProbeStatus
    assert result.status == ProbeStatus.FAILED
    assert result.executable is not None


def test_system_interpreter_not_excluded_but_venv_is(tmp_path, monkeypatch):
    import sys

    from aura.environment import pathsec

    sysbase = tmp_path / "sysbase"
    sysbase.mkdir()
    monkeypatch.setattr(sys, "executable", str(sysbase / "python.exe"))
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    assert os.path.normcase(str(sysbase)) not in pathsec.self_runtime_dirs()

    venv = tmp_path / "venv"
    scripts = venv / "Scripts"
    scripts.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text("home = x\n")
    monkeypatch.setattr(sys, "executable", str(scripts / "python.exe"))
    assert os.path.normcase(str(scripts)) in pathsec.self_runtime_dirs()


# 13. PowerShell probe works on 5.1 and 7+ alike.
def test_powershell_probe_spec():
    from aura.environment.catalog import catalog_entry

    entry = catalog_entry("powershell")
    assert entry is not None and entry.probe is not None
    assert entry.probe.command == "pwsh"
    assert entry.probe.args == [
        "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()",
    ]


def test_bash_has_git_fallback():
    from aura.environment.catalog import catalog_entry

    entry = catalog_entry("bash")
    assert entry is not None and entry.probe is not None
    assert any("Git" in c for c in entry.probe.candidates)


# 10. Linux and macOS inventory behavior remains intact.
def test_linux_macos_behavior_intact():
    from aura.environment.hostplatform import Platform, simulate
    from aura.environment.inventory import service as svc
    from aura.environment.inventory.model import ItemKind

    # APPLICATIONS were never worth an execution — now explicit.
    assert ItemKind.APPLICATION not in svc._WORTH_VERIFYING
    assert ItemKind.CLI in svc._WORTH_VERIFYING
    # The allowlist is platform-independent for real CLIs.
    with simulate(Platform.LINUX):
        assert safe_probe_args("git") == ["--version"]
        assert safe_probe_args("node") == ["--version"]
    with simulate(Platform.MACOS):
        assert safe_probe_args("git") == ["--version"]


NATIVE_WINDOWS = pytest.mark.skipif(
    sys.platform != "win32",
    reason="executes a real .cmd shim: Windows-only by nature",
)


@NATIVE_WINDOWS
def test_spaced_shim_runs_through_call(tmp_path):
    """A shim under a spaced path must execute, not arrive as C:\\Program.

    Live-reproduced: `cmd /d /s /c "C:\\Program Files\\…\\npm.CMD"
    --version` strips to `C:\\Program` (cmd rule 2), so npm, VS Code and
    anything else under Program Files reported exit 1. The `call`
    builtin keeps the remainder intact. Real fixture, real cmd.exe.
    """
    from aura.environment.procexec import ExecStatus, run_argv

    spaced = tmp_path / "dir with spaces"
    spaced.mkdir()
    shim = spaced / "tool.cmd"
    shim.write_text("@echo tool 9.9.9\n")
    outcome = run_argv([str(shim), "--version"], timeout_ms=15000)
    assert outcome.status is ExecStatus.OK, outcome.error
    assert "9.9.9" in outcome.output


@NATIVE_WINDOWS
def test_spaced_shim_agent_path_runs(tmp_path):
    """Same guarantee through the agent/project boundary (exec_.run_file),
    which drives worker CLIs: spaced install dirs must work there too."""
    import aura.exec_ as execmod

    spaced = tmp_path / "dir with spaces"
    spaced.mkdir()
    shim = spaced / "worker.cmd"
    shim.write_text("@echo worker-ok\n")
    out = asyncio.run(
        execmod.run_file([str(shim)], str(tmp_path), 15000))
    assert out.code == 0, out.out
    assert "worker-ok" in out.out
