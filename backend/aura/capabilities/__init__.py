"""aura.capabilities — ONE measured view of what the machine can do.

The registry unites the environment catalog + probes (measured
presence), connected node records (what AURA proved it can drive),
and the curated tool table (what each tool may do, at what risk).

It measures and reports. It never executes, never grants authority,
and never plans. The Central Agent remains the only orchestrator;
this package is the evidence it reasons from.
"""

from .model import (
    ActionRisk,
    Availability,
    Capability,
    CapabilityAction,
    Category,
    Health,
    Resolution,
    Source,
)
from .project import (
    ProjectCapabilities,
    inspect_project_environment,
    project_summary,
)
from .registry import CapabilityRegistry
from .tools import (
    CAPABILITY_MACHINE_NEEDS,
    ROLE_TOOL_NEEDS,
    categories,
    tool_spec,
)

__all__ = [
    "ActionRisk",
    "Availability",
    "Capability",
    "CapabilityAction",
    "Category",
    "Health",
    "Resolution",
    "Source",
    "ProjectCapabilities",
    "inspect_project_environment",
    "project_summary",
    "CapabilityRegistry",
    "CAPABILITY_MACHINE_NEEDS",
    "ROLE_TOOL_NEEDS",
    "categories",
    "tool_spec",
]
