"""FullStackSearch — cross-layer, graph-aware search.

A port of packages/knowledge-fullstack/src/search.ts.

Answers system questions by combining keyword matching over entities with
relationship traversal. Intent is inferred from phrasing, or forced by the
query. No AI.
"""

from __future__ import annotations

import functools
from typing import Any

from ..core import js_regex
from .graph_store import ProjectGraphStore
from .types import Entity, EntityHit, Relation, RelationPath, SystemAnswer, SystemQuery

DEP_EDGES = ("uses-service", "uses-repository", "maps-to-table", "depends-on",
             "calls-endpoint", "handles", "foreign-key")

RELATED_EDGES = ("renders", "imports", "calls-endpoint", "handles", "uses-service",
                 "uses-repository", "maps-to-table", "depends-on", "configures",
                 "documents", "foreign-key", "migrates")

IMPL_KINDS = ("auth-guard", "middleware", "controller", "service", "endpoint",
              "repository")

STOP = frozenset({
    "where", "is", "are", "the", "implemented", "implement", "defined", "how",
    "which", "find", "show", "every", "everything", "related", "connected",
    "associated", "to", "of", "a", "an", "this", "that", "does", "do", "in",
    "for", "me", "all", "and", "call", "calls", "called", "stored", "store",
    "stores", "depend", "depends", "dependency", "dependencies", "what", "who",
    "page", "endpoint", "table", "database", "frontend", "backend",
})

_I_DEPENDENCIES = js_regex.compile(
    r"\bdepend(?:s|ency|encies)?\s+of\b|dependencies of|what does .* (use|depend)"
)
_I_CALLERS = js_regex.compile(
    r"which .*(page|component|frontend|client).*(call|use)|who calls|callers? of|"
    r"what calls"
)
_I_STORES = js_regex.compile(
    r"which .*(table|database|db).*(store|hold|save)|where (is|are).*stored|"
    r"table stores"
)
_I_WHERE = js_regex.compile(
    r"where (is|are).*(implement|defined|handled)|how is .* implement"
)
_I_RELATED = js_regex.compile(
    r"everything|related to|connected to|show all|associated"
)
_WORDS = js_regex.compile(r"[a-z0-9]+", "g")
_PASCAL = js_regex.compile(r"\b([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+)\b", "g")
_QUOTED = js_regex.compile(r"[\"'`]([^\"'`]+)[\"'`]", "g")
_API_PATH = js_regex.compile(r"(/(?:api|v\d+)/[A-Za-z0-9_\-/:${}.]*)")
_ANY_PATH = js_regex.compile(r"(/[A-Za-z][A-Za-z0-9_\-/]{2,})")
_PLACEHOLDER = js_regex.compile(r"^[:{<$]|^\d+$")
_WHITESPACE = js_regex.compile(r"\s")


class FullStackSearch:
    def __init__(self, store: ProjectGraphStore) -> None:
        self._store = store

    def _infer_intent(self, text: str) -> str:
        lowered = text.lower()
        if _I_DEPENDENCIES.search(lowered):
            return "dependencies-of"
        if _I_CALLERS.search(lowered):
            return "callers-of"
        if _I_STORES.search(lowered):
            return "stores"
        if _I_WHERE.search(lowered):
            return "where-implemented"
        if _I_RELATED.search(lowered):
            return "related-to"
        return "keyword"

    def _keyword_hits(self, text: str, k: int) -> list[EntityHit]:
        out: list[EntityHit] = []
        for hit in self._store.keyword_search(text, k):
            entity = self._store.get_entity(hit.chunk_id)
            if entity:
                out.append(EntityHit(entity=entity, score=hit.score,
                                     reasons=list(hit.reasons)))
        return out

    def _content_words(self, text: str) -> list[str]:
        found = [m.group(0) for m in _WORDS.finditer(text.lower())]
        return list(dict.fromkeys(w for w in found if len(w) >= 3 and w not in STOP))

    def _lexical_scan(self, words: list[str]) -> list[EntityHit]:
        """A token scan across entities — bridges "authentication" ↔ "AuthGuard"."""
        if not words:
            return []
        out: list[EntityHit] = []
        for entity in self._store.all_entities():
            haystack = f"{entity.name} {entity.rel_path} {entity.summary or ''}".lower()
            tokens = list(dict.fromkeys(
                t for t in (m.group(0) for m in _WORDS.finditer(haystack))
                if len(t) >= 3
            ))
            score = 0.0
            for word in words:
                for token in tokens:
                    if token == word:
                        score += 1
                        break
                    if word in token or token in word:
                        score += 0.6
                        break
            if score > 0:
                out.append(EntityHit(entity=entity, score=score, reasons=["lexical"]))
        # A stable descending sort, as `Array.prototype.sort` is.
        return sorted(out, key=functools.cmp_to_key(
            lambda a, b: (b.score > a.score) - (b.score < a.score)
        ))

    def _names_in(self, text: str) -> list[str]:
        pascal = [m.group(1) for m in _PASCAL.finditer(text)]
        quoted = [m.group(1) for m in _QUOTED.finditer(text)]
        return list(dict.fromkeys([*pascal, *quoted]))

    def _path_in(self, text: str) -> str | None:
        match = _API_PATH.search(text)
        if match:
            return match.group(1)
        match = _ANY_PATH.search(text)
        return match.group(1) if match else None

    def _resolve_seeds(self, query: SystemQuery) -> list[Entity]:
        seeds: dict[str, Entity] = {}
        for name in self._names_in(query.text):
            for entity in self._store.entities_by_name(name):
                seeds[entity.id] = entity
        if not seeds:
            for hit in self._keyword_hits(query.text, 6):
                seeds[hit.entity.id] = hit.entity
        if not seeds:
            for hit in self._lexical_scan(self._content_words(query.text))[:6]:
                seeds[hit.entity.id] = hit.entity
        return list(seeds.values())

    def _traverse(
        self, seed_ids: list[str], kinds: tuple[str, ...], direction: str, depth: int
    ) -> dict[str, Any]:
        visited: dict[str, None] = dict.fromkeys(seed_ids)
        relations: dict[str, Relation] = {}
        parent: dict[str, dict[str, Any]] = {}
        frontier = list(seed_ids)

        for _ in range(depth):
            if not frontier:
                break
            nxt: list[str] = []
            for entity_id in frontier:
                out = ([r for r in self._store.out_relations(entity_id)
                        if r.kind in kinds] if direction != "in" else [])
                inc = ([r for r in self._store.in_relations(entity_id)
                        if r.kind in kinds] if direction != "out" else [])
                for relation in out:
                    relations[relation.id] = relation
                    if relation.to_id not in visited:
                        visited[relation.to_id] = None
                        parent[relation.to_id] = {"rel": relation, "from": entity_id}
                        nxt.append(relation.to_id)
                for relation in inc:
                    relations[relation.id] = relation
                    if relation.from_id not in visited:
                        visited[relation.from_id] = None
                        parent[relation.from_id] = {"rel": relation, "from": entity_id}
                        nxt.append(relation.from_id)
            frontier = nxt

        def path_to(entity_id: str) -> RelationPath:
            entities: list[Entity] = []
            rels: list[Relation] = []
            current: str | None = entity_id
            guard: set[str] = set()
            while current and current not in guard:
                guard.add(current)
                entity = self._store.get_entity(current)
                if entity:
                    entities.insert(0, entity)
                step = parent.get(current)
                if not step:
                    break
                rels.insert(0, step["rel"])
                current = step["from"]
            return RelationPath(entities=entities, relations=rels)

        return {"visited": list(visited), "relations": list(relations.values()),
                "pathTo": path_to}

    def _related(self, entity_id: str) -> list[dict[str, Any]]:
        out = [{"relation": r, "entity": self._store.get_entity(r.to_id)}
               for r in self._store.out_relations(entity_id)]
        inc = [{"relation": r, "entity": self._store.get_entity(r.from_id)}
               for r in self._store.in_relations(entity_id)]
        return [x for x in [*out, *inc] if x["entity"]]

    def answer(self, query: SystemQuery) -> SystemAnswer:
        intent = query.intent or self._infer_intent(query.text)
        limit = query.limit if query.limit is not None else 12
        depth = query.depth if query.depth is not None else (
            4 if intent == "dependencies-of" else 2 if intent == "related-to" else 3
        )
        hits: list[EntityHit] = []
        paths: list[RelationPath] = []

        if intent == "callers-of":
            hits, paths = self._callers_of(query)
        elif intent == "dependencies-of":
            hits, paths = self._dependencies_of(query, depth)
        elif intent == "stores":
            hits, paths = self._stores(query, limit)
        elif intent == "where-implemented":
            hits, paths = self._where_implemented(query, limit)
        else:
            hits, paths = self._keyword_or_related(query, limit, depth)

        filtered = [
            h for h in hits
            if (query.layers is None or h.entity.layer in query.layers)
            and (query.kinds is None or h.entity.kind in query.kinds)
        ]
        ordered = sorted(filtered, key=functools.cmp_to_key(
            lambda a, b: (b.score > a.score) - (b.score < a.score)
        ))[:limit]
        top = ordered[0] if ordered else None
        return SystemAnswer(
            query=query.text, intent=intent, hits=ordered, paths=paths[:12],
            related=self._related(top.entity.id)[:12] if top else [],
        )

    def _callers_of(self, query: SystemQuery) -> tuple[list[EntityHit], list[RelationPath]]:
        hits: list[EntityHit] = []
        paths: list[RelationPath] = []
        path = self._path_in(query.text)
        endpoints: list[Entity] = []
        if path:
            normalized = "/" + "/".join(
                "*" if _PLACEHOLDER.search(s) else s.lower()
                for s in path.split("/") if s
            )
            endpoints = [
                e for e in self._store.all_entities()
                if e.kind == "endpoint" and "/" + "/".join(
                    "*" if _PLACEHOLDER.search(s) else s.lower()
                    for s in _WHITESPACE.split(
                        str(e.metadata.get("path") or e.name)
                    )[-1].split("/") if s
                ) == normalized
            ]
        if not endpoints:
            endpoints = [h.entity for h in self._keyword_hits(query.text, 6)
                         if h.entity.kind == "endpoint"]
        for endpoint in endpoints:
            for relation in self._store.in_relations(endpoint.id):
                if relation.kind != "calls-endpoint":
                    continue
                caller = self._store.get_entity(relation.from_id)
                if caller:
                    hits.append(EntityHit(entity=caller, score=relation.confidence,
                                          reasons=["calls-endpoint"]))
                    paths.append(RelationPath(entities=[caller, endpoint],
                                              relations=[relation]))
        if not hits and endpoints:
            hits.append(EntityHit(entity=endpoints[0], score=1, reasons=["endpoint"]))
        return hits, paths

    def _dependencies_of(
        self, query: SystemQuery, depth: int
    ) -> tuple[list[EntityHit], list[RelationPath]]:
        paths: list[RelationPath] = []
        seeds = self._resolve_seeds(query)
        seed_ids = {s.id for s in seeds}
        traversal = self._traverse([s.id for s in seeds], DEP_EDGES, "out", depth)
        hits = [
            EntityHit(entity=entity, score=1 if entity.id in seed_ids else 0.6,
                      reasons=["graph"])
            for entity in (self._store.get_entity(i) for i in traversal["visited"])
            if entity
        ]
        for entity_id in traversal["visited"]:
            if entity_id in seed_ids:
                continue
            path = traversal["pathTo"](entity_id)
            if path.relations:
                paths.append(path)
        return hits, paths

    def _stores(
        self, query: SystemQuery, limit: int
    ) -> tuple[list[EntityHit], list[RelationPath]]:
        paths: list[RelationPath] = []
        words = self._content_words(query.text)
        hits = [h for h in self._keyword_hits(query.text, limit * 2)
                if h.entity.kind in ("table", "orm-model")]
        if not hits:
            hits = [h for h in self._lexical_scan(words)
                    if h.entity.kind in ("table", "orm-model")]
        if not hits:
            hits = self._keyword_hits(query.text, limit)
        for hit in hits[:4]:
            for relation in [*self._store.in_relations(hit.entity.id),
                             *self._store.out_relations(hit.entity.id)]:
                other = self._store.get_entity(
                    relation.to_id if relation.from_id == hit.entity.id
                    else relation.from_id
                )
                if other:
                    paths.append(RelationPath(entities=[hit.entity, other],
                                              relations=[relation]))
        return hits, paths

    def _where_implemented(
        self, query: SystemQuery, limit: int
    ) -> tuple[list[EntityHit], list[RelationPath]]:
        paths: list[RelationPath] = []
        words = self._content_words(query.text)
        merged: dict[str, EntityHit] = {}
        for hit in [*self._keyword_hits(query.text, limit * 2),
                    *self._lexical_scan(words)]:
            merged.setdefault(hit.entity.id, hit)
        everything = list(merged.values())
        hits = [
            h for h in everything
            if h.entity.kind in IMPL_KINDS
            or any(w in f"{h.entity.name} {h.entity.rel_path}".lower() for w in words)
        ]
        if not hits:
            hits = everything
        for hit in hits[:5]:
            for rel in self._related(hit.entity.id)[:4]:
                paths.append(RelationPath(entities=[hit.entity, rel["entity"]],
                                          relations=[rel["relation"]]))
        return hits, paths

    def _keyword_or_related(
        self, query: SystemQuery, limit: int, depth: int
    ) -> tuple[list[EntityHit], list[RelationPath]]:
        paths: list[RelationPath] = []
        seeds = self._resolve_seeds(query)
        seed_ids = {s.id for s in seeds}
        seed_hits = [EntityHit(entity=e, score=1, reasons=["name"]) for e in seeds]
        keyword = self._keyword_hits(query.text, limit)
        traversal = self._traverse([s.id for s in seeds], RELATED_EDGES, "both", depth)
        graph_hits = [
            EntityHit(entity=entity, score=0.5, reasons=["graph"])
            for entity in (self._store.get_entity(i) for i in traversal["visited"]
                           if i not in seed_ids)
            if entity
        ]
        merged: dict[str, EntityHit] = {}
        for hit in [*seed_hits, *keyword, *graph_hits]:
            merged.setdefault(hit.entity.id, hit)
        for entity_id in traversal["visited"]:
            path = traversal["pathTo"](entity_id)
            if path.relations:
                paths.append(path)
        return list(merged.values()), paths
