"""Are the connected coding agents up to date?

For each known agent: the version installed on this machine (its own ``--version``, run through the
governed process runner) and the latest version published on npm, from a fixed set of package names.
Nothing is installed or changed here; the answer says whether an update exists and the command that
would apply it, and the person decides.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from dataclasses import dataclass, asdict

from ..environment.pathsec import resolve_executable
from ..environment.procexec import ExecStatus, run_argv

#: worker id -> (binary, npm package). A fixed list: the registry is only ever asked about these.
AGENTS: dict[str, tuple[str, str]] = {
    "opencode": ("opencode", "opencode-ai"),
    "kilo-code": ("kilo", "@kilocode/cli"),
    "claude-code": ("claude", "@anthropic-ai/claude-code"),
    "codex-cli": ("codex", "@openai/codex"),
    "qwen-cli": ("qwen", "@qwen-code/qwen-code"),
    "gemini-cli": ("gemini", "@google/gemini-cli"),
}
NAMES = {"opencode": "OpenCode", "kilo-code": "Kilo Code", "claude-code": "Claude Code",
         "codex-cli": "Codex CLI", "qwen-cli": "Qwen Code", "gemini-cli": "Gemini CLI"}

CACHE_SECONDS = 3600
_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?")
_cache: dict[str, tuple[float, str | None]] = {}
_lock = threading.Lock()


@dataclass(frozen=True)
class AgentVersion:
    id: str
    name: str
    installed: str | None
    latest: str | None
    updateAvailable: bool
    updateCommand: str


def parse_version(text: str) -> str | None:
    found = _VERSION_RE.search(text or "")
    return found.group(0) if found else None


def _key(version: str) -> tuple[int, ...]:
    core = re.split(r"[-+]", version, maxsplit=1)[0]
    return tuple(int(p) for p in core.split("."))


def is_newer(latest: str | None, installed: str | None) -> bool:
    """True when `latest` is a higher release than `installed`. Unknown on either side is not an update."""
    if not latest or not installed:
        return False
    try:
        return _key(latest) > _key(installed)
    except ValueError:
        return False


def installed_version(binary: str) -> str | None:
    path = resolve_executable(binary)
    if not path:
        return None
    out = run_argv([path, "--version"], timeout_ms=15_000)
    if out.status is not ExecStatus.OK:
        return None
    return parse_version(out.stdout) or parse_version(out.stderr)


def latest_version(package: str, fetch=None) -> str | None:
    """The newest published version of `package`, cached for an hour. None when it cannot be read."""
    now = time.time()
    with _lock:
        hit = _cache.get(package)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    url = "https://registry.npmjs.org/" + package.replace("/", "%2F") + "/latest"
    try:
        if fetch is not None:
            body = fetch(url)
        else:
            req = urllib.request.Request(url, headers={"accept": "application/json"})
            with urllib.request.urlopen(req, timeout=8) as res:  # fixed https host, fixed package names
                body = res.read().decode("utf-8", "replace")
        version = parse_version(str(json.loads(body).get("version", "")))
    except Exception:  # noqa: BLE001 — offline or rate-limited: the answer is simply "unknown"
        version = None
    with _lock:
        _cache[package] = (now, version)
    return version


def agent_versions(fetch=None, probe=None) -> list[dict]:
    """One entry per known agent that is installed on this machine."""
    rows: list[dict] = []
    for worker_id, (binary, package) in AGENTS.items():
        installed = (probe or installed_version)(binary)
        if installed is None:
            continue
        latest = latest_version(package, fetch)
        if is_newer(installed, latest):
            latest = None  # the registry's package is not this install's release line, so it says nothing
        rows.append(asdict(AgentVersion(
            id=worker_id, name=NAMES[worker_id], installed=installed, latest=latest,
            updateAvailable=is_newer(latest, installed), updateCommand=f"npm install -g {package}@latest")))
    return rows
