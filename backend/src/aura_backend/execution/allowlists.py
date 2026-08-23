"""The three binary allow-lists and the guards around them.

A port of the allow-list half of packages/ai-service/src/exec/process.ts.

The three lists are disjoint and are NEVER merged. That separation is the
security property, not a tidiness preference:

  * merged into SAFE_BINARIES, medium-risk `terminal.execute` could
    install arbitrary software, or launch a coding agent;
  * merged into AGENT_BINARIES, a delegated agent could install software.

An agent rewrites files on its own judgement, which is a categorically
larger grant than running `npm test`. Keeping the lists apart means either
grant can be revoked without touching the other.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Binaries the safe shell will spawn. Deliberately small: a command that is
# not on this list is refused WITH the list in the message, so the refusal
# is actionable rather than mysterious.
SAFE_BINARIES: frozenset[str] = frozenset(
    {"git", "ls", "pwd", "node", "npm", "npx", "wc", "du", "grep", "find", "cargo", "python3", "go"}
)

# Coding agents `agent.delegate` may launch.
AGENT_BINARIES: frozenset[str] = frozenset(
    {"opencode", "claude", "codex", "gemini", "qwen", "cursor-agent"}
)

# Installers `system.install` may launch. Note what is absent: sudo, pacman,
# apt, dnf, yay, paru. Root-tier installs are never executed by AURA, so no
# privileged or privilege-escalating binary appears here — and an AUR helper
# is privilege-escalating despite running as the user, because it calls
# `sudo pacman` itself.
INSTALLER_BINARIES: frozenset[str] = frozenset({"npm", "pipx", "cargo", "gh"})

# Ordering for the messages. The TypeScript refusals interpolate a Set in
# insertion order, so the lists are reproduced in their declared order to
# keep the user-facing text identical.
_SAFE_ORDER = [
    "git", "ls", "pwd", "node", "npm", "npx", "wc", "du", "grep", "find", "cargo", "python3", "go",
]
_AGENT_ORDER = ["opencode", "claude", "codex", "gemini", "qwen", "cursor-agent"]
_INSTALLER_ORDER = ["npm", "pipx", "cargo", "gh"]

# Shell operators refused in a command line, before anything is spawned.
_SHELL_OPERATORS = re.compile(r"[;&|<>`$\\]")
# Metacharacters refused in an agent binary NAME.
_AGENT_METACHARS = re.compile(r"[;&|<>`$]")
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class ResolvedBinary:
    ok: bool
    bin: str
    # Why it was refused. Empty when ok.
    reason: str = ""


@dataclass(frozen=True)
class ParsedCommand:
    ok: bool
    bin: str
    args: list[str] = field(default_factory=list)
    reason: str = ""


def resolve_agent_binary(name: str) -> ResolvedBinary:
    """Decide whether a binary name may be launched as a coding agent.

    Rejects anything path-like BEFORE consulting the list: a caller must
    name an agent, never locate one. This is what stops
    `/home/someone/evil.sh` — or a relative `../../x` — from ever reaching
    the spawner, regardless of what the catalogue or the client claims.
    """
    candidate = (name or "").strip()
    if not candidate:
        return ResolvedBinary(False, "", "No agent binary was named.")
    if "/" in candidate or "\\" in candidate or _AGENT_METACHARS.search(candidate):
        return ResolvedBinary(False, candidate, "An agent must be named, not given as a path.")
    if candidate not in AGENT_BINARIES:
        return ResolvedBinary(
            False,
            candidate,
            f"'{candidate}' is not on the coding-agent allow-list ({', '.join(_AGENT_ORDER)}).",
        )
    return ResolvedBinary(True, candidate, "")


def resolve_installer_binary(name: str) -> ResolvedBinary:
    """Decide whether a binary may be launched as an installer.

    Same shape and same guarantees as `resolve_agent_binary`: anything
    path-like is refused before the list is consulted.
    """
    candidate = (name or "").strip()
    if not candidate or "/" in candidate or "\\" in candidate or ".." in candidate:
        return ResolvedBinary(
            False, candidate, "An installer must be named, not given as a path."
        )
    if candidate not in INSTALLER_BINARIES:
        return ResolvedBinary(
            False,
            candidate,
            f"'{candidate}' is not on the installer allow-list ({', '.join(_INSTALLER_ORDER)}).",
        )
    return ResolvedBinary(True, candidate, "")


def install_subcommand(bin_name: str, args: list[str]) -> str | None:
    """Is this allow-listed command actually an INSTALL in disguise?

    `npm` and `cargo` are on SAFE_BINARIES because `npm test` and
    `cargo build` are ordinary project work. They are also how software
    gets installed, which means the binary name alone cannot separate "run
    the tests" from "add a global package" — and without this guard,
    `terminal.execute` (medium risk, ask-user) could install anything,
    side-stepping the system floor entirely.

    So the separation between the two grants is enforced on the VERB as
    well as the binary. The two lists do share two names; what they do not
    share is the ability to install.
    """
    sub = next((a for a in args if not a.startswith("-")), None)
    if sub is None:
        return None
    verb = f"{bin_name} {sub}"
    if bin_name == "npm":
        # `npm install` inside a project is legitimate; `-g`/`--global` is
        # what reaches outside it. `npm ci` is project-local by definition.
        if re.fullmatch(r"install|i|add", sub) and any(a in ("-g", "--global") for a in args):
            return f"{verb} --global"
        return None
    if bin_name == "cargo":
        return verb if sub == "install" else None
    if bin_name == "go":
        return verb if sub == "install" else None
    if bin_name == "python3":
        # `python3 -m pip install ...`
        if "pip" in args and "install" in args:
            return "python3 -m pip install"
        return None
    return None


def parse_command(command: str) -> ParsedCommand:
    """Decide whether a command line is runnable, without running it.

    Exported so the Fabric can refuse — or warn — before an approval
    prompt is put in front of the user.
    """
    trimmed = (command or "").strip()
    if not trimmed:
        return ParsedCommand(False, "", [], "No command was given.")
    if _SHELL_OPERATORS.search(trimmed):
        return ParsedCommand(
            False,
            "",
            [],
            "Shell operators are not allowed — pass a single command with plain arguments.",
        )
    parts = _WHITESPACE.split(trimmed)
    bin_name = parts[0]
    if bin_name not in SAFE_BINARIES:
        return ParsedCommand(
            False,
            bin_name,
            [],
            f"'{bin_name}' is not on the allow-list ({', '.join(_SAFE_ORDER)}).",
        )
    installing = install_subcommand(bin_name, parts[1:])
    if installing:
        return ParsedCommand(
            False,
            bin_name,
            [],
            f"Installing software is not something this can do. '{installing}' changes what is "
            "installed on this machine, which goes through system.install — where it is gated "
            "by approval and verified by a real probe.",
        )
    return ParsedCommand(True, bin_name, parts[1:], "")
