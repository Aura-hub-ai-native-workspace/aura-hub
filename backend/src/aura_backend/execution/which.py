"""Finding an executable the way the running OS finds one.

A port of packages/ai-service/src/exec/which.ts.

Everything here is a pure function over an injected platform, PATH,
PATHEXT and file test, for the same reason the TypeScript version is: it
means the Windows branch can be exercised and proved on Linux rather than
reasoned about and hoped for.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

Platform = Literal["win32", "posix"]

# What Windows uses when PATHEXT is unset.
DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

_DRIVE_LETTER = re.compile(r"^[A-Za-z]:")


def current_platform() -> Platform:
    return "win32" if sys.platform == "win32" else "posix"


@dataclass(frozen=True)
class ResolveEnv:
    platform: Platform
    # Raw PATH value. Split with the platform's own delimiter, never ":".
    path_env: str
    path_ext: str | None = None
    is_executable_file: Callable[[str], bool] = lambda _c: False


def _delimiter_for(platform: Platform) -> str:
    return ";" if platform == "win32" else ":"


def _sep_for(platform: Platform) -> str:
    return "\\" if platform == "win32" else "/"


def is_path_like(name: str, platform: Platform) -> bool:
    """Does this look like a path rather than a bare name?"""
    if platform == "win32":
        return "/" in name or "\\" in name or bool(_DRIVE_LETTER.match(name))
    return "/" in name


def resolve_executable_with(name: str, env: ResolveEnv) -> str | None:
    """The real file on disk for a bare binary name, or None.

    On Windows a name is tried both as given and with each PATHEXT
    extension, in PATHEXT order, because that order decides which of
    `foo.exe` and `foo.cmd` actually runs.

    The current directory is deliberately NOT searched: Windows' command
    interpreter does search it, and that is precisely how a stray
    `git.exe` in a project folder would hijack a probe.
    """
    raw = (name or "").strip()
    if not raw:
        return None

    sep = _sep_for(env.platform)
    if env.platform == "win32":
        source = env.path_ext if env.path_ext is not None else DEFAULT_PATHEXT
        # PATHEXT is uppercase by convention while files on disk are not.
        # The resolved path is shown to users, so build it in the casing the
        # file actually has; order is preserved because PATHEXT order decides
        # which extension wins.
        extensions = [""] + [e.strip().lower() for e in source.split(";") if e.strip()]
    else:
        extensions = [""]

    def try_dir(directory: str) -> str | None:
        for ext in extensions:
            # Already carries a known extension — do not build "node.exe.exe".
            if ext and raw.lower().endswith(ext.lower()):
                continue
            if directory:
                joiner = "" if directory.endswith(sep) else sep
                candidate = f"{directory}{joiner}{raw}{ext}"
            else:
                candidate = f"{raw}{ext}"
            if env.is_executable_file(candidate):
                return candidate
        return None

    # An explicit path is used as given, not searched for.
    if is_path_like(raw, env.platform):
        return try_dir("")

    for directory in env.path_env.split(_delimiter_for(env.platform)):
        if not directory:
            continue
        # Windows tolerates quoted PATH entries; Unix does not quote them.
        clean = directory.strip('"') if env.platform == "win32" else directory
        hit = try_dir(clean)
        if hit:
            return hit
    return None


def is_executable_file_on_disk(candidate: str) -> bool:
    try:
        if not os.path.isfile(candidate):
            return False
    except OSError:
        return False
    # Windows has no execute bit — being a file with an executable extension
    # is the whole test there, and X_OK would answer for the wrong OS.
    if sys.platform == "win32":
        return True
    return os.access(candidate, os.X_OK)


def resolve_executable(name: str) -> str | None:
    return resolve_executable_with(
        name,
        ResolveEnv(
            platform=current_platform(),
            path_env=os.environ.get("PATH", ""),
            path_ext=os.environ.get("PATHEXT"),
            is_executable_file=is_executable_file_on_disk,
        ),
    )


# ── launching what we found ──────────────────────────────────────────


@dataclass(frozen=True)
class SpawnTarget:
    file: str
    args: list[str]


class UnsafeArgumentError(Exception):
    """An argument the platform's command interpreter would rewrite."""


# Characters that survive cmd.exe's second parse and change meaning.
#
# `&`, `|`, `<`, `>`, `^`, `(`, `)` can be neutralised by quoting, but `%`
# cannot: `cmd /c` expands `%FOO%` inside quotes as well as outside, so an
# argument containing `%` could interpolate an environment variable —
# leaking its value into a command line, or into an agent's task text. A
# double quote is equally unfixable, because it ends the quoting the escape
# depends on. Neither is worth guessing at, so both are refused.
CMD_UNQUOTABLE = re.compile(r'[%"\r\n]')


def quote_for_cmd(arg: str) -> str:
    """Wrap one argument so cmd.exe passes it through unchanged."""
    if CMD_UNQUOTABLE.search(arg):
        if "%" in arg:
            what = "'%'"
        elif '"' in arg:
            what = "the quote character"
        else:
            what = "the line break"
        raise UnsafeArgumentError(
            "On Windows this argument has to pass through cmd.exe, which "
            f"would reinterpret {what} in it. AURA will not guess at what "
            "you meant — remove it and try again."
        )
    return f'"{arg}"'


def spawn_target_for(resolved: str, args: list[str], platform: Platform) -> SpawnTarget:
    """Turn a resolved executable into something spawnable.

    A `.cmd`/`.bat` shim is not a program — it is a script for the command
    interpreter — so it goes to `cmd.exe /d /s /c` with each argument
    quoted individually.
    """
    if platform != "win32":
        return SpawnTarget(file=resolved, args=list(args))
    lower = resolved.lower()
    if not lower.endswith(".cmd") and not lower.endswith(".bat"):
        return SpawnTarget(file=resolved, args=list(args))
    return SpawnTarget(
        file=os.environ.get("ComSpec") or "cmd.exe",
        args=["/d", "/s", "/c", quote_for_cmd(resolved), *(quote_for_cmd(a) for a in args)],
    )


def is_cmd_shim(resolved: str, platform: Platform) -> bool:
    return platform == "win32" and bool(re.search(r"\.(cmd|bat)$", resolved, re.IGNORECASE))


@dataclass(frozen=True)
class LaunchSpec:
    target: SpawnTarget
    resolved: str | None


def launch_spec(name: str, args: list[str]) -> LaunchSpec:
    """What to hand the spawner for a bare binary name.

    On Unix an unresolvable name still falls back to the bare name: the OS
    resolver has always been the authority there, and this must not turn a
    tool the spawner can find into one AURA claims is missing.
    """
    platform = current_platform()
    resolved = resolve_executable(name)
    if not resolved:
        return LaunchSpec(target=SpawnTarget(file=name, args=list(args)), resolved=None)
    return LaunchSpec(target=spawn_target_for(resolved, args, platform), resolved=resolved)
