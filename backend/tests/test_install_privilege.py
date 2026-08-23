"""Negative controls for install planning.

The privilege value in the catalogue is a FLOOR. This module may raise it
and must never lower it — and AURA must never execute a root-tier install
itself. Both properties are asserted here.
"""

from __future__ import annotations

import os
import sys

import pytest

from aura_backend.execution.install import (
    InstallPlan,
    InstallSpec,
    NoInstallPlan,
    detect_distro,
    is_plan,
    plan_install,
    resolve_privilege,
    userspace_command,
    writable_with_ancestors,
)

METHODS = ["npm-global", "pipx", "cargo", "gh-extension", "system-package"]


def spec(method: str, privilege: str = "user", **kw) -> InstallSpec:
    return InstallSpec(method=method, package="somepkg", privilege=privilege, **kw)


# --------------------------------------------------------------------------
# The privilege floor may only rise.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("method", METHODS)
def test_a_root_catalogue_entry_is_never_de_escalated(method):
    """Escalating is always safe; de-escalating never happens."""
    privilege, _why = resolve_privilege(spec(method, privilege="root"))
    assert privilege == "root"


def test_a_system_package_is_always_root_even_when_the_catalogue_says_user():
    privilege, _ = resolve_privilege(spec("system-package", privilege="user"))
    assert privilege == "root"


def test_an_unresolvable_npm_prefix_escalates_rather_than_assuming(monkeypatch):
    """AURA will not assume it may write somewhere it could not identify."""
    monkeypatch.setattr("aura_backend.execution.install.npm_global_root", lambda: None)
    privilege, why = resolve_privilege(spec("npm-global"))
    assert privilege == "root"
    assert "could not determine" in why


def test_an_unwritable_target_escalates_to_root(monkeypatch, tmp_path):
    unwritable = tmp_path / "locked"
    unwritable.mkdir()
    monkeypatch.setattr("aura_backend.execution.install.npm_global_root", lambda: str(unwritable))
    monkeypatch.setattr(
        "aura_backend.execution.install.writable_with_ancestors", lambda _t: False
    )
    privilege, why = resolve_privilege(spec("npm-global"))
    assert privilege == "root"
    assert "cannot write to" in why


# --------------------------------------------------------------------------
# AURA executes nothing at the root tier.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("method", METHODS)
def test_a_root_tier_plan_is_never_executable(method):
    result = plan_install(
        name="Thing", homepage="https://example.invalid", spec=spec(method, privilege="root")
    )
    assert result.executable is False


def test_a_root_tier_plan_hands_over_a_command_and_runs_nothing():
    result = plan_install(
        name="Docker", homepage="https://docker.com", spec=spec("system-package", privilege="root")
    )
    if is_plan(result):
        assert result.executable is False
        if sys.platform != "win32":
            assert result.command.startswith("sudo ")
    else:
        # No package manager identified — an honest refusal is also correct.
        assert "could not identify" in result.reason


def test_no_userspace_command_ever_names_a_privileged_binary():
    for method in METHODS:
        base = userspace_command(spec(method), "pkg")
        if base is None:
            assert method == "system-package"
            continue
        binary, _args = base
        assert binary in {"npm", "pipx", "cargo", "gh"}
        assert binary not in {"sudo", "pacman", "apt", "dnf", "yay", "paru"}


def test_a_system_package_is_never_a_userspace_command():
    assert userspace_command(spec("system-package"), "pkg") is None


# --------------------------------------------------------------------------
# The package name is catalogue data, never a caller's string.
# --------------------------------------------------------------------------


def test_an_absent_spec_refuses_rather_than_guessing():
    result = plan_install(name="Mystery", homepage="https://example.invalid", spec=None)
    assert isinstance(result, NoInstallPlan)
    assert "will not guess" in result.reason
    assert "https://example.invalid" in result.reason


def test_the_planned_argv_contains_exactly_the_catalogue_package(monkeypatch):
    monkeypatch.setattr("aura_backend.execution.install.resolve_privilege",
                        lambda _s: ("user", "you own it"))
    result = plan_install(
        name="Tool", homepage="h", spec=InstallSpec("npm-global", "opencode-ai", "user")
    )
    assert isinstance(result, InstallPlan)
    assert result.args == ["install", "--global", "opencode-ai"]
    assert result.executable is True


# --------------------------------------------------------------------------
# writable_with_ancestors: only walk past what genuinely does not exist.
# --------------------------------------------------------------------------


def test_a_not_yet_created_directory_under_a_writable_parent_counts_as_writable(tmp_path):
    """~/.cargo/bin does not exist until the first `cargo install`. Testing
    the leaf would escalate an ordinary install for no reason."""
    assert writable_with_ancestors(str(tmp_path / "cargo" / "bin")) is True


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write anywhere")
def test_a_directory_that_exists_and_is_unwritable_is_a_real_refusal(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        assert writable_with_ancestors(str(locked)) is False
    finally:
        locked.chmod(0o700)


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write anywhere")
def test_it_does_not_look_past_an_existing_unwritable_directory(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        # The child does not exist, but its parent exists and is unwritable.
        assert writable_with_ancestors(str(locked / "child")) is False
    finally:
        locked.chmod(0o700)


# --------------------------------------------------------------------------
# Distro detection names a manager; it never runs one.
# --------------------------------------------------------------------------


def test_distro_detection_returns_a_known_manager_or_admits_it_does_not_know():
    distro = detect_distro()
    assert distro.manager in {"", "pacman", "apt", "dnf"}
    if not distro.manager:
        assert distro.install_args == []
