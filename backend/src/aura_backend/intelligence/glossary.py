"""Project Glossary.

A port of packages/ai-service/src/intelligence/glossary.ts.

Builds a glossary of project-specific terminology: module names,
acronyms, technical terms and domain concepts, all extracted from the
real tree.

**This module can raise.** `guessDefinition` interpolates the term into
`new RegExp` WITHOUT escaping it, so a directory named `c++` produces an
invalid pattern and the reference throws `SyntaxError` out of
`buildGlossary` — taking the whole intelligence pipeline with it. The
port raises in the same place for the same reason rather than quietly
skipping the term, because swallowing it would make the Python backend
succeed where the reference fails.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16
from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS
from .identity import _ext_of, _read_dir

SKIP_ACRONYMS = frozenset({
    "JSON", "HTML", "CSS", "XML", "SQL", "API", "URL", "URI", "HTTP", "HTTPS",
    "REST", "AWS", "GCP", "DNS", "TLS", "SSL", "JWT", "EOF", "OK", "NaN", "UTF",
})

SOURCE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
               ".c", ".cpp", ".h")

_ACRONYM = js_regex.compile(r"\b[A-Z]{2,5}\b", "g")
_PASCAL_DECL = js_regex.compile(
    r"\b(?:class|type|interface|struct|enum)\s+([A-Z][a-zA-Z0-9]+)", "g"
)
_PASCAL_PREFIX = js_regex.compile(r"(?:class|type|interface|struct|enum)\s+")
_SNAKE = js_regex.compile(r"\b[A-Z]{2,}_[A-Z_]+\b", "g")
_IS_ACRONYM = js_regex.compile(r"^[A-Z]{2,5}$")
_IS_COMPONENT = js_regex.compile(r"^[A-Z][a-z]+[A-Z]")
_STARTS_UPPER = js_regex.compile(r"^[A-Z][a-z]+")


def extract_acronyms(content: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for match in _ACRONYM.finditer(content):
        term = match.group(0)
        if term in SKIP_ACRONYMS:
            continue
        counts[term] = counts.get(term, 0) + 1
    return counts


def extract_module_names(root: str) -> dict[str, int]:
    counts: dict[str, int] = {}

    def scan(directory: str, depth: int) -> None:
        if depth > 4:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if (entry.is_dir() and entry.name not in IGNORE_DIRS
                    and not entry.name.startswith(".")):
                name = entry.name
                if 3 <= len(name) <= 30:
                    counts[name] = counts.get(name, 0) + 3
                scan(os.path.join(directory, entry.name), depth + 1)

    scan(root, 0)
    return counts


def extract_code_terms(content: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for match in _PASCAL_DECL.finditer(content):
        name = _PASCAL_PREFIX.sub("", match.group(0), count=1)
        if 3 <= len(name) <= 30:
            counts[name] = counts.get(name, 0) + 2
    for match in _SNAKE.finditer(content):
        term = match.group(0)
        if 5 <= len(term) <= 30:
            counts[term] = counts.get(term, 0) + 1
    return counts


def guess_definition(term: str, context: str) -> str:
    """Look for a definition in a nearby comment, else guess from shape.

    The three patterns interpolate `term` verbatim, exactly as the
    reference does. A term containing regex syntax raises here and there.
    """
    patterns = [
        js_regex.compile(rf"//\s*(.+?)\s*\n.*\b{term}\b", "i"),
        js_regex.compile(rf"\b{term}\b.*//\s*(.+?)\s*$", "i"),
        js_regex.compile(rf"/\*\*?\s*(.+?)\s*\*?.*\b{term}\b", "i"),
    ]
    for pattern in patterns:
        match = pattern.search(context)
        if match and match.group(1):
            return slice_utf16(match.group(1).strip(), 0, 200)

    if _IS_ACRONYM.search(term):
        return f"Acronym: {term}"
    if _IS_COMPONENT.search(term):
        return f"Component: {term}"
    return term


def build_glossary(home: Path, project_id: str, root: str, now: str) -> dict[str, Any]:
    acronym_counts: dict[str, int] = {}
    module_counts = extract_module_names(root)
    code_term_counts: dict[str, int] = {}
    term_contexts: dict[str, str] = {}

    budget = 5000

    def scan_file(file_path: str) -> None:
        nonlocal budget
        if budget <= 0:
            return
        budget -= 1
        try:
            with open(file_path, "rb") as handle:
                content = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return
        if len(content) > 100000:
            content = content[:100000]
        snippet = slice_utf16(content, 0, 2000)

        for term, count in extract_acronyms(content).items():
            acronym_counts[term] = acronym_counts.get(term, 0) + count
            term_contexts.setdefault(term, snippet)
        for term, count in extract_code_terms(content).items():
            code_term_counts[term] = code_term_counts.get(term, 0) + count
            term_contexts.setdefault(term, snippet)

    def scan_dir(directory: str) -> None:
        if budget <= 0:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if budget <= 0:
                break
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan_dir(full)
                continue
            if _ext_of(entry.name) in SOURCE_EXTS:
                scan_file(full)

    scan_dir(root)

    all_terms: dict[str, int] = {}
    for source in (module_counts, acronym_counts, code_term_counts):
        for term, count in source.items():
            all_terms[term] = all_terms.get(term, 0) + count

    # Stable sort by descending count — ties keep insertion order, which
    # is modules first, then acronyms, then code terms.
    ordered = sorted(all_terms.items(), key=lambda kv: -kv[1])[:50]

    entries: dict[str, Any] = {}
    for term, _count in ordered:
        if _IS_ACRONYM.search(term):
            domain = "acronym"
        elif _STARTS_UPPER.search(term):
            domain = "component"
        else:
            domain = "module"
        entries[term] = {
            "term": term,
            "definition": guess_definition(term, term_contexts.get(term, "")),
            "domain": domain,
            "source": "auto-extracted",
        }

    glossary = {"entries": entries, "generatedAt": now}
    atomic_write_json(home / "glossary" / f"{project_id}.json", glossary)
    return glossary


# Re-exported so a caller can distinguish "the tree broke the glossary"
# from any other failure, as `SyntaxError` does in the reference.
GlossaryPatternError = re.error


def load_glossary(home: Path, project_id: str) -> dict[str, Any] | None:
    from ..core.json_store import read_json

    return read_json(home / "glossary" / f"{project_id}.json", None)
