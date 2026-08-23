"""Production keyword search.

A port of packages/knowledge-coding/src/search.ts.

Runs BM25 over the inverted index, then applies real filters (language,
extension, kind, path, filename) and ranking boosts (filename, path,
symbol, recency).

**No vector search.** The boost constants below are copied from the
reference rather than chosen, because changing any of them changes every
ranking the product has ever produced.
"""

from __future__ import annotations

import time

from .inverted_index import tokenize
from .store import JsonKnowledgeStore
from .types import SearchHit, SearchQuery

MODE_EXPANSIONS: dict[str, list[str]] = {
    "exact": ["exact"],
    "prefix": ["exact", "prefix"],
    "fuzzy": ["exact", "fuzzy"],
    "auto": ["exact", "prefix", "fuzzy"],
}

FILENAME_BOOST = 1.6
PATH_BOOST = 1.2
SYMBOL_BOOST = 1.3
FILENAME_FILTER_BOOST = 1.3
RECENCY_WEIGHT = 0.15
# Half-life of the recency bonus, in days.
RECENCY_HALFLIFE_DAYS = 60
MS_PER_DAY = 86_400_000
DEFAULT_LIMIT = 20
DEFAULT_FUZZY_DISTANCE = 2


class CodingSearch:
    def __init__(self, store: JsonKnowledgeStore, now_ms=None) -> None:
        self._store = store
        self._now = now_ms or (lambda: time.time() * 1000)

    def search(self, query: SearchQuery) -> list[SearchHit]:
        q_tokens = tokenize(query.text)
        if not q_tokens:
            return []

        modes = set(MODE_EXPANSIONS[query.mode or "auto"])
        max_distance = (
            query.fuzzy_max_distance
            if query.fuzzy_max_distance is not None
            else DEFAULT_FUZZY_DISTANCE
        )
        raw = self._store.index.search(q_tokens, modes, max_distance)

        limit = query.limit if query.limit is not None else DEFAULT_LIMIT
        hits: list[SearchHit] = []
        now = self._now()

        for r in raw:
            chunk = self._store.get_chunk(r.chunk_id)
            if chunk is None:
                continue
            doc = self._store.get_document(chunk.document_id)
            if doc is None:
                continue

            # ── Filters ──
            if query.languages is not None and doc.language not in query.languages:
                continue
            if query.extensions is not None and doc.ext not in query.extensions:
                continue
            if query.kinds is not None and doc.kind not in query.kinds:
                continue
            if query.path_includes is not None and (
                query.path_includes.lower() not in doc.rel_path.lower()
            ):
                continue
            if query.filename is not None and query.filename.lower() not in doc.name.lower():
                continue

            # ── Boosts ──
            score = r.score
            reasons: dict[str, None] = dict.fromkeys(r.reasons)
            name_lower = doc.name.lower()
            path_lower = doc.rel_path.lower()
            symbols = {s.lower() for s in chunk.symbols}

            if any(t in name_lower for t in r.matched):
                score *= FILENAME_BOOST
                reasons["filename"] = None
            if any(t in path_lower for t in r.matched):
                score *= PATH_BOOST
                reasons["path"] = None
            if any(t in symbols or any(t in s for s in symbols) for t in r.matched):
                score *= SYMBOL_BOOST
                reasons["symbol"] = None
            if query.filename is not None:
                score *= FILENAME_FILTER_BOOST
                reasons["filename-filter"] = None

            age_days = max(0.0, (now - doc.modified_ms) / MS_PER_DAY)
            recency = 0.5 ** (age_days / RECENCY_HALFLIFE_DAYS)
            score *= 1 + RECENCY_WEIGHT * recency
            if recency > 0.5:
                reasons["recency"] = None

            hits.append(
                SearchHit(
                    chunk=chunk, document=doc, score=score,
                    matched_terms=r.matched, reasons=list(reasons),
                )
            )

        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]
