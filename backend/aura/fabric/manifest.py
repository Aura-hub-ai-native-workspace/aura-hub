"""Capability manifest — the descriptor surface for THIS backend's fabric.

The TS `CAPABILITY_MANIFEST` remains the reference catalogue during
migration; entries here are ported deliberately, capability by capability,
as their executors land (mirroring how policy.ts was ported before
fabric.ts). An id present in TS but absent here is simply unknown to this
backend — it can never half-exist.

Every entry is either backed by a registered executor today or named as an
extension point; there are no speculative capabilities.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CapabilityField:
    name: str
    type: str  # 'string' | 'number' | 'boolean' | 'array' | 'object'
    required: bool
    description: str


@dataclass(frozen=True)
class CapabilityDescriptor:
    """Same shape as capability-fabric/src/types.ts CapabilityDescriptor,
    narrowed to what the invoke pipeline and policy engine read."""

    id: str
    name: str
    description: str
    category: str
    surface: str  # 'aura-internal' | 'local-process' | 'http' | 'browser'
    risk: str  # low | medium | high
    permissions: list[str] = field(default_factory=list)
    input: tuple[CapabilityField, ...] = ()
    output: str = ""
    verify: str | None = None  # 'read-back' | 'exit-code' | None
    requiresNodeCapability: str | None = None
    irreversible: bool = False


def _f(name: str, type_: str, required: bool, description: str) -> CapabilityField:
    return CapabilityField(name=name, type=type_, required=required, description=description)


BUILTIN_MANIFEST: tuple[CapabilityDescriptor, ...] = (
    CapabilityDescriptor(
        id="workflow.create",
        name="Create workflow",
        category="workflow",
        surface="aura-internal",
        description=(
            "Persists a workflow definition into this AURA installation's "
            "workflow store so it can be inspected, edited and later run."
        ),
        risk="low",
        permissions=["aura.write"],
        input=(
            _f("name", "string", True, "Workflow name"),
            _f("description", "string", False, "What the workflow does"),
            _f("nodes", "array", True, "Graph nodes"),
            _f("edges", "array", True, "Graph edges"),
        ),
        output="The stored Workflow record",
        verify="read-back",
    ),
    CapabilityDescriptor(
        id="workflow.list",
        name="List workflows",
        category="workflow",
        surface="aura-internal",
        description="Every workflow definition stored in this installation.",
        risk="low",
        permissions=["aura.read"],
        input=(),
        output="Workflow summaries",
        verify=None,
    ),
    CapabilityDescriptor(
        id="git.status",
        name="Git status",
        category="git",
        surface="local-process",
        description=(
            "Read-only repository status (branch plus changed files) for the "
            "current project, gathered with a fixed argument vector."
        ),
        risk="low",
        permissions=["project.read"],
        input=(
            _f("detail", "boolean", False, "Include per-file status lines"),
        ),
        output="Repository status text",
        verify="exit-code",
    ),
    CapabilityDescriptor(
        id="fs.write_file",
        name="Write project file",
        category="filesystem",
        surface="local-process",
        description=(
            "Creates or overwrites one file INSIDE the current project. "
            "Relative paths only; escaping the project root is refused."
        ),
        risk="medium",
        permissions=["project.write"],
        input=(
            _f("path", "string", True, "Project-relative destination path"),
            _f("content", "string", True, "Full file contents"),
        ),
        output="The written byte count",
        verify="read-back",
    ),
    CapabilityDescriptor(
        id="fs.read_file",
        name="Read project file",
        category="filesystem",
        surface="local-process",
        description=(
            "Reads one file INSIDE the current project, capped at 64 KiB. "
            "Relative paths only; escaping the project root is refused."
        ),
        risk="low",
        permissions=["project.read"],
        input=(
            _f("path", "string", True, "Project-relative source path"),
        ),
        output="File contents (bounded)",
        verify=None,
    ),
)

_BY_ID = {c.id: c for c in BUILTIN_MANIFEST}

# Runtime registrations (e.g. normalized MCP tools) join the catalogue here.
# They are descriptors ONLY — invoking one still requires an executor in the
# FabricConfig registry, and policy still evaluates every call.
_EXTRA: dict[str, CapabilityDescriptor] = {}


def register_capability(descriptor: CapabilityDescriptor) -> None:
    """Register a runtime capability (MCP normalization, plugin surfaces).

    Registration never grants authority: an unexecuted descriptor changes
    nothing until an executor exists AND policy allows the call.
    """
    if descriptor.id in _BY_ID or descriptor.id in _EXTRA:
        raise ValueError(f"capability already registered: {descriptor.id}")
    _EXTRA[descriptor.id] = descriptor


def unregister_capability(capability_id: str) -> bool:
    return _EXTRA.pop(capability_id, None) is not None


def all_capabilities() -> tuple[CapabilityDescriptor, ...]:
    return BUILTIN_MANIFEST + tuple(_EXTRA.values())


def describe_capability(capability_id: str) -> CapabilityDescriptor | None:
    return _BY_ID.get(capability_id) or _EXTRA.get(capability_id)
