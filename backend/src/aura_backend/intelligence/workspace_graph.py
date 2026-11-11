"""Multi-Repository Intelligence.

A port of packages/ai-service/src/intelligence/workspace.ts.

The workspace graph is WORKSPACE-WIDE, not per project: the reference
computes its path once at module load (`homePath('workspace','graph.json')`).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json, read_json


def _file(home: Path) -> Path:
    return home / "workspace" / "graph.json"


def load_workspace_graph(home: Path) -> dict[str, Any] | None:
    return read_json(_file(home), None)


def save_workspace_graph(home: Path, graph: dict[str, Any]) -> None:
    atomic_write_json(_file(home), graph)


def upsert_repository(
    home: Path, repo_id: str, root: str, identity: dict[str, Any] | None, now: str,
    graph_now: str | None = None,
) -> dict[str, Any]:
    """Add or update one repository in the workspace graph.

    The reference reads the clock twice here — once for the repository's
    `lastIndexed` and once for the graph's `generatedAt` — so the two can
    legitimately differ by a millisecond. `graph_now` keeps that seam
    visible instead of collapsing it; it defaults to `now`.
    """
    graph_now = graph_now if graph_now is not None else now
    graph = load_workspace_graph(home) or {
        "repositories": [], "dependencies": [], "groups": [], "generatedAt": graph_now,
    }

    repo = {
        "id": repo_id,
        "path": root,
        "name": (identity or {}).get("name") or os.path.basename(root),
        "type": (identity or {}).get("repositoryType") or "unknown",
        "primaryLanguage": (identity or {}).get("primaryLanguage") or "unknown",
        "frameworks": (identity or {}).get("frameworks") or [],
        "lastIndexed": now,
    }

    existing = next(
        (i for i, r in enumerate(graph["repositories"]) if r["id"] == repo_id), -1
    )
    if existing >= 0:
        graph["repositories"][existing] = repo
    else:
        graph["repositories"].append(repo)

    graph["generatedAt"] = graph_now
    save_workspace_graph(home, graph)
    return graph


def remove_repository(home: Path, repo_id: str, now: str) -> dict[str, Any] | None:
    graph = load_workspace_graph(home)
    if not graph:
        return None
    graph["repositories"] = [r for r in graph["repositories"] if r["id"] != repo_id]
    graph["dependencies"] = [
        d for d in graph["dependencies"]
        if d["source"] != repo_id and d["target"] != repo_id
    ]
    for group in graph["groups"]:
        group["repositoryIds"] = [g for g in group["repositoryIds"] if g != repo_id]
    graph["generatedAt"] = now
    save_workspace_graph(home, graph)
    return graph


def detect_cross_repo_dependencies(graph: dict[str, Any]) -> list[dict[str, Any]]:
    deps: list[dict[str, Any]] = []
    repos = graph["repositories"]
    for i in range(len(repos)):
        for j in range(i + 1, len(repos)):
            a, b = repos[i], repos[j]
            # A bare `startsWith` on the PARENT directory — so a sibling
            # whose path merely shares a prefix reads as a monorepo pair.
            if (a["path"].startswith(os.path.dirname(b["path"]))
                    or b["path"].startswith(os.path.dirname(a["path"]))):
                deps.append({"source": a["id"], "target": b["id"],
                             "type": "monorepo", "strength": 0.8})
            shared = [f for f in a["frameworks"] if f in b["frameworks"]]
            if shared:
                deps.append({"source": a["id"], "target": b["id"],
                             "type": "shared", "strength": len(shared) * 0.2})
    return deps


def find_repositories(home: Path, criteria: dict[str, Any]) -> list[dict[str, Any]]:
    graph = load_workspace_graph(home)
    if not graph:
        return []
    out = []
    for repo in graph["repositories"]:
        if criteria.get("type") and repo["type"] != criteria["type"]:
            continue
        if (criteria.get("primaryLanguage")
                and repo["primaryLanguage"] != criteria["primaryLanguage"]):
            continue
        if criteria.get("framework") and criteria["framework"] not in repo["frameworks"]:
            continue
        out.append(repo)
    return out


def get_repository_dependencies(home: Path, repository_id: str) -> dict[str, Any]:
    graph = load_workspace_graph(home)
    if not graph:
        return {"incoming": [], "outgoing": []}
    return {
        "incoming": [d for d in graph["dependencies"] if d["target"] == repository_id],
        "outgoing": [d for d in graph["dependencies"] if d["source"] == repository_id],
    }


def create_repository_group(
    home: Path, name: str, description: str, repository_ids: list[str], now: str
) -> dict[str, Any] | None:
    graph = load_workspace_graph(home)
    if not graph:
        return None
    existing = next((g for g in graph["groups"] if g["name"] == name), None)
    if existing:
        existing["description"] = description
        existing["repositoryIds"] = repository_ids
    else:
        graph["groups"].append({"name": name, "description": description,
                                "repositoryIds": repository_ids})
    graph["generatedAt"] = now
    save_workspace_graph(home, graph)
    return graph


def get_workspace_stats(home: Path) -> dict[str, Any]:
    graph = load_workspace_graph(home)
    if not graph:
        return {"totalRepositories": 0, "totalDependencies": 0, "totalGroups": 0,
                "languageDistribution": {}, "frameworkDistribution": {}}

    languages: dict[str, int] = {}
    frameworks: dict[str, int] = {}
    for repo in graph["repositories"]:
        languages[repo["primaryLanguage"]] = languages.get(repo["primaryLanguage"], 0) + 1
        for framework in repo["frameworks"]:
            frameworks[framework] = frameworks.get(framework, 0) + 1

    return {
        "totalRepositories": len(graph["repositories"]),
        "totalDependencies": len(graph["dependencies"]),
        "totalGroups": len(graph["groups"]),
        "languageDistribution": languages,
        "frameworkDistribution": frameworks,
    }
