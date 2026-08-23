"""The retrieval engine's public API.

A port of packages/knowledge-coding/src/engine.ts.

Ties the pipeline together over a real workspace:

    index()       full index of the filesystem
    update()      incremental — added / modified / deleted only
    search()      keyword search (exact / prefix / fuzzy, plus filters)
    get_context() assembled context: matches, neighbours, metadata

No mock data — everything runs against real files.
"""

from __future__ import annotations

from pathlib import Path
from threading import Event

from .context import ContextBuilder
from .ignore import IgnoreConfig, IgnoreRules
from .indexer import CodingIndexer
from .search import CodingSearch
from .store import JsonKnowledgeStore
from .types import CodeDocument, CodingContext, IndexDelta, IndexStats, SearchHit, SearchQuery


class CodingKnowledgeEngine:
    def __init__(
        self,
        root: str,
        index_dir: str = ".aura-index",
        project_name: str | None = None,
        ignore: IgnoreConfig | None = None,
        now_ms=None,
    ) -> None:
        self.root = str(Path(root).resolve())
        self.store = JsonKnowledgeStore(self.root, index_dir)
        self._rules = IgnoreRules(ignore)
        self._indexer = CodingIndexer(self.store, now_ms)
        self._searcher = CodingSearch(self.store, now_ms)
        self.project_name = project_name or Path(self.root).name
        self._context = ContextBuilder(self.store, self.project_name)

    def load(self) -> bool:
        """Load a previously persisted index, if present."""
        return self.store.load()

    def index(self, cancel: Event | None = None) -> IndexStats:
        return self._indexer.full_index(self.root, self._rules, cancel)

    def update(self, cancel: Event | None = None) -> IndexDelta:
        return self._indexer.incremental(self.root, self._rules, cancel)

    def search(self, query: SearchQuery) -> list[SearchHit]:
        return self._searcher.search(query)

    def get_context(
        self,
        query: SearchQuery,
        neighbors: int = 1,
        max_tokens: int = 6000,
        limit: int = 8,
    ) -> CodingContext:
        # The reference widens the hit limit to 30 before grouping, so the
        # context builder can see several chunks per document.
        widened = SearchQuery(**{**query.__dict__, "limit": query.limit or 30})
        hits = self._searcher.search(widened)
        return self._context.build(
            query.text, hits, neighbors=neighbors, max_tokens=max_tokens, limit=limit
        )

    def stats(self) -> dict[str, int]:
        return self.store.stats()

    def documents(self) -> list[CodeDocument]:
        return self.store.all_documents()
