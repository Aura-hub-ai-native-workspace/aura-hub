"""Project environment inspection — what THIS project needs.

Separate from global machine capabilities ON PURPOSE: the machine
answers "what can run here", the project answers "what this needs".
The planner joins them ("node project + node measured → npm test is
routable") without either side claiming the other's job.

Inspection is pure bounded READS of well-known marker files. It never
executes project commands, never installs anything, and never trusts
file contents as instructions — a package.json script is DATA naming
a command AURA may later route through the governed Fabric; writing
it into a prompt does not authorise running it.
"""

from __future__ import annotations

import json
import os

from ..contracts._base import ContractModel

#: One file read may cost at most this. Marker files are small; anything
#: bigger is not a marker and is skipped rather than parsed.
_MAX_FILE_BYTES = 64 * 1024
#: Never read more marker files than this per project.
_MAX_FILES = 12


class ProjectCapabilities(ContractModel):
    """What a project declares about its own environment."""

    root: str = ""
    ecosystems: list[str] = []
    package_manager: str | None = None
    #: Commands read verbatim from project files (UNEXECUTED data).
    scripts: dict[str, str] = {}
    runtimes_required: list[str] = []
    containers: list[str] = []
    vcs: str | None = None
    ci: list[str] = []
    notes: list[str] = []


def _read_text(path: str) -> str | None:
    try:
        if os.path.getsize(path) > _MAX_FILE_BYTES:
            return None
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def _read_json(path: str) -> dict | None:
    text = _read_text(path)
    if not text:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def inspect_project_environment(root: str) -> ProjectCapabilities:
    """Read a project's environment markers. Never raises; an unreadable
    project yields an empty report, never an error that breaks planning."""
    caps = ProjectCapabilities(root=root or "")
    try:
        if not root or not os.path.isdir(root):
            return caps
        return _inspect(root, caps)
    except Exception:
        return caps


def _join(root: str, *parts: str) -> str:
    return os.path.join(root, *parts)


def _inspect(root: str, caps: ProjectCapabilities) -> ProjectCapabilities:
    read = 0

    def load(name: str) -> dict | None:
        nonlocal read
        if read >= _MAX_FILES:
            return None
        read += 1
        return _read_json(_join(root, name))

    pkg = load("package.json")
    if pkg is not None:
        caps.ecosystems.append("node")
        for lock, manager in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"),
                              ("bun.lockb", "bun"), ("package-lock.json", "npm")):
            if os.path.exists(_join(root, lock)):
                caps.package_manager = manager
                break
        if caps.package_manager is None:
            caps.package_manager = "npm"
        scripts = pkg.get("scripts")
        if isinstance(scripts, dict):
            for key in ("test", "build", "lint", "start"):
                value = scripts.get(key)
                if isinstance(value, str) and value.strip():
                    caps.scripts[key] = value.strip()[:200]
        if any(os.path.exists(_join(root, f)) for f in
               ("playwright.config.ts", "playwright.config.js",
                "playwright.config.mjs")):
            caps.notes.append("playwright-config")
        caps.runtimes_required.append("node")

    if os.path.exists(_join(root, "pyproject.toml")) or os.path.exists(
            _join(root, "requirements.txt")) or os.path.exists(_join(root, "setup.py")):
        caps.ecosystems.append("python")
        caps.runtimes_required.append("python")
        for marker in ("pytest.ini", "tox.ini", "tests"):
            if os.path.exists(_join(root, marker)):
                caps.notes.append(f"python-test-marker:{marker}")
                break

    if os.path.exists(_join(root, "Cargo.toml")):
        caps.ecosystems.append("rust")
        caps.runtimes_required.append("cargo")

    if os.path.exists(_join(root, "go.mod")):
        caps.ecosystems.append("go")
        caps.runtimes_required.append("go")

    if os.path.exists(_join(root, "Makefile")):
        caps.notes.append("makefile")

    if os.path.exists(_join(root, "Dockerfile")):
        caps.containers.append("dockerfile")
    if os.path.exists(_join(root, "docker-compose.yml")) or os.path.exists(
            _join(root, "docker-compose.yaml")):
        caps.containers.append("compose")

    if os.path.exists(_join(root, ".git")):
        caps.vcs = "git"

    for ci in (".github", ".gitlab-ci.yml", "Jenkinsfile", ".circleci"):
        if os.path.exists(_join(root, ci)):
            caps.ci.append(ci)

    def _dedup(items: list[str]) -> list[str]:
        seen: list[str] = []
        for item in items:
            if item not in seen:
                seen.append(item)
        return seen

    caps.ecosystems = _dedup(caps.ecosystems)
    caps.runtimes_required = _dedup(caps.runtimes_required)
    caps.containers = _dedup(caps.containers)
    caps.ci = _dedup(caps.ci)
    caps.notes = _dedup(caps.notes)[:20]
    return caps


def project_summary(caps: ProjectCapabilities, max_chars: int = 600) -> str | None:
    """One bounded line for planning prompts. None when the project
    declares nothing — silence, not a guess."""
    bits: list[str] = []
    if caps.ecosystems:
        bits.append("ecosystem: " + "/".join(caps.ecosystems))
    if caps.package_manager:
        bits.append("manager: " + caps.package_manager)
    for key in ("test", "build", "lint"):
        if key in caps.scripts:
            bits.append(f"{key}: {caps.scripts[key]}")
    if caps.containers:
        bits.append("containers: " + ",".join(caps.containers))
    if caps.vcs:
        bits.append("vcs: " + caps.vcs)
    if not bits:
        return None
    text = "project needs [" + "; ".join(bits) + "] (commands read from files, not executed)"
    return text[:max_chars]
