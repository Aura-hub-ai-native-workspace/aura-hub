"""ProjectGraphStore — the persistent system graph.

A port of packages/knowledge-fullstack/src/graph/graphStore.ts.

Entities are the source of truth (extracted per file, incrementally);
relations are a pure function of entities and are recomputed on every
index or update, so the graph is always consistent.

Entity keyword search REUSES the frozen Coding engine's `InvertedIndex` —
no new search stack, no vectors.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.js_number import js_number, to_js_numbers
from ..retrieval import InvertedIndex, RawHit, tokenize
from .types import Entity, Relation

SCHEMA_VERSION = 1


@dataclass
class FileRecord:
    rel_path: str
    checksum: str
    modified_ms: float
    size: int
    entity_ids: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"relPath": self.rel_path, "checksum": self.checksum,
                "modifiedMs": self.modified_ms, "size": self.size,
                "entityIds": list(self.entity_ids)}

    @staticmethod
    def from_json(raw: dict[str, Any]) -> FileRecord:
        return FileRecord(rel_path=raw["relPath"], checksum=raw["checksum"],
                          modified_ms=raw["modifiedMs"], size=raw["size"],
                          entity_ids=raw.get("entityIds") or [])


class ProjectGraphStore:
    def __init__(self, root: str, index_dir: str = ".aura-fullstack") -> None:
        self.root = str(Path(root).resolve())
        self._dir = (index_dir if os.path.isabs(index_dir)
                     else os.path.join(self.root, index_dir))
        self._entities: dict[str, Entity] = {}
        self._relations: dict[str, Relation] = {}
        self._out_adj: dict[str, dict[str, None]] = {}
        self._in_adj: dict[str, dict[str, None]] = {}
        self._files: dict[str, FileRecord] = {}
        self._name_index: dict[str, dict[str, None]] = {}
        self._keyword = InvertedIndex()

    # ── mutation (entities) ──────────────────────────────────────────

    def set_file_entities(
        self, rel_path: str, meta: dict[str, Any], entities: list[Entity]
    ) -> None:
        self.remove_file(rel_path)
        ids: list[str] = []
        for entity in entities:
            self._entities[entity.id] = entity
            ids.append(entity.id)
        self._files[rel_path] = FileRecord(
            rel_path=rel_path, checksum=meta["checksum"],
            modified_ms=meta["modifiedMs"], size=meta["size"], entity_ids=ids,
        )

    def remove_file(self, rel_path: str) -> bool:
        record = self._files.get(rel_path)
        if record is None:
            return False
        for entity_id in record.entity_ids:
            self._entities.pop(entity_id, None)
        del self._files[rel_path]
        return True

    # ── relations (recomputed wholesale by the linker) ───────────────

    def set_relations(self, relations: list[Relation]) -> None:
        self._relations.clear()
        self._out_adj.clear()
        self._in_adj.clear()
        for relation in relations:
            if (relation.from_id not in self._entities
                    or relation.to_id not in self._entities):
                continue  # drop dangling
            self._relations[relation.id] = relation
            self._out_adj.setdefault(relation.from_id, {})[relation.id] = None
            self._in_adj.setdefault(relation.to_id, {})[relation.id] = None

    def rebuild_indexes(self) -> None:
        """Rebuild the name and keyword indexes from the current entities."""
        self._name_index.clear()
        self._keyword = InvertedIndex()
        for entity in self._entities.values():
            lname = entity.name.lower()
            self._name_index.setdefault(lname, {})[entity.id] = None
            self._keyword.add(entity.id, self._search_text(entity))

    def _search_text(self, entity: Entity) -> str:
        values = list(entity.metadata.values())
        # `typeof v === 'string' || typeof v === 'number'` — a BOOLEAN is
        # neither, and Python's `isinstance(x, int)` is true for bools, so
        # they are excluded explicitly. Numbers are stringified the way
        # JavaScript stringifies them.
        def scalar(value: Any) -> bool:
            return isinstance(value, str) or (
                isinstance(value, (int, float)) and not isinstance(value, bool)
            )

        meta = " ".join(
            v if isinstance(v, str) else js_number(v)
            for v in values if scalar(v)
        )
        arrays = " ".join(
            item for v in values
            if isinstance(v, list) and all(isinstance(x, str) for x in v)
            for item in v
        )
        return (f"{entity.name} {entity.kind} {entity.layer} "
                f"{entity.summary or ''} {entity.rel_path} {meta} {arrays} "
                f"{entity.snippet or ''}")

    # ── access ───────────────────────────────────────────────────────

    def get_entity(self, entity_id: str) -> Entity | None:
        return self._entities.get(entity_id)

    def all_entities(self) -> list[Entity]:
        return list(self._entities.values())

    def all_relations(self) -> list[Relation]:
        return list(self._relations.values())

    def entities_by_name(self, name: str) -> list[Entity]:
        ids = self._name_index.get(name.lower(), {})
        return [self._entities[i] for i in ids if i in self._entities]

    def keyword_search(self, text: str, k: int) -> list[RawHit]:
        return self._keyword.search(
            tokenize(text), {"exact", "prefix", "fuzzy"}, 2
        )[:k]

    def out_relations(self, entity_id: str) -> list[Relation]:
        return [self._relations[r] for r in self._out_adj.get(entity_id, {})
                if r in self._relations]

    def in_relations(self, entity_id: str) -> list[Relation]:
        return [self._relations[r] for r in self._in_adj.get(entity_id, {})
                if r in self._relations]

    def manifest(self) -> dict[str, FileRecord]:
        return self._files

    def stats(self) -> dict[str, Any]:
        by_kind: dict[str, int] = {}
        by_layer: dict[str, int] = {}
        by_relation: dict[str, int] = {}
        for entity in self._entities.values():
            by_kind[entity.kind] = by_kind.get(entity.kind, 0) + 1
            by_layer[entity.layer] = by_layer.get(entity.layer, 0) + 1
        for relation in self._relations.values():
            by_relation[relation.kind] = by_relation.get(relation.kind, 0) + 1
        return {"entities": len(self._entities), "relations": len(self._relations),
                "files": len(self._files), "byKind": by_kind, "byLayer": by_layer,
                "byRelation": by_relation}

    # ── persistence ──────────────────────────────────────────────────

    def _file(self, name: str) -> str:
        return os.path.join(self._dir, name)

    def save(self, updated_ms: float) -> None:
        os.makedirs(self._dir, exist_ok=True)

        def write_atomic(name: str, data: Any) -> None:
            # The reference writes to `<name>.tmp` in the same directory
            # then renames — the same crash-safety property, without the
            # predictable temp name.
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=f".{name}.", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(to_js_numbers(data), handle, ensure_ascii=False,
                          separators=(",", ":"))
            os.replace(tmp, self._file(name))

        write_atomic("meta.json", {"version": SCHEMA_VERSION, "root": self.root,
                                   "updatedMs": updated_ms})
        write_atomic("entities.json", [e.to_json() for e in self._entities.values()])
        write_atomic("relations.json", [r.to_json() for r in self._relations.values()])
        write_atomic("files.json", [f.to_json() for f in self._files.values()])

    def load(self) -> bool:
        try:
            with open(self._file("meta.json"), encoding="utf-8") as handle:
                meta = json.load(handle)
            if meta.get("version") != SCHEMA_VERSION:
                return False
            with open(self._file("entities.json"), encoding="utf-8") as handle:
                entities = json.load(handle)
            with open(self._file("relations.json"), encoding="utf-8") as handle:
                relations = json.load(handle)
            with open(self._file("files.json"), encoding="utf-8") as handle:
                files = json.load(handle)
            for raw in entities:
                entity = Entity.from_json(raw)
                self._entities[entity.id] = entity
            for raw in files:
                record = FileRecord.from_json(raw)
                self._files[record.rel_path] = record
            self.rebuild_indexes()
            self.set_relations([Relation.from_json(r) for r in relations])
            return True
        except (OSError, ValueError, KeyError):
            return False
