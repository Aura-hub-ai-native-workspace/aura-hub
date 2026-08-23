"""Assemble retrieval context from search hits.

A port of packages/knowledge-coding/src/context.ts.

For the top hits: the matched chunks, their neighbour chunks (for
surrounding code), file and document metadata, a token count, and precise
source references — all inside a token budget.
"""

from __future__ import annotations

from .store import JsonKnowledgeStore
from .types import (
    CodeDocument,
    CodingContext,
    CodingContextEntry,
    ContextChunkRef,
    SearchHit,
)

DEFAULT_NEIGHBORS = 1
DEFAULT_MAX_TOKENS = 6000
DEFAULT_LIMIT = 8


class ContextBuilder:
    def __init__(self, store: JsonKnowledgeStore, project_name: str) -> None:
        self._store = store
        self._project_name = project_name

    def build(
        self,
        query: str,
        hits: list[SearchHit],
        neighbors: int = DEFAULT_NEIGHBORS,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        limit: int = DEFAULT_LIMIT,
    ) -> CodingContext:
        # Group hits by document, keeping the best score and all matched
        # chunks. Insertion order matters for ties, as it does in the
        # reference's Map.
        groups: dict[str, dict] = {}
        for hit in hits:
            group = groups.get(hit.document.id)
            if group is None:
                group = {"score": 0.0, "match_ids": {}}
                groups[hit.document.id] = group
            group["score"] = max(group["score"], hit.score)
            group["match_ids"][hit.chunk.id] = None

        ordered = sorted(groups.items(), key=lambda kv: kv[1]["score"], reverse=True)[:limit]

        entries: list[CodingContextEntry] = []
        total_tokens = 0
        truncated = False

        for doc_id, group in ordered:
            doc = self._store.get_document(doc_id)
            if doc is None:
                continue

            # Matched chunks plus neighbours, de-duplicated, in source order.
            by_id: dict[str, ContextChunkRef] = {}
            for chunk_id in group["match_ids"]:
                chunk = self._store.get_chunk(chunk_id)
                if chunk is not None:
                    by_id[chunk_id] = ContextChunkRef(chunk=chunk, role="match")
                for neighbor in self._store.neighbor_chunks(chunk_id, neighbors):
                    if neighbor.id not in by_id:
                        by_id[neighbor.id] = ContextChunkRef(chunk=neighbor, role="neighbor")
            refs = sorted(by_id.values(), key=lambda r: r.chunk.start_line)

            entry_tokens = sum(r.chunk.token_estimate for r in refs)
            if total_tokens + entry_tokens > max_tokens:
                # Try to fit at least the matched chunks if nothing is in yet
                # — an empty context because the first file was large is a
                # worse answer than a partial one.
                if not entries:
                    match_only = [r for r in refs if r.role == "match"]
                    tokens = sum(r.chunk.token_estimate for r in match_only)
                    if tokens <= max_tokens:
                        entries.append(self._entry(doc, match_only, group["score"]))
                        total_tokens += tokens
                truncated = True
                break

            entries.append(self._entry(doc, refs, group["score"]))
            total_tokens += entry_tokens

        stats = self._store.stats()
        return CodingContext(
            query=query,
            entries=entries,
            total_tokens=total_tokens,
            project={
                "root": self._store.root,
                "name": self._project_name,
                "fileCount": stats["documents"],
                "chunkCount": stats["chunks"],
            },
            truncated=truncated,
        )

    def _entry(
        self, doc: CodeDocument, refs: list[ContextChunkRef], score: float
    ) -> CodingContextEntry:
        start_line = min(r.chunk.start_line for r in refs)
        end_line = max(r.chunk.end_line for r in refs)
        return CodingContextEntry(
            document=doc,
            chunks=refs,
            score=score,
            source=f"{doc.rel_path}:{start_line}-{end_line}",
            tokens=sum(r.chunk.token_estimate for r in refs),
        )
