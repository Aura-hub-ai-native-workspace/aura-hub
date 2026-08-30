"""AutomationRule — schema/automation-rule.schema.json (automation/types.ts:128-162).

Trigger/action/condition unions are envelope-frozen at P1; field-level freeze
completes at the Phase 7 gate (README D2).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel

AutomationTriggerType = Literal[
    "mission-completed", "mission-accepted", "diagnosis-completed",
    "diagnosis-accepted", "file-changed", "readme-changed",
    "dependency-changed", "pr-merged", "schedule",
]


class RuleTrigger(ContractModel):
    type: AutomationTriggerType
    match: dict | None = None  # coarse filter; all key/values must match payload
    cron: str | None = None    # five-field; required iff type==='schedule'
    projectId: str | None = None  # required for schedule rules — no ambient guessing


class RuleAction(ContractModel):
    id: str
    action: str
    label: str
    config: dict
    continueOnError: bool | None = None


class RetryPolicy(ContractModel):
    maxAttempts: int = Field(ge=1)
    delayMs: float
    backoffFactor: float


class AutomationRule(ContractModel):
    id: str = Field(pattern=r"^rule-")
    name: str
    description: str
    category: str
    enabled: bool
    trigger: RuleTrigger
    conditions: list[dict]
    chain: list[RuleAction]
    retry: RetryPolicy
    createdAt: str
    updatedAt: str
