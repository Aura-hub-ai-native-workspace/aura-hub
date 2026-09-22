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

PolicyDecision = Literal["auto-execute", "ask-user", "require-approval", "deny"]
RiskLevel = Literal["low", "medium", "high"]
PermissionScope = Literal[
    "project.read", "project.write", "process.execute", "network.outbound",
    "account.authorize", "resource.destroy", "system.modify",
    "aura.read", "aura.write",
]

DECISIONS: tuple[str, ...] = ("auto-execute", "ask-user", "require-approval", "deny")

RANK: dict[str, int] = {
    "auto-execute": 0,
    "ask-user": 1,
    "require-approval": 2,
    "deny": 3,
}

DEFAULT_POLICY: dict[str, Any] = {
    "byRisk": {"low": "auto-execute", "medium": "ask-user", "high": "require-approval"},
    "overrides": {
        # Human gates by definition — authorizing an account is the
        # moment the human is *supposed* to be present.
        "provider.connect": "require-approval",
    },
    "nodeOverrides": {},
    "nodeAllowlists": {},
    "allowAutonomous": True,
    # Explicit autonomy grants. Each listed capability runs without
    # interrupting the user — delegation, mission control, writes,
    # terminal use and git. Every one is reversible through the
    # project's own version control or bounded by allow-lists and fixed
    # argument vectors. This list CANNOT authorize destruction: floors
    # fire first and the grant is skipped whenever one did, so listing
    # filesystem.delete here would change nothing. Operators can still
    # re-gate any entry with an override (overrides only escalate), and
    # allowAutonomous=False suppresses every grant.
    "autonomy": [
        "agent.delegate",
        "filesystem.write",
        "git.commit",
        "git.push",
        "mission.approve",
        "mission.start",
        "terminal.execute",
    ],
}

HUMAN_ONLY_SCOPES = frozenset({"account.authorize", "resource.destroy", "system.modify"})


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
    inp = raw if isinstance(raw, dict) else {}

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

    # Autonomy grants get the same hostile-input treatment as every
    # other list: non-string and empty entries are dropped, duplicates
    # collapse, and the result is sorted so sanitized configs compare
    # equal. Absent means the shipped default; present-but-malformed
    # means no grants (fail closed — there is no spelling of
    # "everything" here).
    raw_grants = inp.get("autonomy")
    if raw_grants is None and "autonomy" not in inp:
        autonomy = sorted(DEFAULT_POLICY["autonomy"])
    elif isinstance(raw_grants, list):
        autonomy = sorted({x for x in raw_grants
                           if isinstance(x, str) and x})
    else:
        autonomy = []

    return {
        "byRisk": by_risk,
        "overrides": overrides,
        "nodeOverrides": node_overrides,
        "nodeAllowlists": node_allowlists,
        "allowAutonomous": allow_autonomous,
        "autonomy": autonomy,
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
        "ask-user": f"{name} changes something. One confirmation and it proceeds.",
        "require-approval": f"{name} needs your explicit authorization, recorded against this mission.",
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
    # checked here — they are satisfied by the approval the floors demand;
    # checking them would make authorization impossible instead of gated.
    missing = [p for p in cap.permissions if p not in HUMAN_ONLY_SCOPES and p not in inp.granted]
    if missing:
        return {
            "decision": "deny",
            "rule": "permission-denied",
            "risk": risk,
            "reason": f"This needs {', '.join(missing)}, which has not been granted. Grant it on the node and try again.",
        }

    # Floors are a LOWER BOUND seeded into the decision, not early returns:
    # layers below fold with _stricter() and can only escalate.
    decision: PolicyDecision = cfg.get("byRisk", {}).get(risk, "auto-execute")
    rule = f"risk-default:{risk}"
    reason = ""

    floored = False

    def floor(name: str, why: str) -> None:
        nonlocal decision, rule, reason, floored
        floored = True
        decision = _stricter(decision, "require-approval")
        rule = name
        reason = why

    if cap.irreversible:
        floor("irreversible-floor",
              f"{cap.name} cannot be undone from here, so it always needs your explicit go-ahead.")
    elif "resource.destroy" in cap.permissions:
        floor("destructive-floor", f"{cap.name} destroys something. That is always your call.")
    elif "account.authorize" in cap.permissions:
        floor("authorization-floor",
              f"{cap.name} acts against your account, so you authorize it yourself.")
    elif "system.modify" in cap.permissions:
        floor("system-floor",
              f"{cap.name} changes software on this machine, so it always needs your go-ahead.")

    # Autonomy grants — the one layer allowed to relax, and only down
    # to auto-execute, never past a floor or a deny. A grant fires only
    # when no floor fired above: destruction, account authorization and
    # system modification stay gated no matter what the autonomy list
    # contains. Operator overrides and node rules below still escalate,
    # so any grant can be re-gated per deployment, and allowAutonomous
    # = False still suppresses every grant.
    if (not floored and decision != "deny"
            and cap.id in (cfg.get("autonomy") or [])):
        decision = "auto-execute"
        rule = f"autonomy:{cap.id}"
        reason = (f"{cap.name} is covered by the autonomy grant: normal "
                  "reversible work that runs without interrupting you.")

    # Configurable layers — each may escalate and claim the rule when it does,
    # or when it restates the current level more specifically. A weaker
    # candidate must NEVER claim the rule (that would let a permissive
    # override relabel a floor it never overcame).
    def apply(candidate: PolicyDecision | None, name: str, why: str) -> None:
        nonlocal decision, rule, reason
        if candidate is None:
            return
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
        decision = "ask-user"
        rule = "autonomy-disabled"
        reason = ""

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
