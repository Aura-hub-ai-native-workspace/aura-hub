"""FullStackIndexer — real filesystem → project graph.

A port of packages/knowledge-fullstack/src/indexer.ts.

REUSES the frozen Coding Knowledge Engine's scanner, ignore rules and
safe reader — no re-implementation — then runs the extractor registry per
file and re-links the whole graph. Relations are recomputed on every run,
so the graph is consistent after an incremental update.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Event
from typing import Any

from ..retrieval import IgnoreRules, WorkspaceScanner, detect_kind, detect_language, read_file_safe
from .extract.registry import ExtractorRegistry
from .graph_store import ProjectGraphStore
from .linker import RelationLinker
from .types import SourceFile


class AnalysisCancelled(Exception):
    """The reference throws an `Error` whose `name` is `AbortError`."""


@dataclass
class AnalyzeOptions:
    on_progress: Callable[[dict[str, Any]], None] | None = None
    cancel: Event | None = None


def _ext_of(name: str) -> str:
    dot = name.rfind(".")
    return "" if dot <= 0 else name[dot:]


class FullStackIndexer:
    def __init__(
        self, store: ProjectGraphStore, registry: ExtractorRegistry,
        linker: RelationLinker,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._registry = registry
        self._linker = linker
        self._now = now if now is not None else lambda: time.time() * 1000

    def _build_file(self, entry: Any, rules: IgnoreRules) -> dict[str, Any]:
        read = read_file_safe(entry.abs_path, rules.max_file_bytes)
        if not read.ok:
            error = read.error or {}
            return {"error": {
                "relPath": entry.rel_path,
                "code": error.get("code") or "EREAD",
                "message": error.get("message") or "read failed",
            }}
        if read.binary or not read.text:
            return {"skip": True, "checksum": read.checksum}
        name = os.path.basename(entry.rel_path)
        ext = _ext_of(name)
        language = detect_language(name, ext)
        return {"file": SourceFile(
            rel_path=entry.rel_path, abs_path=entry.abs_path, name=name, ext=ext,
            language=language, kind=detect_kind(name, language), text=read.text,
            size=entry.size, checksum=read.checksum, modified_ms=entry.modified_ms,
        )}

    def _relink(self) -> None:
        self._store.set_relations(self._linker.link(self._store.all_entities()))
        self._store.rebuild_indexes()

    def analyze(
        self, root: str, rules: IgnoreRules, opts: AnalyzeOptions | None = None
    ) -> dict[str, Any]:
        opts = opts or AnalyzeOptions()
        start = self._now()
        scan = WorkspaceScanner(rules).scan(root, opts.cancel)

        errors: list[dict[str, Any]] = [e.to_json() for e in scan.errors]
        by_kind: dict[str, int] = {}
        by_layer: dict[str, int] = {}
        files = 0
        total_bytes = 0
        entity_count = 0
        seen: set[str] = set()

        index = 0
        for entry in scan.entries:
            if opts.cancel is not None and opts.cancel.is_set():
                raise AnalysisCancelled("Analysis cancelled")
            index += 1
            if opts.on_progress:
                opts.on_progress({"phase": "analyze", "processed": index,
                                  "total": len(scan.entries), "path": entry.rel_path})
            built = self._build_file(entry, rules)
            seen.add(entry.rel_path)
            if built.get("error"):
                errors.append(built["error"])
                continue
            if not built.get("file"):
                continue
            source = built["file"]
            entities = self._registry.run(source)
            self._store.set_file_entities(
                source.rel_path,
                {"checksum": source.checksum, "modifiedMs": source.modified_ms,
                 "size": source.size},
                entities,
            )
            files += 1
            total_bytes += source.size
            entity_count += len(entities)
            for entity in entities:
                by_kind[entity.kind] = by_kind.get(entity.kind, 0) + 1
                by_layer[entity.layer] = by_layer.get(entity.layer, 0) + 1

        for rel in list(self._store.manifest()):
            if rel not in seen:
                self._store.remove_file(rel)

        if opts.on_progress:
            opts.on_progress({"phase": "link", "processed": entity_count})
        self._relink()
        if opts.on_progress:
            opts.on_progress({"phase": "persist", "processed": files})
        self._store.save(self._now())
        if opts.on_progress:
            opts.on_progress({"phase": "done", "processed": files})

        stats = self._store.stats()
        return {"files": files, "entities": stats["entities"],
                "relations": stats["relations"], "bytes": total_bytes,
                "skipped": scan.skipped, "errors": errors,
                "durationMs": self._now() - start,
                "byKind": by_kind, "byLayer": by_layer}

    def update(
        self, root: str, rules: IgnoreRules, opts: AnalyzeOptions | None = None
    ) -> dict[str, Any]:
        opts = opts or AnalyzeOptions()
        start = self._now()
        before = self._store.stats()
        scan = WorkspaceScanner(rules).scan(root, opts.cancel)
        manifest = self._store.manifest()
        errors: list[dict[str, Any]] = [e.to_json() for e in scan.errors]

        files_added = files_modified = files_unchanged = 0
        seen: set[str] = set()

        index = 0
        for entry in scan.entries:
            if opts.cancel is not None and opts.cancel.is_set():
                raise AnalysisCancelled("Update cancelled")
            seen.add(entry.rel_path)
            index += 1
            if opts.on_progress:
                opts.on_progress({"phase": "analyze", "processed": index,
                                  "total": len(scan.entries), "path": entry.rel_path})
            record = manifest.get(entry.rel_path)
            if (record and record.size == entry.size
                    and record.modified_ms == entry.modified_ms):
                files_unchanged += 1
                continue

            built = self._build_file(entry, rules)
            if built.get("error"):
                errors.append(built["error"])
                continue
            if built.get("skip"):
                # Binary or skipped: refresh the metadata when the content
                # is identical, so it is not re-read every run.
                if record and record.checksum == built.get("checksum"):
                    record.modified_ms = entry.modified_ms
                    record.size = entry.size
                    files_unchanged += 1
                continue
            if not built.get("file"):
                continue
            source = built["file"]
            if record and record.checksum == source.checksum:
                record.modified_ms = entry.modified_ms
                record.size = entry.size
                files_unchanged += 1
                continue
            entities = self._registry.run(source)
            self._store.set_file_entities(
                source.rel_path,
                {"checksum": source.checksum, "modifiedMs": source.modified_ms,
                 "size": source.size},
                entities,
            )
            if record:
                files_modified += 1
            else:
                files_added += 1

        files_deleted = 0
        for rel in list(manifest):
            if rel not in seen:
                self._store.remove_file(rel)
                files_deleted += 1

        if opts.on_progress:
            opts.on_progress({"phase": "link", "processed": 0})
        self._relink()
        if opts.on_progress:
            opts.on_progress({"phase": "persist", "processed": 0})
        self._store.save(self._now())
        if opts.on_progress:
            opts.on_progress({"phase": "done", "processed": 0})

        after = self._store.stats()
        return {
            "filesAdded": files_added, "filesModified": files_modified,
            "filesDeleted": files_deleted, "filesUnchanged": files_unchanged,
            "entitiesBefore": before["entities"], "entitiesAfter": after["entities"],
            "relationsBefore": before["relations"],
            "relationsAfter": after["relations"],
            "durationMs": self._now() - start, "errors": errors,
        }
