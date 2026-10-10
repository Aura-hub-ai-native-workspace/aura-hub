"""Physical Engineering domain model — the foundation for AURA's engineering orchestration.

This package provides:
- Domain model (entities, relationships, types)
- Engineering Graph (storage, traversal, dependency tracking)
- Artifact system (versioning, provenance, integrity)
- Tool registry (detection, capabilities, availability)
- Capability extensions (engineering namespaces)
- Event model (engineering events, change impact)
- Context extensions (engineering context)
- Change impact analysis (dependency propagation, stale detection)

The Capability Fabric remains the ONLY governed execution path.
AURA does NOT build CAD/EDA/simulation tools — it orchestrates them.
"""

from .domain import (
    ArtifactStatus,
    ArtifactType,
    CapabilityRisk,
    ComponentState,
    EngineeringDomain,
    EngineeringEvent,
    EngineeringEventType,
    NodeType,
    RelationshipType,
    ToolAvailability,
    ToolStatus,
    ValidationResult,
)

__all__ = [
    "ArtifactStatus",
    "ArtifactType",
    "CapabilityRisk",
    "ComponentState",
    "EngineeringDomain",
    "EngineeringEvent",
    "EngineeringEventType",
    "NodeType",
    "RelationshipType",
    "ToolAvailability",
    "ToolStatus",
    "ValidationResult",
]
