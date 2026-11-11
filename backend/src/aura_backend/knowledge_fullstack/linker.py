"""RelationLinker — turns entities into a cross-layer graph.

A port of packages/knowledge-fullstack/src/link/linker.ts.

This is where "understanding" happens: frontend API usage is connected to
backend endpoints, endpoints to controllers, controllers to services,
services to repositories and models, models to tables, tables to tables,
code to env vars and dependencies, and architecture docs to the code they
describe.

Relations are a PURE FUNCTION of the entity set, so re-linking after an
incremental update always yields a consistent graph. No AI, no I/O.
"""

from __future__ import annotations

import os

from ..core import js_regex
from .types import Entity, Relation

_PLACEHOLDER = js_regex.compile(r"^[:{<$]|\$\{|^\d+$")
_REPO_SUFFIX = js_regex.compile(r"(Repository|Repo)$")

CLASS_KINDS = ("controller", "service", "repository", "auth-guard")
COMPONENT_KINDS = ("component", "page", "layout")


def norm_path(path: str) -> str:
    segments = [s for s in path.split("/") if s]
    return "/" + "/".join(
        "*" if _PLACEHOLDER.search(segment) else segment.lower()
        for segment in segments
    )


class RelationLinker:
    def link(self, entities: list[Entity]) -> list[Relation]:
        rels: list[Relation] = []
        seen: set[str] = set()

        def add(from_id: str, to_id: str, kind: str, confidence: float,
                evidence: str | None = None, rel_path: str | None = None) -> None:
            if from_id == to_id:
                return
            relation_id = f"{from_id}|{kind}|{to_id}"
            if relation_id in seen:
                return
            seen.add(relation_id)
            rels.append(Relation(id=relation_id, from_id=from_id, to_id=to_id,
                                 kind=kind, confidence=confidence,
                                 evidence=evidence, rel_path=rel_path))

        by_class_name: dict[str, Entity] = {}
        by_component_name: dict[str, Entity] = {}
        by_hook_name: dict[str, Entity] = {}
        table_by_name: dict[str, Entity] = {}
        model_by_name: dict[str, Entity] = {}
        env_by_name: dict[str, list[Entity]] = {}
        dep_by_name: dict[str, list[Entity]] = {}

        for entity in entities:
            if entity.kind in CLASS_KINDS:
                by_class_name[entity.metadata.get("className") or entity.name] = entity
            if entity.kind in COMPONENT_KINDS:
                by_component_name[entity.name] = entity
            if entity.kind == "hook":
                by_hook_name[entity.name] = entity
            if entity.kind == "table":
                table_by_name[entity.name.lower()] = entity
            if entity.kind == "orm-model":
                model_by_name[entity.name] = entity
            if entity.kind == "env-var":
                env_by_name.setdefault(entity.name, []).append(entity)
            if entity.kind == "dependency":
                dep_by_name.setdefault(entity.name, []).append(entity)

        endpoint_by_path: dict[str, list[Entity]] = {}
        for endpoint in (e for e in entities if e.kind == "endpoint"):
            key = norm_path(endpoint.metadata.get("path") or endpoint.name)
            endpoint_by_path.setdefault(key, []).append(endpoint)

        def nearest_dep(name: str, from_path: str) -> Entity | None:
            """The closest ancestor manifest that declares this package."""
            candidates = dep_by_name.get(name)
            if not candidates:
                return None
            best: Entity | None = None
            best_len = -1
            for candidate in candidates:
                directory = os.path.dirname(
                    candidate.metadata.get("manifest") or candidate.rel_path
                )
                prefix = "" if directory == "." else directory + "/"
                if ((prefix == "" or from_path.startswith(prefix))
                        and len(prefix) > best_len):
                    best = candidate
                    best_len = len(prefix)
            return best if best is not None else candidates[0]

        for entity in entities:
            meta = entity.metadata

            if isinstance(meta.get("apiCalls"), list):
                for call in meta["apiCalls"]:
                    key = norm_path(call["path"])
                    for endpoint in endpoint_by_path.get(key, []):
                        method_match = endpoint.metadata.get("method") == call["method"]
                        add(entity.id, endpoint.id, "calls-endpoint",
                            0.92 if method_match else 0.72,
                            f"{call['method']} {call['path']}", entity.rel_path)

            if isinstance(meta.get("renders"), list):
                for tag in meta["renders"]:
                    target = by_component_name.get(tag)
                    if target and target.id != entity.id:
                        add(entity.id, target.id,
                            "imports" if entity.kind == "component" else "renders",
                            0.7, f"<{tag}>", entity.rel_path)

            if isinstance(meta.get("hooks"), list):
                for hook in meta["hooks"]:
                    target = by_hook_name.get(hook)
                    if target:
                        add(entity.id, target.id, "uses-hook", 0.75, hook,
                            entity.rel_path)

            if entity.kind == "route" and isinstance(meta.get("target"), str):
                target = by_component_name.get(meta["target"])
                if target:
                    add(entity.id, target.id, "defines-route", 0.8, meta["target"],
                        entity.rel_path)

            if (entity.kind in ("controller", "service", "repository")
                    and isinstance(meta.get("refs"), list)):
                for ref in meta["refs"]:
                    target = by_class_name.get(ref) or model_by_name.get(ref)
                    if not target:
                        continue
                    if target.kind == "service":
                        add(entity.id, target.id, "uses-service", 0.8, ref,
                            entity.rel_path)
                    elif target.kind == "repository":
                        add(entity.id, target.id, "uses-repository", 0.8, ref,
                            entity.rel_path)
                    elif target.kind == "orm-model":
                        add(entity.id, target.id, "uses-repository", 0.7, ref,
                            entity.rel_path)

            if entity.kind == "repository":
                model_name = _REPO_SUFFIX.sub("", entity.name, count=1)
                model = model_by_name.get(model_name)
                if model:
                    add(entity.id, model.id, "uses-repository", 0.7,
                        f"{entity.name}→{model_name}", entity.rel_path)

            if entity.kind == "endpoint":
                for other in entities:
                    if other.kind == "controller" and other.rel_path == entity.rel_path:
                        add(entity.id, other.id, "handles", 0.8, "same-file",
                            entity.rel_path)
                    # `(c.relPath === e.relPath || true)` is ALWAYS true in
                    # the reference, so a secured endpoint links to every
                    # guard anywhere — only the confidence differs.
                    if meta.get("secured") and other.kind == "auth-guard":
                        add(entity.id, other.id, "secured-by",
                            0.8 if other.rel_path == entity.rel_path else 0.4,
                            "secured", entity.rel_path)

            if entity.kind == "orm-model" and isinstance(meta.get("tableName"), str):
                table = table_by_name.get(meta["tableName"].lower())
                if table:
                    add(entity.id, table.id, "maps-to-table", 0.9,
                        meta["tableName"], entity.rel_path)

            if entity.kind == "table" and isinstance(meta.get("foreignKeys"), list):
                for fk in meta["foreignKeys"]:
                    target = table_by_name.get(fk["refTable"].lower())
                    if target:
                        add(entity.id, target.id, "foreign-key", 0.9,
                            f"{fk['column']}→{fk['refTable']}", entity.rel_path)

            if entity.kind == "migration" and isinstance(meta.get("tables"), list):
                for table_name in meta["tables"]:
                    target = table_by_name.get(table_name.lower())
                    if target:
                        add(entity.id, target.id, "migrates", 0.85, table_name,
                            entity.rel_path)

            if isinstance(meta.get("envRefs"), list):
                for name in meta["envRefs"]:
                    for env in env_by_name.get(name, []):
                        add(entity.id, env.id, "configures", 0.7, name,
                            entity.rel_path)

            if entity.kind == "dockerfile" and isinstance(meta.get("env"), list):
                for name in meta["env"]:
                    for env in env_by_name.get(name, []):
                        add(entity.id, env.id, "configures", 0.7, name,
                            entity.rel_path)

            if isinstance(meta.get("externalImports"), list):
                for spec in meta["externalImports"]:
                    dep = nearest_dep(spec, entity.rel_path)
                    if dep:
                        add(entity.id, dep.id, "depends-on", 0.6, spec,
                            entity.rel_path)

            if (entity.kind == "compose-service"
                    and isinstance(meta.get("dependsOn"), list)):
                for dep_name in meta["dependsOn"]:
                    target = next((x for x in entities
                                   if x.kind == "compose-service"
                                   and x.name == dep_name), None)
                    if target:
                        add(entity.id, target.id, "runs-in", 0.8, dep_name,
                            entity.rel_path)

            if entity.kind == "arch-module":
                target = (by_class_name.get(entity.name)
                          or by_component_name.get(entity.name)
                          or model_by_name.get(entity.name))
                if target:
                    add(entity.id, target.id, "documents", 0.7, "named",
                        entity.rel_path)
                for dep_name in (meta.get("dependencies") or []):
                    resolved = by_class_name.get(dep_name) or model_by_name.get(dep_name)
                    if resolved:
                        add(entity.id, resolved.id, "depends-on", 0.6, dep_name,
                            entity.rel_path)

        return rels
