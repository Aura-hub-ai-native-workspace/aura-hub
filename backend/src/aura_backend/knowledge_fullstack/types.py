"""@aura/knowledge-fullstack — System Vocabulary.

A port of packages/knowledge-fullstack/src/types.ts.

Where the Coding engine models *files and chunks*, the FullStack engine
models a *system*: typed entities across every layer and the
relationships between them. Entities are the source of truth; the
relationship graph is derived from them by the linker.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

LAYERS = ("frontend", "backend", "database", "config", "infra", "deployment",
          "docs", "architecture")

ENTITY_KINDS = (
    # frontend
    "page", "component", "layout", "hook", "route", "asset", "api-client",
    "state-store",
    # backend
    "endpoint", "controller", "service", "repository", "middleware", "auth-guard",
    # database
    "orm-model", "table", "migration",
    # config / infra / deploy
    "env-var", "dependency", "dockerfile", "compose-service", "ci-pipeline",
    "build-config",
    # docs / architecture
    "arch-module", "doc",
)

RELATION_KINDS = (
    "renders", "imports", "uses-hook", "defines-route", "calls-endpoint",
    "handles", "uses-service", "uses-repository", "maps-to-table", "foreign-key",
    "migrates", "configures", "depends-on", "documents", "secured-by", "runs-in",
)

QUERY_INTENTS = ("keyword", "where-implemented", "callers-of", "stores",
                 "related-to", "dependencies-of")


@dataclass
class Entity:
    """One typed thing, extracted from one real file."""

    # Stable id: `${kind}:${relPath}#${name}`.
    id: str
    kind: str
    layer: str
    name: str
    rel_path: str
    line: int | None = None
    language: str | None = None
    # One-line human description.
    summary: str | None = None
    # Source snippet for search + context.
    snippet: str | None = None
    # Raw extracted signals the linker later resolves into relationships.
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        # `JSON.stringify` drops keys whose value is `undefined`, which is
        # what an absent `line`, `summary` or `snippet` is in the
        # reference — so they are omitted rather than sent as null.
        payload: dict[str, Any] = {"id": self.id, "kind": self.kind,
                                   "layer": self.layer, "name": self.name,
                                   "relPath": self.rel_path}
        if self.line is not None:
            payload["line"] = self.line
        if self.language is not None:
            payload["language"] = self.language
        if self.summary is not None:
            payload["summary"] = self.summary
        if self.snippet is not None:
            payload["snippet"] = self.snippet
        payload["metadata"] = self.metadata
        return payload

    @staticmethod
    def from_json(raw: dict[str, Any]) -> Entity:
        return Entity(
            id=raw["id"], kind=raw["kind"], layer=raw["layer"], name=raw["name"],
            rel_path=raw["relPath"], line=raw.get("line"),
            language=raw.get("language"), summary=raw.get("summary"),
            snippet=raw.get("snippet"), metadata=raw.get("metadata") or {},
        )


@dataclass
class Relation:
    # Stable id: `${from}|${kind}|${to}`.
    id: str
    from_id: str
    to_id: str
    kind: str
    # 0..1 — how sure the linker is about this edge.
    confidence: float
    evidence: str | None = None
    rel_path: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"id": self.id, "from": self.from_id,
                                   "to": self.to_id, "kind": self.kind,
                                   "confidence": self.confidence}
        if self.evidence is not None:
            payload["evidence"] = self.evidence
        if self.rel_path is not None:
            payload["relPath"] = self.rel_path
        return payload

    @staticmethod
    def from_json(raw: dict[str, Any]) -> Relation:
        return Relation(
            id=raw["id"], from_id=raw["from"], to_id=raw["to"], kind=raw["kind"],
            confidence=raw["confidence"], evidence=raw.get("evidence"),
            rel_path=raw.get("relPath"),
        )


@dataclass
class SourceFile:
    rel_path: str
    abs_path: str
    name: str
    ext: str
    language: str
    kind: str
    text: str
    size: int
    checksum: str
    modified_ms: float


@dataclass
class SystemQuery:
    text: str
    # Force a specific interpretation; otherwise inferred from phrasing.
    intent: str | None = None
    layers: list[str] | None = None
    kinds: list[str] | None = None
    limit: int | None = None
    # Graph traversal depth for relationship queries.
    depth: int | None = None


@dataclass
class EntityHit:
    entity: Entity
    score: float
    reasons: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"entity": self.entity.to_json(), "score": self.score,
                "reasons": list(self.reasons)}


@dataclass
class RelationPath:
    """A resolved relationship chain between entities."""

    entities: list[Entity] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"entities": [e.to_json() for e in self.entities],
                "relations": [r.to_json() for r in self.relations]}


@dataclass
class SystemAnswer:
    query: str
    intent: str
    hits: list[EntityHit] = field(default_factory=list)
    # Cross-layer chains discovered for relationship queries.
    paths: list[RelationPath] = field(default_factory=list)
    # Directly-related entities (1 hop) for the top hit.
    related: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "query": self.query, "intent": self.intent,
            "hits": [h.to_json() for h in self.hits],
            "paths": [p.to_json() for p in self.paths],
            "related": [{"relation": r["relation"].to_json(),
                         "entity": r["entity"].to_json()} for r in self.related],
        }
