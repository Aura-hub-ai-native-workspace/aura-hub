"""AuditRecord — schema/audit-record.schema.json.

Append-only trail semantics frozen in invariants.md §3. One record per settled
invocation AND per human approval decision (approvalDecision/decidedBy).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel, PolicyDecision, RiskLevel

InvocationOutcome = Literal[
    "succeeded", "unverified", "denied", "awaiting-approval", "failed", "unsupported"
]


class InvocationActor(ContractModel):
    kind: Literal["agent", "human", "system"]
    id: str
    role: str | None = None


class AuditRecord(ContractModel):
    invocationId: str = Field(min_length=1)
    at: str = Field(min_length=1)
    capabilityId: str = Field(min_length=1)
    actor: InvocationActor
    projectId: str | None = None
    risk: RiskLevel
    decision: PolicyDecision
    decisionRule: str
    outcome: InvocationOutcome
    verified: bool | None
    durationMs: float
    inputSummary: str  # redacted+bounded — fabric.ts summarizeInput semantics
    missionId: str | None = None
    taskId: str | None = None
    workflowId: str | None = None
    runId: str | None = None
    workflowNodeId: str | None = None
    approvalId: str | None = None
    nodeId: str | None = None
    requestedNodeId: str | None = None
    executedNodeId: str | None = None
    approvalDecision: Literal["granted", "denied"] | None = None
    decidedBy: str | None = None
