"""Governance vocabulary.

A direct port of packages/capability-fabric/src/types.py's policy-relevant
declarations. Nothing here executes; it is the shared language the policy
engine, the fabric and the audit trail all speak.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PolicyDecision(str, Enum):
    AUTO_EXECUTE = "auto-execute"
    ASK_USER = "ask-user"
    REQUIRE_APPROVAL = "require-approval"
    DENY = "deny"


class PermissionScope(str, Enum):
    PROJECT_READ = "project.read"
    PROJECT_WRITE = "project.write"
    PROCESS_EXECUTE = "process.execute"
    NETWORK_OUTBOUND = "network.outbound"
    ACCOUNT_AUTHORIZE = "account.authorize"
    RESOURCE_DESTROY = "resource.destroy"
    SYSTEM_MODIFY = "system.modify"
    AURA_READ = "aura.read"
    AURA_WRITE = "aura.write"


# Scopes no node flag may ever grant. They are deliberately excluded from the
# permission-denied floor as well, so a capability needing one is *gated*
# rather than made impossible.
HUMAN_ONLY_SCOPES: frozenset[PermissionScope] = frozenset(
    {
        PermissionScope.ACCOUNT_AUTHORIZE,
        PermissionScope.RESOURCE_DESTROY,
        PermissionScope.SYSTEM_MODIFY,
    }
)

# How restrictive each decision is. stricter() folds by this rank, which is
# what makes every configurable layer escalate-only.
_RANK: dict[PolicyDecision, int] = {
    PolicyDecision.AUTO_EXECUTE: 0,
    PolicyDecision.ASK_USER: 1,
    PolicyDecision.REQUIRE_APPROVAL: 2,
    PolicyDecision.DENY: 3,
}


def rank(decision: PolicyDecision) -> int:
    return _RANK[decision]


@dataclass(frozen=True)
class PolicySubject:
    """The capability being evaluated, plus the node it resolved to.

    `capability_name` and `node_name` are display names. They are here
    because the engine's `reason` is user-facing prose that names the
    action and the node — it is what a person reads in an approval
    prompt, not a debug string.
    """

    capability_id: str
    risk: RiskLevel
    permissions: tuple[PermissionScope, ...] = ()
    irreversible: bool = False
    node_id: str | None = None
    capability_name: str = ""
    node_name: str = ""


@dataclass(frozen=True)
class PolicyInput:
    subject: PolicySubject
    # None means "this capability needs no node". False is the hard floor.
    node_available: bool | None = None
    granted: frozenset[PermissionScope] = frozenset()


@dataclass(frozen=True)
class PolicyEvaluation:
    decision: PolicyDecision
    reason: str
    rule: str
    risk: RiskLevel


@dataclass
class PolicyConfig:
    by_risk: dict[RiskLevel, PolicyDecision] = field(default_factory=dict)
    overrides: dict[str, PolicyDecision] = field(default_factory=dict)
    # Keyed two ways: "@<nodeId>" and "<capabilityId>@<nodeId>".
    node_overrides: dict[str, PolicyDecision] = field(default_factory=dict)
    # Absent key means "no list". An empty list means "nothing is allowed" —
    # the distinction is load-bearing; see sanitize_policy.
    node_allowlists: dict[str, list[str]] = field(default_factory=dict)
    allow_autonomous: bool = True


@dataclass(frozen=True)
class Grants:
    """A run's permission envelope. Narrowing only — never widened."""

    read: bool = False
    write: bool = False
    execute: bool = False
    autonomous: bool = False
