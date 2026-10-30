"""Candidate filter: provenance precedence, sovereignty, cloud, cost and grants.

The filter is pure, so these tests build candidates and policies directly and
check each exclusion reason. The golden test at the end proves that, under the
default policy and verified metadata, eligibility matches the old router rule.
"""

from __future__ import annotations

import pytest

from aura.agent_runtime.model_metadata import parse_ollama_show
from aura.sovereign.candidate_policy import (
    LEGACY_INFERRED_TAGS,
    CandidateInput,
    CostState,
    EndpointPolicy,
    Fact,
    PaidGrant,
    Provenance,
    TaskRequest,
    candidate_from_record,
    cost_state_for,
    filter_candidates,
    resolve_tag,
)
from aura.sovereign.model_registry import (
    ModelRecord,
    _infer_capabilities,
    reconcile_capabilities,
)
from aura.sovereign.model_router import SOVEREIGN_NETWORK_CLASSES
from aura.sovereign.policy import SovereignPolicy

DEFAULT = SovereignPolicy()                                   # sovereign_mode off
SOVEREIGN = SovereignPolicy(sovereign_mode=True,
                            allowed_classes=frozenset({"local", "private"}))


def _cand(endpoint="ep", model="m", network="local", caps=None, healthy=True):
    return CandidateInput(endpoint_id=endpoint, model_name=model, network_class=network,
                          capabilities=caps or {}, healthy=healthy)


def _verified(value=True):
    return Fact(value, Provenance.VERIFIED, "ollama:/api/show")


def _inferred(value=True):
    return Fact(value, Provenance.INFERRED, "name heuristic")


def _reason(result, endpoint="ep", model="m"):
    matches = [e for e in result.excluded if (e.endpoint_id, e.model_name) == (endpoint, model)]
    return matches[0].reason if matches else None


# ── provenance and precedence ───────────────────────────────────────────


def test_verified_value_stands_over_operator_claim_of_the_same_value():
    fact = resolve_tag("tool-calling", _verified(True), operator=True, inferred=None)
    assert fact.provenance is Provenance.VERIFIED and fact.value is True


def test_operator_cannot_claim_a_capability_the_server_verifiably_lacks():
    fact = resolve_tag("tool-calling", _verified(False), operator=True, inferred=None)
    assert fact.value is False
    assert fact.provenance is Provenance.VERIFIED
    assert "server says otherwise" in fact.note


def test_operator_may_restrict_a_verified_capability():
    fact = resolve_tag("tool-calling", _verified(True), operator=False, inferred=None)
    assert fact.value is False and fact.provenance is Provenance.OPERATOR


def test_operator_declaration_fills_a_gap_when_nothing_is_verified():
    fact = resolve_tag("vision", None, operator=True, inferred=None)
    assert fact.value is True and fact.provenance is Provenance.OPERATOR


def test_inferred_value_is_only_used_when_nothing_better_exists():
    assert resolve_tag("json-mode", None, None, True).provenance is Provenance.INFERRED
    assert resolve_tag("json-mode", None, None, None).provenance is Provenance.UNKNOWN


def test_unknown_is_never_false():
    fact = resolve_tag("tool-calling", None, None, None)
    assert fact.value is None and fact.provenance is Provenance.UNKNOWN


# ── misleading names do not decide critical capabilities ────────────────


def test_inferred_vision_cannot_satisfy_a_vision_task():
    result = filter_candidates(
        [_cand(caps={"vision": _inferred(True)})],
        TaskRequest(frozenset({"vision"})), DEFAULT, {})
    assert _reason(result) == "capability-unverified"


def test_inferred_json_mode_cannot_satisfy_a_structured_output_task():
    result = filter_candidates(
        [_cand(caps={"json-mode": _inferred(True), "text-generation": _verified()})],
        TaskRequest(frozenset({"json-mode"})), DEFAULT, {})
    assert _reason(result) == "capability-unverified"


def test_inferred_code_generation_is_accepted_for_coding_only_as_the_legacy_exception():
    assert "code-generation" in LEGACY_INFERRED_TAGS
    result = filter_candidates(
        [_cand(caps={"code-generation": _inferred(True), "text-generation": _inferred(True)})],
        TaskRequest(frozenset({"code-generation", "text-generation"})), DEFAULT, {})
    assert [e.model_name for e in result.eligible] == ["m"]


def test_a_verified_embedding_tag_does_not_make_a_chat_model_eligible_for_text():
    result = filter_candidates(
        [_cand(caps={"embedding": _verified(True)})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, {})
    assert _reason(result) == "capability-unverified"


# ── sovereignty and cloud ───────────────────────────────────────────────


def test_sovereign_mode_is_a_hard_boundary_even_for_an_enabled_cloud_endpoint():
    endpoints = {"ep": EndpointPolicy("ep", "cloud", cloud_enabled=True, declared_free=True)}
    result = filter_candidates(
        [_cand(network="cloud", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), SOVEREIGN, endpoints)
    assert _reason(result) == "sovereignty-blocked"


def test_cloud_is_not_eligible_unless_enabled_for_that_endpoint():
    result = filter_candidates(
        [_cand(network="cloud", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, {})
    assert _reason(result) == "cloud-not-enabled"


def test_enabling_cloud_alone_does_not_make_an_unknown_cost_endpoint_eligible():
    endpoints = {"ep": EndpointPolicy("ep", "cloud", cloud_enabled=True)}
    result = filter_candidates(
        [_cand(network="cloud", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, endpoints)
    assert _reason(result) == "cost-unknown"


def test_cloud_endpoint_enabled_and_declared_free_is_eligible():
    endpoints = {"ep": EndpointPolicy("ep", "cloud", cloud_enabled=True, declared_free=True)}
    result = filter_candidates(
        [_cand(network="cloud", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, endpoints)
    assert [e.cost_state for e in result.eligible] == [CostState.FREE_VERIFIED]


# ── cost states, grants and caps ────────────────────────────────────────


def test_unknown_cost_is_never_treated_as_free():
    endpoints = {"ep": EndpointPolicy("ep", "private")}
    result = filter_candidates(
        [_cand(network="private", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, endpoints)
    assert _reason(result) == "cost-unknown"


def test_loopback_local_runtime_is_free_by_structure():
    assert cost_state_for("local", None) is CostState.FREE_VERIFIED


def test_paid_endpoint_without_a_price_is_rejected_as_unbounded():
    endpoints = {"ep": EndpointPolicy("ep", "cloud", cloud_enabled=True, declared_paid=True)}
    result = filter_candidates(
        [_cand(network="cloud", caps={"text-generation": _verified()})],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, endpoints)
    assert _reason(result) == "paid-price-unbounded"


def _paid_endpoint(price=0.01):
    return {"ep": EndpointPolicy("ep", "cloud", cloud_enabled=True, price_per_1k_tokens=price)}


def _paid_cand(model="m"):
    return _cand(model=model, network="cloud", caps={"text-generation": _verified()})


def test_paid_candidate_without_a_grant_needs_per_request_authorization():
    result = filter_candidates([_paid_cand()], TaskRequest(frozenset({"text-generation"})),
                               DEFAULT, _paid_endpoint())
    assert _reason(result) == "paid-needs-authorization"


def test_grant_for_another_model_does_not_apply():
    grant = PaidGrant("ep", "other-model", spend_cap=1.0)
    result = filter_candidates([_paid_cand("m")], TaskRequest(frozenset({"text-generation"})),
                               DEFAULT, _paid_endpoint(), grants=[grant])
    assert _reason(result) == "paid-needs-authorization"


def test_grant_within_cap_makes_the_paid_candidate_eligible_with_an_estimate():
    grant = PaidGrant("ep", "m", spend_cap=0.05)
    result = filter_candidates([_paid_cand()],
                               TaskRequest(frozenset({"text-generation"}), max_output_tokens=1000),
                               DEFAULT, _paid_endpoint(0.01), grants=[grant])
    assert len(result.eligible) == 1
    assert result.eligible[0].estimated_max_cost == pytest.approx(0.01)
    assert result.eligible[0].grant is grant


def test_spend_cap_is_enforced_including_what_is_already_spent():
    grant = PaidGrant("ep", "m", spend_cap=0.05)
    request = TaskRequest(frozenset({"text-generation"}), max_output_tokens=1000,
                          spent_by_grant={("ep", "m"): 0.045})
    result = filter_candidates([_paid_cand()], request, DEFAULT, _paid_endpoint(0.01),
                               grants=[grant])
    assert _reason(result) == "spend-cap-exceeded"


def test_a_single_request_larger_than_the_cap_is_refused():
    grant = PaidGrant("ep", "m", spend_cap=0.001)
    result = filter_candidates([_paid_cand()],
                               TaskRequest(frozenset({"text-generation"}), max_output_tokens=4096),
                               DEFAULT, _paid_endpoint(0.01), grants=[grant])
    assert _reason(result) == "spend-cap-exceeded"


def test_free_candidates_never_trigger_a_paid_fallback():
    """Filtering reports every candidate. Choosing a paid one requires a grant,
    so a free candidate that later fails cannot lead to a silent paid call."""
    endpoints = {
        "free-ep": EndpointPolicy("free-ep", "local"),
        "paid-ep": EndpointPolicy("paid-ep", "cloud", cloud_enabled=True, price_per_1k_tokens=0.01),
    }
    candidates = [
        _cand(endpoint="free-ep", model="a", network="local", caps={"text-generation": _verified()}),
        _cand(endpoint="paid-ep", model="b", network="cloud", caps={"text-generation": _verified()}),
    ]
    result = filter_candidates(candidates, TaskRequest(frozenset({"text-generation"})),
                               DEFAULT, endpoints)
    assert [e.model_name for e in result.eligible] == ["a"]
    assert _reason(result, "paid-ep", "b") == "paid-needs-authorization"


# ── health and determinism ──────────────────────────────────────────────


def test_unhealthy_candidate_is_excluded():
    result = filter_candidates(
        [_cand(caps={"text-generation": _verified()}, healthy=False)],
        TaskRequest(frozenset({"text-generation"})), DEFAULT, {})
    assert _reason(result) == "unhealthy"


def test_filter_is_deterministic_and_keeps_input_order():
    cands = [_cand(model=f"m{i}", caps={"text-generation": _verified()}) for i in range(4)]
    request = TaskRequest(frozenset({"text-generation"}))
    first = filter_candidates(cands, request, DEFAULT, {})
    second = filter_candidates(cands, request, DEFAULT, {})
    assert first == second
    assert [e.model_name for e in first.eligible] == ["m0", "m1", "m2", "m3"]


# ── golden: under the default policy, eligibility matches the old router rule ──


def _record(name: str, payload: dict, endpoint: str = "ollama-local") -> ModelRecord:
    """A registry record built the same way discovery builds it (metadata verified)."""
    hints = _infer_capabilities(name, 0)
    meta = parse_ollama_show(name, payload)
    tags, sources, context = reconcile_capabilities(hints, meta)
    return ModelRecord(id=f"{endpoint}/{name}", model_name=name, endpoint_id=endpoint,
                       base_url="http://127.0.0.1:11434", network_class="local",
                       capabilities=tags, capability_sources=sources,
                       context_length=context, healthy=True)


GOLDEN_RECORDS = [
    _record("qwen2.5-coder:1.5b", {"capabilities": ["completion", "tools"],
                                   "model_info": {"qwen2.context_length": 32768}}),
    _record("nomic-embed-text:latest", {"capabilities": ["embedding"]}),
    _record("qwen3:4b", {"capabilities": ["completion", "tools", "thinking"]}),
]


@pytest.mark.parametrize("task", [
    frozenset({"text-generation"}),
    frozenset({"code-generation"}),
    frozenset({"embedding"}),
])
def test_golden_default_policy_matches_the_old_router_rule(task):
    """Tags that have a verified source or are legacy-inferred must give the same answer as before."""
    endpoints = {"ollama-local": EndpointPolicy("ollama-local", "local")}
    candidates = [candidate_from_record(r) for r in GOLDEN_RECORDS]
    new = {e.model_name for e in filter_candidates(
        candidates, TaskRequest(task), DEFAULT, endpoints).eligible}
    old = {r.model_name for r in GOLDEN_RECORDS
           if r.matches(task)
           and r.network_class in SOVEREIGN_NETWORK_CLASSES
           and r.healthy is not False}
    assert new == old


def test_golden_json_mode_is_the_one_intended_difference():
    """json-mode is known only from the name for these models, and the old router
    accepted it. The new rule refuses it. That is the change this slice makes."""
    endpoints = {"ollama-local": EndpointPolicy("ollama-local", "local")}
    candidates = [candidate_from_record(r) for r in GOLDEN_RECORDS]
    new = {e.model_name for e in filter_candidates(
        candidates, TaskRequest(frozenset({"json-mode"})), DEFAULT, endpoints).eligible}
    old = {r.model_name for r in GOLDEN_RECORDS if r.matches(frozenset({"json-mode"}))}
    assert old - new == old                       # every match was name-only
    assert new == set()
