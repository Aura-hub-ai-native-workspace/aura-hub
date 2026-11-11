"""Document Priority Engine.

A port of packages/ai-service/src/intelligence/documentPriority.ts.

Ranks documentation and source files by relevance to the user's intent —
documentation outranks implementation for overview questions.
"""

from __future__ import annotations

import functools
import os
from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16
from .identity import _ext_of, _read_dir

INTENT_DOC_PRIORITIES: dict[str, dict[str, int]] = {
    "project_overview": {"readme": 1, "project": 2, "vision": 3, "architecture": 4,
                         "design": 5, "module_summary": 6, "graph": 7, "source": 9,
                         "config": 8, "test": 10},
    "architecture": {"architecture": 1, "design": 2, "readme": 3, "module_summary": 4,
                     "graph": 5, "source": 7, "project": 6, "config": 8, "test": 10,
                     "vision": 9},
    "module_explanation": {"module_summary": 1, "source": 2, "architecture": 3,
                           "graph": 4, "readme": 6, "design": 5, "config": 7,
                           "test": 8, "project": 9, "vision": 10},
    "function_explanation": {"source": 1, "module_summary": 2, "graph": 3,
                             "architecture": 4, "readme": 6, "design": 5, "config": 8,
                             "test": 7, "project": 9, "vision": 10},
    "bug_fix": {"source": 1, "test": 2, "module_summary": 3, "graph": 4,
                "architecture": 5, "readme": 7, "design": 6, "config": 8,
                "project": 9, "vision": 10},
    "debugging": {"source": 1, "graph": 2, "module_summary": 3, "architecture": 4,
                  "test": 5, "readme": 7, "design": 6, "config": 8, "project": 9,
                  "vision": 10},
    "refactoring": {"source": 1, "architecture": 2, "module_summary": 3, "design": 4,
                    "graph": 5, "readme": 7, "test": 6, "config": 8, "project": 9,
                    "vision": 10},
    "code_search": {"source": 1, "module_summary": 3, "graph": 4, "readme": 7,
                    "architecture": 5, "design": 6, "config": 8, "test": 2,
                    "project": 9, "vision": 10},
    "api_reference": {"source": 1, "module_summary": 2, "readme": 3, "architecture": 4,
                      "graph": 5, "design": 6, "config": 7, "test": 8, "project": 9,
                      "vision": 10},
    "dependency": {"config": 1, "source": 3, "module_summary": 4, "readme": 5,
                   "architecture": 6, "graph": 7, "design": 8, "test": 9,
                   "project": 10, "vision": 10},
    "build_system": {"config": 1, "readme": 2, "source": 4, "architecture": 5,
                     "module_summary": 6, "graph": 7, "design": 8, "test": 3,
                     "project": 9, "vision": 10},
    "documentation": {"readme": 1, "architecture": 2, "design": 3, "project": 4,
                      "vision": 5, "module_summary": 6, "source": 8, "graph": 7,
                      "config": 9, "test": 10},
    "design": {"architecture": 1, "design": 2, "readme": 3, "module_summary": 4,
               "graph": 5, "source": 7, "project": 6, "config": 8, "test": 10,
               "vision": 9},
    "security": {"source": 1, "config": 2, "module_summary": 3, "graph": 4,
                 "architecture": 5, "readme": 7, "design": 6, "test": 8,
                 "project": 9, "vision": 10},
    "performance": {"source": 1, "module_summary": 2, "graph": 3, "architecture": 4,
                    "readme": 7, "design": 5, "config": 8, "test": 6, "project": 9,
                    "vision": 10},
    "testing": {"test": 1, "source": 2, "module_summary": 3, "readme": 5,
                "architecture": 4, "graph": 6, "design": 7, "config": 8,
                "project": 9, "vision": 10},
    "unknown": {"readme": 1, "source": 3, "module_summary": 4, "architecture": 5,
                "graph": 6, "design": 7, "config": 8, "test": 2, "project": 9,
                "vision": 10},
}

_TEST_FILE = js_regex.compile(r"\.(test|spec)\.[jt]sx?$")
_CONFIG_FILE = js_regex.compile(r"\.(json|yaml|yml|toml|ini|env)$")
_TITLE = js_regex.compile(r"^#\s+(.+)$", "m")

DOC_EXTS = (".md", ".mdx", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml",
            ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".c", ".cpp",
            ".h", ".java")


def detect_doc_kind(rel_path: str, file_name: str) -> str:
    lower = file_name.lower()
    directory = rel_path.lower()

    if lower == "readme.md":
        return "readme"
    if "project" in lower and lower.endswith(".md"):
        return "project"
    if "vision" in lower and lower.endswith(".md"):
        return "vision"
    if "architect" in lower and lower.endswith(".md"):
        return "architecture"
    if "design" in lower and lower.endswith(".md"):
        return "design"
    if directory.startswith(("test", "__test")) or _TEST_FILE.search(lower):
        return "test"
    if _CONFIG_FILE.search(lower):
        return "config"
    return "source"


def detect_doc_title(content: str, file_name: str) -> str:
    match = _TITLE.search(content)
    return match.group(1).strip() if match and match.group(1) else file_name


def _locale_compare(a: str, b: str) -> int:
    """`String.prototype.localeCompare` for the paths this sees.

    Node's ICU collation orders `.` and `/` before letters and is
    case-insensitive at the primary level. For ASCII repository paths the
    ordering that matters is: compare case-folded, then break ties with
    the raw comparison.
    """
    ka, kb = a.lower(), b.lower()
    if ka != kb:
        return -1 if ka < kb else 1
    if a == b:
        return 0
    return -1 if a < b else 1


def prioritize_documents(
    root: str, intent_type: str, important_files: list[str] | None = None,
    max_results: int = 30,
) -> list[dict[str, Any]]:
    priorities = INTENT_DOC_PRIORITIES.get(intent_type) or INTENT_DOC_PRIORITIES["unknown"]
    docs: list[dict[str, Any]] = []
    important_files = important_files or []

    def collect(directory: str, rel_prefix: str) -> None:
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in (
                "node_modules", "dist", "build", ".aura"
            ):
                continue
            full = os.path.join(directory, entry.name)
            rel = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
            if entry.is_dir():
                collect(full, rel)
                continue
            ext = _ext_of(entry.name)
            if ext not in DOC_EXTS:
                continue
            kind = detect_doc_kind(rel, entry.name)
            priority = priorities.get(kind, 10)
            title = entry.name
            try:
                with open(full, "rb") as handle:
                    text = handle.read().decode("utf-8", errors="replace")
                title = detect_doc_title(slice_utf16(text, 0, 5000), entry.name)
            except OSError:
                pass
            docs.append({"path": rel, "priority": priority, "kind": kind, "title": title})

    collect(root, "")

    def _compare(a: dict[str, Any], b: dict[str, Any]) -> int:
        return (a["priority"] - b["priority"]) or _locale_compare(a["path"], b["path"])

    docs.sort(key=functools.cmp_to_key(_compare))

    for name in important_files:
        if not any(d["path"] == name for d in docs):
            kind = detect_doc_kind(name, os.path.basename(name))
            docs.insert(0, {
                "path": name,
                "priority": max(1, priorities.get(kind, 10) - 1),
                "kind": kind,
                "title": os.path.basename(name),
            })

    return docs[:max_results]
