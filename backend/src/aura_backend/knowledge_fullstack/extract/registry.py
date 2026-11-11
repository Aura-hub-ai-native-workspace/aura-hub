"""ExtractorRegistry.

A port of packages/knowledge-fullstack/src/extract/registry.ts — runs the
applicable extractors for one file and augments the result with
cross-cutting environment references.
"""

from __future__ import annotations

from ..types import Entity, SourceFile
from .architecture import ArchitectureExtractor
from .backend import BackendExtractor
from .config import ConfigExtractor
from .database import DatabaseExtractor
from .extractor import Extractor, LineMap, env_refs, make_entity
from .frontend import FrontendExtractor


class ExtractorRegistry:
    def __init__(self, extractors: list[Extractor] | None = None) -> None:
        self._extractors: list[Extractor] = extractors if extractors is not None else [
            FrontendExtractor(), BackendExtractor(), DatabaseExtractor(),
            ConfigExtractor(), ArchitectureExtractor(),
        ]

    def run(self, file: SourceFile) -> list[Entity]:
        """Extract all entities for one real file."""
        lines = LineMap(file.text)
        out: list[Entity] = []
        seen: set[str] = set()

        for extractor in self._extractors:
            if not extractor.applies_to(file):
                continue
            for entity in extractor.extract(file, lines):
                if entity.id in seen:
                    continue
                seen.add(entity.id)
                out.append(entity)

        refs = env_refs(file.text)
        if refs:
            # Every entity in this file carries the same reference list —
            # the reference assigns the SAME array object to each, and
            # nothing mutates it afterwards.
            for entity in out:
                entity.metadata["envRefs"] = refs
            # Referenced variables become nodes even when no `.env`
            # declares them.
            for name in refs:
                entity_id = f"env-var:{file.rel_path}#{name}"
                if entity_id not in seen and not any(
                    e.kind == "env-var" and e.name == name for e in out
                ):
                    seen.add(entity_id)
                    out.append(make_entity(
                        "env-var", "config", name, file, 1,
                        f"env {name} (referenced)", None,
                        {"referencedIn": file.rel_path},
                    ))
        return out
