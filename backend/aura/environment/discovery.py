"""Bounded machine-environment discovery — what is actually on this machine.

Discovery answers "what is here", and it answers it from the machine's own
effective PATH rather than from a list of directories somebody guessed at.
Everything it finds is reported. What it *runs* is a much smaller set:

    found on PATH ──▶ discovered
                        │
                        ├── location is tamper-resistant?   (pathsec)
                        └── a package manager claims it?    (provenance)
                                │
                                ├── both → probed for a version → VERIFIED / FAILED / TIMEOUT
                                └── else → UNVERIFIED, and never executed

The second branch is the point. ``--version`` is not a safe no-op: a wrapper
script that ``exec``s its real command ignores the flag entirely and does
whatever it was going to do. Requiring deliberate installation before running
anything protects against binaries nobody has written yet, which an ignore
list of today's dangerous filenames could never do.

Nothing here recurses the filesystem, sources a shell rc file, builds a shell
command, or executes anything discovered from machine state without the two
checks above.
"""
from __future__ import annotations

import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from .pathsec import (
    LocationTrust,
    effective_path,
    location_trust,
    real_target,
    self_runtime_dirs,
)
from .procexec import ExecStatus, run_argv
from .provenance import Origin, Provenance, ProvenanceIndex, build_index

IS_WINDOWS = sys.platform == "win32"

#: How many trusted candidates may be executed in one scan.
MAX_UNKNOWN_PROBE = 60
#: How many candidates are described in the result at all. Execution is not
#: the only cost: a machine with tens of thousands of programs on PATH would
#: otherwise produce a multi-megabyte response for a UI that shows a list.
#: The count and the truncation flag stay truthful, so nothing is dropped
#: silently — only unlisted.
MAX_REPORTED = 400
#: How many files are read from any single directory.
MAX_PER_DIR = 400
#: How many directories are enumerated at all.
MAX_DIRS = 60
#: Budget for one unknown-tool version check.
UNKNOWN_TIMEOUT_MS = 6000
#: Parallel unknown probes.
UNKNOWN_CONCURRENCY = 8

#: Directories represented by the OS package inventory instead of per-file
#: cards. Enumerating /usr/bin yields ~2900 coreutils entries, which buries
#: the tools a person actually installed. They are reported as skipped, with
#: the reason, rather than silently dropped.
_SYSTEM_DIRS = (
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/games",
    "/usr/local/games",
    "/usr/bin/site_perl",
    "/usr/bin/vendor_perl",
    "/usr/bin/core_perl",
    "/usr/lib",
    "/usr/libexec",
)

#: Version-manager trees. Their bin directories hold generated trampolines
#: and per-interpreter copies of the same console scripts — one pyenv install
#: contributed over a hundred entries, none of them a separately installed
#: tool. The whole tree is skipped, and reported as skipped.
_VERSION_MANAGER_MARKERS = (
    "/.pyenv/",
    "/.rbenv/",
    "/.nodenv/",
    "/.jenv/",
    "/.asdf/",
    "/.rustup/toolchains/",
    "/.nvm/versions/",
)

#: Not programs: libraries, headers, data and build leftovers.
_NON_PROGRAM_SUFFIXES = frozenset(
    {
        ".so", ".dylib", ".dll", ".a", ".o", ".lib", ".pdb", ".h", ".c", ".cc",
        ".cpp", ".hpp", ".rs", ".java", ".class", ".jar", ".log", ".tmp", ".txt",
        ".md", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".lock", ".map",
        ".zip", ".gz", ".xz", ".bz2", ".tar", ".png", ".svg", ".ico",
    }
)

#: Executable names are permissive: `g++`, `clang++`, `7z`, and non-ASCII
#: names are all legitimate. Only path separators and control characters are
#: rejected, because those indicate something other than a command name.
_BAD_NAME_RE = re.compile(r"[\x00-\x1f\x7f/\\]")


class ToolStatus(str, Enum):
    """What AURA established about one discovered tool."""

    VERIFIED = "verified"
    """Ran, exited cleanly, and reported a version."""

    UNVERIFIED = "unverified"
    """Present on disk. Not run, or run without producing a usable version."""

    FAILED = "failed"
    """Ran and exited non-zero."""

    TIMEOUT = "timeout"
    """Did not answer in time. Presence is unknown, not disproved."""

    BLOCKED = "blocked"
    """Deliberately not executed. ``detail`` says why."""


@dataclass
class DiscoveredTool:
    id: str
    name: str
    executable: str
    real_path: str
    source: str
    status: ToolStatus
    present: bool
    version: str | None
    detail: str
    latency_ms: int | None
    category: str
    origin: str
    package: str | None = None
    manager: str | None = None
    probe_command: str | None = None
    aliases: list[str] = field(default_factory=list)
    executed: bool = False


@dataclass
class DiscoveryReport:
    """Discovery's answer plus an honest account of its own limits."""

    tools: list[DiscoveredTool] = field(default_factory=list)
    #: Every program found on PATH, including any not listed in ``tools``.
    total_candidates: int = 0
    #: How many were executed to establish a version.
    scanned_candidates: int = 0
    #: How many appear in ``tools``.
    reported_candidates: int = 0
    truncated: bool = False
    skipped_directories: list[dict[str, str]] = field(default_factory=list)
    directories_scanned: int = 0


@dataclass
class _Candidate:
    name: str
    path: str
    real_path: str
    provenance: Provenance
    trust: LocationTrust
    trust_reason: str
    aliases: set[str] = field(default_factory=set)


_CATEGORY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cloud", ("aws", "gcloud", "azure", "firebase", "vercel", "wrangler", "supabase",
               "terraform", "kubectl", "docker", "podman", "railway", "render", "netlify",
               "fly", "heroku", "cloudflare", "doctl", "pulumi")),
    ("ai", ("claude", "codex", "gemini", "opencode", "kilo", "qwen", "copilot", "cursor",
            "kimi", "openclaude", "ollama", "aider", "llm")),
    ("development", ("git", "gh", "glab", "cargo", "npm", "pnpm", "yarn", "pip", "uv",
                     "poetry", "go", "java", "python", "node", "bun", "deno", "make",
                     "cmake", "gcc", "clang", "rust", "ruby", "php", "dotnet")),
    ("system", ("curl", "wget", "ssh", "adb", "sqlite", "psql", "redis", "mongo", "ffmpeg",
                "rsync", "tar", "jq")),
)


def _category_for(name: str) -> str:
    lower = name.lower()
    for category, needles in _CATEGORY_RULES:
        if any(needle in lower for needle in needles):
            return category
    return "unknown"


def _dir_skip_reason(directory: str) -> str | None:
    """Why a PATH entry is not enumerated, or ``None`` to enumerate it."""
    normalised = os.path.normcase(os.path.normpath(directory))
    for system in _SYSTEM_DIRS:
        if normalised == os.path.normcase(os.path.normpath(system)):
            return "covered by the operating system package inventory"
    posix = normalised.replace("\\", "/") + "/"
    for marker in _VERSION_MANAGER_MARKERS:
        if marker in posix:
            return "a version-manager tree, not separately installed tools"
    if normalised in self_runtime_dirs():
        return "the Python environment AURA itself is running in"
    return None


def _looks_like_program(entry: Path) -> bool:
    name = entry.name
    if not name or name.startswith("."):
        return False
    if _BAD_NAME_RE.search(name):
        return False
    if len(name) > 64:
        return False
    if entry.suffix.lower() in _NON_PROGRAM_SUFFIXES:
        return False
    try:
        # is_file() follows symlinks, so a broken link is correctly excluded.
        if not entry.is_file():
            return False
    except OSError:
        return False
    if IS_WINDOWS:
        return True
    try:
        return os.access(str(entry), os.X_OK)
    except OSError:
        return False


def _list_programs(directory: Path, limit: int = MAX_PER_DIR) -> tuple[list[Path], bool]:
    """Programs directly inside ``directory``. No recursion. Returns (entries, truncated)."""
    try:
        if not directory.is_dir():
            return [], False
        entries = sorted(directory.iterdir(), key=lambda p: p.name)
    except OSError:
        return [], False
    kept: list[Path] = []
    for entry in entries:
        if len(kept) >= limit:
            return kept, True
        try:
            if _looks_like_program(entry):
                kept.append(entry)
        except OSError:
            continue
    return kept, False


def _strip_windows_ext(name: str) -> str:
    if not IS_WINDOWS:
        return name
    stem, ext = os.path.splitext(name)
    if ext.lower() in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        return stem
    return name


_VERSION_BODY = r"\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.\-]*)?"

#: The version must begin a token. Without this, the "2.5-Coder" inside a
#: model name like "Qwen2.5-Coder" printed in a banner reads as a version.
_VERSION_STRICT = re.compile(rf"(?:^|(?<=[\s(\[{{=:,\"'/]))v?({_VERSION_BODY})(?![\d.])")

#: Relaxed form, used only on lines that say "version", where a glued prefix
#: is idiomatic: `go version go1.22.0 linux/amd64`.
_VERSION_LABELLED = re.compile(rf"(?<![\d.])({_VERSION_BODY})(?![\d.])")

#: Box-drawing splash screens are not version output.
_PRINTABLE = re.compile(r"[\x20-\x7e]")

#: Nothing this long is a version. Without a ceiling a tool that prints a
#: nine-hundred-digit number hands that string straight to the UI as one.
_MAX_VERSION_LEN = 64


def _is_banner(line: str) -> bool:
    if len(line) < 8:
        return False
    printable = len(_PRINTABLE.findall(line))
    return printable / len(line) < 0.7


def extract_version(output: str) -> str | None:
    """The version in ``output``, or ``None``.

    Never invents one. The previous implementation fell back to the first
    forty characters of whatever the command printed, which turned
    ``Usage: sometool <cmd>`` into a version string and displayed it as one.

    Lines that mention a version are read first and read leniently; every
    other line has to present the number as its own token, which is what
    keeps an ASCII-art splash screen from yielding a version.
    """
    if not output:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]

    for line in lines:
        if "version" in line.lower() and not _is_banner(line):
            for match in _VERSION_LABELLED.finditer(line):
                if len(match.group(1)) <= _MAX_VERSION_LEN:
                    return match.group(1)

    for line in lines:
        if _is_banner(line):
            continue
        for match in _VERSION_STRICT.finditer(line):
            if len(match.group(1)) <= _MAX_VERSION_LEN:
                return match.group(1)
    return None


def _probe_tool(candidate: _Candidate, path: str, cwd: str) -> DiscoveredTool:
    """Run one trusted candidate's version check and interpret the result."""
    outcome = run_argv(
        [candidate.path, "--version"],
        timeout_ms=UNKNOWN_TIMEOUT_MS,
        cwd=cwd,
        path=path,
    )
    version = extract_version(outcome.output) if outcome.status is ExecStatus.OK else None
    name = _strip_windows_ext(candidate.name)

    if outcome.status is ExecStatus.OK and version:
        status, detail = ToolStatus.VERIFIED, f"{name} {version} — {candidate.provenance.detail}."
    elif outcome.status is ExecStatus.OK:
        status = ToolStatus.UNVERIFIED
        detail = f"{name} ran but did not report a version AURA could read."
    elif outcome.status is ExecStatus.TIMEOUT:
        status = ToolStatus.TIMEOUT
        detail = f"{name} did not answer within {UNKNOWN_TIMEOUT_MS}ms, so its version is unknown."
    elif outcome.status is ExecStatus.FAILED:
        status = ToolStatus.FAILED
        detail = f"{name} is installed but its version check exited {outcome.exit_code}."
    elif outcome.status is ExecStatus.DENIED:
        status = ToolStatus.UNVERIFIED
        detail = f"{name} is present but this account may not execute it."
    else:
        status = ToolStatus.UNVERIFIED
        detail = f"{name} is present but could not be run ({outcome.error or outcome.status.value})."

    return DiscoveredTool(
        id=f"unknown:{name}",
        name=name,
        executable=candidate.path,
        real_path=candidate.real_path,
        source="PATH",
        status=status,
        present=status is ToolStatus.VERIFIED,
        version=version,
        detail=detail,
        latency_ms=outcome.duration_ms,
        category=_category_for(name),
        origin=candidate.provenance.origin.value,
        package=candidate.provenance.package,
        manager=candidate.provenance.manager,
        probe_command=f"{name} --version",
        aliases=sorted(candidate.aliases),
        executed=True,
    )


def _unexecuted_tool(candidate: _Candidate, detail: str) -> DiscoveredTool:
    name = _strip_windows_ext(candidate.name)
    blocked = candidate.trust is not LocationTrust.TRUSTED
    return DiscoveredTool(
        id=f"unknown:{name}",
        name=name,
        executable=candidate.path,
        real_path=candidate.real_path,
        source="PATH",
        status=ToolStatus.BLOCKED if blocked else ToolStatus.UNVERIFIED,
        present=False,
        version=None,
        detail=detail,
        latency_ms=None,
        category=_category_for(name),
        origin=candidate.provenance.origin.value,
        package=candidate.provenance.package,
        manager=candidate.provenance.manager,
        probe_command=None,
        aliases=sorted(candidate.aliases),
        executed=False,
    )


def _collect_candidates(
    index: ProvenanceIndex,
    exclude_real_paths: set[str],
    exclude_names: set[str],
    path: str,
) -> tuple[list[_Candidate], list[dict[str, str]], int]:
    """Walk the effective PATH and build one candidate per distinct program."""
    by_real: dict[str, _Candidate] = {}
    skipped: list[dict[str, str]] = []
    seen_dirs: set[str] = set()
    scanned_dirs = 0

    for raw in path.split(os.pathsep):
        if not raw:
            continue
        directory = os.path.normpath(os.path.expanduser(raw))
        key = os.path.normcase(directory)
        if key in seen_dirs:
            continue
        seen_dirs.add(key)

        reason = _dir_skip_reason(directory)
        if reason:
            skipped.append({"directory": directory, "reason": reason})
            continue
        if scanned_dirs >= MAX_DIRS:
            skipped.append({"directory": directory, "reason": "directory budget reached"})
            continue
        if not os.path.isdir(directory):
            continue

        scanned_dirs += 1
        entries, truncated_dir = _list_programs(Path(directory))
        if truncated_dir:
            skipped.append(
                {"directory": directory, "reason": f"only the first {MAX_PER_DIR} entries were read"}
            )

        for entry in entries:
            bare = _strip_windows_ext(entry.name)
            if bare.lower() in exclude_names:
                continue
            target = real_target(entry)
            if target in exclude_real_paths:
                continue
            existing = by_real.get(target)
            if existing is not None:
                # A second name for a file already seen: an alias, not a tool.
                existing.aliases.add(bare)
                continue
            verdict = location_trust(entry)
            by_real[target] = _Candidate(
                name=bare,
                path=str(entry),
                real_path=target,
                provenance=index.classify(entry),
                trust=verdict.trust,
                trust_reason=verdict.reason,
            )

    return list(by_real.values()), skipped, scanned_dirs


#: Suffixes packages add to a name that the command itself drops.
_PACKAGE_SUFFIXES = ("-cli", "-code", "-tool", "-js", "-ai", ".js")


def _primary_rank(name: str, package: str) -> tuple[int, int, str]:
    """Which of a package's commands should name the card.

    `@emend-ai/utim` ships `utim` and `utimlite`; `render-cli` ships
    `render`. Picking the shortest name would label the first pair
    "utimlite" and npm's own package "npx". Closeness to the package name is
    what actually identifies the primary command.
    """
    lower = name.lower()
    basename = package.split("/")[-1].lower()
    stripped = basename
    for suffix in _PACKAGE_SUFFIXES:
        if stripped.endswith(suffix) and len(stripped) > len(suffix):
            stripped = stripped[: -len(suffix)]
            break

    if lower == basename:
        return (0, len(lower), lower)
    if lower == stripped:
        return (1, len(lower), lower)
    if basename.startswith(lower) or lower.startswith(stripped):
        # A longer shared prefix is a closer match.
        return (2, -len(lower), lower)
    return (3, len(lower), lower)


def _merge_by_package(candidates: list[_Candidate]) -> list[_Candidate]:
    """Collapse several binaries from one package into one logical tool.

    ``@emend-ai/utim`` installs ``utim`` and ``utimlite``; npm installs ``npm``
    and ``npx``. Those are one thing each, and the package identity — not a
    similar-looking name — is what proves it.
    """
    grouped: dict[tuple[str, str], list[_Candidate]] = {}
    singles: list[_Candidate] = []
    for candidate in candidates:
        provenance = candidate.provenance
        if provenance.package and provenance.manager:
            grouped.setdefault((provenance.manager, provenance.package), []).append(candidate)
        else:
            singles.append(candidate)

    merged: list[_Candidate] = list(singles)
    for (_, package), members in grouped.items():
        if len(members) == 1:
            merged.append(members[0])
            continue
        members.sort(key=lambda c: _primary_rank(c.name, package))
        primary = members[0]
        for other in members[1:]:
            primary.aliases.add(other.name)
            primary.aliases.update(other.aliases)
        primary.aliases.discard(primary.name)
        merged.append(primary)
    return merged


#: What survives the reporting cap first: things AURA actually established.
_REPORT_RANK = {
    ToolStatus.VERIFIED: 0,
    ToolStatus.FAILED: 1,
    ToolStatus.TIMEOUT: 1,
    ToolStatus.BLOCKED: 2,
    ToolStatus.UNVERIFIED: 3,
}

_ORIGIN_RANK = {
    Origin.NPM_GLOBAL: 0,
    Origin.PIPX: 1,
    Origin.CARGO: 2,
    Origin.VENV: 3,
    Origin.OS_PACKAGE: 4,
    Origin.CATALOG: 0,
    Origin.UNKNOWN: 9,
}


def discover_tools(
    index: ProvenanceIndex | None = None,
    *,
    exclude_real_paths: set[str] | None = None,
    exclude_names: set[str] | None = None,
    exclude_packages: set[tuple[str, str]] | None = None,
    max_probe: int = MAX_UNKNOWN_PROBE,
    path: str | None = None,
) -> DiscoveryReport:
    """Enumerate the machine's PATH and verify what is safe to verify."""
    index = index or build_index()
    search_path = path if path is not None else effective_path()
    cwd = str(Path(os.path.expanduser("~")))

    candidates, skipped, scanned_dirs = _collect_candidates(
        index,
        exclude_real_paths or set(),
        {n.lower() for n in (exclude_names or set())},
        search_path,
    )
    candidates = _merge_by_package(candidates)

    # A package the catalog already reports is not also an unknown tool,
    # whichever of its entry points was found.
    if exclude_packages:
        candidates = [
            c
            for c in candidates
            if not (
                c.provenance.manager
                and c.provenance.package
                and (c.provenance.manager, c.provenance.package) in exclude_packages
            )
        ]

    runnable: list[_Candidate] = []
    blocked: list[DiscoveredTool] = []
    for candidate in candidates:
        if candidate.trust is not LocationTrust.TRUSTED:
            blocked.append(
                _unexecuted_tool(
                    candidate,
                    f"{candidate.name} was found at {candidate.path} but AURA did not run it: "
                    f"{candidate.trust_reason}.",
                )
            )
        elif not candidate.provenance.trusted:
            blocked.append(
                _unexecuted_tool(
                    candidate,
                    f"{candidate.name} was found at {candidate.path}. No package manager claims "
                    "it, so AURA lists it without running it.",
                )
            )
        else:
            runnable.append(candidate)

    # Provenance first, then name, so the budget is spent on the most
    # strongly attested tools rather than on whatever sorts earliest.
    runnable.sort(key=lambda c: (_ORIGIN_RANK.get(c.provenance.origin, 9), c.name.lower()))
    to_probe = runnable[:max_probe]
    deferred = [
        _unexecuted_tool(
            c,
            f"{c.name} was found at {c.path} but this scan's verification budget "
            f"({max_probe}) was already spent.",
        )
        for c in runnable[max_probe:]
    ]

    probed: list[DiscoveredTool] = []
    if to_probe:
        workers = min(UNKNOWN_CONCURRENCY, len(to_probe))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aura-discover") as pool:
            futures = {pool.submit(_probe_tool, c, search_path, cwd): c for c in to_probe}
            for future in as_completed(futures):
                candidate = futures[future]
                try:
                    probed.append(future.result())
                except Exception as exc:  # one tool must never sink the scan
                    probed.append(
                        _unexecuted_tool(candidate, f"Probe for {candidate.name} failed: {exc}")
                    )

    tools = probed + deferred + blocked
    tools.sort(key=lambda t: (_REPORT_RANK.get(t.status, 3), t.name.lower()))
    reported = tools[:MAX_REPORTED]
    reported.sort(key=lambda t: t.name.lower())

    return DiscoveryReport(
        tools=reported,
        total_candidates=len(candidates),
        scanned_candidates=len(to_probe),
        reported_candidates=len(reported),
        truncated=bool(deferred) or len(reported) < len(tools),
        skipped_directories=skipped,
        directories_scanned=scanned_dirs,
    )


def discovered_to_dict(tool: DiscoveredTool) -> dict[str, Any]:
    return {
        "id": tool.id,
        "name": tool.name,
        "executable": tool.executable,
        "realPath": tool.real_path,
        "source": tool.source,
        "status": tool.status.value,
        "present": tool.present,
        "version": tool.version,
        "detail": tool.detail,
        "latencyMs": tool.latency_ms,
        "category": tool.category,
        "origin": tool.origin,
        "package": tool.package,
        "manager": tool.manager,
        "probeCommand": tool.probe_command,
        "aliases": tool.aliases,
        "executed": tool.executed,
    }
