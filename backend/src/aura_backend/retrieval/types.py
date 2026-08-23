"""The retrieval domain.

A port of the observable half of packages/knowledge-coding/src/types.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def estimate_tokens(text: str) -> int:
    """The product's one token estimator: `ceil(len / 4)`.

    Deliberately crude and deliberately shared — the reference declares it
    in three places, and this port keeps one.
    """
    return -(-len(text) // 4)


@dataclass
class CodeDocument:
    id: str
    abs_path: str
    rel_path: str
    project_root: str
    name: str
    ext: str
    language: str
    kind: str
    size: int
    checksum: str
    modified_ms: float
    indexed_ms: float
    lines: int
    truncated: bool
    binary: bool
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "absPath": self.abs_path, "relPath": self.rel_path,
            "projectRoot": self.project_root, "name": self.name, "ext": self.ext,
            "language": self.language, "kind": self.kind, "size": self.size,
            "checksum": self.checksum, "modifiedMs": self.modified_ms,
            "indexedMs": self.indexed_ms, "lines": self.lines,
            "truncated": self.truncated, "binary": self.binary,
            "metadata": self.metadata,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> CodeDocument:
        return CodeDocument(
            id=raw["id"], abs_path=raw["absPath"], rel_path=raw["relPath"],
            project_root=raw["projectRoot"], name=raw["name"], ext=raw["ext"],
            language=raw["language"], kind=raw["kind"], size=raw["size"],
            checksum=raw["checksum"], modified_ms=raw["modifiedMs"],
            indexed_ms=raw["indexedMs"], lines=raw["lines"],
            truncated=raw["truncated"], binary=raw["binary"],
            metadata=raw.get("metadata", {}),
        )


@dataclass
class CodeChunk:
    id: str
    document_id: str
    ordinal: int
    text: str
    start_line: int
    end_line: int
    start_byte: int
    end_byte: int
    token_estimate: int
    language: str
    rel_path: str
    symbols: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "documentId": self.document_id, "ordinal": self.ordinal,
            "text": self.text, "startLine": self.start_line, "endLine": self.end_line,
            "startByte": self.start_byte, "endByte": self.end_byte,
            "tokenEstimate": self.token_estimate, "language": self.language,
            "relPath": self.rel_path, "symbols": self.symbols,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> CodeChunk:
        return CodeChunk(
            id=raw["id"], document_id=raw["documentId"], ordinal=raw["ordinal"],
            text=raw["text"], start_line=raw["startLine"], end_line=raw["endLine"],
            start_byte=raw["startByte"], end_byte=raw["endByte"],
            token_estimate=raw["tokenEstimate"], language=raw["language"],
            rel_path=raw["relPath"], symbols=raw.get("symbols", []),
        )


@dataclass
class SearchQuery:
    text: str
    limit: int | None = None
    # exact | prefix | fuzzy | auto
    mode: str | None = None
    fuzzy_max_distance: int | None = None
    languages: list[str] | None = None
    extensions: list[str] | None = None
    kinds: list[str] | None = None
    path_includes: str | None = None
    filename: str | None = None


@dataclass
class SearchHit:
    chunk: CodeChunk
    document: CodeDocument
    score: float
    matched_terms: list[str]
    reasons: list[str]


@dataclass
class ScanEntry:
    abs_path: str
    rel_path: str
    size: int
    modified_ms: float


@dataclass
class FileError:
    rel_path: str
    code: str
    message: str

    def to_json(self) -> dict[str, Any]:
        return {"relPath": self.rel_path, "code": self.code, "message": self.message}


@dataclass
class ContextChunkRef:
    chunk: CodeChunk
    # 'match' | 'neighbor'
    role: str


@dataclass
class CodingContextEntry:
    document: CodeDocument
    chunks: list[ContextChunkRef]
    score: float
    source: str
    tokens: int


@dataclass
class CodingContext:
    query: str
    entries: list[CodingContextEntry]
    total_tokens: int
    project: dict[str, Any]
    truncated: bool


@dataclass
class IndexStats:
    files: int
    chunks: int
    bytes: int
    binaries: int
    errors: list[FileError]
    by_language: dict[str, int]
    skipped: int
    duration_ms: float

    def to_json(self) -> dict[str, Any]:
        return {
            "files": self.files, "chunks": self.chunks, "bytes": self.bytes,
            "binaries": self.binaries, "errors": [e.to_json() for e in self.errors],
            "byLanguage": self.by_language, "skipped": self.skipped,
            "durationMs": self.duration_ms,
        }


@dataclass
class IndexDelta:
    added: int
    modified: int
    deleted: int
    unchanged: int
    stats: IndexStats

    def to_json(self) -> dict[str, Any]:
        return {
            "added": self.added, "modified": self.modified, "deleted": self.deleted,
            "unchanged": self.unchanged, "stats": self.stats.to_json(),
        }
