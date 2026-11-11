"""Architecture Explorer.

A port of packages/ai-service/src/intelligence/architecture.ts.

Module hierarchy, dependency flow, entry points, API surface and code
navigation — all derived from real files, no AST library.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ..core import js_regex
from ..core.node_path import rel_path as node_rel
from .constants import IGNORE_DIRS, LANG_BY_EXT
from .identity import _ext_of, _read_dir

_IMPORT = js_regex.compile(r"(?:import|from|require)\s+.*?['\"](.+?)['\"]", "g")
_FUNC = js_regex.compile(r"export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)", "g")
_CLASS = js_regex.compile(r"export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{", "g")
_METHOD = js_regex.compile(r"(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{", "g")
_ROUTE = js_regex.compile(
    r"(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*['\"]([^'\"]+)['\"]", "g"
)

COMMON_ENTRIES = [
    {"file": "index.ts", "type": "main", "description": "TypeScript entry"},
    {"file": "index.js", "type": "main", "description": "JavaScript entry"},
    {"file": "main.ts", "type": "main", "description": "Main TypeScript"},
    {"file": "main.py", "type": "main", "description": "Python entry"},
    {"file": "app.py", "type": "server", "description": "Python app"},
    {"file": "server.ts", "type": "server", "description": "Server entry"},
    {"file": "worker.ts", "type": "worker", "description": "Worker entry"},
]

API_EXTS = (".ts", ".js", ".py", ".go", ".java")


def _read_text(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def build_module_hierarchy(root: str, max_depth: int = 5) -> dict[str, Any]:
    return _build_node(root, root, "directory", 0, max_depth)


def _build_node(
    root: str, full_path: str, node_type: str, depth: int, max_depth: int
) -> dict[str, Any]:
    node: dict[str, Any] = {
        "name": os.path.basename(full_path),
        "path": node_rel(full_path, root),
        "type": node_type,
        "children": [],
    }
    if node_type != "directory" or depth >= max_depth:
        return node
    try:
        entries = _read_dir(full_path)
    except OSError:
        return node
    for entry in entries:
        if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
            continue
        child_path = os.path.join(full_path, entry.name)
        child_type = "directory" if entry.is_dir() else "file"
        node["children"].append(
            _build_node(root, child_path, child_type, depth + 1, max_depth)
        )
    return node


def detect_entry_points(root: str, _identity: dict[str, Any] | None) -> list[dict[str, Any]]:
    entry_points: list[dict[str, Any]] = []

    pkg_path = os.path.join(root, "package.json")
    if os.path.exists(pkg_path):
        text = _read_text(pkg_path)
        try:
            pkg = json.loads(text) if text is not None else None
        except ValueError:
            pkg = None
        if isinstance(pkg, dict):
            if pkg.get("main"):
                entry_points.append({"file": pkg["main"], "type": "main",
                                     "description": "Main entry point"})
            if pkg.get("bin"):
                binary = pkg["bin"]
                bins = {"cli": binary} if isinstance(binary, str) else binary
                if isinstance(bins, dict):
                    for name, file in bins.items():
                        entry_points.append({"file": file, "type": "cli",
                                             "description": f"CLI command: {name}"})
            scripts = pkg.get("scripts")
            if isinstance(scripts, dict) and scripts.get("start"):
                entry_points.append({"file": scripts["start"], "type": "server",
                                     "description": "Start script"})

    for entry in COMMON_ENTRIES:
        if os.path.exists(os.path.join(root, entry["file"])):
            entry_points.append(dict(entry))

    src_dir = os.path.join(root, "src")
    if os.path.exists(src_dir):
        for entry in COMMON_ENTRIES:
            if os.path.exists(os.path.join(src_dir, entry["file"])):
                entry_points.append({**entry, "file": f"src/{entry['file']}"})

    return entry_points


def build_dependency_graph(root: str) -> dict[str, Any]:
    nodes: list[dict[str, str]] = []
    edges: list[dict[str, str]] = []
    processed: set[str] = set()

    def scan_file(file_path: str) -> None:
        if file_path in processed:
            return
        processed.add(file_path)
        rel_path = node_rel(file_path, root)
        nodes.append({"id": rel_path, "label": os.path.basename(file_path), "type": "file"})

        content = _read_text(file_path)
        if content is None:
            return

        for match in _IMPORT.finditer(content):
            import_path = match.group(1)
            if import_path.startswith("."):
                resolved = os.path.normpath(
                    os.path.join(os.path.dirname(file_path), import_path)
                )
                edges.append({"source": rel_path,
                              "target": node_rel(resolved, root),
                              "type": "local"})
            else:
                # The reference's second branch is
                # `startsWith('@') || !startsWith('.')`, which is always
                # true here since the first branch already took the dots.
                pkg_name = ("/".join(import_path.split("/")[:2])
                            if import_path.startswith("@")
                            else import_path.split("/")[0])
                edges.append({"source": rel_path, "target": pkg_name, "type": "external"})

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
            elif LANG_BY_EXT.get(_ext_of(entry.name)):
                scan_file(full)

    scan_dir(root)
    return {"nodes": nodes, "edges": edges}


def map_api_surface(root: str) -> dict[str, Any]:
    endpoints: list[dict[str, Any]] = []
    classes: list[dict[str, Any]] = []
    functions: list[dict[str, Any]] = []

    def scan_file(file_path: str) -> None:
        content = _read_text(file_path)
        if content is None:
            return
        rel_path = node_rel(file_path, root)

        for match in _FUNC.finditer(content):
            functions.append({
                "name": match.group(1),
                "file": rel_path,
                "parameters": [p.strip() for p in match.group(2).split(",") if p.strip()],
                "exported": True,
            })

        for match in _CLASS.finditer(content):
            class_name = match.group(1)
            # The method scan re-runs over the WHOLE file for every
            # exported class, so a file with two classes lists the same
            # methods twice. Reproduced.
            methods = [
                m.group(1) for m in _METHOD.finditer(content)
                if m.group(1) not in ("constructor", class_name)
            ]
            entry: dict[str, Any] = {"name": class_name, "file": rel_path,
                                     "methods": methods}
            # `extends: match[2]` is `undefined` with no `extends` clause,
            # and `JSON.stringify` drops the key entirely.
            if match.group(2) is not None:
                entry["extends"] = match.group(2)
            classes.append(entry)

        for match in _ROUTE.finditer(content):
            endpoints.append({"method": match.group(1).upper(),
                              "path": match.group(2), "file": rel_path})

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
            elif _ext_of(entry.name) in API_EXTS:
                scan_file(full)

    scan_dir(root)
    return {"endpoints": endpoints, "classes": classes, "functions": functions}


def find_usages(root: str, symbol_name: str) -> list[dict[str, Any]]:
    usages: list[dict[str, Any]] = []

    def scan_file(file_path: str) -> None:
        content = _read_text(file_path)
        if content is None:
            return
        lines = content.split("\n")
        rel_path = node_rel(file_path, root)
        for index, line in enumerate(lines):
            if symbol_name in line:
                usages.append({"file": rel_path, "line": index + 1,
                               "context": line.strip()})

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
            elif LANG_BY_EXT.get(_ext_of(entry.name)):
                scan_file(full)

    scan_dir(root)
    return usages
