"""Architecture Validation.

A port of packages/ai-service/src/intelligence/validation.ts.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from typing import Any

from ..core import js_regex
from ..core.node_path import rel_path as node_rel
from .constants import IGNORE_DIRS
from .health_engine import _round
from .identity import _ext_of, _read_dir

_LOCAL_IMPORT = js_regex.compile(r"(?:import|from)\s+.*?['\"](\.[^'\"]+)['\"]", "g")

ENTRY_FILES = ("index.ts", "index.js", "main.ts", "main.py", "app.py", "server.ts")


def _read_text(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def check_circular_dependencies(root: str) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    import_map: dict[str, list[str]] = {}

    def scan_file(file_path: str) -> None:
        rel_path = node_rel(file_path, root)
        imports: dict[str, None] = {}
        content = _read_text(file_path)
        if content is None:
            return
        for match in _LOCAL_IMPORT.finditer(content):
            resolved = os.path.normpath(
                os.path.join(os.path.dirname(file_path), match.group(1))
            )
            imports[node_rel(resolved, root)] = None
        import_map[rel_path] = list(imports)

    def scan_dir(directory: str) -> None:
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan_dir(full)
            elif _ext_of(entry.name) in (".ts", ".js"):
                scan_file(full)

    scan_dir(root)

    visited: set[str] = set()
    in_stack: set[str] = set()

    def has_cycle(node: str) -> bool:
        # `inStack` is deliberately NOT unwound on the `return true` path,
        # exactly as in the reference — the state persists into the next
        # top-level call and can change what the next node reports.
        if node in in_stack:
            return True
        if node in visited:
            return False
        visited.add(node)
        in_stack.add(node)
        for imported in import_map.get(node, []):
            if has_cycle(imported):
                return True
        in_stack.discard(node)
        return False

    # Node's stack is far deeper than Python's default 1000 frames, and a
    # real import chain can exceed it. Raised for this traversal only.
    previous = sys.getrecursionlimit()
    sys.setrecursionlimit(max(previous, 20000))
    try:
        for node in list(import_map):
            if has_cycle(node):
                violations.append({
                    "rule": "no-circular-deps", "severity": "error",
                    "message": f"Circular dependency detected involving {node}",
                    "file": node,
                })
                break  # Report first cycle found
    finally:
        sys.setrecursionlimit(previous)

    return violations


def check_entry_point_exists(root: str) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    has_entry = any(
        os.path.exists(os.path.join(root, f)) or os.path.exists(os.path.join(root, "src", f))
        for f in ENTRY_FILES
    )
    if has_entry:
        return violations

    pkg_path = os.path.join(root, "package.json")
    if os.path.exists(pkg_path):
        text = _read_text(pkg_path)
        try:
            pkg = json.loads(text) if text is not None else None
        except ValueError:
            violations.append({"rule": "entry-point-exists", "severity": "error",
                               "message": "Cannot read package.json"})
            return violations
        if isinstance(pkg, dict) and not pkg.get("main") and not pkg.get("bin") or not isinstance(pkg, dict):
            violations.append({
                "rule": "entry-point-exists", "severity": "error",
                "message": "No entry point found in package.json or file system",
            })
    else:
        violations.append({"rule": "entry-point-exists", "severity": "error",
                           "message": "No entry point file found"})
    return violations


def check_readme_exists(root: str) -> list[dict[str, Any]]:
    has_readme = any(os.path.exists(os.path.join(root, f))
                     for f in ("README.md", "readme.md", "README"))
    if has_readme:
        return []
    return [{"rule": "readme-exists", "severity": "warning",
             "message": "No README file found"}]


def check_source_structure(root: str) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    if any(os.path.exists(os.path.join(root, d)) for d in ("src", "lib", "app")):
        return violations
    # No try/catch in the reference: an unreadable root propagates.
    root_files = [e.name for e in _read_dir(root)
                  if _ext_of(e.name) in (".ts", ".js", ".py", ".go")]
    if len(root_files) > 5:
        violations.append({
            "rule": "src-directory-structure", "severity": "info",
            "message": "Consider organizing source files in src/ directory",
        })
    return violations


def check_test_coverage(root: str) -> list[dict[str, Any]]:
    test_files = 0

    def scan_dir(directory: str) -> None:
        nonlocal test_files
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan_dir(full)
            elif (".test." in entry.name or ".spec." in entry.name
                  or "_test." in entry.name):
                test_files += 1

    scan_dir(root)
    if test_files == 0:
        return [{"rule": "test-coverage", "severity": "warning",
                 "message": "No test files found"}]
    return []


def check_dependency_direction(root: str) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    utils_dir = os.path.join(root, "utils")
    app_dir = os.path.join(root, "app")

    if not (os.path.exists(utils_dir) and os.path.exists(app_dir)):
        return violations

    def scan_dir(directory: str) -> bool:
        try:
            entries = _read_dir(directory)
        except OSError:
            return False
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                if scan_dir(full):
                    return True
            else:
                content = _read_text(full)
                if content is None:
                    continue
                if "from '../app'" in content or 'from "../app"' in content:
                    return True
        return False

    if scan_dir(utils_dir):
        violations.append({"rule": "dependency-direction", "severity": "warning",
                           "message": "utils/ should not import from app/"})
    return violations


DEFAULT_RULES: list[dict[str, Any]] = [
    {"id": "no-circular-deps", "name": "No Circular Dependencies",
     "description": "Modules should not have circular dependencies",
     "severity": "error", "check": check_circular_dependencies},
    {"id": "entry-point-exists", "name": "Entry Point Exists",
     "description": "Project should have a clear entry point",
     "severity": "error", "check": check_entry_point_exists},
    {"id": "readme-exists", "name": "README Exists",
     "description": "Project should have a README file",
     "severity": "warning", "check": check_readme_exists},
    {"id": "src-directory-structure", "name": "Source Directory Structure",
     "description": "Source code should be organized in src/ or similar",
     "severity": "info", "check": check_source_structure},
    {"id": "test-coverage", "name": "Test Coverage",
     "description": "Project should have test files",
     "severity": "warning", "check": check_test_coverage},
    {"id": "dependency-direction", "name": "Dependency Direction",
     "description": "Dependencies should flow downward (core → utils)",
     "severity": "warning", "check": check_dependency_direction},
]


def validate_architecture(
    root: str, identity: dict[str, Any] | None, profile: dict[str, Any] | None,
    rules: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    rules = rules if rules is not None else DEFAULT_RULES
    violations: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    passed_rules: list[str] = []

    for rule in rules:
        check: Callable[[str], list[dict[str, Any]]] = rule["check"]
        rule_violations = check(root)
        if not rule_violations:
            passed_rules.append(rule["id"])
            continue
        for violation in rule_violations:
            if violation["severity"] == "error":
                violations.append(violation)
            else:
                warnings.append({
                    "rule": violation["rule"], "message": violation["message"],
                    "suggestion": f"Fix: {violation['message']}",
                })

    return {
        "valid": not violations,
        "score": _round((len(passed_rules) / len(rules)) * 100),
        "violations": violations,
        "warnings": warnings,
        "passedRules": passed_rules,
    }
