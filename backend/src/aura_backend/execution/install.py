"""Turning catalogue knowledge into a governed install plan.

A port of packages/ai-service/src/exec/install.ts.

This module decides three things and nothing else:

  1. which command would install a node,
  2. what privilege that genuinely needs ON THIS MACHINE,
  3. whether AURA may run it.

It performs no installation. It spawns nothing except `npm config get
prefix` for detection. The package name never comes from a caller — it
comes from the catalogue, which is data in the repository. That is the
same invariant that keeps probing safe, applied to a far more dangerous
verb.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .which import launch_spec

InstallMethod = Literal["npm-global", "pipx", "cargo", "gh-extension", "system-package"]
InstallPrivilege = Literal["user", "root"]

_SYSTEM_PACKAGE_WHY = (
    "Installing a system package changes software for every user on this machine, "
    "which needs administrator rights."
)


@dataclass(frozen=True)
class InstallSpec:
    method: InstallMethod
    package: str
    privilege: InstallPrivilege
    distro: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class InstallPlan:
    """What AURA would do about an install, before any of it happens."""

    # True when AURA may run this itself as the current user.
    executable: bool
    privilege: InstallPrivilege
    # Installer binary — always on INSTALLER_BINARIES when executable.
    bin: str
    args: list[str]
    # The whole thing as one line, for display and for the guided path.
    command: str
    # Why this needs the privilege it needs, in plain language.
    why: str


@dataclass(frozen=True)
class NoInstallPlan:
    """A node AURA cannot install at all, and the honest reason."""

    reason: str
    executable: bool = False


PlanResult = InstallPlan | NoInstallPlan


def is_plan(result: PlanResult) -> bool:
    return isinstance(result, InstallPlan)


# ── privilege detection ──────────────────────────────────────────────


def writable_with_ancestors(target: str) -> bool:
    """Can the current user write here, treating a not-yet-created
    directory as writable if its nearest existing ancestor is?

    `~/.cargo/bin` does not exist until the first `cargo install` creates
    it. Testing the leaf would report "not writable" and escalate a
    perfectly ordinary userspace install to the root tier, sending the
    user to a terminal for no reason.

    Only directories that genuinely do not exist are walked past. A
    directory that EXISTS and is not writable is a real refusal, not
    something to look past.
    """
    directory = Path(target).resolve()
    while True:
        if os.access(directory, os.W_OK):
            return True
        parent = directory.parent
        # Reached the root without finding anything writable.
        if parent == directory:
            return False
        if directory.exists():
            return False
        directory = parent


def npm_global_root() -> str | None:
    """Where `npm install -g` would actually write on this machine."""
    try:
        # `npm` is `npm.cmd` on Windows, which cannot be spawned directly.
        # Asking by bare name there fails, and the except below would read
        # that as "cannot determine the prefix" and escalate an ordinary
        # userspace install to the root tier — sending every Windows user
        # to a terminal, with a `sudo` command their OS does not have.
        spec = launch_spec("npm", ["config", "get", "prefix"])
        prefix = subprocess.run(
            [spec.target.file, *spec.target.args],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            shell=False,
        ).stdout.strip()
        if not prefix or prefix == "undefined":
            return None
        # Layout is a platform fact, not a preference: Windows keeps global
        # modules directly under the prefix, Unix under prefix/lib.
        if sys.platform == "win32":
            return str(Path(prefix) / "node_modules")
        return str(Path(prefix) / "lib" / "node_modules")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def resolve_privilege(spec: InstallSpec) -> tuple[InstallPrivilege, str]:
    """The privilege an install genuinely needs here.

    The catalogue value is a FLOOR. This may RAISE it — never lower it. A
    machine whose npm prefix is `/usr` needs root for a package the
    catalogue calls userspace, and answering "user" there produces an
    EACCES that reads like an AURA defect. Escalating is always safe;
    de-escalating never happens, at any point in this function.
    """
    if spec.privilege == "root":
        return "root", _SYSTEM_PACKAGE_WHY

    if spec.method == "npm-global":
        root = npm_global_root()
        if not root:
            why = (
                "AURA could not determine where npm installs global packages, "
                "so it will not assume it may write there."
            )
            return "root", why
        if writable_with_ancestors(root):
            return "user", f"npm installs global packages into {root}, which you own."
        return (
            "root",
            f"npm installs global packages into {root}, which your user cannot write to.",
        )

    if spec.method == "cargo":
        home = os.environ.get("CARGO_HOME") or str(Path.home() / ".cargo")
        binary_dir = str(Path(home) / "bin")
        if writable_with_ancestors(binary_dir):
            return "user", f"cargo installs into {binary_dir}, which you own."
        return "root", f"cargo would install into {binary_dir}, which your user cannot write to."

    if spec.method == "pipx":
        binary_dir = os.environ.get("PIPX_BIN_DIR") or str(Path.home() / ".local" / "bin")
        if writable_with_ancestors(binary_dir):
            return "user", f"pipx installs into {binary_dir}, which you own."
        return "root", f"pipx would install into {binary_dir}, which your user cannot write to."

    if spec.method == "gh-extension":
        binary_dir = str(Path.home() / ".local" / "share" / "gh")
        if writable_with_ancestors(binary_dir):
            return "user", f"GitHub CLI keeps extensions in {binary_dir}, which you own."
        return "root", f"GitHub CLI would write to {binary_dir}, which your user cannot write to."

    # system-package
    return "root", _SYSTEM_PACKAGE_WHY


# ── distro detection, for the guided command only ────────────────────


@dataclass(frozen=True)
class Distro:
    id: str
    manager: str
    install_args: list[str]


_ID_RE = re.compile(r'^ID=("?)(.+?)\1$', re.MULTILINE)
_ID_LIKE_RE = re.compile(r'^ID_LIKE=("?)(.+?)\1$', re.MULTILINE)


def detect_distro() -> Distro:
    """Which distro family this is, from /etc/os-release.

    Used ONLY to name the right package manager in an instruction the user
    runs themselves. AURA never executes any of these.
    """
    distro_id = ""
    try:
        release = Path("/etc/os-release").read_text(encoding="utf-8")
        match = _ID_RE.search(release)
        distro_id = match.group(2).strip() if match else ""
        if not distro_id:
            like = _ID_LIKE_RE.search(release)
            distro_id = like.group(2).split()[0].strip() if like else ""
    except OSError:
        # Not Linux, or no os-release. Falls through to the unknown case.
        pass

    if distro_id in ("arch", "manjaro", "endeavouros"):
        return Distro("arch", "pacman", ["-S", "--needed"])
    if distro_id in ("debian", "ubuntu", "pop", "linuxmint"):
        return Distro("debian", "apt", ["install"])
    if distro_id in ("fedora", "rhel", "centos"):
        return Distro("fedora", "dnf", ["install"])
    return Distro(distro_id or "unknown", "", [])


# ── plan construction ────────────────────────────────────────────────

_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._@/:+-]+$")


def _show(token: str) -> str:
    """Quote a token for display in a shell instruction, if it needs it."""
    if _SAFE_TOKEN.match(token):
        return token
    escaped = token.replace("'", "'\\''")
    return f"'{escaped}'"


def _line(bin_name: str, args: list[str]) -> str:
    return " ".join(_show(t) for t in [bin_name, *args])


def _elevated(command: str) -> str:
    """The same command, marked as needing administrator rights on the
    platform the user is actually on.

    `sudo` is a Unix program. Printing it to a Windows user would be an
    instruction they cannot follow — and this string is the whole
    deliverable of the guided path, so getting it wrong wastes the one
    thing AURA hands over when it refuses to act.
    """
    if sys.platform == "win32":
        return f"{command}   (run this in an Administrator terminal)"
    return f"sudo {command}"


def userspace_command(spec: InstallSpec, package: str) -> tuple[str, list[str]] | None:
    """The argv for a userspace install method.

    Every binary here is on INSTALLER_BINARIES; nothing assembles a shell
    string, and the package is the only variable part.
    """
    if spec.method == "npm-global":
        return "npm", ["install", "--global", package]
    if spec.method == "pipx":
        return "pipx", ["install", package]
    if spec.method == "cargo":
        return "cargo", ["install", package]
    if spec.method == "gh-extension":
        return "gh", ["extension", "install", package]
    # system-package is never userspace, by definition. Reaching here would
    # be a bug in resolve_privilege, so refuse rather than improvise.
    return None


def plan_install(
    *, name: str, homepage: str, spec: InstallSpec | None
) -> PlanResult:
    """Work out what installing this node would take.

    Returns a NoInstallPlan — not an exception and not a guess — when the
    catalogue has no install spec. "AURA does not know how to install
    this" is a legitimate answer and must reach the user as one.
    """
    if spec is None:
        return NoInstallPlan(
            reason=(
                f"AURA has no verified way to install {name}, so it will not guess at one. "
                f"See {homepage} for the project's own instructions."
            )
        )

    privilege, why = resolve_privilege(spec)

    if privilege == "root":
        distro = detect_distro()
        package = (distro.id and spec.distro.get(distro.id)) or spec.package

        if spec.method != "system-package":
            # A userspace method that escalated — e.g. an npm prefix under
            # /usr. The command is still the userspace one; only the
            # privilege changed, so say exactly that rather than inventing
            # a distro package that may not exist.
            base = userspace_command(spec, spec.package)
            if base is None:
                return NoInstallPlan(
                    reason=f"AURA has no verified way to install {name} on this machine."
                )
            bin_name, args = base
            return InstallPlan(
                executable=False,
                privilege=privilege,
                bin=bin_name,
                args=args,
                command=_elevated(_line(bin_name, args)),
                why=why,
            )

        if not distro.manager:
            return NoInstallPlan(
                reason=(
                    f"{name} is a system package, and AURA could not identify this machine's "
                    f"package manager. Install it the way your distribution recommends: {homepage}"
                )
            )
        args = [*distro.install_args, package]
        return InstallPlan(
            executable=False,
            privilege=privilege,
            bin=distro.manager,
            args=args,
            command=_elevated(_line(distro.manager, args)),
            why=why,
        )

    base = userspace_command(spec, spec.package)
    if base is None:
        return NoInstallPlan(
            reason=f"AURA has no verified way to install {name} on this machine."
        )
    bin_name, args = base
    return InstallPlan(
        executable=True,
        privilege="user",
        bin=bin_name,
        args=args,
        command=_line(bin_name, args),
        why=why,
    )
