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

    # npm.cmd routes through cmd.exe with quoting.
    wrapped = _windows_cmd_wrapper(["C:\\npm\\npm.cmd", "--version"])
    assert wrapped is not None
    assert wrapped[0].lower().endswith("cmd.exe")
    assert wrapped[1:4] == ["/d", "/s", "/c"]
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
