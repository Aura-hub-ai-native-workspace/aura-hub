"""Negative controls for the policy engine.

These are the tests that matter. A policy engine that returns the right
answer for well-formed input is easy; the product's security rests on what
it does with configuration that is wrong, hostile, or written by someone
trying to make an irreversible action run unattended.

Every test here asserts something that must remain FALSE forever.
"""

from __future__ import annotations

import itertools

import pytest

from aura_backend.policy import (
    HUMAN_ONLY_SCOPES,
    Grants,
    PermissionScope,
    PolicyConfig,
    PolicyDecision,
    PolicyInput,
    PolicySubject,
    RiskLevel,
    evaluate_policy,
    grants_for,
    sanitize_policy,
    stricter,
)
from aura_backend.policy.engine import DEFAULT_POLICY

ALL_SCOPES = list(PermissionScope)
ALL_DECISIONS = list(PolicyDecision)

# The four floor-bearing subjects, one per floor.
IRREVERSIBLE = PolicySubject(
    capability_id="agent.delegate",
    risk=RiskLevel.HIGH,
    permissions=(PermissionScope.PROJECT_WRITE, PermissionScope.PROCESS_EXECUTE),
    irreversible=True,
    node_id="opencode",
)
DESTRUCTIVE = PolicySubject(
    capability_id="resource.drop",
    risk=RiskLevel.LOW,
    permissions=(PermissionScope.RESOURCE_DESTROY,),
    node_id="psql",
)
AUTHORIZING = PolicySubject(
    capability_id="provider.connect",
    risk=RiskLevel.LOW,
    permissions=(PermissionScope.ACCOUNT_AUTHORIZE,),
    node_id="gh",
)
SYSTEM = PolicySubject(
    capability_id="system.install",
    risk=RiskLevel.LOW,
    permissions=(PermissionScope.PROCESS_EXECUTE, PermissionScope.SYSTEM_MODIFY),
    node_id="npm",
)
FLOOR_SUBJECTS = [IRREVERSIBLE, DESTRUCTIVE, AUTHORIZING, SYSTEM]

EVERYTHING_GRANTED = frozenset(ALL_SCOPES)

AT_LEAST_APPROVAL = {PolicyDecision.REQUIRE_APPROVAL, PolicyDecision.DENY}


def evaluate(subject: PolicySubject, config: PolicyConfig, **kw) -> PolicyDecision:
    return evaluate_policy(
        PolicyInput(subject=subject, granted=EVERYTHING_GRANTED, **kw), config
    ).decision


# --------------------------------------------------------------------------
# No configuration can lower a floor.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
@pytest.mark.parametrize("permissive", ALL_DECISIONS, ids=lambda d: d.value)
def test_no_risk_default_can_lower_a_floor(subject, permissive):
    config = PolicyConfig(by_risk=dict.fromkeys(RiskLevel, permissive))
    assert evaluate(subject, config) in AT_LEAST_APPROVAL


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
@pytest.mark.parametrize("permissive", ALL_DECISIONS, ids=lambda d: d.value)
def test_no_capability_override_can_lower_a_floor(subject, permissive):
    config = PolicyConfig(
        by_risk=dict(DEFAULT_POLICY.by_risk),
        overrides={subject.capability_id: permissive},
    )
    assert evaluate(subject, config) in AT_LEAST_APPROVAL


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
@pytest.mark.parametrize("permissive", ALL_DECISIONS, ids=lambda d: d.value)
def test_no_node_override_can_lower_a_floor(subject, permissive):
    """Node governance is deny-only.

    If a node override could lift a floor, then "which machine am I on"
    would decide whether an irreversible action needs a human.
    """
    for key in (f"@{subject.node_id}", f"{subject.capability_id}@{subject.node_id}"):
        config = PolicyConfig(
            by_risk=dict(DEFAULT_POLICY.by_risk), node_overrides={key: permissive}
        )
        assert evaluate(subject, config) in AT_LEAST_APPROVAL, key


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
def test_an_allowlist_naming_the_node_does_not_become_a_fast_path(subject):
    """Being allow-listed grants passage, never permission."""
    config = PolicyConfig(
        by_risk=dict.fromkeys(RiskLevel, PolicyDecision.AUTO_EXECUTE),
        node_allowlists={subject.capability_id: [subject.node_id]},
    )
    assert evaluate(subject, config) in AT_LEAST_APPROVAL


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
def test_every_permissive_layer_at_once_still_cannot_lower_a_floor(subject):
    config = PolicyConfig(
        by_risk=dict.fromkeys(RiskLevel, PolicyDecision.AUTO_EXECUTE),
        overrides={subject.capability_id: PolicyDecision.AUTO_EXECUTE},
        node_overrides={
            f"@{subject.node_id}": PolicyDecision.AUTO_EXECUTE,
            f"{subject.capability_id}@{subject.node_id}": PolicyDecision.AUTO_EXECUTE,
        },
        node_allowlists={subject.capability_id: [subject.node_id]},
        allow_autonomous=True,
    )
    assert evaluate(subject, config) in AT_LEAST_APPROVAL


# --------------------------------------------------------------------------
# A floor is a lower bound, not a ceiling: deny must still be reachable.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("subject", FLOOR_SUBJECTS, ids=lambda s: s.capability_id)
def test_a_floor_does_not_prevent_denying_the_capability(subject):
    """The floors seed and fall through; they used to return early, which
    made it impossible to deny an irreversible capability outright."""
    config = PolicyConfig(
        by_risk=dict(DEFAULT_POLICY.by_risk),
        overrides={subject.capability_id: PolicyDecision.DENY},
    )
    assert evaluate(subject, config) is PolicyDecision.DENY


# --------------------------------------------------------------------------
# Hard floors precede configuration entirely.
# --------------------------------------------------------------------------


def test_an_unavailable_node_denies_before_any_configuration_is_read():
    config = PolicyConfig(
        by_risk=dict.fromkeys(RiskLevel, PolicyDecision.AUTO_EXECUTE),
        overrides={"git.status": PolicyDecision.AUTO_EXECUTE},
    )
    result = evaluate_policy(
        PolicyInput(
            subject=PolicySubject("git.status", RiskLevel.LOW, node_id="git"),
            node_available=False,
            granted=EVERYTHING_GRANTED,
        ),
        config,
    )
    assert result.decision is PolicyDecision.DENY
    assert result.rule == "no-provider"


def test_a_missing_permission_denies_regardless_of_configuration():
    config = PolicyConfig(by_risk=dict.fromkeys(RiskLevel, PolicyDecision.AUTO_EXECUTE))
    result = evaluate_policy(
        PolicyInput(
            subject=PolicySubject(
                "filesystem.write",
                RiskLevel.MEDIUM,
                permissions=(PermissionScope.PROJECT_WRITE,),
            ),
            granted=frozenset({PermissionScope.PROJECT_READ}),
        ),
        config,
    )
    assert result.decision is PolicyDecision.DENY
    assert result.rule == "permission-denied"


def test_a_human_only_scope_is_gated_not_made_impossible():
    """Human-only scopes are excluded from the permission floor on purpose.

    Otherwise every capability needing one would be permanently unreachable
    rather than reaching a human for a decision.
    """
    result = evaluate_policy(
        PolicyInput(
            subject=AUTHORIZING,
            granted=frozenset(),  # nothing granted at all
        ),
        PolicyConfig(by_risk=dict(DEFAULT_POLICY.by_risk)),
    )
    assert result.decision is PolicyDecision.REQUIRE_APPROVAL
    assert result.rule == "authorization-floor"


# --------------------------------------------------------------------------
# Human-only scopes are ungrantable.
# --------------------------------------------------------------------------


def test_no_grant_combination_ever_yields_a_human_only_scope():
    for read, write, execute, autonomous in itertools.product([False, True], repeat=4):
        scopes = set(grants_for(Grants(read, write, execute, autonomous)))
        leaked = scopes & set(HUMAN_ONLY_SCOPES)
        assert not leaked, f"{leaked} leaked from {read=} {write=} {execute=} {autonomous=}"


# --------------------------------------------------------------------------
# stricter() only ever escalates.
# --------------------------------------------------------------------------


def test_stricter_never_returns_something_weaker_than_either_input():
    from aura_backend.policy.types import rank

    for a, b in itertools.product(ALL_DECISIONS, repeat=2):
        assert rank(stricter(a, b)) >= max(rank(a), rank(b))


# --------------------------------------------------------------------------
# The sanitizer reads the policy file as hostile input.
# --------------------------------------------------------------------------


def test_a_malformed_allowlist_denies_everything_rather_than_allowing_everything():
    """Fail closed. A dropped allow-list would allow every node; an empty
    one allows none, which is the safe reading of a damaged file."""
    config = sanitize_policy({"nodeAllowlists": {"agent.delegate": "not-a-list"}})
    assert config.node_allowlists["agent.delegate"] == []

    subject = PolicySubject("agent.delegate", RiskLevel.HIGH, node_id="opencode")
    result = evaluate_policy(
        PolicyInput(subject=subject, granted=EVERYTHING_GRANTED), config
    )
    assert result.decision is PolicyDecision.DENY
    assert result.rule == "node-not-allowlisted:agent.delegate"


def test_an_absent_allowlist_is_not_an_empty_one():
    config = sanitize_policy({})
    subject = PolicySubject("git.status", RiskLevel.LOW, node_id="git")
    assert (
        evaluate_policy(PolicyInput(subject=subject, granted=EVERYTHING_GRANTED), config).decision
        is PolicyDecision.AUTO_EXECUTE
    )


def test_unknown_decision_strings_are_dropped_not_coerced():
    config = sanitize_policy(
        {"overrides": {"agent.delegate": "definitely-run-it"}, "byRisk": {"high": "yolo"}}
    )
    assert "agent.delegate" not in config.overrides
    assert config.by_risk[RiskLevel.HIGH] is PolicyDecision.REQUIRE_APPROVAL


def test_a_node_override_key_without_an_at_sign_is_ignored():
    """A key that cannot address a node is a mistake, and a mistaken key
    that silently became a capability-wide rule would be a quiet privilege
    change."""
    config = sanitize_policy({"nodeOverrides": {"agent.delegate": "auto-execute"}})
    assert config.node_overrides == {}


def test_a_non_boolean_allow_autonomous_is_read_as_false():
    assert sanitize_policy({"allowAutonomous": "yes"}).allow_autonomous is False
    assert sanitize_policy({"allowAutonomous": 1}).allow_autonomous is False
    assert sanitize_policy({}).allow_autonomous is True


def test_a_corrupt_policy_file_degrades_to_the_shipped_default():
    for garbage in (None, [], "", 42, "not json at all"):
        config = sanitize_policy(garbage)
        assert config.by_risk == DEFAULT_POLICY.by_risk
        assert config.allow_autonomous is True


# --------------------------------------------------------------------------
# The autonomy switch.
# --------------------------------------------------------------------------


def test_disabling_autonomy_escalates_auto_execute_to_ask_user():
    config = PolicyConfig(
        by_risk=dict.fromkeys(RiskLevel, PolicyDecision.AUTO_EXECUTE), allow_autonomous=False
    )
    result = evaluate_policy(
        PolicyInput(
            subject=PolicySubject("project.list", RiskLevel.LOW), granted=EVERYTHING_GRANTED
        ),
        config,
    )
    assert result.decision is PolicyDecision.ASK_USER
    assert result.rule == "autonomy-disabled"


def test_disabling_autonomy_never_weakens_a_stronger_decision():
    config = PolicyConfig(by_risk=dict(DEFAULT_POLICY.by_risk), allow_autonomous=False)
    assert evaluate(IRREVERSIBLE, config) in AT_LEAST_APPROVAL
