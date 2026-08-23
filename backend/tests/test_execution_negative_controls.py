"""Negative controls for the execution layer.

The reference module's own header says it best: nothing here decides
whether an action is permitted, only that whatever runs runs safely
bounded. These tests assert the bounds — and every one of them describes
something an attacker or a bug would otherwise get away with.

Python earns extra scrutiny here because `subprocess` makes the unsafe
form (a command string through a shell) easier to write than the safe
one. Several tests below exist purely to prove no such path was taken.
"""

from __future__ import annotations

import subprocess
import sys
import threading

import pytest

from aura_backend.execution import (
    AGENT_BINARIES,
    INSTALLER_BINARIES,
    SAFE_BINARIES,
    TIMEOUT_EXIT_CODE,
    ProcessNotInstalled,
    ProcessRefused,
    SpawnOptions,
    UnsafeArgumentError,
    install_subcommand,
    parse_command,
    quote_for_cmd,
    resolve_agent_binary,
    resolve_installer_binary,
    run_agent,
    run_installer,
    safe_shell,
    safe_shell_with_code,
    settle,
)
from aura_backend.execution.process import SpawnError

# --------------------------------------------------------------------------
# The three allow-lists are disjoint and stay that way.
# --------------------------------------------------------------------------


def test_the_three_allowlists_are_pairwise_disjoint_except_the_two_shared_installers():
    """SAFE and INSTALLER deliberately share `npm` and `cargo`; the verb
    guard is what separates the grants. Everything else must be disjoint."""
    assert SAFE_BINARIES & AGENT_BINARIES == frozenset()
    assert AGENT_BINARIES & INSTALLER_BINARIES == frozenset()
    assert SAFE_BINARIES & INSTALLER_BINARIES == {"npm", "cargo"}


def test_no_agent_is_reachable_through_the_safe_shell():
    """terminal.execute must never be able to launch a coding agent."""
    for agent in AGENT_BINARIES:
        parsed = parse_command(f"{agent} run 'do something'")
        assert not parsed.ok, agent


def test_no_privilege_escalating_binary_is_on_any_list():
    """An AUR helper is privilege-escalating despite running as the user,
    because it calls `sudo pacman` itself."""
    for dangerous in ("sudo", "doas", "su", "pacman", "apt", "dnf", "yay", "paru", "sh", "bash"):
        assert dangerous not in SAFE_BINARIES
        assert dangerous not in AGENT_BINARIES
        assert dangerous not in INSTALLER_BINARIES


# --------------------------------------------------------------------------
# Command injection.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "git status; rm -rf /",
        "git status && rm -rf /",
        "git status || rm -rf /",
        "git status | sh",
        "git status > /etc/passwd",
        "git status < /etc/shadow",
        "git status `whoami`",
        "git status $(whoami)",
        "git status $HOME",
        "git status \\; rm",
    ],
)
def test_shell_operators_are_refused_before_anything_is_spawned(command):
    parsed = parse_command(command)
    assert not parsed.ok
    assert "Shell operators are not allowed" in parsed.reason


def test_a_refused_command_never_reaches_a_spawn(tmp_path):
    with pytest.raises(ProcessRefused):
        safe_shell_with_code("rm -rf /", SpawnOptions(cwd=str(tmp_path)))


def test_arguments_containing_metacharacters_are_data_not_syntax(tmp_path):
    """The killer test for a Python port: if any code path joined argv into
    a shell string, this would create a file."""
    canary = tmp_path / "pwned"
    script = tmp_path / "echo.js"
    script.write_text("console.log(process.argv[2])\n", encoding="utf-8")
    # `parse_command` refuses metacharacters in a command line, so drive the
    # argv path directly the way an executor does.
    result = subprocess.run(
        [sys.executable, "-c", "pass"], capture_output=True
    )
    assert result.returncode == 0
    from aura_backend.execution.process import _spawn

    err, out, _ = _spawn(
        "node",
        [str(script), f"; touch {canary}"],
        cwd=str(tmp_path),
        timeout_ms=10_000,
        close_stdin=True,
    )
    assert err is None
    assert f"; touch {canary}" in out
    assert not canary.exists(), "an argument was interpreted as shell syntax"


# --------------------------------------------------------------------------
# Named, not located.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "/bin/sh",
        "/home/someone/evil.sh",
        "../../bin/sh",
        "./opencode",
        "C:\\Windows\\System32\\cmd.exe",
        "opencode; rm -rf /",
        "opencode && x",
        "opencode`id`",
        "opencode$X",
        "",
        "   ",
    ],
)
def test_an_agent_must_be_named_never_located(name):
    assert resolve_agent_binary(name).ok is False


@pytest.mark.parametrize(
    "name", ["/usr/bin/npm", "../npm", "..", "npm/../sudo", "sudo", "pacman", "yay", "", "sh"]
)
def test_an_installer_must_be_named_never_located(name):
    assert resolve_installer_binary(name).ok is False


def test_refusal_happens_before_any_process_is_started(tmp_path):
    with pytest.raises(ProcessRefused):
        run_agent("/bin/sh", ["-c", "touch pwned"], SpawnOptions(cwd=str(tmp_path)))
    with pytest.raises(ProcessRefused):
        run_installer("sudo", ["pacman", "-S", "x"], SpawnOptions(cwd=str(tmp_path)))
    assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------
# The install verb guard — the system-floor bypass.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "npm install -g typescript",
        "npm install --global typescript",
        "npm i -g x",
        "npm add --global x",
        "npm -g install x",
        "npm install x -g",
        "cargo install ripgrep",
        "go install example.com/x@latest",
        "python3 -m pip install requests",
    ],
)
def test_installing_through_the_safe_shell_is_refused(command):
    """Without this guard, medium-risk terminal.execute could install
    anything, side-stepping the system floor entirely."""
    parsed = parse_command(command)
    assert not parsed.ok
    assert "system.install" in parsed.reason


@pytest.mark.parametrize(
    "command",
    ["npm install", "npm install lodash", "npm ci", "npm test", "cargo build", "go build",
     "python3 script.py", "python3 -m pip download x"],
)
def test_ordinary_project_work_is_still_allowed(command):
    """The guard separates the grants on the verb. It must not turn `npm
    test` into a refusal."""
    assert parse_command(command).ok is True


def test_the_verb_guard_is_not_fooled_by_flag_ordering():
    assert install_subcommand("npm", ["install", "-g", "x"]) is not None
    assert install_subcommand("npm", ["-g", "install", "x"]) is not None
    assert install_subcommand("npm", ["install", "x", "--global"]) is not None
    assert install_subcommand("npm", ["install", "x"]) is None


# --------------------------------------------------------------------------
# Exit status truthfulness. The bug this layer exists to prevent.
# --------------------------------------------------------------------------


def test_a_timed_out_process_is_never_reported_as_success():
    out = settle(SpawnError(code=None, killed=True, signal="SIGTERM"), "", "", 700)
    assert out.code == TIMEOUT_EXIT_CODE != 0
    assert out.timed_out is True


def test_a_signalled_process_reports_128_plus_the_signal():
    assert settle(SpawnError(signal="SIGTERM"), "", "", 0).code == 143
    assert settle(SpawnError(signal="SIGKILL"), "", "", 0).code == 137
    assert settle(SpawnError(signal="SIGINT"), "", "", 0).code == 130


def test_an_unknown_signal_still_fails_rather_than_succeeding():
    assert settle(SpawnError(signal="SIGWEIRD"), "", "", 0).code == 128


def test_an_error_with_no_numeric_status_reports_one_never_zero():
    assert settle(SpawnError(code="ENOENT", message="boom"), "", "", 0).code == 1
    assert settle(SpawnError(code=None, message="boom"), "", "", 0).code == 1


def test_only_a_genuine_clean_exit_reports_zero():
    assert settle(None, "fine", "", 0).code == 0


def test_a_real_timeout_reports_124_and_kills_the_child(tmp_path):
    script = tmp_path / "slow.js"
    script.write_text("setTimeout(function(){}, 60000)\n", encoding="utf-8")
    result = safe_shell_with_code(
        "node slow.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=700)
    )
    assert result.code == TIMEOUT_EXIT_CODE
    assert result.timed_out is True
    assert "timed out" in result.out


def test_safe_shell_refuses_to_return_partial_output_from_a_killed_process(tmp_path):
    """Returning partial output as the value would let a caller treat a
    truncated run as a completed one."""
    script = tmp_path / "partial.js"
    script.write_text(
        'console.log("partial"); setTimeout(function(){}, 60000)\n', encoding="utf-8"
    )
    with pytest.raises(ProcessRefused) as exc:
        safe_shell("node partial.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=700))
    assert "partial" in str(exc.value)


# --------------------------------------------------------------------------
# Resource bounds.
# --------------------------------------------------------------------------


def test_a_runaway_child_cannot_exhaust_memory(tmp_path):
    """Node enforces maxBuffer inside execFile; Python does not, so the cap
    is implemented in the port. Without it this is a denial of service
    reachable from any allow-listed command."""
    script = tmp_path / "big.js"
    script.write_text('process.stdout.write("x".repeat(9*1024*1024))\n', encoding="utf-8")
    result = safe_shell_with_code("node big.js", SpawnOptions(cwd=str(tmp_path)))
    assert result.code == 1, "an overflowing process must fail, not succeed"
    assert len(result.out) <= 4 * 1024 * 1024 + 64


def test_a_child_that_ignores_sigterm_is_still_reaped(tmp_path):
    """A DELIBERATE difference from the reference: Node sends its kill
    signal once and waits forever if the child ignores it. A hung backend
    is a worse failure than a divergence, so the port escalates."""
    script = tmp_path / "stubborn.js"
    script.write_text(
        'process.on("SIGTERM", function(){}); setTimeout(function(){}, 60000)\n',
        encoding="utf-8",
    )
    result = safe_shell_with_code(
        "node stubborn.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=700)
    )
    assert result.code == TIMEOUT_EXIT_CODE
    assert result.timed_out is True


def test_cancellation_stops_a_running_process(tmp_path):
    script = tmp_path / "slow.js"
    script.write_text("setTimeout(function(){}, 60000)\n", encoding="utf-8")
    cancel = threading.Event()
    threading.Timer(0.4, cancel.set).start()
    result = safe_shell_with_code(
        "node slow.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=30_000, cancel=cancel)
    )
    assert result.code != 0, "a cancelled process must not report success"
    assert result.timed_out is False, "cancellation is not a timeout"


# --------------------------------------------------------------------------
# Windows argument handling, proved on Linux.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("arg", ["%PATH%", "100%", 'say "hi"', "a\nb", "a\rb"])
def test_arguments_cmd_would_reinterpret_are_refused_not_guessed_at(arg):
    """`cmd /c` expands %FOO% inside quotes as well as outside, so an
    argument containing % could leak an environment variable into an
    agent's task text."""
    with pytest.raises(UnsafeArgumentError):
        quote_for_cmd(arg)


@pytest.mark.parametrize("arg", ["plain", "with space", "a&b", "a|b", "a>b", "a^b", "a(b)"])
def test_metacharacters_quoting_can_neutralise_are_allowed(arg):
    assert quote_for_cmd(arg) == f'"{arg}"'


# --------------------------------------------------------------------------
# Missing binaries are reported honestly.
# --------------------------------------------------------------------------


def test_a_missing_binary_is_reported_as_not_installed_not_as_a_crash(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(ProcessNotInstalled):
        run_agent("opencode", ["run", "hi"], SpawnOptions(cwd=str(tmp_path), timeout_ms=2000))
