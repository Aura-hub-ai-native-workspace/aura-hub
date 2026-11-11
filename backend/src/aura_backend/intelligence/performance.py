"""Performance Engine.

A port of packages/ai-service/src/intelligence/performance.ts.

Incremental indexing state: which source files changed since the last
run, tracked by mtime. The index state is WORKSPACE-WIDE — the reference
computes its path once at module load, so it is shared by every project.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json, read_json
from ..core.node_path import rel_path as node_rel
from ..core.node_time import stat_mtime_ms
from .constants import IGNORE_DIRS
from .identity import _ext_of, _read_dir

INDEX_EXTS = (".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
              ".c", ".cpp", ".h", ".md", ".json")


def _file(home: Path) -> Path:
    return home / "index-state" / "file-mtimes.json"


def load_index_state(home: Path) -> dict[str, float]:
    state = read_json(_file(home), {})
    return state if isinstance(state, dict) else {}


def save_index_state(home: Path, state: dict[str, float]) -> None:
    atomic_write_json(_file(home), state)


def scan_files_with_mtime(root: str, max_files: int = 10000) -> dict[str, float]:
    files: dict[str, float] = {}
    stack = [root]

    while stack and len(files) < max_files:
        directory = stack.pop()
        try:
            entries = _read_dir(directory)
        except OSError:
            continue
        for entry in entries:
            if len(files) >= max_files:
                break
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                stack.append(full)
                continue
            if _ext_of(entry.name) not in INDEX_EXTS:
                continue
            try:
                files[node_rel(full, root)] = stat_mtime_ms(os.stat(full))
            except OSError:
                pass
    return files


def detect_changes(home: Path, root: str) -> dict[str, Any]:
    start = time.perf_counter()
    stored = load_index_state(home)
    current = scan_files_with_mtime(root)

    changed: list[str] = []
    added: list[str] = []
    unchanged: list[str] = []
    removed: list[str] = []

    for file, mtime in current.items():
        stored_mtime = stored.get(file)
        if stored_mtime is None:
            added.append(file)
        elif stored_mtime < mtime:
            changed.append(file)
        else:
            unchanged.append(file)

    removed.extend(f for f in stored if f not in current)

    return {
        "changed": changed, "unchanged": unchanged, "added": added,
        "removed": removed, "totalIndexed": len(current),
        "durationMs": round((time.perf_counter() - start) * 1000),
    }


def update_index_state(home: Path, root: str) -> None:
    save_index_state(home, dict(scan_files_with_mtime(root)))


def has_changes(home: Path, root: str) -> bool:
    stored = load_index_state(home)
    current = scan_files_with_mtime(root, 1000)

    if len(stored) != len(current):
        return True

    # `checked++ > 100` tests the OLD value, so the loop stops on the
    # 102nd file rather than the 101st.
    for checked, (file, mtime) in enumerate(current.items()):
        if checked > 100:
            break
        if stored.get(file) != mtime:
            return True
    return False


class LazyFileLoader:
    """On-demand file loading with a bounded, insertion-ordered cache."""

    def __init__(self, root: str, max_cache_size: int = 1000) -> None:
        self._cache: dict[str, str] = {}
        self._root = root
        self._max_cache_size = max_cache_size

    def load(self, relative_path: str) -> str | None:
        cached = self._cache.get(relative_path)
        if cached is not None:
            return cached
        full_path = os.path.join(self._root, relative_path)
        try:
            with open(full_path, "rb") as handle:
                content = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return None
        self._cache[relative_path] = content
        if len(self._cache) > self._max_cache_size:
            # A JavaScript `Map` evicts its FIRST inserted key; a Python
            # dict preserves the same order.
            first = next(iter(self._cache))
            del self._cache[first]
        return content

    def load_many(self, relative_paths: list[str]) -> dict[str, str | None]:
        return {p: self.load(p) for p in relative_paths}

    def clear(self) -> None:
        self._cache.clear()

    def stats(self) -> dict[str, int]:
        return {"size": len(self._cache), "max_size": self._max_cache_size}
