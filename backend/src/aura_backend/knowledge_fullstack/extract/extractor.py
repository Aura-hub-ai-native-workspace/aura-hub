"""Extraction framework.

A port of packages/knowledge-fullstack/src/extract/extractor.ts.

A `SourceFile` (real file content) is passed to the extractors whose
`applies_to` matches. Each returns typed entities with raw signals in
`metadata` that the linker later resolves into relationships.

Analysis is real but dependency-free: line scanning and robust regexes
over actual source — no AST library, no network, no model.
"""

from __future__ import annotations

from typing import Any, Protocol

from ...core import js_regex
from ...core.js_string import slice_utf16
from ..types import Entity, SourceFile


class LineMap:
    """Maps a character offset to a 1-based line number (binary search).

    Offsets are UTF-16 code units in the reference (`charCodeAt`), so a
    text containing an astral character would index differently. Python
    string indices are code points; the two agree for every file without
    one, and `offset_map` records the difference when there is.
    """

    def __init__(self, text: str) -> None:
        self._starts = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self._starts.append(index + 1)

    def line_at(self, index: int) -> int:
        lo, hi = 0, len(self._starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) >> 1
            if self._starts[mid] <= index:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1


def entity_id(kind: str, rel_path: str, name: str) -> str:
    return f"{kind}:{rel_path}#{name}"


def make_entity(
    kind: str, layer: str, name: str, file: SourceFile,
    line: int | None = None, summary: str | None = None,
    snippet: str | None = None, metadata: dict[str, Any] | None = None,
) -> Entity:
    return Entity(
        id=entity_id(kind, file.rel_path, name), kind=kind, layer=layer, name=name,
        rel_path=file.rel_path, line=line, language=file.language,
        summary=summary, snippet=snippet, metadata=metadata if metadata is not None else {},
    )


def snippet_around(file: SourceFile, line: int, radius: int = 3) -> str:
    """A short snippet around a line, for context and search."""
    lines = file.text.split("\n")
    start = max(0, line - 1 - radius)
    end = min(len(lines), line + radius)
    return slice_utf16("\n".join(lines[start:end]), 0, 600)


class Extractor(Protocol):
    id: str

    def applies_to(self, file: SourceFile) -> bool: ...
    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]: ...


_IMPORT_FROM = js_regex.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]", "g")

_ENV_PATTERNS = [
    js_regex.compile(r"process\.env\.([A-Z0-9_]+)", "g"),
    js_regex.compile(r"process\.env\[\s*['\"]([A-Z0-9_]+)['\"]\s*\]", "g"),
    js_regex.compile(r"import\.meta\.env\.([A-Z0-9_]+)", "g"),
    js_regex.compile(r"std::env::var\(\s*\"([A-Z0-9_]+)\"", "g"),
    js_regex.compile(r"os\.environ(?:\.get)?\(?\s*['\"]([A-Z0-9_]+)['\"]", "g"),
]


def import_specifiers(text: str) -> dict[str, list[str]]:
    local: list[str] = []
    external: list[str] = []
    for match in _IMPORT_FROM.finditer(text):
        spec = match.group(1)
        if spec.startswith((".", "@/", "~")):
            local.append(spec)
        else:
            external.append(
                "/".join(spec.split("/")[:2]) if spec.startswith("@")
                else spec.split("/")[0]
            )
    return {"local": list(dict.fromkeys(local)),
            "external": list(dict.fromkeys(external))}


def env_refs(text: str) -> list[str]:
    out: dict[str, None] = {}
    for pattern in _ENV_PATTERNS:
        for match in pattern.finditer(text):
            out[match.group(1)] = None
    return list(out)
