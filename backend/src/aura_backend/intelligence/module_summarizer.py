"""Module Summarizer.

A port of packages/ai-service/src/intelligence/moduleSummarizer.ts.

Summaries are derived from real file contents — nothing is invented.
"""

from __future__ import annotations

import functools
import os
from pathlib import Path
from typing import Any

from ..core import js_regex
from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS, LANG_BY_EXT
from .identity import _ext_of, _read_dir

_KEYFILE = js_regex.compile(r"index|main|mod|lib|core", "i")
_EXPORTS = js_regex.compile(
    r"export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)", "g"
)
_EXPORT_PREFIX = js_regex.compile(r"export\s+(?:async\s+)?(?:function|class|const|let|var)\s+")
_CLASSES = js_regex.compile(r"class\s+(\w+)", "g")
_CLASS_PREFIX = js_regex.compile(r"class\s+")


def _read_text(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def extract_capabilities(abs_path: str, files: list[str]) -> list[str]:
    capabilities: dict[str, None] = {}
    samples = 0

    for name in files[:10]:
        if samples >= 50:
            break
        content = _read_text(os.path.join(abs_path, name))
        if content is None:
            continue
        if len(content) > 100000:
            content = content[:100000]
        samples += 1

        exports = [m.group(0) for m in _EXPORTS.finditer(content)]
        for raw in exports[:10]:
            name_only = _EXPORT_PREFIX.sub("", raw, count=1)
            if 2 < len(name_only) < 40:
                capabilities[name_only] = None

        classes = [m.group(0) for m in _CLASSES.finditer(content)]
        for raw in classes[:5]:
            name_only = _CLASS_PREFIX.sub("", raw, count=1)
            if 2 < len(name_only) < 40:
                capabilities[name_only] = None

    return list(capabilities)[:15]


def build_module_description(
    name: str, capabilities: list[str], file_count: int, language: str
) -> str:
    parts = [f"{name} module ({language}, {file_count} files)"]
    if capabilities:
        parts.append(f"Key components: {', '.join(capabilities[:6])}")
    return ". ".join(parts)


def _size_of(path: str) -> int:
    try:
        return os.stat(path).st_size
    except OSError:
        return 0


def summarize_module(root: str, module_path: str, module_name: str) -> dict[str, Any] | None:
    abs_path = os.path.join(root, module_path)
    if not os.path.exists(abs_path):
        return None
    try:
        entries = _read_dir(abs_path)
    except OSError:
        return None

    files: list[str] = []
    sub_dirs: list[str] = []
    lang_counts: dict[str, int] = {}

    for entry in entries:
        if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
            continue
        if entry.is_dir():
            sub_dirs.append(entry.name)
            continue
        ext = _ext_of(entry.name)
        language = LANG_BY_EXT.get(ext)
        if language:
            files.append(entry.name)
            lang_counts[language] = lang_counts.get(language, 0) + 1

    if not files and not sub_dirs:
        return None

    ordered = sorted(lang_counts.items(), key=lambda kv: -kv[1])
    primary_lang = ordered[0][0] if ordered else "unknown"

    capabilities = extract_capabilities(abs_path, files)

    # The reference's key-file filter SORTS `files` IN PLACE from inside
    # the filter callback:
    #
    #   files.filter(f => /index|.../i.test(f) || f === files.sort(...)[0])
    #
    # `Array.prototype.filter` captures the length once and re-reads
    # `files[i]` on every step, so each sort reorders what the remaining
    # steps see. Reproduced literally, because the output depends on it.
    def _by_size_desc(a: str, b: str) -> int:
        return _size_of(os.path.join(abs_path, b)) - _size_of(os.path.join(abs_path, a))

    key_files: list[str] = []
    length = len(files)
    for i in range(length):
        if i >= len(files):
            break
        candidate = files[i]
        if _KEYFILE.search(candidate):
            key_files.append(candidate)
            continue
        files.sort(key=functools.cmp_to_key(_by_size_desc))
        if candidate == files[0]:
            key_files.append(candidate)
    key_files = key_files[:5]

    return {
        "name": module_name,
        "path": module_path,
        "description": build_module_description(
            module_name, capabilities, len(files), primary_lang
        ),
        "capabilities": capabilities,
        "fileCount": len(files),
        "primaryLanguage": primary_lang,
        "keyFiles": key_files,
        "dependencies": [],
        "childModules": sub_dirs,
    }


def generate_repository_summary(
    home: Path, project_id: str, root: str, now: str,
    identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    modules: list[dict[str, Any]] = []

    try:
        entries = _read_dir(root)
    except OSError:
        entries = []

    for entry in entries:
        if (not entry.is_dir() or entry.name.startswith(".")
                or entry.name in IGNORE_DIRS):
            continue
        summary = summarize_module(root, entry.name, entry.name)
        if summary:
            modules.append(summary)

    src_dir = os.path.join(root, "src")
    if os.path.exists(src_dir):
        try:
            for entry in _read_dir(src_dir):
                if (not entry.is_dir() or entry.name.startswith(".")
                        or entry.name in IGNORE_DIRS):
                    continue
                summary = summarize_module(root, f"src/{entry.name}", entry.name)
                if summary and not any(m["name"] == entry.name for m in modules):
                    modules.append(summary)
        except OSError:
            pass

    total_files = 0
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            dir_entries = _read_dir(directory)
        except OSError:
            continue
        for entry in dir_entries:
            if entry.is_dir():
                if entry.name not in IGNORE_DIRS and not entry.name.startswith("."):
                    stack.append(os.path.join(directory, entry.name))
            else:
                total_files += 1

    summary = {
        "projectName": (identity or {}).get("name") or os.path.basename(root),
        "purpose": (identity or {}).get("purpose", "") if identity else "",
        "modules": modules,
        "totalFiles": total_files,
        "generatedAt": now,
    }
    atomic_write_json(home / "summaries" / f"{project_id}.json", summary)
    return summary
