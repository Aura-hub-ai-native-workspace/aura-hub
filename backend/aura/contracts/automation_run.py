"""AutomationRun — schema/automation-run.schema.json (automation/types.ts:178-300).

Deprecated workflowRunId/workflowRunState mirror `produced` and MUST keep
being written while deprecated (shipped-UI compat — frozen).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel
from .automation_rule import AutomationTriggerType

RunStatus = Literal[
    "queued", "running", "paused", "retrying", "completed", "failed", "cancelled"
]
TimelineType = Literal[
    "queued", "started", "condition-check", "action-started",
    "action-completed", "action-failed", "action-retried", "action-skipped",
    "paused", "resumed", "cancelled", "completed", "failed", "log",
]
RunActionStatus = Literal[
    "pending", "running", "retrying", "completed", "failed", "skipped"
]


class RunTimelineEntry(ContractModel):
    id: str
    at: str
    type: TimelineType
    message: str
    level: Literal["info", "warn", "error"] | None = None
    actionId: str | None = None


class ActionRunState(ContractModel):
    status: RunActionStatus | None = None
    produced: list[dict] | None = None


class AutomationEvent(ContractModel):
    type: AutomationTriggerType
    projectId: str
    projectPath: str
    at: str
    payload: dict


class AutomationRun(ContractModel):
    id: str
    ruleId: str
    event: AutomationEvent
    status: RunStatus
    timeline: list[RunTimelineEntry]
    actions: list[ActionRunState]
    conditions: list[dict]
    startedAt: str
    ruleName: str | None = None
    finishedAt: str | None = None
    ms: float | None = None
    error: str | None = None
    nextRunId: str | None = None
    produced: list[dict] | None = None
    # @deprecated mirrors of produced — still written (frozen compat)
    workflowRunId: str | None = Field(default=None)
    workflowRunState: str | None = Field(default=None)
