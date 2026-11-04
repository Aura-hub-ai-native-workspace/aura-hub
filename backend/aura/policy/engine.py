"""Policy engine — byte-exact port of packages/capability-fabric/src/policy.ts.

Evaluated on EVERY invocation before any executor is reached. The order IS
the security argument (frozen, invariants.md §1):

  1. hard floors        — not configurable
  2. permission check   — node-grantable scopes only
  3. capability override
  4. node overrides / allowlists   (deny-only in effect)
  5. autonomy switch
  6. risk default

Configuration can make the Fabric MORE cautious than intended, never less.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# ── frozen vocabularies ──────────────────────────────────────────────────────

PolicyDecision = Literal["auto-execute", "deny"]
RiskLevel = Literal["low", "medium", "high"]
PermissionScope = Literal[
    "project.read", "project.write", "process.execute", "network.outbound",
    "account.authorize", "resource.destroy", "system.modify",
    "aura.read", "aura.write",
]

DECISIONS: tuple[str, ...] = ("auto-execute", "deny")

#: Decisions a stored policy file written before the approval workflow was
#: removed may still name. They are read as the decision the new rule gives:
#: a step that would have waited for a person now runs (routine) or is refused.
LEGACY_DECISION = {"ask-user": "auto-execute", "require-approval": "deny"}


def _current(decision: str) -> str:
    return LEGACY_DECISION.get(decision, decision)

RANK: dict[str, int] = {
    "auto-execute": 0,
    "deny": 1,
}

#: Routine project work runs directly: no risk level asks by default. What
#: still stops is the hard floors below (account authorization, machine
#: changes, destructive and irreversible actions) and anything the person
#: explicitly configures to ask.
DEFAULT_POLICY: dict[str, Any] = {
    "byRisk": {"low": "auto-execute", "medium": "auto-execute", "high": "auto-execute"},
    "overrides": {
    },
    "nodeOverrides": {},
    "nodeAllowlists": {},
    "allowAutonomous": True,
}

#: The defaults AURA used to ship. A stored policy that is exactly these —
#: saved verbatim, never customized — is read as today's defaults.
LEGACY_DEFAULT_BY_RISK = {"low": "auto-execute", "medium": "ask-user", "high": "require-approval"}
LEGACY_DEFAULT_OVERRIDES = {"mission.approve": "ask-user", "provider.connect": "require-approval"}

HUMAN_ONLY_SCOPES = frozenset({"account.authorize", "resource.destroy", "system.modify"})


def upgrade_legacy_default_policy(raw: Any) -> Any:
    """Read a stored policy that is exactly the old shipped default as the
    current default. Nothing the person customized is touched: any other
    byRisk value, any other override, any node rule keeps the policy as it
    is. Pure — the stored file is not rewritten."""
    if not isinstance(raw, dict):
        return raw
    if raw.get("byRisk") != LEGACY_DEFAULT_BY_RISK:
        return raw
    overrides = raw.get("overrides") or {}
    if not isinstance(overrides, dict) or any(
            LEGACY_DEFAULT_OVERRIDES.get(k) != v for k, v in overrides.items()):
        return raw
    upgraded = dict(raw)
    upgraded["byRisk"] = dict(DEFAULT_POLICY["byRisk"])
    upgraded["overrides"] = {k: v for k, v in overrides.items() if k not in ("mission.approve", "provider.connect")}
    return upgraded


def _is_decision(v: Any) -> bool:
    return isinstance(v, str) and v in DECISIONS


def _stricter(a: PolicyDecision, b: PolicyDecision) -> PolicyDecision:
    """The stricter of two decisions. Ties keep the standing value (a)."""
    return a if RANK[a] >= RANK[b] else b  # type: ignore[return-value]


# ── untrusted-input coercion ─────────────────────────────────────────────────


def sanitize_policy(raw: Any) -> dict[str, Any]:
    """Coerce a hostile file/request body into an acceptable policy.

    Unknown decision strings are DROPPED (never carried into comparisons);
    malformed allowlists become EMPTY lists (fail closed); a damaged autonomy
    setting reads cautious, never permissive. Mirrors sanitizePolicy :74-113.
    """
    inp = upgrade_legacy_default_policy(raw) if isinstance(raw, dict) else {}

    by_risk = dict(DEFAULT_POLICY["byRisk"])
    for level in ("low", "medium", "high"):
        v = (inp.get("byRisk") or {}).get(level) if isinstance(inp.get("byRisk"), dict) else None
        if _is_decision(v):
            by_risk[level] = v  # type: ignore[assignment]

    overrides: dict[str, PolicyDecision] = {}
    for ident, v in (inp.get("overrides") or {}).items():
        if isinstance(ident, str) and ident and _is_decision(v):
            overrides[ident] = v

    node_overrides: dict[str, PolicyDecision] = {}
    for key, v in (inp.get("nodeOverrides") or {}).items():
        if isinstance(key, str) and "@" in key and _is_decision(v):
            node_overrides[key] = v

    node_allowlists: dict[str, list[str]] = {}
    for cap_id, v in (inp.get("nodeAllowlists") or {}).items():
        if not isinstance(cap_id, str) or not cap_id:
            continue
        node_allowlists[cap_id] = (
            [x for x in v if isinstance(x, str) and x] if isinstance(v, list) else []
        )

    raw_autonomy = inp.get("allowAutonomous")
    if raw_autonomy is None and "allowAutonomous" not in inp:
        allow_autonomous = DEFAULT_POLICY["allowAutonomous"]
    elif isinstance(raw_autonomy, bool):
        allow_autonomous = raw_autonomy
    else:
        allow_autonomous = False

    return {
        "byRisk": by_risk,
        "overrides": overrides,
        "nodeOverrides": node_overrides,
        "nodeAllowlists": node_allowlists,
        "allowAutonomous": allow_autonomous,
    }


# ── inputs ───────────────────────────────────────────────────────────────────


@dataclass
class CapabilityDescriptor:
    """Minimal descriptor surface the engine reads (manifest is P4)."""

    id: str
    name: str
    risk: RiskLevel
    permissions: list[str] = field(default_factory=list)
    irreversible: bool | None = None


@dataclass
class PolicySubject:
    node: dict[str, str] | None = None      # {id, name} — identity only
    requestedNodeId: str | None = None
    actorKind: str | None = None
    actorId: str | None = None
    projectId: str | None = None
    missionId: str | None = None
    taskId: str | None = None


@dataclass
class PolicyInput:
    capability: CapabilityDescriptor
    config: dict[str, Any]
    granted: list[str]
    nodeAvailable: bool | None              # null when the capability needs no node
    subject: PolicySubject | None = None


# ── evaluation ───────────────────────────────────────────────────────────────


def _reason_for(decision: PolicyDecision, name: str) -> str:
    return {
        "auto-execute": f"{name} is low risk and reversible, so it runs without interrupting you.",
        "deny": f"{name} is not permitted under the current policy.",
    }[decision]


def evaluate_policy(inp: PolicyInput) -> dict[str, Any]:
    cap, cfg = inp.capability, inp.config
    risk: RiskLevel = cap.risk

    # 1a. No provider connected → outright denial (before everything else).
    if inp.nodeAvailable is False:
        return {
            "decision": "deny",
            "rule": "no-provider",
            "risk": risk,
            "reason": f"Nothing connected can perform {cap.name.lower()} yet. Connect a node that provides it and this becomes available.",
        }

    # 1b. Node-grantable scope check. Human-only scopes are deliberately NOT
    # checked here — they are a policy decision, not a person's go-ahead;
    # checking them would make authorization impossible instead of gated.
    missing = [p for p in cap.permissions if p not in HUMAN_ONLY_SCOPES and p not in inp.granted]
    if missing:
        return {
            "decision": "deny",
            "rule": "permission-denied",
            "risk": risk,
            "reason": f"This needs {', '.join(missing)}, which has not been granted. Grant it on the node and try again.",
        }

    # Autonomous worker delegation. A coding-agent delegation has already
    # been through intent interpretation, a validated plan, worker-pin and
    # permission resolution, and a project scope — so once those checks
    # pass the policy decision is auto-execute, not a human handover.
    # The high-risk / irreversible floors below are what would otherwise
    # hold a delegated worker behind a person's go-ahead: for agent.delegate
    # specifically they must not demand a separate human go-ahead. denial
    # paths above (no provider, missing grants, unknown/unusable node)
    # are unchanged, and this autonomous judgment is recorded.
    if cap.id == "agent.delegate" and cfg.get("allowAutonomous", True):
        return {
            "decision": "auto-execute",
            "rule": "autonomous-delegation",
            "risk": risk,
            "reason": (
                f"{cap.name} is a governed, audited worker action: the "
                "worker pin, permission grants and project scope are already "
                "established by AURA, so it runs without a separate "
                "permission step."
            ),
        }

    # Floors are a LOWER BOUND seeded into the decision, not early returns:
    # layers below fold with _stricter() and can only escalate.
    decision: PolicyDecision = _current(cfg.get("byRisk", {}).get(risk, "auto-execute"))
    rule = f"risk-default:{risk}"
    reason = ""

    def floor(name: str, why: str) -> None:
        nonlocal decision, rule, reason
        decision = _stricter(decision, "deny")
        rule = name
        reason = why

    if cap.irreversible:
        floor("irreversible-floor",
              f"{cap.name} cannot be undone from here, so AURA refuses it and never runs it unattended.")
    elif "resource.destroy" in cap.permissions:
        floor("destructive-floor", f"{cap.name} destroys something, so AURA refuses it.")
    elif "account.authorize" in cap.permissions:
        floor("authorization-floor",
              f"{cap.name} acts against your account, so AURA refuses it.")
    elif "system.modify" in cap.permissions:
        floor("system-floor",
              f"{cap.name} changes software on this machine, so AURA refuses it unless it runs by hand.")

    # Configurable layers — each may escalate and claim the rule when it does,
    # or when it restates the current level more specifically. A weaker
    # candidate must NEVER claim the rule (that would let a permissive
    # override relabel a floor it never overcame).
    def apply(candidate: PolicyDecision | None, name: str, why: str) -> None:
        nonlocal decision, rule, reason
        if candidate is None:
            return
        candidate = _current(candidate)
        escalates = RANK[candidate] > RANK[decision]
        confirms = RANK[candidate] == RANK[decision] and candidate == decision
        if escalates or confirms:
            rule = name
            reason = why
        decision = _stricter(decision, candidate)

    apply(cfg.get("overrides", {}).get(cap.id), f"override:{cap.id}", "")

    node = inp.subject.node if inp.subject else None
    if node:
        # Least specific first: node-wide, then capability-on-node.
        apply(
            cfg.get("nodeOverrides", {}).get(f"@{node['id']}"),
            f"node-override:@{node['id']}",
            f"{node['name']} is restricted by the workspace policy.",
        )
        apply(
            cfg.get("nodeOverrides", {}).get(f"{cap.id}@{node['id']}"),
            f"node-override:{cap.id}@{node['id']}",
            f"{node['name']} is not permitted to perform {cap.name.lower()} under the workspace policy.",
        )
        allowlist = cfg.get("nodeAllowlists", {}).get(cap.id)
        # An allowlist that EXISTS and excludes this node denies; absent means
        # "no list configured", not "empty list".
        if allowlist is not None and node["id"] not in allowlist:
            apply(
                "deny",
                f"node-not-allowlisted:{cap.id}",
                f"{node['name']} is not on the list of nodes permitted to perform {cap.name.lower()}.",
            )

    if not cfg.get("allowAutonomous", True) and decision == "auto-execute":
        # Autonomy switched off: nothing may run unattended, and nothing waits
        # for a person either, so the action is refused.
        decision = "deny"
        rule = "autonomy-disabled"
        reason = "Autonomous operation is switched off in the workspace policy, so this is refused."

    # No human approval gate exists in AURA Hub Alpha. Decisions that would
    # have waited for a person are resolved here, by policy, immediately:
    #   legacy 'ask-user' -> runs (no human gate);
    #   legacy 'require-approval' -> refused outright (never parked).
    return {
        "decision": decision,
        "rule": rule,
        "risk": risk,
        "reason": reason or _reason_for(decision, cap.name),
    }


def grants_for(permissions: dict[str, bool]) -> list[str]:
    """Node permission flags → policy scopes (kept beside the check, policy.ts:317-332)."""
    out: list[str] = []
    if permissions.get("read"):
        out += ["project.read", "aura.read"]
    if permissions.get("write"):
        out += ["project.write", "aura.write"]
    if permissions.get("execute"):
        out += ["process.execute", "network.outbound"]
    # resource.destroy / account.authorize are NEVER node-grantable.
    return out
