"""PolicyConfig — schema/policy-config.schema.json."""

from __future__ import annotations

from pydantic import Field

from ._base import ContractModel, PolicyDecision, RiskLevel


class PolicyConfig(ContractModel):
    byRisk: dict[RiskLevel, PolicyDecision] = Field(
        description="Default decision per risk level when nothing more specific applies."
    )
    overrides: dict[str, PolicyDecision] = Field(default_factory=dict)
    nodeOverrides: dict[str, PolicyDecision] = Field(
        default_factory=dict,
        description="Deny-only in effect; keys '@<nodeId>' or '<capabilityId>@<nodeId>'.",
    )
    nodeAllowlists: dict[str, list[str]] = Field(
        default_factory=dict,
        description="capabilityId -> permitted node ids; outside the list is denied.",
    )
    allowAutonomous: bool = True
