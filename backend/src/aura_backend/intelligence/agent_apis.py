"""Agent Foundation APIs.

A port of packages/ai-service/src/intelligence/agentApis.ts.

**Security note, preserved rather than fixed.** Every function here
guards path traversal with a bare prefix test:

    if (!fullPath.startsWith(root)) return null;

A sibling directory whose path merely SHARES A PREFIX with the root — say
`/w/project-sibling` against a root of `/w/project` — passes that test.
The check is reproduced exactly, because changing it would change what
the two backends return for the same call, and the difference is recorded
in the phase document instead. These functions are not reachable from the
HTTP surface: only `getProjectInfo` and `getDirectoryTree` are called,
by `runProjectIntelligence`, with the project's own registered root.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

from ..core import js_regex
from ..core.node_path import rel_path as node_rel
from ..core.node_time import date_ms_from_stat
from .constants import IGNORE_DIRS, LANG_BY_EXT
from .identity import _ext_of, _read_dir


def _iso_from_stat(stat: os.stat_result) -> str:
    """`stat.mtime.toISOString()`.

    Node's `stat.mtime` carries an INTEGER millisecond, rounded HALF UP
    from `mtimeMs` — not truncated, and not to even. `core.node_time`
    owns that conversion; going through `st_mtime` (a lossy float in
    seconds) lands a millisecond away often enough to show up.
    """
    millis = date_ms_from_stat(stat)
    moment = datetime.fromtimestamp(millis / 1000, tz=UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis % 1000:03d}Z"


def _read_text(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def read_file(root: str, file_path: str) -> dict[str, Any] | None:
    full_path = os.path.abspath(os.path.join(root, file_path))
    if not full_path.startswith(root):
        return None
    try:
        with open(full_path, "rb") as handle:
            content = handle.read().decode("utf-8", errors="replace")
        stat = os.stat(full_path)
    except OSError:
        return None
    return {
        "path": node_rel(full_path, root),
        "content": content,
        "language": LANG_BY_EXT.get(_ext_of(os.path.basename(full_path)), "unknown"),
        "size": stat.st_size,
        "lastModified": _iso_from_stat(stat),
    }


def search_code(
    root: str, pattern: str, max_results: int = 50,
    file_pattern: str | None = None, case_sensitive: bool = False,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    regex = js_regex.compile(pattern, "g" if case_sensitive else "gi")
    file_regex = js_regex.compile(file_pattern) if file_pattern else None

    def scan_file(file_path: str) -> None:
        if len(results) >= max_results:
            return
        content = _read_text(file_path)
        if content is None:
            return
        lines = content.split("\n")
        rel_path = node_rel(file_path, root)
        for index, line in enumerate(lines):
            if len(results) >= max_results:
                break
            if regex.search(line):
                start = max(0, index - 2)
                end = min(len(lines), index + 3)
                results.append({
                    "file": rel_path, "line": index + 1, "content": line.strip(),
                    "context": "\n".join(lines[start:end]),
                })

    def scan_dir(directory: str) -> None:
        if len(results) >= max_results:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if len(results) >= max_results:
                break
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan_dir(full)
                continue
            if file_regex is not None and not file_regex.search(entry.name):
                continue
            if LANG_BY_EXT.get(_ext_of(entry.name)):
                scan_file(full)

    scan_dir(root)
    return results


def get_project_info(context: dict[str, Any]) -> dict[str, Any]:
    identity = context.get("identity")
    summary = context.get("summary")
    return {
        "name": (identity or {}).get("name") or os.path.basename(context["root"]),
        "description": (
            (identity or {}).get("purpose")
            or (identity or {}).get("description")
            or ""
        ),
        "language": (identity or {}).get("primaryLanguage") or "unknown",
        "frameworks": (identity or {}).get("frameworks") or [],
        "entryPoints": (identity or {}).get("entryPoints") or [],
        "modules": [m["name"] for m in ((summary or {}).get("modules") or [])],
    }


def list_files(
    root: str, dir_path: str = ".", recursive: bool = False,
    max_depth: int = 3, file_pattern: str | None = None,
) -> list[str]:
    files: list[str] = []
    full_path = os.path.abspath(os.path.join(root, dir_path))
    if not full_path.startswith(root):
        return []
    file_regex = js_regex.compile(file_pattern) if file_pattern else None

    def scan_dir(directory: str, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            rel_path = node_rel(full, root)
            if entry.is_dir():
                files.append(f"{rel_path}/")
                if recursive:
                    scan_dir(full, depth + 1)
                continue
            if file_regex is not None and not file_regex.search(entry.name):
                continue
            files.append(rel_path)

    scan_dir(full_path, 0)
    return files


def get_directory_tree(
    root: str, dir_path: str = ".", max_depth: int = 3
) -> dict[str, Any]:
    full_path = os.path.abspath(os.path.join(root, dir_path))
    if not full_path.startswith(root):
        return {}

    def scan_dir(directory: str, depth: int) -> dict[str, Any]:
        if depth > max_depth:
            return {}
        result: dict[str, Any] = {}
        try:
            entries = _read_dir(directory)
        except OSError:
            return {}
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                result[f"{entry.name}/"] = scan_dir(full, depth + 1)
            else:
                result[entry.name] = None
        return result

    return scan_dir(full_path, 0)


def file_exists(root: str, file_path: str) -> bool:
    full_path = os.path.abspath(os.path.join(root, file_path))
    if not full_path.startswith(root):
        return False
    return os.path.exists(full_path)


def get_file_info(root: str, file_path: str) -> dict[str, Any]:
    full_path = os.path.abspath(os.path.join(root, file_path))
    if not full_path.startswith(root):
        return {"exists": False}
    try:
        stat = os.stat(full_path)
    except OSError:
        return {"exists": False}
    return {
        "exists": True,
        "size": stat.st_size,
        "lastModified": _iso_from_stat(stat),
        "isDirectory": os.path.isdir(full_path),
    }
