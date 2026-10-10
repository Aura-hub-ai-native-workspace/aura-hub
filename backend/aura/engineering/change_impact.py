"""Change Impact Analysis — answers "when X changes, what must be revalidated?"

This module builds on the Engineering Graph's traversal capabilities to provide
structured change impact reports. When an artifact, requirement, or component
changes, this module:

1. Finds all directly dependent nodes (reverse traversal)
2. Identifies affected artifacts
3. Marks stale artifacts
4. Returns a structured impact report
5. Suggests revalidation order

The graph does the traversal. This module provides the workflow logic around it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .artifacts import ArtifactStore
from .domain import (
    new_id,
    now_iso,
)
from .events import EngineeringEventStore, EngineeringEventType
from .graph import EngineeringGraph


@dataclass
class ImpactNode:
    """A single node in the impact chain."""

    node_id: str
    node_type: str
    name: str
    relationship: str
    depth: int
    suggested_action: str = ""


@dataclass
class ImpactReport:
    """Structured report of change impact analysis."""

    id: str
    source_node_id: str
    source_name: str
    total_affected: int
    affected_nodes: list[ImpactNode] = field(default_factory=list)
    stale_artifacts: list[str] = field(default_factory=list)  # artifact IDs marked stale
    suggested_order: list[str] = field(default_factory=list)  # node IDs in revalidation order
    timestamp: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "sourceNodeId": self.source_node_id,
            "sourceName": self.source_name,
            "totalAffected": self.total_affected,
            "affectedNodes": [
                {
                    "nodeId": n.node_id,
                    "nodeType": n.node_type,
                    "name": n.name,
                    "relationship": n.relationship,
                    "depth": n.depth,
                    "suggestedAction": n.suggested_action,
                }
                for n in self.affected_nodes
            ],
            "staleArtifacts": self.stale_artifacts,
            "suggestedOrder": self.suggested_order,
            "timestamp": self.timestamp,
        }


# ── Action suggestions by node type ─────────────────────────────────────────

_ACTION_MAP: dict[str, str] = {
    "artifact": "Review and revalidate artifact",
    "requirement": "Reassess requirement impact on downstream components",
    "system": "Review system-level design implications",
    "subsystem": "Review subsystem design and interfaces",
    "component": "Review component specifications",
    "test": "Re-run affected tests",
    "evidence": "Re-collect validation evidence",
    "constraint": "Verify constraints still satisfied",
    "parameter": "Review parameter propagation",
}


def _suggest_action(node_type: str, relationship: str) -> str:
    """Suggest an action based on node type and relationship."""
    base = _ACTION_MAP.get(node_type, "Review affected item")
    if relationship == "derived_from":
        return f"Regenerate: {base.lower()}"
    if relationship == "depends_on":
        return f"Revalidate: {base.lower()}"
    if relationship == "modeled_by":
        return f"Re-check model: {base.lower()}"
    if relationship == "validated_by":
        return f"Re-run validation: {base.lower()}"
    return base


def analyze_change_impact(
    graph: EngineeringGraph,
    node_id: str,
    artifact_store: ArtifactStore | None = None,
    event_store: EngineeringEventStore | None = None,
    mark_stale: bool = True,
) -> ImpactReport:
    """Analyze the impact of a change to a specific node.

    Steps:
    1. Validate the source node exists
    2. Run reverse traversal to find all affected nodes
    3. Compute depth (distance from source)
    4. Suggest actions for each affected node
    5. Optionally mark affected artifacts as stale
    6. Generate a suggested revalidation order (depth-first, leaves first)
    7. Record the impact analysis event

    Args:
        graph: The engineering graph to analyze
        node_id: The ID of the node that changed
        artifact_store: Optional artifact store for marking stale artifacts
        event_store: Optional event store for recording the analysis
        mark_stale: Whether to mark affected artifacts as stale (default True)

    Returns:
        ImpactReport with affected nodes, stale artifacts, and suggested order
    """
    source = graph.get_node(node_id)
    if not source:
        return ImpactReport(
            id=new_id("impact"),
            source_node_id=node_id,
            source_name="<unknown>",
            total_affected=0,
        )

    # Collect affected nodes via reverse traversal with depth tracking
    raw_impact = graph.change_impact(node_id)

    # Build impact nodes with depth and action suggestions
    affected: list[ImpactNode] = []
    seen: set[str] = set()
    for item in raw_impact:
        nid = item["nodeId"]
        if nid in seen:
            continue
        seen.add(nid)
        depth = len(item.get("path", []))
        affected.append(ImpactNode(
            node_id=nid,
            node_type=item.get("nodeType", "unknown"),
            name=item.get("name", ""),
            relationship=item.get("relationship", ""),
            depth=depth,
            suggested_action=_suggest_action(
                item.get("nodeType", ""),
                item.get("relationship", ""),
            ),
        ))

    # Sort by depth (deepest first = leaves first for revalidation)
    affected.sort(key=lambda n: -n.depth)

    # Mark stale artifacts
    stale_ids: list[str] = []
    if mark_stale and artifact_store:
        for node in affected:
            if node.node_type == "artifact" and node.relationship in (
                "depends_on", "derived_from", "modeled_by"
            ):
                result = artifact_store.mark_stale(node.node_id)
                if result:
                    stale_ids.append(node.node_id)

    # Build suggested order (nodes that should be revalidated first)
    # Artifacts come first, then tests, then other nodes
    artifact_nodes = [n for n in affected if n.node_type == "artifact"]
    test_nodes = [n for n in affected if n.node_type == "test"]
    other_nodes = [n for n in affected if n.node_type not in ("artifact", "test")]
    suggested_order = [n.node_id for n in artifact_nodes + test_nodes + other_nodes]

    report = ImpactReport(
        id=new_id("impact"),
        source_node_id=node_id,
        source_name=source.name,
        total_affected=len(affected),
        affected_nodes=affected,
        stale_artifacts=stale_ids,
        suggested_order=suggested_order,
    )

    # Record event
    if event_store:
        event_store.record(
            event_type=EngineeringEventType.CHANGE_IMPACT_DETECTED,
            node_id=node_id,
            outcome="analyzed",
            metadata={
                "impactReportId": report.id,
                "totalAffected": report.total_affected,
                "staleArtifacts": len(stale_ids),
            },
        )

    return report


def propagate_change(
    graph: EngineeringGraph,
    node_id: str,
    artifact_store: ArtifactStore | None = None,
    event_store: EngineeringEventStore | None = None,
) -> ImpactReport:
    """Analyze change impact AND mark all affected artifacts stale.

    This is the full propagation: analyze + mark stale + record events.
    Use this when a change has been committed and downstream items need
    to be flagged for revalidation.

    Returns the ImpactReport for inspection by the calling agent.
    """
    return analyze_change_impact(
        graph=graph,
        node_id=node_id,
        artifact_store=artifact_store,
        event_store=event_store,
        mark_stale=True,
    )
