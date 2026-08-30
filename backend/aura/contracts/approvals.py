"""ApprovalRequest — schema/approval-request.schema.json.

Store semantics frozen in invariants.md §2: only state==='pending' is ever
persisted or restored; grants are single-use via consumedAt; item fingerprints
bind the approval to one exact call.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel, RiskLevel


class ApprovalItem(ContractModel):
    invocationId: str
    capabilityId: str
    title: str
    detail: str
    risk: RiskLevel
    irreversible: bool
    fingerprint: str | None = None  # 32 lowercase hex — canonicalization spec §1


class ApprovalRequest(ContractModel):
    id: str = Field(pattern=r"^apr-")
    state: Literal["pending", "granted", "denied", "expired"]
    requestedAt: str
    summary: str
    items: list[ApprovalItem] = Field(min_length=1)
    decidedAt: str | None = None
    projectId: str | None = None
    missionId: str | None = None
    taskId: str | None = None
    workflowId: str | None = None
    runId: str | None = None
    workflowNodeId: str | None = None
    rule: str | None = None
    onAccept: str | None = None
    onDecline: str | None = None
    target: str | None = None
    decidedBy: str | None = None
    consumedAt: str | None = None
