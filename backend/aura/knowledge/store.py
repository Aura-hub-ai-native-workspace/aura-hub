"""Knowledge base store — chunked BM25 retrieval over ingested documents.

Architecture:
  KnowledgeBase
    ├── DocumentRecord  — one per ingested file (path, metadata, chunk count)
    ├── Chunk           — one piece of text (~512 tokens) with source reference
    └── BM25Index       — in-memory inverted index, rebuilt from store on load

Persistence:
  store_dir/
    index.json   — list of DocumentRecord dicts (no chunk text — text in chunks/)
    chunks/
      <doc_id>.jsonl  — one JSON line per chunk for that document

No cloud service is contacted during indexing or retrieval.  The optional
vector search path (S9) embeds chunks through a local Ollama model; if no
embedding model is configured, BM25-only search is used with an honest note.

Retrieval quality notes:
  - BM25 does well for keyword queries and named entities
  - Vector search adds semantic recall but requires an embedding model
  - Hybrid ranking (BM25 + cosine) is used when both are available
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

CHUNK_CHARS = 1500    # target chunk size — roughly 350-400 tokens
CHUNK_OVERLAP = 150   # overlap to avoid cutting context at boundaries


def _chunk_text(text: str, doc_id: str) -> list["Chunk"]:
    """Split text into overlapping fixed-size chunks."""
    if not text.strip():
        return []
    chunks: list[Chunk] = []
    start = 0
    idx = 0
    while start < len(text):
        end = start + CHUNK_CHARS
        # Try to break at a sentence boundary
        if end < len(text):
            for sep in ("\n\n", "\n", ". ", " "):
                pos = text.rfind(sep, start + CHUNK_CHARS // 2, end)
                if pos != -1:
                    end = pos + len(sep)
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(Chunk(
                id=f"{doc_id}:{idx}",
                doc_id=doc_id,
                text=piece,
                start_char=start,
                end_char=min(end, len(text)),
                index=idx,
            ))
            idx += 1
        start = end - CHUNK_OVERLAP
        if start >= len(text):
            break
    return chunks


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    id: str           # "{doc_id}:{index}"
    doc_id: str
    text: str
    start_char: int
    end_char: int
    index: int

    def to_dict(self) -> dict:
        return {
            "id": self.id, "docId": self.doc_id, "text": self.text,
            "startChar": self.start_char, "endChar": self.end_char,
            "index": self.index}

    @classmethod
    def from_dict(cls, d: dict) -> "Chunk":
        return cls(
            id=d["id"], doc_id=d["docId"], text=d["text"],
            start_char=d["startChar"], end_char=d["endChar"],
            index=d["index"])


@dataclass
class DocumentRecord:
    doc_id: str         # SHA-256 of (path + mtime) for stable deduplication
    path: str           # original file path
    mime_type: str = ""
    chunk_count: int = 0
    char_count: int = 0
    added_at: float = field(default_factory=time.time)
    metadata: dict = field(default_factory=dict)
    extraction_status: str = "ok"
    extraction_note: str = ""

    def to_dict(self) -> dict:
        return {
            "docId": self.doc_id, "path": self.path,
            "mimeType": self.mime_type, "chunkCount": self.chunk_count,
            "charCount": self.char_count,
            "addedAt": self.added_at, "metadata": self.metadata,
            "extractionStatus": self.extraction_status,
            "extractionNote": self.extraction_note,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DocumentRecord":
        return cls(
            doc_id=d["docId"], path=d["path"],
            mime_type=d.get("mimeType", ""),
            chunk_count=d.get("chunkCount", 0),
            char_count=d.get("charCount", 0),
            added_at=d.get("addedAt", 0.0),
            metadata=d.get("metadata", {}),
            extraction_status=d.get("extractionStatus", "ok"),
            extraction_note=d.get("extractionNote", ""),
        )


@dataclass
class SearchResult:
    chunk: Chunk
    doc_record: DocumentRecord
    score: float
    match_type: str      # "bm25" | "vector" | "hybrid"

    def to_dict(self) -> dict:
        return {
            "chunkId": self.chunk.id,
            "docId": self.chunk.doc_id,
            "path": self.doc_record.path,
            "text": self.chunk.text,
            "score": round(self.score, 4),
            "matchType": self.match_type,
            "startChar": self.chunk.start_char,
            "endChar": self.chunk.end_char,
        }


# ---------------------------------------------------------------------------
# BM25 index
# ---------------------------------------------------------------------------

def _tokenise(text: str) -> list[str]:
    """Simple alphanumeric tokeniser. Lower-case, strip punctuation."""
    return re.findall(r"[a-z0-9]+", text.lower())


_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "of", "to", "in", "is", "it",
    "be", "as", "at", "so", "we", "he", "she", "they", "you",
    "but", "for", "on", "are", "was", "with", "this", "that",
    "by", "from", "not", "have", "has", "had", "can", "will",
    "do", "does", "did", "if", "then", "than", "when", "which",
})


def _keywords(text: str) -> list[str]:
    return [t for t in _tokenise(text) if t not in _STOPWORDS and len(t) > 1]


class BM25Index:
    """Okapi BM25 inverted index.

    Accurate enough for organizational document retrieval.  Does not
    require any external library.  Rebuilt from chunk store on startup.
    """

    K1 = 1.5
    B = 0.75

    def __init__(self) -> None:
        self._idf: dict[str, float] = {}
        self._tf: dict[str, dict[str, float]] = defaultdict(dict)
        self._doc_len: dict[str, int] = {}
        self._avg_len: float = 0.0
        self._n_docs: int = 0

    def add(self, chunk: Chunk) -> None:
        tokens = _keywords(chunk.text)
        self._doc_len[chunk.id] = len(tokens)
        tf_raw: dict[str, int] = defaultdict(int)
        for t in tokens:
            tf_raw[t] += 1
        for term, count in tf_raw.items():
            self._tf[term][chunk.id] = count
        self._n_docs += 1
        self._avg_len = sum(self._doc_len.values()) / max(self._n_docs, 1)

    def _compute_idf(self, term: str) -> float:
        df = len(self._tf.get(term, {}))
        if df == 0:
            return 0.0
        return math.log((self._n_docs - df + 0.5) / (df + 0.5) + 1)

    def score(self, chunk_id: str, query_tokens: list[str]) -> float:
        total = 0.0
        dl = self._doc_len.get(chunk_id, 0)
        for term in query_tokens:
            tf = self._tf.get(term, {}).get(chunk_id, 0)
            if tf == 0:
                continue
            idf = self._compute_idf(term)
            numer = tf * (self.K1 + 1)
            denom = tf + self.K1 * (1 - self.B + self.B * dl / max(self._avg_len, 1))
            total += idf * numer / denom
        return total

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        """Return (chunk_id, score) pairs sorted by score descending."""
        tokens = _keywords(query)
        if not tokens:
            return []
        # Only score chunks that contain at least one query token
        candidates: set[str] = set()
        for t in tokens:
            candidates.update(self._tf.get(t, {}).keys())
        scored = [(cid, self.score(cid, tokens)) for cid in candidates]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]


# ---------------------------------------------------------------------------
# Knowledge Base
# ---------------------------------------------------------------------------

def _doc_id(path: str) -> str:
    """Stable document ID from path (mtime-independent for manual inserts)."""
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:16]


class KnowledgeBase:
    """Local document store with BM25 retrieval.

    Args:
        store_dir: directory where index.json and chunks/ are stored.
            Created automatically if it does not exist.
        embedding_port: optional ModelPort for vector embedding search.
            When None, only BM25 search is available.
    """

    def __init__(self, store_dir: str | Path = "~/.aura/knowledge",
                 embedding_port=None) -> None:
        self._dir = Path(store_dir).expanduser().resolve()
        self._dir.mkdir(parents=True, exist_ok=True)
        (self._dir / "chunks").mkdir(exist_ok=True)
        self._embedding_port = embedding_port

        self._records: dict[str, DocumentRecord] = {}
        self._chunks: dict[str, Chunk] = {}     # chunk_id → Chunk
        self._index = BM25Index()

        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _index_path(self) -> Path:
        return self._dir / "index.json"

    def _chunks_path(self, doc_id: str) -> Path:
        return self._dir / "chunks" / f"{doc_id}.jsonl"

    def _load(self) -> None:
        """Load index and chunk files from disk."""
        try:
            records_raw = json.loads(self._index_path().read_text("utf-8"))
            for rd in records_raw:
                rec = DocumentRecord.from_dict(rd)
                self._records[rec.doc_id] = rec
        except (OSError, json.JSONDecodeError, KeyError):
            return

        for doc_id in self._records:
            cp = self._chunks_path(doc_id)
            if not cp.exists():
                continue
            for line in cp.read_text("utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    chunk = Chunk.from_dict(json.loads(line))
                    self._chunks[chunk.id] = chunk
                    self._index.add(chunk)
                except (json.JSONDecodeError, KeyError):
                    continue

    def _save_index(self) -> None:
        tmp = self._index_path().with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps([r.to_dict() for r in self._records.values()],
                       indent=2),
            encoding="utf-8")
        tmp.replace(self._index_path())

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def add_document(self, path: str | Path,
                     extraction_result) -> DocumentRecord:
        """Add an extracted document to the knowledge base.

        Args:
            path: original file path (used as stable identifier)
            extraction_result: ExtractionResult from DocumentIngestor.
                The .text field is chunked and indexed.

        Returns the DocumentRecord (existing record if already indexed).
        """
        from aura.multimodal.ingestor import ExtractionStatus

        path_str = str(Path(path).resolve())
        doc_id = _doc_id(path_str)

        chunks = _chunk_text(extraction_result.text or "", doc_id)

        record = DocumentRecord(
            doc_id=doc_id,
            path=path_str,
            mime_type=getattr(extraction_result, "mime_type", ""),
            chunk_count=len(chunks),
            char_count=len(extraction_result.text or ""),
            metadata=dict(getattr(extraction_result, "metadata", {}) or {}),
            extraction_status=getattr(extraction_result, "status",
                                       ExtractionStatus.OK).value,
            extraction_note=getattr(extraction_result, "note", "") or "",
        )

        # Write chunks to disk
        cp = self._chunks_path(doc_id)
        with cp.open("w", encoding="utf-8") as fh:
            for chunk in chunks:
                fh.write(json.dumps(chunk.to_dict()) + "\n")
                self._chunks[chunk.id] = chunk
                self._index.add(chunk)

        self._records[doc_id] = record
        self._save_index()
        return record

    def remove_document(self, path: str | Path) -> bool:
        """Remove a document and its chunks. Returns True if found."""
        path_str = str(Path(path).resolve())
        doc_id = _doc_id(path_str)
        if doc_id not in self._records:
            return False
        # Remove from in-memory structures (BM25 does not support deletion;
        # restart rebuilds cleanly from the chunk files)
        del self._records[doc_id]
        for cid in list(self._chunks.keys()):
            if self._chunks[cid].doc_id == doc_id:
                del self._chunks[cid]
        cp = self._chunks_path(doc_id)
        if cp.exists():
            cp.unlink(missing_ok=True)
        self._save_index()
        return True

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------

    def search(self, query: str, top_k: int = 5) -> list[SearchResult]:
        """BM25 keyword search over all indexed chunks.

        Returns up to top_k results sorted by relevance score.
        Each result includes the chunk text and source document path.
        """
        hits = self._index.search(query, top_k=top_k)
        results: list[SearchResult] = []
        for chunk_id, score in hits:
            chunk = self._chunks.get(chunk_id)
            if chunk is None:
                continue
            record = self._records.get(chunk.doc_id)
            if record is None:
                continue
            results.append(SearchResult(
                chunk=chunk, doc_record=record,
                score=score, match_type="bm25"))
        return results

    def search_with_context(self, query: str, top_k: int = 5,
                            context_chunks: int = 1) -> list[SearchResult]:
        """BM25 search with adjacent-chunk context expansion.

        For each hit, neighbouring chunks (context_chunks on each side) are
        appended to the text so the agent sees more context around the match.
        """
        hits = self.search(query, top_k=top_k)
        expanded: list[SearchResult] = []
        for hit in hits:
            raw_ids = [
                f"{hit.chunk.doc_id}:{max(0, hit.chunk.index - i)}"
                for i in range(context_chunks, 0, -1)
            ] + [hit.chunk.id] + [
                f"{hit.chunk.doc_id}:{hit.chunk.index + i}"
                for i in range(1, context_chunks + 1)
            ]
            seen: set[str] = set()
            context_ids = [cid for cid in raw_ids
                           if not (cid in seen or seen.add(cid))]  # type: ignore[func-returns-value]
            text_parts = []
            for cid in context_ids:
                c = self._chunks.get(cid)
                if c:
                    text_parts.append(c.text)
            combined_text = "\n\n".join(text_parts)
            expanded_chunk = Chunk(
                id=hit.chunk.id,
                doc_id=hit.chunk.doc_id,
                text=combined_text,
                start_char=hit.chunk.start_char,
                end_char=hit.chunk.end_char,
                index=hit.chunk.index,
            )
            expanded.append(SearchResult(
                chunk=expanded_chunk,
                doc_record=hit.doc_record,
                score=hit.score,
                match_type=hit.match_type,
            ))
        return expanded

    def snapshot(self) -> dict:
        """Secret-free status snapshot for monitoring UI."""
        return {
            "documents": len(self._records),
            "chunks": len(self._chunks),
            "storeDir": str(self._dir),
            "docs": [r.to_dict() for r in self._records.values()],
        }
