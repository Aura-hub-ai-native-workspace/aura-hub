"""Repository Memory.

A port of packages/ai-service/src/intelligence/repositoryMemory.ts.

Each project owns persistent AI memory about its architecture, patterns,
conventions and key decisions, so the repository is not rediscovered on
every request.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16
from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS
from .identity import _ext_of, _read_dir

_PATTERN_EXTS = (".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java")
_NAMING_EXTS = (".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp")

_P_SINGLETON = js_regex.compile(r"\bSingleton\b|getInstance\s*\(")
_P_FACTORY = js_regex.compile(r"\bFactory\b|create[A-Z]\w+\(")
_P_STRATEGY = js_regex.compile(r"\bStrategy\b|Strategy\s*\{")
_P_OBSERVER = js_regex.compile(r"\bObserver\b|\.on\(|\.emit\(|EventEmitter")
_P_ADAPTER = js_regex.compile(r"\bAdapter\b|Adapter\s*\{")
_P_DECORATOR = js_regex.compile(r"\bDecorator\b|@\w+\s*\n\s*(?:class|function|method)")
# NOTE: tested against the file PATH, not its contents. Reproduced.
_P_MIDDLEWARE = js_regex.compile(r"\bMiddleware\b|middleware", "i")
_P_REPOSITORY = js_regex.compile(r"Repository\b")
_P_SERVICE = js_regex.compile(r"Service\b")
_P_CONTROLLER = js_regex.compile(r"Controller\b")
_P_IFACE_OR_CLASS = js_regex.compile(r"interface|class")

_CAMEL_FILE = js_regex.compile(r"^[a-z][a-zA-Z0-9]*\.[a-z]+$")
_PASCAL_FILE = js_regex.compile(r"^[A-Z][a-zA-Z0-9]*\.[a-z]+$")
_KEBAB_FILE = js_regex.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z]+$")
_SNAKE_FILE = js_regex.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z]+$")
_MD_TITLE = js_regex.compile(r"^#\s+(.+)$", "m")
_MD_SUFFIX = js_regex.compile(r"\.md$")


def detect_design_patterns(root: str) -> list[str]:
    patterns: dict[str, None] = {}

    def scan(directory: str, depth: int) -> None:
        if depth > 4:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan(full, depth + 1)
                continue
            if _ext_of(entry.name) not in _PATTERN_EXTS:
                continue
            try:
                with open(full, "rb") as handle:
                    content = slice_utf16(
                        handle.read().decode("utf-8", errors="replace"), 0, 20000
                    )
            except OSError:
                continue
            if _P_SINGLETON.search(content):
                patterns["Singleton"] = None
            if _P_FACTORY.search(content):
                patterns["Factory"] = None
            if _P_STRATEGY.search(content):
                patterns["Strategy"] = None
            if _P_OBSERVER.search(content):
                patterns["Observer"] = None
            if _P_ADAPTER.search(content):
                patterns["Adapter"] = None
            if _P_DECORATOR.search(content):
                patterns["Decorator"] = None
            if _P_MIDDLEWARE.search(full):
                patterns["Middleware"] = None
            if _P_REPOSITORY.search(content) and _P_IFACE_OR_CLASS.search(content):
                patterns["Repository"] = None
            if _P_SERVICE.search(content) and _P_IFACE_OR_CLASS.search(content):
                patterns["Service"] = None
            if _P_CONTROLLER.search(content) and _P_IFACE_OR_CLASS.search(content):
                patterns["Controller"] = None

    scan(root, 0)
    return list(patterns)


def detect_naming_conventions(root: str) -> list[str]:
    conventions: list[str] = []
    sample_files: list[str] = []

    def collect(directory: str, depth: int) -> None:
        if depth > 3 or len(sample_files) >= 100:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            if entry.is_dir():
                collect(os.path.join(directory, entry.name), depth + 1)
                continue
            if _ext_of(entry.name) in _NAMING_EXTS:
                sample_files.append(entry.name)

    collect(root, 0)
    if not sample_files:
        return conventions

    total = len(sample_files)
    camel = [f for f in sample_files if _CAMEL_FILE.search(f)]
    pascal = [f for f in sample_files if _PASCAL_FILE.search(f)]
    kebab = [f for f in sample_files if _KEBAB_FILE.search(f)]
    snake = [f for f in sample_files if _SNAKE_FILE.search(f)]

    if len(camel) > total * 0.3:
        conventions.append("camelCase file names")
    if len(pascal) > total * 0.3:
        conventions.append("PascalCase file names (components/classes)")
    if len(kebab) > total * 0.3:
        conventions.append("kebab-case file names")
    if len(snake) > total * 0.3:
        conventions.append("snake_case file names")
    return conventions


def detect_module_structure(root: str) -> list[str]:
    structure: list[str] = []
    src_dir = os.path.join(root, "src")
    if os.path.exists(src_dir):
        try:
            for entry in _read_dir(src_dir):
                if (entry.is_dir() and entry.name not in IGNORE_DIRS
                        and not entry.name.startswith(".")):
                    structure.append(entry.name)
        except OSError:
            pass
    return structure[:20]


def analyze_dependencies(root: str) -> list[str]:
    deps: list[str] = []
    pkg_file = os.path.join(root, "package.json")
    if os.path.exists(pkg_file):
        try:
            with open(pkg_file, "rb") as handle:
                pkg = json.loads(handle.read().decode("utf-8", errors="replace"))
            if isinstance(pkg, dict) and isinstance(pkg.get("dependencies"), dict):
                deps.extend(list(pkg["dependencies"])[:20])
        except (OSError, ValueError):
            pass
    return deps


def detect_architecture_style(root: str) -> str:
    structure: set[str] = set()
    try:
        for entry in _read_dir(root):
            if (entry.is_dir() and entry.name not in IGNORE_DIRS
                    and not entry.name.startswith(".")):
                structure.add(entry.name.lower())
    except OSError:
        pass

    if {"packages", "apps", "libs"} & structure:
        return "monorepo"
    if {"plugins", "extensions", "addons"} & structure:
        return "microkernel"
    if {"events", "handlers", "listeners"} & structure:
        return "event-driven"
    if "src" in structure:
        src_dirs: set[str] = set()
        try:
            for entry in _read_dir(os.path.join(root, "src")):
                if entry.is_dir():
                    src_dirs.add(entry.name.lower())
        except OSError:
            pass
        if {"controllers", "services", "repositories"} & src_dirs:
            return "layered"
        if {"routes", "middleware"} & src_dirs:
            return "mvc"
    if {"services", "svc", "microservices"} & structure:
        return "microservices"
    if "modules" in structure and "core" in structure:
        return "plugin"
    if "src" in structure and "packages" not in structure:
        return "monolith"
    return "unknown"


ADR_DIRS = ("docs/adr", "adr", "docs/decisions", "decisions")


def extract_key_decisions(root: str) -> list[str]:
    decisions: list[str] = []
    for rel in ADR_DIRS:
        full = os.path.join(root, *rel.split("/"))
        if not os.path.exists(full):
            continue
        try:
            for entry in _read_dir(full):
                if not entry.name.endswith(".md"):
                    continue
                with open(os.path.join(full, entry.name), "rb") as handle:
                    content = slice_utf16(
                        handle.read().decode("utf-8", errors="replace"), 0, 500
                    )
                match = _MD_TITLE.search(content)
                title = (match.group(1) if match and match.group(1)
                         else _MD_SUFFIX.sub("", entry.name, count=1))
                decisions.append(title)
        except OSError:
            pass
    return decisions[:10]


def build_repository_profile(
    home: Path, project_id: str, root: str, now: str
) -> dict[str, Any]:
    profile = {
        "architectureStyle": detect_architecture_style(root),
        "designPatterns": detect_design_patterns(root),
        "namingConventions": detect_naming_conventions(root),
        "moduleStructure": detect_module_structure(root),
        "dependencies": analyze_dependencies(root),
        "keyDecisions": extract_key_decisions(root),
        "generatedAt": now,
    }
    atomic_write_json(home / "repo-profile" / f"{project_id}.json", profile)
    return profile
