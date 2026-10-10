"""Engineering Graph — the relationship backbone of physical engineering in AURA.

Answers: "What depends on what?" "What produced this?" "What validates this?"
         "What changed?" "What must be revalidated?"

Storage: JSON file via aura.jsonutil (matches existing persistence patterns).
Traversal: In-memory adjacency list rebuilt on load.

Design principle: The graph is a data structure, not a database. It provides
queries, not a query language. It loads entirely into memory for a desktop
application where projects have hundreds of nodes, not millions.
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_atomic
from .domain import (
    EngineeringEdge,
    EngineeringNode,
    NodeType,
    RelationshipType,
    new_id,
    now_iso,
)


class EngineeringGraph:
    """In-memory engineering graph with JSON persistence.

    Provides:
    - Node CRUD
    - Edge CRUD
    - Forward traversal (what does this node depend on?)
    - Reverse traversal (what depends on this node?)
    - Dependency lookup
    - Provenance lookup
    - Change impact detection
    """

    def __init__(self, project_id: str, home: Path | None = None) -> None:
        self._project_id = project_id
        self._home = home or aura_path()
        self._file = self._home / "engineering-graph" / f"{project_id}.json"
        self._nodes: dict[str, EngineeringNode] = {}
        self._edges: dict[str, EngineeringEdge] = {}
        # Adjacency lists (rebuilt on load)
        self._forward: dict[str, list[str]] = defaultdict(list)  # node → [edge_ids]
        self._reverse: dict[str, list[str]] = defaultdict(list)  # node → [edge_ids]
        self._node_edges: dict[str, list[str]] = defaultdict(list)  # node → [edge_ids]
        self.load()

    # ── Persistence ─────────────────────────────────────────────────────

    def load(self) -> None:
        """Load graph from disk, rebuild adjacency lists."""
        data = read_json_file(self._file, {"nodes": [], "edges": [], "version": 1})
        self._nodes = {}
        self._edges = {}
        self._forward = defaultdict(list)
        self._reverse = defaultdict(list)
        self._node_edges = defaultdict(list)

        for nd in data.get("nodes", []):
            node = EngineeringNode.from_dict(nd)
            self._nodes[node.id] = node

        for ed in data.get("edges", []):
            edge = EngineeringEdge.from_dict(ed)
            self._edges[edge.id] = edge
            self._forward[edge.source_id].append(edge.id)
            self._reverse[edge.target_id].append(edge.id)
            self._node_edges[edge.source_id].append(edge.id)
            self._node_edges[edge.target_id].append(edge.id)

    def save(self) -> None:
        """Persist graph to disk."""
        self._file.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 1,
            "projectId": self._project_id,
            "nodes": [n.to_dict() for n in self._nodes.values()],
            "edges": [e.to_dict() for e in self._edges.values()],
        }
        write_json_atomic(self._file, data)

    # ── Node Operations ─────────────────────────────────────────────────

    def add_node(
        self,
        node_type: NodeType,
        domain: str,
        name: str,
        description: str = "",
        state: str = "",
        metadata: dict[str, Any] | None = None,
        node_id: str = "",
    ) -> EngineeringNode:
        """Add a node to the graph."""
        nid = node_id or new_id("node")
        from .domain import EngineeringDomain

        node = EngineeringNode(
            id=nid,
            node_type=node_type,
            domain=EngineeringDomain(domain),
            name=name,
            description=description,
            state=state,
            metadata=metadata or {},
        )
        self._nodes[nid] = node
        self.save()
        return node

    def get_node(self, node_id: str) -> EngineeringNode | None:
        """Get a node by ID."""
        return self._nodes.get(node_id)

    def find_nodes(
        self,
        node_type: NodeType | None = None,
        domain: str | None = None,
        name: str | None = None,
    ) -> list[EngineeringNode]:
        """Find nodes matching criteria."""
        results = list(self._nodes.values())
        if node_type:
            results = [n for n in results if n.node_type == node_type]
        if domain:
            results = [n for n in results if n.domain.value == domain]
        if name:
            results = [n for n in results if name.lower() in n.name.lower()]
        return results

    def update_node(self, node_id: str, **kwargs: Any) -> EngineeringNode | None:
        """Update a node's fields."""
        node = self._nodes.get(node_id)
        if not node:
            return None
        for key, value in kwargs.items():
            attr = key.replace("_", "")
            if hasattr(node, attr):
                setattr(node, attr, value)
        node.updated_at = now_iso()
        self.save()
        return node

    def remove_node(self, node_id: str) -> bool:
        """Remove a node and all its edges."""
        if node_id not in self._nodes:
            return False
        # Remove all edges involving this node
        edge_ids = list(self._node_edges.get(node_id, []))
        for eid in edge_ids:
            self._remove_edge_internal(eid)
        del self._nodes[node_id]
        self._node_edges.pop(node_id, None)
        self.save()
        return True

    # ── Edge Operations ─────────────────────────────────────────────────

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relationship: RelationshipType,
        metadata: dict[str, Any] | None = None,
        edge_id: str = "",
    ) -> EngineeringEdge | None:
        """Add a relationship edge between two nodes."""
        if source_id not in self._nodes or target_id not in self._nodes:
            return None
        eid = edge_id or new_id("edge")
        edge = EngineeringEdge(
            id=eid,
            source_id=source_id,
            target_id=target_id,
            relationship=relationship,
            metadata=metadata or {},
        )
        self._edges[eid] = edge
        self._forward[source_id].append(eid)
        self._reverse[target_id].append(eid)
        self._node_edges[source_id].append(eid)
        self._node_edges[target_id].append(eid)
        self.save()
        return edge

    def get_edge(self, edge_id: str) -> EngineeringEdge | None:
        return self._edges.get(edge_id)

    def _remove_edge_internal(self, edge_id: str) -> None:
        """Remove an edge from internal structures (no save)."""
        edge = self._edges.pop(edge_id, None)
        if not edge:
            return
        if edge_id in self._forward.get(edge.source_id, []):
            self._forward[edge.source_id].remove(edge_id)
        if edge_id in self._reverse.get(edge.target_id, []):
            self._reverse[edge.target_id].remove(edge_id)
        if edge_id in self._node_edges.get(edge.source_id, []):
            self._node_edges[edge.source_id].remove(edge_id)
        if edge_id in self._node_edges.get(edge.target_id, []):
            self._node_edges[edge.target_id].remove(edge_id)

    def remove_edge(self, edge_id: str) -> bool:
        if edge_id not in self._edges:
            return False
        self._remove_edge_internal(edge_id)
        self.save()
        return True

    # ── Traversal ───────────────────────────────────────────────────────

    def forward(self, node_id: str) -> list[EngineeringNode]:
        """What does this node depend on / derive from? (outgoing edges)"""
        result = []
        for eid in self._forward.get(node_id, []):
            edge = self._edges.get(eid)
            if edge and edge.target_id in self._nodes:
                result.append(self._nodes[edge.target_id])
        return result

    def reverse(self, node_id: str) -> list[EngineeringNode]:
        """What depends on this node? (incoming edges)"""
        result = []
        for eid in self._reverse.get(node_id, []):
            edge = self._edges.get(eid)
            if edge and edge.source_id in self._nodes:
                result.append(self._nodes[edge.source_id])
        return result

    def forward_edges(self, node_id: str) -> list[EngineeringEdge]:
        """Get outgoing edges from a node."""
        result = []
        for eid in self._forward.get(node_id, []):
            edge = self._edges.get(eid)
            if edge:
                result.append(edge)
        return result

    def reverse_edges(self, node_id: str) -> list[EngineeringEdge]:
        """Get incoming edges to a node."""
        result = []
        for eid in self._reverse.get(node_id, []):
            edge = self._edges.get(eid)
            if edge:
                result.append(edge)
        return result

    def all_edges_for(self, node_id: str) -> list[EngineeringEdge]:
        """Get all edges involving a node (both directions)."""
        result = []
        for eid in self._node_edges.get(node_id, []):
            edge = self._edges.get(eid)
            if edge:
                result.append(edge)
        return result

    # ── Dependency Queries ──────────────────────────────────────────────

    def dependencies_of(self, node_id: str) -> list[EngineeringNode]:
        """All nodes this node depends on (transitive, depth-first)."""
        visited: set[str] = set()
        result: list[EngineeringNode] = []
        self._dfs_forward(node_id, visited, result, max_depth=10)
        return result

    def dependents_of(self, node_id: str) -> list[EngineeringNode]:
        """All nodes that depend on this node (transitive, depth-first)."""
        visited: set[str] = set()
        result: list[EngineeringNode] = []
        self._dfs_reverse(node_id, visited, result, max_depth=10)
        return result

    def _dfs_forward(
        self, node_id: str, visited: set[str], result: list[EngineeringNode], max_depth: int
    ) -> None:
        if node_id in visited or max_depth <= 0:
            return
        visited.add(node_id)
        for edge in self.forward_edges(node_id):
            target = self._nodes.get(edge.target_id)
            if target:
                result.append(target)
                self._dfs_forward(edge.target_id, visited, result, max_depth - 1)

    def _dfs_reverse(
        self, node_id: str, visited: set[str], result: list[EngineeringNode], max_depth: int
    ) -> None:
        if node_id in visited or max_depth <= 0:
            return
        visited.add(node_id)
        for edge in self.reverse_edges(node_id):
            source = self._nodes.get(edge.source_id)
            if source:
                result.append(source)
                self._dfs_reverse(edge.source_id, visited, result, max_depth - 1)

    # ── Change Impact ───────────────────────────────────────────────────

    def change_impact(self, node_id: str) -> list[dict[str, Any]]:
        """When a node changes, what may be affected?

        Returns a list of affected nodes with the relationship path.
        """
        affected = []
        visited: set[str] = set()
        self._collect_impact(node_id, visited, affected, [], max_depth=8)
        return affected

    def _collect_impact(
        self,
        node_id: str,
        visited: set[str],
        result: list[dict[str, Any]],
        path: list[str],
        max_depth: int,
    ) -> None:
        if node_id in visited or max_depth <= 0:
            return
        visited.add(node_id)
        for edge in self.reverse_edges(node_id):
            source = self._nodes.get(edge.source_id)
            if source:
                result.append({
                    "nodeId": source.id,
                    "nodeType": source.node_type.value,
                    "name": source.name,
                    "relationship": edge.relationship.value,
                    "viaEdge": edge.id,
                    "path": path + [node_id],
                })
                self._collect_impact(
                    source.id, visited, result, path + [node_id], max_depth - 1
                )

    # ── Provenance Queries ──────────────────────────────────────────────

    def produced_by(self, artifact_id: str) -> list[EngineeringNode]:
        """Which tools/agents/capabilities produced this artifact?"""
        result = []
        for edge in self.reverse_edges(artifact_id):
            if edge.relationship == RelationshipType.PRODUCED_BY:
                node = self._nodes.get(edge.source_id)
                if node:
                    result.append(node)
        return result

    def validates(self, artifact_id: str) -> list[EngineeringNode]:
        """Which tests/validations apply to this artifact?"""
        result = []
        for edge in self.reverse_edges(artifact_id):
            if edge.relationship == RelationshipType.VALIDATED_BY:
                node = self._nodes.get(edge.source_id)
                if node:
                    result.append(node)
        return result

    # ── Summary ─────────────────────────────────────────────────────────

    def summary(self) -> dict[str, Any]:
        """Graph summary for context/reporting."""
        node_types: dict[str, int] = defaultdict(int)
        edge_types: dict[str, int] = defaultdict(int)
        for node in self._nodes.values():
            node_types[node.node_type.value] += 1
        for edge in self._edges.values():
            edge_types[edge.relationship.value] += 1
        return {
            "projectId": self._project_id,
            "totalNodes": len(self._nodes),
            "totalEdges": len(self._edges),
            "nodeTypes": dict(node_types),
            "edgeTypes": dict(edge_types),
        }
