"""Repository Intelligence Engine — the pipeline.

A port of the orchestration in packages/ai-service/src/intelligence/index.ts.

Everything here executes BEFORE any provider is called; providers receive
pre-assembled context.

    User → Intent → Identity → Memory → Summaries → Documents
         → Context Assembly → Token Budget → Provider

`now` is threaded through every generator rather than read inside them.
`generatedAt` is the only non-deterministic field any of them produce,
and supplying it is what makes the whole pipeline diffable against the
reference.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .artifacts import (
    identity_needs_regeneration,
    load_identity,
    load_repository_health,
    load_repository_profile,
    load_repository_summary,
)
from .change import (
    analyze_change_patterns,
    detect_hotspots,
    generate_change_report,
    get_change_velocity,
    load_change_log,
)
from .context_assembler import assemble_context
from .cross_repo import build_cross_repo_graph, get_graph_stats
from .document_priority import prioritize_documents
from .glossary import build_glossary
from .glossary import load_glossary as _load_glossary
from .health_engine import generate_repository_health
from .identity import generate_identity, save_identity
from .module_summarizer import generate_repository_summary
from .performance import detect_changes, has_changes
from .personality import detect_personality
from .repository_intent import classify_repository_intent
from .repository_memory import build_repository_profile
from .staleness import is_cache_stale
from .validation import validate_architecture
from .verification import generate_verification_report
from .versioning import (
    create_version,
    generate_artifact_hash,
    get_current_version,
    get_version_stats,
)
from .workspace_graph import load_workspace_graph, upsert_repository


def run_intelligence_pipeline(
    home: Path, project_id: str, project_root: str, query: str,
    project_profile: dict[str, Any] | None, coding_context: str,
    graph_context: str, memory_context: str, retrieved_files: list[str], now: str,
) -> dict[str, Any]:
    # 1. Classify intent
    intent = classify_repository_intent(query)

    # 2. Load or generate identity
    identity = load_identity(home, project_id)
    used_identity = bool(identity)
    if not identity and project_profile:
        identity = generate_identity(project_id, project_root, {
            "frameworks": project_profile.get("frameworks") or [],
            "has": project_profile.get("has") or {},
        }, now)
        save_identity(home, identity)
        used_identity = True
    elif (identity and identity_needs_regeneration(home, project_id, project_root)
          and project_profile):
        identity = generate_identity(project_id, project_root, {
            "frameworks": project_profile.get("frameworks") or [],
            "has": project_profile.get("has") or {},
        }, now)
        save_identity(home, identity)

    # 3. Load or generate the repository summary
    summary = load_repository_summary(home, project_id)
    used_summary = bool(summary)
    if not summary or (summary.get("generatedAt")
                       and is_cache_stale(summary["generatedAt"], project_root)):
        summary = generate_repository_summary(
            home, project_id, project_root, now,
            {"name": identity["name"], "purpose": identity["purpose"],
             "mainModules": identity["mainModules"]} if identity else None,
        )
        used_summary = True

    # 4. Load or generate the repository profile (memory)
    profile = load_repository_profile(home, project_id)
    if not profile or (profile.get("generatedAt")
                       and is_cache_stale(profile["generatedAt"], project_root)):
        profile = build_repository_profile(home, project_id, project_root, now)

    # 5. Load or generate the glossary
    glossary = _load_glossary(home, project_id)
    if not glossary or (glossary.get("generatedAt")
                        and is_cache_stale(glossary["generatedAt"], project_root)):
        glossary = build_glossary(home, project_id, project_root, now)

    # 6. Load or generate health
    health = load_repository_health(home, project_id)
    if not health or (health.get("generatedAt")
                      and is_cache_stale(health["generatedAt"], project_root)):
        health = generate_repository_health(
            home, project_id, project_root, now, identity, summary
        )

    # 7. Prioritize documents for this intent
    prioritized = prioritize_documents(
        project_root, intent.type, (project_profile or {}).get("importantFiles")
    )

    # 8. Assemble context
    context = assemble_context({
        "intent": intent, "identity": identity, "summary": summary,
        "profile": profile, "glossary": glossary, "health": health,
        "prioritizedDocs": prioritized, "codingContext": coding_context,
        "graphContext": graph_context, "memoryContext": memory_context,
        "retrievedFiles": retrieved_files,
    })

    return {
        "intent": intent.to_json(), "identity": identity, "summary": summary,
        "profile": profile, "glossary": glossary, "health": health,
        "prioritizedDocs": prioritized, "context": context,
        "usedIdentity": used_identity, "usedSummary": used_summary,
    }


def snapshot_version_if_changed(
    home: Path, project_id: str, fingerprint_source: Any, file_count: int, now: str
) -> None:
    """Record a version only when the repository's understanding changed."""
    fingerprint = generate_artifact_hash(
        json.dumps(fingerprint_source if fingerprint_source is not None else {},
                   separators=(",", ":"), ensure_ascii=False)
    )
    current = get_current_version(home, project_id)
    if current and current["artifactHashes"].get("understanding") == fingerprint:
        return
    create_version(home, project_id, {"understanding": fingerprint},
                   {"fileCount": file_count, "totalTokens": 0, "lastIndexed": now}, now)


def run_project_intelligence(
    home: Path, project_id: str, root: str, now: str
) -> dict[str, Any]:
    """Every per-project Group A engine, in one bundle."""
    from . import architecture as arch_mod
    from .agent_apis import get_directory_tree, get_project_info

    identity = load_identity(home, project_id)
    summary = load_repository_summary(home, project_id)
    profile = load_repository_profile(home, project_id)
    glossary = _load_glossary(home, project_id)
    health = load_repository_health(home, project_id)

    verification = generate_verification_report(
        home, project_id, root, now, identity, summary, health, profile, glossary
    )
    architecture = {
        "hierarchy": arch_mod.build_module_hierarchy(root),
        "dependencies": arch_mod.build_dependency_graph(root),
        "entryPoints": arch_mod.detect_entry_points(root, identity),
        "apiSurface": arch_mod.map_api_surface(root),
    }
    personality = detect_personality(
        home, project_id, root, now, identity, profile, glossary
    )
    validation = validate_architecture(root, identity, profile)

    log = load_change_log(home)
    change = (
        {"report": generate_change_report(log),
         "patterns": analyze_change_patterns(log),
         "hotspots": detect_hotspots(log),
         "velocity": get_change_velocity(log)}
        if log else
        {"report": "No change history recorded yet.", "patterns": [],
         "hotspots": [], "velocity": 0}
    )

    snapshot_version_if_changed(
        home, project_id, {"identity": identity, "summary": summary},
        (summary or {}).get("totalFiles", 0) if summary else 0, now,
    )
    versions = {**get_version_stats(home, project_id),
                "current": get_current_version(home, project_id)}

    agent = {
        "info": get_project_info({
            "projectId": project_id, "root": root, "identity": identity,
            "summary": summary, "profile": profile, "glossary": glossary,
        }),
        "tree": get_directory_tree(root),
    }

    changes = detect_changes(home, root)
    performance = {
        "hasChanges": has_changes(home, root),
        "changed": len(changes["changed"]),
        "added": len(changes["added"]),
        "removed": len(changes["removed"]),
        "totalIndexed": changes["totalIndexed"],
    }

    return {
        "verification": verification, "architecture": architecture,
        "personality": personality, "validation": validation, "change": change,
        "versions": versions, "agent": agent, "performance": performance,
    }


def run_workspace_intelligence(
    home: Path, repos: list[dict[str, str]], now: str
) -> dict[str, Any]:
    """Register every known project into the workspace graph and analyze it."""
    for repo in repos:
        upsert_repository(home, repo["id"], repo["root"],
                          load_identity(home, repo["id"]), now)
    graph = load_workspace_graph(home)
    cross = build_cross_repo_graph(home, graph, now) if graph else None
    from .workspace_graph import get_workspace_stats

    return {
        "stats": get_workspace_stats(home),
        "repositories": (graph or {}).get("repositories") or [],
        "crossRepo": get_graph_stats(cross) if cross else None,
    }
