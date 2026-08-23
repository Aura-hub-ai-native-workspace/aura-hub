"""The policy engine — the single place a governance decision is made.

A behavioral port of packages/capability-fabric/src/policy.ts. The
evaluation *order* is the security argument, not an implementation
detail, so it is reproduced exactly:

    1. hard floors      (checked before any configuration is read)
    2. risk default     (the seed)
    3. the four approval floors  (a LOWER BOUND, and they fall through)
    4. configurable layers, each folded with stricter()
    5. the autonomy switch

Every configurable layer can only escalate. No configuration — not a risk
default, not a capability override, not a node override, not an allowlist —
can lower a floor. That property is what makes it safe to let users edit
`fabric-policy.json` at all.

There is exactly one policy engine. Do not add a second decision point
anywhere in this backend.
"""

from __future__ import annotations

from .types import (
    HUMAN_ONLY_SCOPES,
    Grants,
    PermissionScope,
    PolicyConfig,
    PolicyDecision,
    PolicyEvaluation,
    PolicyInput,
    RiskLevel,
    rank,
)

DEFAULT_POLICY = PolicyConfig(
    by_risk={
        RiskLevel.LOW: PolicyDecision.AUTO_EXECUTE,
        RiskLevel.MEDIUM: PolicyDecision.ASK_USER,
        RiskLevel.HIGH: PolicyDecision.REQUIRE_APPROVAL,
    },
    overrides={
        "mission.approve": PolicyDecision.ASK_USER,
        "provider.connect": PolicyDecision.REQUIRE_APPROVAL,
    },
    allow_autonomous=True,
)


def stricter(a: PolicyDecision, b: PolicyDecision) -> PolicyDecision:
    """Fold two decisions to the more restrictive. Ties keep `a`."""
    return b if rank(b) > rank(a) else a


def grants_for(grants: Grants) -> tuple[PermissionScope, ...]:
    """Translate a run's grant flags into permission scopes.

    The three human-only scopes are never emitted, at any combination of
    flags. That is why granting "write" to a run can never escalate into
    authority to destroy a resource or authorize an account.
    """
    scopes: list[PermissionScope] = []
    if grants.read:
        scopes += [PermissionScope.PROJECT_READ, PermissionScope.AURA_READ]
    if grants.write:
        scopes += [PermissionScope.PROJECT_WRITE, PermissionScope.AURA_WRITE]
    if grants.execute:
        scopes += [PermissionScope.PROCESS_EXECUTE, PermissionScope.NETWORK_OUTBOUND]
    return tuple(scopes)


def reason_for(decision: PolicyDecision, capability_name: str) -> str:
    """The fallback prose, when no rule supplied its own.

    Named after the reference's `reasonFor`, and worded identically: this
    text is shown to a person deciding whether to authorize an action.
    """
    if decision is PolicyDecision.AUTO_EXECUTE:
        return f"{capability_name} is low risk and reversible, so it runs without interrupting you."
    if decision is PolicyDecision.ASK_USER:
        return f"{capability_name} changes something. One confirmation and it proceeds."
    if decision is PolicyDecision.REQUIRE_APPROVAL:
        return (
            f"{capability_name} needs your explicit authorization, recorded against this mission."
        )
    return f"{capability_name} is not permitted under the current policy."


def evaluate_policy(inp: PolicyInput, config: PolicyConfig) -> PolicyEvaluation:
    subject = inp.subject
    risk = subject.risk
    name = subject.capability_name

    # ---- 1. Hard floors. Checked before configuration is read, so no
    # configuration can be written that skips them. ----
    if inp.node_available is False:
        return PolicyEvaluation(
            decision=PolicyDecision.DENY,
            reason=(
                f"Nothing connected can perform {name.lower()} yet. "
                "Connect a node that provides it and this becomes available."
            ),
            rule="no-provider",
            risk=risk,
        )

    # Human-only scopes are excluded here on purpose: a capability needing
    # one must reach a human, not become unreachable.
    required = [p for p in subject.permissions if p not in HUMAN_ONLY_SCOPES]
    missing = [p for p in required if p not in inp.granted]
    if missing:
        names = ", ".join(p.value for p in missing)
        return PolicyEvaluation(
            decision=PolicyDecision.DENY,
            reason=(
                f"This needs {names}, which has not been granted. "
                "Grant it on the node and try again."
            ),
            rule="permission-denied",
            risk=risk,
        )

    # ---- 2. Seed from the risk default. The seed carries NO reason: it
    # falls through to `reason_for` at the end unless a later rule speaks
    # for itself. ----
    decision = config.by_risk.get(risk, DEFAULT_POLICY.by_risk[risk])
    reason = ""
    rule = f"risk-default:{risk.value}"

    # ---- 3. The four approval floors. These are a lower bound: they seed
    # via stricter() and fall through, so a later `deny` still applies. An
    # earlier version returned early here, which made it impossible to deny
    # an irreversible capability. ----
    floor: tuple[str, str] | None = None
    if subject.irreversible:
        floor = (
            "irreversible-floor",
            f"{name} cannot be undone from here, so it always needs your explicit go-ahead.",
        )
    elif PermissionScope.RESOURCE_DESTROY in subject.permissions:
        floor = ("destructive-floor", f"{name} destroys something. That is always your call.")
    elif PermissionScope.ACCOUNT_AUTHORIZE in subject.permissions:
        floor = (
            "authorization-floor",
            f"{name} acts against your account, so you authorize it yourself.",
        )
    elif PermissionScope.SYSTEM_MODIFY in subject.permissions:
        floor = (
            "system-floor",
            f"{name} changes software on this machine, so it always needs your go-ahead.",
        )

    if floor is not None:
        # The floor claims the rule label unconditionally. Even when the
        # standing decision is already stricter (a configured `deny`), the
        # floor is why this capability could never have been silent, and the
        # audit record should say so.
        decision = stricter(decision, PolicyDecision.REQUIRE_APPROVAL)
        rule, reason = floor

    # ---- 4. Configurable layers, least specific first. ----
    def apply(candidate: PolicyDecision | None, next_rule: str, next_reason: str) -> None:
        """Fold a candidate in, claiming the rule label only if it earned it.

        A weaker candidate changes nothing and must not relabel a floor —
        otherwise a permissive override would make the audit record claim a
        decision it did not cause.
        """
        nonlocal decision, rule, reason
        if candidate is None:
            return
        # A candidate claims the rule when it genuinely escalates, or when
        # it restates the current level from a more specific position
        # (candidates arrive least-specific first, so a later equal is more
        # specific). A weaker candidate changes nothing and must not claim
        # the label, or a permissive override would relabel a floor it never
        # overcame.
        if rank(candidate) >= rank(decision):
            rule, reason = next_rule, next_reason
        decision = stricter(decision, candidate)

    # A capability override speaks for itself only through the decision it
    # produces, so it supplies no prose — `reason_for` fills it in.
    apply(config.overrides.get(subject.capability_id), f"override:{subject.capability_id}", "")

    node_id = subject.node_id
    node_name = subject.node_name or node_id or ""
    if node_id:
        apply(
            config.node_overrides.get(f"@{node_id}"),
            f"node-override:@{node_id}",
            f"{node_name} is restricted by the workspace policy.",
        )
        apply(
            config.node_overrides.get(f"{subject.capability_id}@{node_id}"),
            f"node-override:{subject.capability_id}@{node_id}",
            (
                f"{node_name} is not permitted to perform {name.lower()} "
                "under the workspace policy."
            ),
        )

        allowlist = config.node_allowlists.get(subject.capability_id)
        if allowlist is not None and node_id not in allowlist:
            apply(
                PolicyDecision.DENY,
                f"node-not-allowlisted:{subject.capability_id}",
                f"{node_name} is not on the list of nodes permitted to perform {name.lower()}.",
            )

    # ---- 5. The autonomy switch. ----
    if not config.allow_autonomous and decision is PolicyDecision.AUTO_EXECUTE:
        decision = PolicyDecision.ASK_USER
        rule = "autonomy-disabled"
        reason = ""

    return PolicyEvaluation(
        decision=decision, reason=reason or reason_for(decision, name), rule=rule, risk=risk
    )


def sanitize_policy(raw: object) -> PolicyConfig:
    """Read a policy file as hostile input.

    The policy file is the thing most likely to be wrong, hand-edited, or
    copied from another machine. Every unreadable value degrades toward
    *more* restriction, never less.
    """
    # Only `byRisk` starts from the shipped default. `overrides` and the node
    # rules start EMPTY: a sanitized file describes what the operator
    # configured, and silently re-adding the shipped overrides would make a
    # cleared override reappear.
    config = PolicyConfig(
        by_risk=dict(DEFAULT_POLICY.by_risk),
        allow_autonomous=DEFAULT_POLICY.allow_autonomous,
    )
    if not isinstance(raw, dict):
        return config

    def as_decision(value: object) -> PolicyDecision | None:
        try:
            return PolicyDecision(value)  # type: ignore[arg-type]
        except (ValueError, TypeError):
            return None

    by_risk = raw.get("byRisk")
    if isinstance(by_risk, dict):
        for key, value in by_risk.items():
            try:
                level = RiskLevel(key)
            except ValueError:
                continue
            decision = as_decision(value)
            if decision is not None:
                config.by_risk[level] = decision

    overrides = raw.get("overrides")
    if isinstance(overrides, dict):
        for key, value in overrides.items():
            decision = as_decision(value)
            if isinstance(key, str) and key and decision is not None:
                config.overrides[key] = decision

    node_overrides = raw.get("nodeOverrides")
    if isinstance(node_overrides, dict):
        for key, value in node_overrides.items():
            # A key without "@" cannot address a node, so it can only be a
            # mistake — and a mistaken key that silently became a
            # capability-wide rule would be a quiet privilege change.
            if not isinstance(key, str) or "@" not in key:
                continue
            decision = as_decision(value)
            if decision is not None:
                config.node_overrides[key] = decision

    allowlists = raw.get("nodeAllowlists")
    if isinstance(allowlists, dict):
        for key, value in allowlists.items():
            if not isinstance(key, str) or not key:
                continue
            if isinstance(value, list):
                config.node_allowlists[key] = [n for n in value if isinstance(n, str) and n]
            else:
                # Fail closed. A malformed allow-list denies everything
                # rather than being dropped, which would allow everything.
                config.node_allowlists[key] = []

    if "allowAutonomous" in raw:
        value = raw.get("allowAutonomous")
        # Present but not a boolean is a damaged setting; read it cautiously.
        config.allow_autonomous = value if isinstance(value, bool) else False

    return config
