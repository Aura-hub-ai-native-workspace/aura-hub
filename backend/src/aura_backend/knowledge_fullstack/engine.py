"""FullStackKnowledgeEngine — the production public API.

A port of packages/knowledge-fullstack/src/engine.ts.

Understands an entire software system over a real workspace:
`analyze()` for a full pass, `update()` for an incremental one,
`search()` for cross-layer graph-aware questions, `graph()` for the
entities and relationships, and `to_context_package()` for the bridge
into the frozen retrieval layer.

Reuses the frozen Coding Knowledge Engine. No embeddings, no vector
search, no mock data.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..retrieval import IgnoreConfig, IgnoreRules, estimate_tokens
from .extract.registry import ExtractorRegistry
from .graph_store import ProjectGraphStore
from .indexer import AnalyzeOptions, FullStackIndexer
from .linker import RelationLinker
from .search import FullStackSearch
from .types import Entity, SystemAnswer, SystemQuery

LAYER_CATEGORY: dict[str, str] = {
    "frontend": "frontend",
    "backend": "backend",
    "database": "database",
    "config": "architecture",
    "infra": "deployment",
    "deployment": "deployment",
    "docs": "documentation",
    "architecture": "architecture",
}


class FullStackKnowledgeEngine:
    def __init__(
        self, root: str, index_dir: str | None = None, project_name: str | None = None,
        ignore: IgnoreConfig | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self.root = str(Path(root).resolve())
        self.store = ProjectGraphStore(
            self.root, index_dir if index_dir is not None else ".aura-fullstack"
        )
        self._rules = IgnoreRules(ignore)
        self._indexer = FullStackIndexer(
            self.store, ExtractorRegistry(), RelationLinker(), now
        )
        self._searcher = FullStackSearch(self.store)
        self.project_name = (project_name if project_name is not None
                             else Path(self.root).name)
        self._now = now if now is not None else lambda: time.time() * 1000

    def load(self) -> bool:
        return self.store.load()

    def analyze(self, opts: AnalyzeOptions | None = None) -> dict[str, Any]:
        return self._indexer.analyze(self.root, self._rules, opts)

    def update(self, opts: AnalyzeOptions | None = None) -> dict[str, Any]:
        return self._indexer.update(self.root, self._rules, opts)

    def search(self, query: SystemQuery) -> SystemAnswer:
        return self._searcher.answer(query)

    def graph(self) -> dict[str, Any]:
        return {"entities": self.store.all_entities(),
                "relations": self.store.all_relations(),
                "stats": self.store.stats()}

    def entity(self, entity_id: str) -> Entity | None:
        return self.store.get_entity(entity_id)

    def stats(self) -> dict[str, Any]:
        return self.store.stats()

    def to_context_package(
        self, answer: SystemAnswer, max_tokens: int = 6000,
        assembled_at: float | None = None,
    ) -> dict[str, Any]:
        """Bridge a `SystemAnswer` into the frozen retrieval ContextPackage."""
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        stamp = assembled_at if assembled_at is not None else self._now()

        def push(entity: Entity, score: float) -> None:
            if entity.id in seen:
                return
            seen.add(entity.id)
            snippet = entity.snippet or entity.summary or f"{entity.kind} {entity.name}"
            items.append({
                "id": entity.id,
                "title": (f"{entity.kind}: {entity.name} — {entity.rel_path}"
                          + (f":{entity.line}" if entity.line else "")),
                "snippet": snippet,
                "kind": "fullstack",
                "category": LAYER_CATEGORY[entity.layer],
                "sourceEngine": "fullstack-engine",
                "ref": entity.rel_path,
                "score": score,
                "tokens": estimate_tokens(snippet),
                "updatedAt": stamp,
            })

        for hit in answer.hits:
            push(hit.entity, hit.score)
        for path in answer.paths:
            for entity in path.entities:
                push(entity, 0.5)

        total = sum(i["tokens"] for i in items)
        return {
            "query": answer.query, "items": items, "totalTokens": total,
            "budget": {"maxTokens": max_tokens, "usedTokens": total,
                       "truncated": total > max_tokens},
            "byEngine": {"fullstack-engine": len(items)},
            "truncated": total > max_tokens,
            "assembledAt": stamp,
        }
