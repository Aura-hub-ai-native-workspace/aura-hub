"""Engineering domain types — the vocabulary of physical engineering in AURA.

Every type here is a plain dataclass or enum. No framework dependencies,
no I/O, no side effects. The domain model is the vocabulary that the
graph, artifacts, capabilities, and events speak.

Design principle: this module defines WHAT exists, not HOW it is stored
or executed. Storage belongs to the graph module. Execution belongs to
the capability fabric.
"""

from __future__ import annotations

import enum
import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

# ── Enums ──────────────────────────────────────────────────────────────────


class EngineeringDomain(str, enum.Enum):
    """Engineering domains that AURA can orchestrate."""

    MECHANICAL = "mechanical"
    ELECTRONICS = "electronics"
    FIRMWARE = "firmware"
    SIMULATION = "simulation"
    MANUFACTURING = "manufacturing"
    VALIDATION = "validation"
    SYSTEM = "system"  # cross-domain system-level


class NodeType(str, enum.Enum):
    """Types of nodes in the Engineering Graph."""

    PROJECT = "project"
    REQUIREMENT = "requirement"
    SYSTEM = "system"
    SUBSYSTEM = "subsystem"
    COMPONENT = "component"
    ARTIFACT = "artifact"
    CONSTRAINT = "constraint"
    PARAMETER = "parameter"
    TEST = "test"
    EVIDENCE = "evidence"
    TOOL = "tool"
    AGENT = "agent"
    CAPABILITY = "capability"


class RelationshipType(str, enum.Enum):
    """Typed relationships between Engineering Graph nodes."""

    DERIVES = "derives"  # requirement → system
    CONTAINS = "contains"  # system → subsystem, subsystem → component
    MODELED_BY = "modeled_by"  # component → artifact (CAD)
    DERIVED_FROM = "derived_from"  # artifact → artifact (version lineage)
    DEPENDS_ON = "depends_on"  # artifact → artifact (dependency)
    CONSTRAINED_BY = "constrained_by"  # artifact → constraint
    VALIDATED_BY = "validated_by"  # artifact → test
    PRODUCED_BY = "produced_by"  # artifact → tool/agent/capability
    PRODUCES = "produces"  # test → evidence
    SATISFIES = "satisfies"  # requirement → constraint
    IMPLEMENTS = "implements"  # firmware → component
    TESTS = "tests"  # test → artifact


class ArtifactType(str, enum.Enum):
    """Types of engineering artifacts."""

    CAD_MODEL = "cad-model"
    SCHEMATIC = "schematic"
    PCB = "pcb"
    FIRMWARE = "firmware"
    BOM = "bom"
    GERBER = "gerber"
    DRILL = "drill"
    SIMULATION_RESULT = "simulation-result"
    TEST_REPORT = "test-report"
    DOCUMENTATION = "documentation"
    CONFIGURATION = "configuration"
    MEASUREMENT = "measurement"
    EVIDENCE = "evidence"
    STEP = "step"
    STL = "stl"
    DXF = "dxf"


class ArtifactStatus(str, enum.Enum):
    """Verification status of an artifact."""

    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    FAILED = "failed"
    PENDING = "pending"
    STALE = "stale"  # dependencies changed, needs revalidation


class CapabilityRisk(str, enum.Enum):
    """Risk classification for engineering capabilities.

    Extends the existing Fabric RiskLevel with a physical-action tier.
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL_PHYSICAL = "critical-physical"


class ComponentState(str, enum.Enum):
    """State of an engineering component in the graph."""

    PLANNED = "planned"
    IN_DESIGN = "in-design"
    DESIGNED = "designed"
    VALIDATED = "validated"
    MANUFACTURING_READY = "manufacturing-ready"
    MANUFACTURED = "manufactured"
    DEPRECATED = "deprecated"


class ToolAvailability(str, enum.Enum):
    """Availability status of an engineering tool."""

    INSTALLED = "installed"
    MISSING = "missing"
    VERSION_MISMATCH = "version-mismatch"
    UNSUPPORTED = "unsupported"
    UNKNOWN = "unknown"


class ToolStatus(str, enum.Enum):
    """Runtime status of a tool connection."""

    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    ERROR = "error"


class ValidationResult(str, enum.Enum):
    """Outcome of a validation check."""

    PASS = "pass"
    FAIL = "fail"
    WARNING = "warning"
    SKIPPED = "skipped"
    ERROR = "error"


class EngineeringEventType(str, enum.Enum):
    """Types of engineering events."""

    PROJECT_CREATED = "project.created"
    REQUIREMENT_CREATED = "requirement.created"
    COMPONENT_CREATED = "component.created"
    ARTIFACT_CREATED = "artifact.created"
    ARTIFACT_UPDATED = "artifact.updated"
    ARTIFACT_VERIFIED = "artifact.verified"
    ARTIFACT_FAILED = "artifact.failed"
    ARTIFACT_STALE = "artifact.stale"
    CAPABILITY_REQUESTED = "capability.requested"
    CAPABILITY_APPROVED = "capability.approved"
    CAPABILITY_DENIED = "capability.denied"
    CAPABILITY_EXECUTED = "capability.executed"
    TOOL_DETECTED = "tool.detected"
    TOOL_UNAVAILABLE = "tool.unavailable"
    SIMULATION_STARTED = "simulation.started"
    SIMULATION_COMPLETED = "simulation.completed"
    VALIDATION_STARTED = "validation.started"
    VALIDATION_COMPLETED = "validation.completed"
    DEPENDENCY_CHANGED = "dependency.changed"
    CHANGE_IMPACT_DETECTED = "change-impact.detected"


# ── Value Objects ───────────────────────────────────────────────────────────


def new_id(prefix: str = "eng") -> str:
    """Generate a deterministic engineering ID."""
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    """Current timestamp in ISO 8601 format (UTC, Z suffix)."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def content_hash(data: bytes) -> str:
    """SHA-256 content hash for artifact integrity verification."""
    return hashlib.sha256(data).hexdigest()


def file_hash(file_path: str | Any) -> str:
    """Compute SHA-256 hash of a file's contents."""
    h = hashlib.sha256()
    path = str(file_path)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Domain Entities ─────────────────────────────────────────────────────────


@dataclass
class EngineeringNode:
    """A node in the Engineering Graph.

    Every entity in the engineering project — requirements, systems,
    components, artifacts, constraints, tests — is a node with a type,
    domain, and metadata.
    """

    id: str
    node_type: NodeType
    domain: EngineeringDomain
    name: str
    description: str = ""
    state: str = ""  # ComponentState value, or free-text for other types
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nodeType": self.node_type.value,
            "domain": self.domain.value,
            "name": self.name,
            "description": self.description,
            "state": self.state,
            "metadata": self.metadata,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EngineeringNode:
        return cls(
            id=d["id"],
            node_type=NodeType(d["nodeType"]),
            domain=EngineeringDomain(d["domain"]),
            name=d["name"],
            description=d.get("description", ""),
            state=d.get("state", ""),
            metadata=d.get("metadata", {}),
            created_at=d.get("createdAt", now_iso()),
            updated_at=d.get("updatedAt", now_iso()),
        )


@dataclass
class EngineeringEdge:
    """A typed relationship between two Engineering Graph nodes."""

    id: str
    source_id: str
    target_id: str
    relationship: RelationshipType
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "sourceId": self.source_id,
            "targetId": self.target_id,
            "relationship": self.relationship.value,
            "metadata": self.metadata,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EngineeringEdge:
        return cls(
            id=d["id"],
            source_id=d["sourceId"],
            target_id=d["targetId"],
            relationship=RelationshipType(d["relationship"]),
            metadata=d.get("metadata", {}),
            created_at=d.get("createdAt", now_iso()),
        )


@dataclass
class ArtifactRecord:
    """An engineering artifact with full metadata and provenance.

    Every engineering output — CAD model, schematic, PCB, firmware,
    BOM, Gerber, test report — is tracked as an artifact with
    versioning, integrity hashing, and provenance chain.
    """

    id: str
    artifact_type: ArtifactType
    name: str
    version: str  # semver
    file_path: str
    file_hash: str  # SHA-256
    status: ArtifactStatus = ArtifactStatus.UNVERIFIED
    source: str = ""  # agent-generated, user-created, imported, tool-output
    author_agent: str = ""
    parent_id: str = ""  # previous version
    dependencies: list[str] = field(default_factory=list)  # artifact IDs
    parameters: dict[str, Any] = field(default_factory=dict)
    constraints: dict[str, Any] = field(default_factory=dict)
    provenance: ArtifactProvenance = field(default_factory=lambda: ArtifactProvenance())
    relationships: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "artifactType": self.artifact_type.value,
            "name": self.name,
            "version": self.version,
            "filePath": self.file_path,
            "fileHash": self.file_hash,
            "status": self.status.value,
            "source": self.source,
            "authorAgent": self.author_agent,
            "parentId": self.parent_id,
            "dependencies": self.dependencies,
            "parameters": self.parameters,
            "constraints": self.constraints,
            "provenance": self.provenance.to_dict(),
            "relationships": self.relationships,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ArtifactRecord:
        prov = d.get("provenance", {})
        return cls(
            id=d["id"],
            artifact_type=ArtifactType(d["artifactType"]),
            name=d["name"],
            version=d["version"],
            file_path=d["filePath"],
            file_hash=d["fileHash"],
            status=ArtifactStatus(d.get("status", "unverified")),
            source=d.get("source", ""),
            author_agent=d.get("authorAgent", ""),
            parent_id=d.get("parentId", ""),
            dependencies=d.get("dependencies", []),
            parameters=d.get("parameters", {}),
            constraints=d.get("constraints", {}),
            provenance=ArtifactProvenance.from_dict(prov) if prov else ArtifactProvenance(),
            relationships=d.get("relationships", []),
            created_at=d.get("createdAt", now_iso()),
            updated_at=d.get("updatedAt", now_iso()),
        )


@dataclass
class ArtifactProvenance:
    """Provenance chain for an artifact — WHO produced it, HOW, and under WHAT governance.

    Connects to AURA's existing audit architecture. The auditId links
    to the Capability Fabric's AuditStore record.
    """

    agent: str = ""  # which agent produced this
    capability: str = ""  # which capability was invoked (e.g., "cad.create_part")
    tool: str = ""  # which external tool was used (e.g., "cadquery", "kicad")
    invocation_id: str = ""  # Fabric invocation ID
    audit_id: str = ""  # AuditStore record ID
    policy_decision: str = ""  # auto-execute, ask-user, require-approval
    approval_required: bool = False
    approval_granted: bool = False
    input_artifacts: list[str] = field(default_factory=list)  # dependency artifact IDs
    parameters: dict[str, Any] = field(default_factory=dict)
    constraints: dict[str, Any] = field(default_factory=dict)
    validation_result: str = ""  # pass, fail, pending, skipped
    validation_details: str = ""
    timestamp: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "capability": self.capability,
            "tool": self.tool,
            "invocationId": self.invocation_id,
            "auditId": self.audit_id,
            "policyDecision": self.policy_decision,
            "approvalRequired": self.approval_required,
            "approvalGranted": self.approval_granted,
            "inputArtifacts": self.input_artifacts,
            "parameters": self.parameters,
            "constraints": self.constraints,
            "validationResult": self.validation_result,
            "validationDetails": self.validation_details,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ArtifactProvenance:
        if not d:
            return cls()
        return cls(
            agent=d.get("agent", ""),
            capability=d.get("capability", ""),
            tool=d.get("tool", ""),
            invocation_id=d.get("invocationId", ""),
            audit_id=d.get("auditId", ""),
            policy_decision=d.get("policyDecision", ""),
            approval_required=d.get("approvalRequired", False),
            approval_granted=d.get("approvalGranted", False),
            input_artifacts=d.get("inputArtifacts", []),
            parameters=d.get("parameters", {}),
            constraints=d.get("constraints", {}),
            validation_result=d.get("validationResult", ""),
            validation_details=d.get("validationDetails", ""),
            timestamp=d.get("timestamp", now_iso()),
        )


@dataclass
class ToolRecord:
    """A registered engineering tool/provider.

    Describes an external tool that AURA can orchestrate.
    Includes detection method, capabilities, and availability.
    """

    id: str
    name: str
    version: str = ""
    provider: str = ""  # e.g., "freecad", "kicad", "cadquery"
    domain: EngineeringDomain = EngineeringDomain.MECHANICAL
    executable: str = ""  # CLI command to invoke
    capabilities: list[str] = field(default_factory=list)  # capability IDs
    availability: ToolAvailability = ToolAvailability.UNKNOWN
    detection_method: str = ""  # how to detect if installed
    invocation_method: str = ""  # CLI, Python, REST API, IPC
    documentation_url: str = ""
    license: str = ""  # open-source, commercial, free-tier
    headless_support: bool = False
    cross_platform: bool = True
    platform_notes: str = ""
    last_detected: str = ""
    detected_version: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "provider": self.provider,
            "domain": self.domain.value,
            "executable": self.executable,
            "capabilities": self.capabilities,
            "availability": self.availability.value,
            "detectionMethod": self.detection_method,
            "invocationMethod": self.invocation_method,
            "documentationUrl": self.documentation_url,
            "license": self.license,
            "headlessSupport": self.headless_support,
            "crossPlatform": self.cross_platform,
            "platformNotes": self.platform_notes,
            "lastDetected": self.last_detected,
            "detectedVersion": self.detected_version,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ToolRecord:
        return cls(
            id=d["id"],
            name=d["name"],
            version=d.get("version", ""),
            provider=d.get("provider", ""),
            domain=EngineeringDomain(d.get("domain", "mechanical")),
            executable=d.get("executable", ""),
            capabilities=d.get("capabilities", []),
            availability=ToolAvailability(d.get("availability", "unknown")),
            detection_method=d.get("detectionMethod", ""),
            invocation_method=d.get("invocationMethod", ""),
            documentation_url=d.get("documentationUrl", ""),
            license=d.get("license", ""),
            headless_support=d.get("headlessSupport", False),
            cross_platform=d.get("crossPlatform", True),
            platform_notes=d.get("platformNotes", ""),
            last_detected=d.get("lastDetected", ""),
            detected_version=d.get("detectedVersion", ""),
            metadata=d.get("metadata", {}),
        )


@dataclass
class EngineeringEventRecord:
    """An engineering event — the atomic unit of change tracking.

    Events are append-only, like AURA's existing AuditStore.
    They capture what happened, who did it, and what was affected.
    """

    id: str
    event_type: EngineeringEventType
    project_id: str = ""
    actor: str = ""  # user, agent, system
    agent: str = ""  # which agent
    capability: str = ""  # which capability
    artifact_id: str = ""  # which artifact was affected
    node_id: str = ""  # which graph node was affected
    outcome: str = ""  # success, failure, pending
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "eventType": self.event_type.value,
            "projectId": self.project_id,
            "actor": self.actor,
            "agent": self.agent,
            "capability": self.capability,
            "artifactId": self.artifact_id,
            "nodeId": self.node_id,
            "outcome": self.outcome,
            "metadata": self.metadata,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EngineeringEventRecord:
        return cls(
            id=d["id"],
            event_type=EngineeringEventType(d["eventType"]),
            project_id=d.get("projectId", ""),
            actor=d.get("actor", ""),
            agent=d.get("agent", ""),
            capability=d.get("capability", ""),
            artifact_id=d.get("artifactId", ""),
            node_id=d.get("nodeId", ""),
            outcome=d.get("outcome", ""),
            metadata=d.get("metadata", {}),
            timestamp=d.get("timestamp", now_iso()),
        )


# Backward-compat alias used by events.py and __init__.py
EngineeringEvent = EngineeringEventRecord


@dataclass
class EngineeringCapability:
    """An engineering capability contract — extends the Capability Fabric.

    Describes what an engineering agent can request, what it produces,
    what risk it carries, and what governance applies.
    """

    id: str  # e.g., "cad.create_part"
    name: str
    description: str
    domain: EngineeringDomain
    risk: CapabilityRisk
    approval_required: bool
    executor: str  # which executor handles this
    provider: str = ""  # which tool provides this
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)
    verification: str = ""  # read-back, exit-code, http-status, none
    irreversible: bool = False
    version: str = "1.0.0"
    status: str = "proposed"  # proposed, implemented, deprecated
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "domain": self.domain.value,
            "risk": self.risk.value,
            "approvalRequired": self.approval_required,
            "executor": self.executor,
            "provider": self.provider,
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "verification": self.verification,
            "irreversible": self.irreversible,
            "version": self.version,
            "status": self.status,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EngineeringCapability:
        return cls(
            id=d["id"],
            name=d["name"],
            description=d.get("description", ""),
            domain=EngineeringDomain(d.get("domain", "mechanical")),
            risk=CapabilityRisk(d.get("risk", "low")),
            approval_required=d.get("approvalRequired", False),
            executor=d.get("executor", ""),
            provider=d.get("provider", ""),
            input_schema=d.get("inputSchema", {}),
            output_schema=d.get("outputSchema", {}),
            verification=d.get("verification", ""),
            irreversible=d.get("irreversible", False),
            version=d.get("version", "1.0.0"),
            status=d.get("status", "proposed"),
            metadata=d.get("metadata", {}),
        )
