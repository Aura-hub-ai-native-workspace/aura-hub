"""Cross-Repository Graph.

A port of packages/ai-service/src/intelligence/crossRepo.ts.
"""

from __future__ import annotations

import os
from collections import deque
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json, read_json


def _file(home: Path) -> Path:
    return home / "cross-repo" / "graph.json"


def load_cross_repo_graph(home: Path) -> dict[str, Any] | None:
    return read_json(_file(home), None)


def save_cross_repo_graph(home: Path, graph: dict[str, Any]) -> None:
    atomic_write_json(_file(home), graph)


def detect_shared_code(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    edges: list[dict[str, Any]] = []
    repos = workspace["repositories"]
    for i in range(len(repos)):
        for j in range(i + 1, len(repos)):
            a, b = repos[i], repos[j]
            a_name, b_name = a["name"].lower(), b["name"].lower()
            if b_name in a_name or a_name in b_name:
                edges.append({
                    "source": a["id"], "target": b["id"], "type": "shared-code",
                    "weight": 0.5, "metadata": {"reason": "name-similarity"},
                })
    return edges


def detect_monorepo_cluster(workspace: dict[str, Any]) -> dict[str, Any] | None:
    parent_groups: dict[str, list[str]] = {}
    for repo in workspace["repositories"]:
        parent = os.path.dirname(repo["path"])
        parent_groups.setdefault(parent, []).append(repo["id"])

    largest: list[str] = []
    for group in parent_groups.values():
        if len(group) > len(largest):
            largest = group

    if len(largest) < 2:
        return None
    return {"id": "monorepo", "name": "Monorepo", "repositoryIds": largest,
            "relationship": "monorepo"}


def detect_language_clusters(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    lang_groups: dict[str, list[str]] = {}
    for repo in workspace["repositories"]:
        lang_groups.setdefault(repo["primaryLanguage"], []).append(repo["id"])
    for lang, repo_ids in lang_groups.items():
        if len(repo_ids) >= 2:
            clusters.append({
                "id": f"lang-{lang.lower()}", "name": f"{lang} Repositories",
                "repositoryIds": repo_ids, "relationship": "same-language",
            })
    return clusters


def build_cross_repo_graph(
    home: Path, workspace: dict[str, Any], now: str
) -> dict[str, Any]:
    edges: list[dict[str, Any]] = []
    clusters: list[dict[str, Any]] = []

    for dep in workspace["dependencies"]:
        edges.append({"source": dep["source"], "target": dep["target"],
                      "type": dep["type"], "weight": dep["strength"]})

    edges.extend(detect_shared_code(workspace))

    monorepo = detect_monorepo_cluster(workspace)
    if monorepo:
        clusters.append(monorepo)
    clusters.extend(detect_language_clusters(workspace))

    graph = {"repositories": workspace["repositories"], "edges": edges,
             "clusters": clusters, "generatedAt": now}
    save_cross_repo_graph(home, graph)
    return graph


def find_path(graph: dict[str, Any], source: str, target: str) -> list[str] | None:
    visited: set[str] = set()
    queue: deque[list[str]] = deque([[source]])

    while queue:
        path = queue.popleft()
        current = path[-1]
        if current == target:
            return path
        if current in visited:
            continue
        visited.add(current)
        for edge in graph["edges"]:
            if edge["source"] == current and edge["target"] not in visited:
                queue.append([*path, edge["target"]])
            if edge["target"] == current and edge["source"] not in visited:
                queue.append([*path, edge["source"]])
    return None


def get_graph_stats(graph: dict[str, Any]) -> dict[str, Any]:
    edge_types: dict[str, int] = {}
    for edge in graph["edges"]:
        edge_types[edge["type"]] = edge_types.get(edge["type"], 0) + 1

    connectivity = [
        len([e for e in graph["edges"]
             if e["source"] == r["id"] or e["target"] == r["id"]])
        for r in graph["repositories"]
    ]
    average = sum(connectivity) / len(connectivity) if connectivity else 0

    return {
        "totalRepositories": len(graph["repositories"]),
        "totalEdges": len(graph["edges"]),
        "totalClusters": len(graph["clusters"]),
        "edgeTypes": edge_types,
        "averageConnectivity": average,
    }
