"""Slice C: explicit lifecycle states for inventory candidates.

The states are independent. Discovery authorises nothing, configuration is not
reachability, reachability is not capability, a name hint is not verified
evidence, and stale evidence is unknown rather than true.
"""

from __future__ import annotations

import pytest

from aura.sovereign.candidate_policy import CostState, EndpointPolicy
from aura.sovereign.inventory_state import (
    FAILED,
    FRESH,
    INFERRED,
    PATH_AURA_MEDIATED,
    PATH_WORKER_CLI,
    STALE,
    VERIFIED,
    StateName,
    assess_candidate,
    dispatch_for,
)
from aura.sovereign.model_registry import ModelRecord
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy

NOW = 1000.0
PROBE_TTL = 60.0
META_TTL = 600.0
TEXT = frozenset({"text-generation"})
TOOLS = frozenset({"text-generation", "tool-calling"})


def _rec(model="m", endpoint="ep", network="local", caps=None, sources=None,
         healthy=True, last_checked=NOW, metadata_checked=NOW, absent=(), ctx=0,
         last_error="", category=""):
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    return ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint,
        base_url="http://127.0.0.1:11434", network_class=network,
        capabilities=frozenset(caps),
        capability_sources=dict(sources if sources is not None else caps),
        healthy=healthy, last_checked=last_checked, metadata_checked=metadata_checked,
        verified_absent=frozenset(absent), context_length=ctx, last_error=last_error,
        last_error_category=category)


def _assess(rec, task=TEXT, endpoints=None, configured=frozenset({"ep"}), grants=(),
            spent=None, overrides=None, path=PATH_WORKER_CLI, now=NOW,
            policy=SovereignPolicy()):
    endpoints = endpoints if endpoints is not None else {
        "ep": EndpointPolicy("ep", "local", declared_free=True)}
    return assess_candidate(
        rec, task_caps=task, policy=policy, endpoints=endpoints, grants=grants,
        spent_by_grant=spent or {}, configured_endpoints=configured,
        capability_overrides=overrides, now=now, probe_ttl=PROBE_TTL,
        metadata_ttl=META_TTL, path=path)


# ── independence: no state implies another ──────────────────────────────


def test_discovery_alone_is_not_trust():
    a = _assess(_rec(), configured=frozenset())
    assert a.states[StateName.DISCOVERED].value is True
    assert a.states[StateName.CONFIGURED].value is None
    assert a.states[StateName.POLICY_ELIGIBLE].value is False
    assert a.exclusion == "not-configured"
    assert a.task_ready is False


def test_configuration_is_not_reachability():
    rec = _rec(healthy=None, last_checked=0.0)
    a = _assess(rec)
    assert a.states[StateName.CONFIGURED].value is True
    assert a.states[StateName.REACHABLE].value is None   # never probed: unknown, not True
    assert a.task_ready is False


def test_reachability_is_not_capability():
    rec = _rec(caps={}, sources={})
    a = _assess(rec)
    assert a.states[StateName.REACHABLE].value is True
    assert a.states[StateName.METADATA_VERIFIED].value is None
    assert a.task_ready is False


# ── transitions and stale evidence ──────────────────────────────────────


def test_transition_unprobed_to_ready_to_stale():
    rec = _rec(healthy=None, last_checked=0.0)
    assert _assess(rec).task_ready is False

    rec.healthy = True
    rec.last_checked = NOW
    assert _assess(rec).task_ready is True

    later = NOW + PROBE_TTL + 1
    stale = _assess(rec, now=later)
    assert stale.states[StateName.REACHABLE].value is None
    assert stale.states[StateName.REACHABLE].freshness == STALE
    assert stale.task_ready is False


def test_transition_to_failed_probe_is_false_not_unknown():
    a = _assess(_rec(healthy=False, last_error="connection refused to 10.1.2.3",
                     category="connection-refused"))
    fact = a.states[StateName.REACHABLE]
    assert fact.value is False and fact.evidence == FAILED
    assert fact.detail == "connection-refused"       # the category, not the raw text
    assert "10.1.2.3" not in fact.detail and "connection refused" not in fact.detail
    assert a.task_ready is False


def test_stale_metadata_is_unknown_and_blocks_readiness():
    rec = _rec(metadata_checked=NOW - META_TTL - 1)
    a = _assess(rec)
    fact = a.states[StateName.METADATA_VERIFIED]
    assert fact.value is None and fact.freshness == STALE
    assert a.task_ready is False


def test_fresh_verified_metadata_is_true():
    fact = _assess(_rec()).states[StateName.METADATA_VERIFIED]
    assert fact.value is True and fact.evidence == VERIFIED and fact.freshness == FRESH


# ── capability provenance: name hints never establish readiness ─────────


def test_name_hint_only_text_capability_is_not_task_ready():
    rec = _rec(caps={"text-generation": "name-hint"}, sources={"text-generation": "name-hint"})
    a = _assess(rec)
    assert a.task_ready is False
    assert any("rests on a name hint only" in r for r in a.not_ready_reasons)
    assert a.states[StateName.METADATA_VERIFIED].evidence == INFERRED


def test_misleading_name_cannot_make_a_model_tool_capable():
    rec = _rec(model="tools-tiny-chat", caps={"text-generation": "ollama:/api/show",
                                              "json-mode": "name-hint"},
               sources={"text-generation": "ollama:/api/show", "json-mode": "name-hint"})
    a = _assess(rec, task=frozenset({"text-generation", "tool-calling"}))
    assert a.task_ready is False
    assert any("tool-calling not reported" in r for r in a.not_ready_reasons)


# ── verified negatives are preserved ────────────────────────────────────


def test_verified_absence_of_tools_blocks_a_tool_task_but_not_a_text_task():
    rec = _rec(caps={"text-generation": "ollama:/api/show"}, absent={"tool-calling"})
    assert _assess(rec, task=TEXT).task_ready is True
    tool_task = _assess(rec, task=TOOLS)
    assert tool_task.task_ready is False
    assert any("tool-calling verified absent" in r for r in tool_task.not_ready_reasons)


def test_verified_absence_cannot_be_overridden_to_ready_by_a_name_claim():
    rec = _rec(caps={"text-generation": "ollama:/api/show"}, absent={"tool-calling"},
               model="claims-tools-model")
    a = _assess(rec, task=TOOLS)
    assert a.task_ready is False


# ── task-specific readiness and operator overrides ──────────────────────


def test_readiness_is_per_task_for_the_same_record():
    rec = _rec(caps={"text-generation": "ollama:/api/show", "tool-calling": "ollama:/api/show"})
    assert _assess(rec, task=TOOLS).task_ready is True
    rec2 = _rec(caps={"text-generation": "ollama:/api/show"})
    assert _assess(rec2, task=TOOLS).task_ready is False


def test_operator_override_can_establish_a_capability_with_operator_provenance():
    rec = _rec(caps={"text-generation": "ollama:/api/show"})
    a = _assess(rec, task=TOOLS, overrides={"ep": {"tool-calling": True}})
    assert a.task_ready is True


def test_operator_override_can_disable_a_capability():
    a = _assess(_rec(), task=TEXT, overrides={"ep": {"text-generation": False}})
    assert a.task_ready is False
    assert any("disabled by operator override" in r for r in a.not_ready_reasons)


def test_metadata_state_does_not_count_operator_overrides_as_server_metadata():
    rec = _rec(caps={}, sources={})
    a = _assess(rec, task=frozenset(), overrides={"ep": {"tool-calling": True}})
    assert a.states[StateName.METADATA_VERIFIED].value is None


# ── dispatchability is an execution-path assessment ─────────────────────


def test_free_local_model_is_dispatchable_on_the_worker_path():
    assert dispatch_for(PATH_WORKER_CLI, CostState.FREE_VERIFIED).supported


def test_the_aura_mediated_path_is_never_dispatchable_without_a_real_path():
    for cost in (CostState.FREE_VERIFIED, CostState.PAID, CostState.UNKNOWN):
        result = dispatch_for(PATH_AURA_MEDIATED, cost)
        assert result.supported is False
        assert "no AURA-mediated execution path exists" in result.reason


def test_paid_is_not_dispatchable_on_either_path_today():
    worker = dispatch_for(PATH_WORKER_CLI, CostState.PAID)
    aura = dispatch_for(PATH_AURA_MEDIATED, CostState.PAID)
    assert not worker.supported and worker.reason == "paid-dispatch-not-metered"
    assert not aura.supported


def test_unknown_cost_is_never_dispatchable():
    assert not dispatch_for(PATH_WORKER_CLI, CostState.UNKNOWN).supported
    assert not dispatch_for(PATH_WORKER_CLI, CostState.UNKNOWN).supported


def test_unknown_execution_path_is_refused():
    assert not dispatch_for("magic", CostState.FREE_VERIFIED).supported


def test_a_valid_paid_grant_is_reported_but_still_not_task_ready():
    policy = parse_model_policy({
        "schemaVersion": 1,
        "endpoints": {"api": {"networkClass": "cloud", "cloudEnabled": True,
                              "cost": "paid", "pricePer1kTokens": 0.01}},
        "paidGrants": [{"endpointId": "api", "modelName": "m", "spendCap": 5.0}]})
    rec = _rec(model="m", endpoint="api", network="cloud")
    a = _assess(rec, endpoints={k: v for k, v in policy.endpoints.items()},
                configured=frozenset({"api"}), grants=policy.grants, path=PATH_WORKER_CLI)
    assert a.grant_valid is True and a.grant_available == pytest.approx(5.0)
    assert a.states[StateName.POLICY_ELIGIBLE].value is True
    assert a.task_ready is False
    assert any(r.startswith("dispatch:") for r in a.not_ready_reasons)


def test_an_exhausted_paid_grant_is_reported_as_not_valid():
    policy = parse_model_policy({
        "schemaVersion": 1,
        "endpoints": {"api": {"networkClass": "cloud", "cloudEnabled": True,
                              "cost": "paid", "pricePer1kTokens": 0.01}},
        "paidGrants": [{"endpointId": "api", "modelName": "m", "spendCap": 0.01}]})
    a = _assess(_rec(model="m", endpoint="api", network="cloud"),
                endpoints=dict(policy.endpoints), configured=frozenset({"api"}),
                grants=policy.grants, spent={("api", "m"): 0.01})
    assert a.grant_valid is False
    assert a.exclusion == "spend-cap-exceeded"


def test_a_free_ready_local_candidate_is_task_ready():
    a = _assess(_rec())
    assert a.task_ready is True
    assert a.not_ready_reasons == ()
    assert a.states[StateName.TASK_READY].value is True


def test_operator_claim_cannot_override_a_verified_absence_in_policy_or_readiness():
    rec = _rec(caps={"text-generation": "ollama:/api/show"}, absent={"tool-calling"})
    a = _assess(rec, task=TOOLS, overrides={"ep": {"tool-calling": True}})
    assert a.task_ready is False
    assert a.states[StateName.POLICY_ELIGIBLE].value is False
    assert a.exclusion == "capability-unverified"
