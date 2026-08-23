"""The real local index on disk.

A port of packages/knowledge-coding/src/store/indexStore.ts.

Persists documents, chunks, the file manifest (for incremental indexing)
and the inverted index to a directory. Writes are atomic (tmp + rename).

The store is deliberately an interface-shaped class so a future vector
index becomes an ADDITIONAL backend the engine composes, rather than a
replacement for this keyword store or for any calling code.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .inverted_index import InvertedIndex
from .types import CodeChunk, CodeDocument

SCHEMA_VERSION = 1


@dataclass
class FileRecord:
    rel_path: str
    checksum: str
    modified_ms: float
    size: int
    language: str
    kind: str
    doc_id: str
    chunk_ids: list[str]

    def to_json(self) -> dict[str, Any]:
        return {
            "relPath": self.rel_path, "checksum": self.checksum,
            "modifiedMs": self.modified_ms, "size": self.size,
            "language": self.language, "kind": self.kind,
            "docId": self.doc_id, "chunkIds": self.chunk_ids,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> FileRecord:
        return FileRecord(
            rel_path=raw["relPath"], checksum=raw["checksum"],
            modified_ms=raw["modifiedMs"], size=raw["size"],
            language=raw["language"], kind=raw["kind"],
            doc_id=raw["docId"], chunk_ids=raw.get("chunkIds", []),
        )


def _ordinal_of(chunk_id: str) -> int:
    i = chunk_id.rfind("#")
    if i < 0:
        return 0
    try:
        return int(chunk_id[i + 1:])
    except ValueError:
        return 0


class JsonKnowledgeStore:
    def __init__(self, root: str, index_dir: str = ".aura-index") -> None:
        self.root = str(Path(root).resolve())
        directory = Path(index_dir)
        self._dir = directory if directory.is_absolute() else Path(self.root) / index_dir
        self.index = InvertedIndex()
        self._documents: dict[str, CodeDocument] = {}
        self._chunks: dict[str, CodeChunk] = {}
        self._by_path: dict[str, str] = {}
        self._files: dict[str, FileRecord] = {}
        self._doc_chunks: dict[str, list[str]] = {}

    def _file(self, name: str) -> Path:
        return self._dir / name

    def load(self) -> bool:
        try:
            meta = json.loads(self._file("meta.json").read_text(encoding="utf-8"))
            if meta.get("version") != SCHEMA_VERSION:
                return False
            docs = json.loads(self._file("documents.json").read_text(encoding="utf-8"))
            chunks = json.loads(self._file("chunks.json").read_text(encoding="utf-8"))
            files = json.loads(self._file("manifest.json").read_text(encoding="utf-8"))
            index = json.loads(self._file("index.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, KeyError):
            return False

        for raw in docs:
            doc = CodeDocument.from_json(raw)
            self._documents[doc.id] = doc
            self._by_path[doc.rel_path] = doc.id
        for raw in chunks:
            chunk = CodeChunk.from_json(raw)
            self._chunks[chunk.id] = chunk
            self._doc_chunks.setdefault(chunk.document_id, []).append(chunk.id)
        for ids in self._doc_chunks.values():
            ids.sort(key=_ordinal_of)
        for raw in files:
            record = FileRecord.from_json(raw)
            self._files[record.rel_path] = record
        self.index = InvertedIndex.from_json(index)
        return True

    def save(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)

        def write_atomic(name: str, data: Any) -> None:
            fd, tmp = tempfile.mkstemp(dir=str(self._dir), prefix=f".{name}.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, ensure_ascii=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, self._file(name))
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise

        import time

        write_atomic("meta.json", {"version": SCHEMA_VERSION, "root": self.root,
                                   "updatedMs": int(time.time() * 1000)})
        write_atomic("documents.json", [d.to_json() for d in self._documents.values()])
        write_atomic("chunks.json", [c.to_json() for c in self._chunks.values()])
        write_atomic("manifest.json", [f.to_json() for f in self._files.values()])
        write_atomic("index.json", self.index.to_json())

    def upsert_document(self, doc: CodeDocument, chunks: list[CodeChunk]) -> None:
        self.remove_document_by_path(doc.rel_path)
        self._documents[doc.id] = doc
        self._by_path[doc.rel_path] = doc.id
        ids: list[str] = []
        for chunk in chunks:
            self._chunks[chunk.id] = chunk
            # The indexed text is the chunk PLUS its symbols and the file
            # name — which is why a filename match can score at all.
            self.index.add(chunk.id, f"{chunk.text}\n{' '.join(chunk.symbols)}\n{doc.name}")
            ids.append(chunk.id)
        ids.sort(key=_ordinal_of)
        self._doc_chunks[doc.id] = ids
        self._files[doc.rel_path] = FileRecord(
            rel_path=doc.rel_path, checksum=doc.checksum, modified_ms=doc.modified_ms,
            size=doc.size, language=doc.language, kind=doc.kind, doc_id=doc.id,
            chunk_ids=ids,
        )

    def remove_document_by_path(self, rel_path: str) -> bool:
        doc_id = self._by_path.get(rel_path)
        if doc_id is None:
            return False
        for chunk_id in self._doc_chunks.get(doc_id, []):
            self.index.remove(chunk_id)
            self._chunks.pop(chunk_id, None)
        self._doc_chunks.pop(doc_id, None)
        self._documents.pop(doc_id, None)
        self._by_path.pop(rel_path, None)
        self._files.pop(rel_path, None)
        return True

    def get_document(self, doc_id: str) -> CodeDocument | None:
        return self._documents.get(doc_id)

    def get_document_by_path(self, rel_path: str) -> CodeDocument | None:
        doc_id = self._by_path.get(rel_path)
        return self._documents.get(doc_id) if doc_id else None

    def get_chunk(self, chunk_id: str) -> CodeChunk | None:
        return self._chunks.get(chunk_id)

    def document_chunks(self, doc_id: str) -> list[CodeChunk]:
        return [c for c in (self._chunks.get(i) for i in self._doc_chunks.get(doc_id, [])) if c]

    def neighbor_chunks(self, chunk_id: str, radius: int) -> list[CodeChunk]:
        chunk = self._chunks.get(chunk_id)
        if chunk is None:
            return []
        ids = self._doc_chunks.get(chunk.document_id, [])
        try:
            pos = ids.index(chunk_id)
        except ValueError:
            return []
        out: list[CodeChunk] = []
        for d in range(1, radius + 1):
            # `ids[pos - d]` is `undefined` in JavaScript when the index goes
            # negative; in Python it WRAPS to the end of the list and would
            # return the last chunk of a file as a "neighbour" of the first.
            # The bound is the whole point of this line.
            before = self._chunks.get(ids[pos - d]) if 0 <= pos - d else None
            after = self._chunks.get(ids[pos + d]) if pos + d < len(ids) else None
            if before:
                out.append(before)
            if after:
                out.append(after)
        return out

    def manifest(self) -> dict[str, FileRecord]:
        return self._files

    def all_documents(self) -> list[CodeDocument]:
        return list(self._documents.values())

    def stats(self) -> dict[str, int]:
        return {"documents": len(self._documents), "chunks": len(self._chunks)}
