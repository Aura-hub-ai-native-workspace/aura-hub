"""Install planning — turning catalog knowledge into a governed install plan.

This is the Python equivalent of the TypeScript exec/install.ts.

This module decides three things and nothing else:

  1. which command would install a node,
  2. what privilege that genuinely needs ON THIS MACHINE,
  3. whether AURA may run it.

It performs no installation. It spawns nothing. system.install's
executor asks it for a plan, and the plan is either something the
existing process primitive can run as the current user, or an
instruction for the human.

The package name never comes from a caller. It comes from the
CatalogEntry.install, which is data in the repository — the same
invariant that keeps probing safe, applied to a far more dangerous verb.
"""
from __future__ import annotations

import os
import platform
import subprocess
from dataclasses import dataclass
from typing import Any

from .catalog import CatalogEntry, InstallSpec

INSTALLER_BINARIES = frozenset(["npm", "pipx", "cargo", "gh"])


INSTALLER_BINARIES = frozenset(["npm", "pipx", "cargo", "gh"])


@dataclass
class InstallPlan:
    executable: bool
    privilege: str
    bin: str
    args: list[str]
    command: str
    why: str


@dataclass
class NoInstallPlan:
    executable: bool = False
    reason: str = ""


PlanResult = InstallPlan | NoInstallPlan


def is_plan(r: PlanResult) -> bool:
    return isinstance(r, InstallPlan)


def _writable_with_ancestors(target: str) -> bool:
    dir_path = os.path.realpath(target)
    while True:
        try:
            if os.access(dir_path, os.W_OK):
                return True
            parent = os.path.dirname(dir_path)
            if parent == dir_path:
                return False
            if not os.path.exists(dir_path):
                dir_path = parent
            else:
                return False
        except OSError:
            return False


def _npm_global_root() -> str | None:
    try:
        result = subprocess.run(
            ["npm", "config", "get", "prefix"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        prefix = result.stdout.strip()
        if prefix and prefix != "undefined":
            return os.path.join(prefix, "lib", "node_modules")
        return None
    except Exception:
        return None


def _resolve_privilege(spec: InstallSpec) -> tuple[str, str]:
    if spec.privilege == "root":
        return (
            "root",
            "Installing a system package changes software for every user on this machine, which needs administrator rights.",
        )

    method = spec.method
    if method == "npm-global":
        root = _npm_global_root()
        if not root:
            return (
                "root",
                "AURA could not determine where npm installs global packages, so it will not assume it may write there.",
            )
        if _writable_with_ancestors(root):
            return ("user", f"npm installs global packages into {root}, which you own.")
        return ("root", f"npm installs global packages into {root}, which your user cannot write to.")
    elif method == "cargo":
        cargo_home = os.environ.get("CARGO_HOME", os.path.join(os.path.expanduser("~"), ".cargo"))
        bin_dir = os.path.join(cargo_home, "bin")
        if _writable_with_ancestors(bin_dir):
            return ("user", f"cargo installs into {bin_dir}, which you own.")
        return ("root", f"cargo would install into {bin_dir}, which your user cannot write to.")
    elif method == "pipx":
        pipx_bin = os.environ.get("PIPX_BIN_DIR", os.path.join(os.path.expanduser("~"), ".local", "bin"))
        if _writable_with_ancestors(pipx_bin):
            return ("user", f"pipx installs into {pipx_bin}, which you own.")
        return ("root", f"pipx would install into {pipx_bin}, which your user cannot write to.")
    elif method == "gh-extension":
        gh_ext_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "gh")
        if _writable_with_ancestors(gh_ext_dir):
            return ("user", f"GitHub CLI keeps extensions in {gh_ext_dir}, which you own.")
        return ("root", f"GitHub CLI would write to {gh_ext_dir}, which your user cannot write to.")
    elif method == "system-package":
        return (
            "root",
            "Installing a system package changes software for every user on this machine, which needs administrator rights.",
        )

    return (
        "root",
        f"Unknown install method: {method}",
    )


def _detect_distro() -> dict[str, Any]:
    system = platform.system()
    if system == "Linux":
        try:
            with open("/etc/os-release", "r") as f:
                content = f.read()
            import re
            id_match = re.search(r'^ID=("?)(.+?)\1$', content, re.MULTILINE)
            id_value = id_match.group(2) if id_match else ""
            if not id_value:
                like_match = re.search(r'^ID_LIKE=("?)(.+?)\1$', content, re.MULTILINE)
                if like_match:
                    id_value = like_match.group(2).split()[0]

            distro_map = {
                "arch": {"id": "arch", "manager": "pacman", "installArgs": ["-S", "--needed"]},
                "manjaro": {"id": "arch", "manager": "pacman", "installArgs": ["-S", "--needed"]},
                "endeavouros": {"id": "arch", "manager": "pacman", "installArgs": ["-S", "--needed"]},
                "debian": {"id": "debian", "manager": "apt", "installArgs": ["install"]},
                "ubuntu": {"id": "debian", "manager": "apt", "installArgs": ["install"]},
                "pop": {"id": "debian", "manager": "apt", "installArgs": ["install"]},
                "linuxmint": {"id": "debian", "manager": "apt", "installArgs": ["install"]},
                "fedora": {"id": "fedora", "manager": "dnf", "installArgs": ["install"]},
                "rhel": {"id": "fedora", "manager": "dnf", "installArgs": ["install"]},
                "centos": {"id": "fedora", "manager": "dnf", "installArgs": ["install"]},
            }
            return distro_map.get(id_value, {"id": id_value or "unknown", "manager": "", "installArgs": []})
        except Exception:
            return {"id": "unknown", "manager": "", "installArgs": []}
    elif system == "Darwin":
        return {"id": "macos", "manager": "brew", "installArgs": ["install"]}
    elif system == "Windows":
        return {"id": "windows", "manager": "choco", "installArgs": ["/i"]}

    return {"id": "unknown", "manager": "", "installArgs": []}


def _show_token(token: str) -> str:
    import re
    if re.match(r'^[A-Za-z0-9._@/:+-]+$', token):
        return token
    return f"'{token.replace('\'', '\'\\\'\'')}'"


def _line(bin_path: str, args: list[str]) -> str:
    return " ".join([_show_token(bin_path)] + [_show_token(a) for a in args])


def _userspace_command(spec: InstallSpec, pkg: str) -> dict[str, Any] | None:
    method = spec.method
    if method == "npm-global":
        return {"bin": "npm", "args": ["install", "--global", pkg]}
    elif method == "pipx":
        return {"bin": "pipx", "args": ["install", pkg]}
    elif method == "cargo":
        return {"bin": "cargo", "args": ["install", pkg]}
    elif method == "gh-extension":
        return {"bin": "gh", "args": ["extension", "install", pkg]}
    elif method == "system-package":
        return None
    return None


def plan_install(entry: CatalogEntry) -> PlanResult:
    spec = entry.install
    if spec is None:
        return NoInstallPlan(
            reason=f"AURA has no verified way to install {entry.name}, so it will not guess at one. See {entry.homepage} for the project's own instructions.",
        )

    privilege, why = _resolve_privilege(spec)

    if privilege == "root":
        distro = _detect_distro()
        pkg = spec.distro.get(distro["id"], spec.package) if distro["id"] != "unknown" else spec.package

        if spec.method != "system-package":
            base = _userspace_command(spec, spec.package)
            if base:
                cmd = f"sudo {_line(base['bin'], base['args'])}"
                return InstallPlan(
                    executable=False,
                    privilege="root",
                    bin=base["bin"],
                    args=base["args"],
                    command=cmd,
                    why=why,
                )
            return NoInstallPlan(
                reason=f"AURA has no verified way to install {entry.name} on this machine.",
            )

        if not distro["manager"]:
            return NoInstallPlan(
                reason=f"{entry.name} is a system package, and AURA could not identify this machine's package manager. Install it the way your distribution recommends: {entry.homepage}",
            )

        cmd = f"sudo {_line(distro['manager'], [*distro['installArgs'], pkg])}"
        return InstallPlan(
            executable=False,
            privilege="root",
            bin=distro["manager"],
            args=[*distro["installArgs"], pkg],
            command=cmd,
            why=why,
        )

    base = _userspace_command(spec, spec.package)
    if not base:
        return NoInstallPlan(
            reason=f"AURA has no verified way to install {entry.name} on this machine.",
        )

    return InstallPlan(
        executable=True,
        privilege="user",
        bin=base["bin"],
        args=base["args"],
        command=_line(base["bin"], base["args"]),
        why=why,
    )


def validate_installer_binary(bin_name: str) -> tuple[bool, str]:
    if not bin_name or "/" in bin_name or "\\" in bin_name or ".." in bin_name:
        return (False, "An installer must be named, not given as a path.")
    if bin_name not in INSTALLER_BINARIES:
        return (False, f"'{bin_name}' is not on the installer allow-list ({', '.join(sorted(INSTALLER_BINARIES))}).")
    return (True, "")
