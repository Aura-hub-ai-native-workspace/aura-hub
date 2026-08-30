"""WorkflowVersion — schema/workflow-version.schema.json (versions.ts:44-70).

Immutable. A run executes a version, never the live definition. graphHash is
pinned by canonicalization spec §2 — compute it via aura.canonical.graph_hash.
"""

from __future__ import annotations

from pydantic import Field

from ._base import ContractModel
from .workflow_def import WfEdge, WfNode


class WorkflowVersion(ContractModel):
    id: str
    workflowId: str = Field(pattern=r"^wf-")
    number: int = Field(ge=1, description="Monotonic per workflow, starts at 1.")
    name: str  # name at publish time; renames must not retitle finished runs
    description: str
    createdAt: str
    createdBy: str  # 'user' | 'run:<id>' | 'ai-generate' | 'import'
    graphHash: str = Field(pattern=r"^[0-9a-f]{32}$")
    nodes: list[WfNode]
    edges: list[WfEdge]
    note: str | None = None
    restoredFrom: str | None = None
