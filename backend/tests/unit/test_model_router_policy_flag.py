"""Slice B: policy-gated routing behind AURA_MODEL_POLICY_ROUTING (default off).

Flag off must be the legacy routing, with no policy or ledger access. Flag on
must apply the candidate filter, fail closed on any policy or accounting error,
and never select a paid candidate, because paid dispatch is not metered yet.
"""

from __future__ import annotations

import pytest

from aura.sovereign import model_router as mr
from aura.sovereign.model_registry import ModelRecord, ModelRegistry
from aura.sovereign.model_router import (
    POLICY_ROUTING_ENV,
    ModelRouter,
    policy_routing_enabled,
)
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy
from aura.sovereign.usage_ledger import UsageLedger

ALL_VERIFIED = {"text-generation": "ollama:/api/show", "code-generation": "name-hint"}


def _record(endpoint, model, network="local", caps=None, sources=None, healthy=True):
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    return ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint,
        base_url="http://127.0.0.1:11434", network_class=network,
        capabilities=frozenset(caps),
        capability_sources=dict(sources if sources is not None else caps),
        healthy=healthy)


def _registry(*records) -> ModelRegistry:
    reg = ModelRegistry()
    for rec in records:
        reg.register_manual(rec)
    return reg


def _router(registry, policy_doc=None, ledger=None, sovereign=None):
    policy = parse_model_policy(policy_doc) if policy_doc is not None else \
        parse_model_policy({"schemaVersion": 1})
    return ModelRouter(registry, policy=policy,
                       sovereign=sovereign or SovereignPolicy(),
                       ledger=ledger)


@pytest.fixture
def ledger(tmp_path):
    return UsageLedger(tmp_path / "usage.sqlite3")


@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setenv(POLICY_ROUTING_ENV, "1")


# ── the flag ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value,expected", [
    (None, False), ("", False), ("0", False), ("false", False), ("off", False),
    ("1", True), ("true", True), ("YES", True), ("on", True), ("maybe", False),
])
def test_flag_is_off_unless_explicitly_enabled(value, expected):
    env = {} if value is None else {POLICY_ROUTING_ENV: value}
    assert policy_routing_enabled(env) is expected


# ── flag off: legacy behaviour, with no policy or ledger access ─────────


def test_flag_off_matches_the_legacy_path_exactly(monkeypatch):
    monkeypatch.delenv(POLICY_ROUTING_ENV, raising=False)
    reg = _registry(_record("ep", "a"), _record("ep", "b", healthy=False))
    router = ModelRouter(reg)
    for task in ["Write a Python function to parse invoices", "Summarise this report"]:
        assert router.route(task) == router._route_legacy(task, None, None)


def test_flag_off_never_touches_policy_or_ledger(monkeypatch):
    monkeypatch.delenv(POLICY_ROUTING_ENV, raising=False)

    def forbidden(*a, **k):
        raise AssertionError("policy or ledger accessed while the flag is off")

    monkeypatch.setattr(mr, "load_model_policy", forbidden)
    monkeypatch.setattr(mr, "load_sovereign_policy", forbidden)
    monkeypatch.setattr(mr, "UsageLedger", forbidden)
    decision = ModelRouter(_registry(_record("ep", "a"))).route("Summarise this report")
    assert decision.record is not None and decision.exclusions == ()


def test_flag_off_needs_no_policy_file(tmp_path, monkeypatch):
    monkeypatch.delenv(POLICY_ROUTING_ENV, raising=False)
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    decision = ModelRouter(_registry(_record("ep", "a"))).route("Summarise this report")
    assert decision.record is not None


# ── flag on: local, private, cloud, free, paid, unknown, cap, unhealthy ──


def test_local_loopback_model_is_routed_without_any_declaration(flag_on, ledger):
    router = _router(_registry(_record("ollama-local", "small", network="local")),
                     ledger=ledger)
    decision = router.route("Summarise this report")
    assert decision.record is not None and decision.record.model_name == "small"


def test_private_endpoint_without_a_cost_declaration_is_not_routed(flag_on, ledger):
    router = _router(_registry(_record("gpu-lan", "big", network="private")))
    decision = router.route("Summarise this report")
    assert decision.record is None
    assert "cost-unknown" in decision.reason
    assert "model_policy.json" in decision.reason


def test_private_endpoint_declared_free_is_routed(flag_on, ledger):
    doc = {"schemaVersion": 1, "endpoints": {"gpu-lan": {"networkClass": "private", "cost": "free"}}}
    router = _router(_registry(_record("gpu-lan", "big", network="private")),
                     policy_doc=doc)
    assert router.route("Summarise this report").record is not None


def test_cloud_endpoint_is_never_selected_unless_enabled_by_name(flag_on, ledger):
    reg = _registry(_record("api", "cloud-model", network="cloud"))
    router = _router(reg)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is None
    assert [e.reason for e in decision.exclusions] == ["cloud-not-enabled"]


def test_enabled_free_cloud_endpoint_is_routed(flag_on, ledger):
    doc = {"schemaVersion": 1, "endpoints": {"api": {
        "networkClass": "cloud", "cloudEnabled": True, "cost": "free"}}}
    router = _router(_registry(_record("api", "cloud-model", network="cloud")),
                     policy_doc=doc)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is not None


def test_sovereign_mode_blocks_an_enabled_cloud_endpoint(flag_on, ledger):
    doc = {"schemaVersion": 1, "endpoints": {"api": {
        "networkClass": "cloud", "cloudEnabled": True, "cost": "free"}}}
    sovereign = SovereignPolicy(sovereign_mode=True,
                                allowed_classes=frozenset({"local", "private"}))
    router = _router(_registry(_record("api", "cloud-model", network="cloud")),
                     policy_doc=doc, sovereign=sovereign)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is None
    assert [e.reason for e in decision.exclusions] == ["sovereignty-blocked"]


def test_paid_candidate_with_a_grant_is_still_not_selected_until_metering_exists(flag_on, ledger):
    doc = {"schemaVersion": 1,
           "endpoints": {"paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                                      "cost": "paid", "pricePer1kTokens": 0.01}},
           "paidGrants": [{"endpointId": "paid-api", "modelName": "big", "spendCap": 5.0}]}
    router = _router(_registry(_record("paid-api", "big", network="cloud")),
                     policy_doc=doc)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is None
    assert "paid-dispatch-not-metered" in [e.reason for e in decision.exclusions]


def test_paid_candidate_without_a_grant_is_excluded_for_authorization(flag_on, ledger):
    doc = {"schemaVersion": 1,
           "endpoints": {"paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                                      "cost": "paid", "pricePer1kTokens": 0.01}}}
    router = _router(_registry(_record("paid-api", "big", network="cloud")),
                     policy_doc=doc)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is None
    assert [e.reason for e in decision.exclusions] == ["paid-needs-authorization"]


def test_exhausted_spend_cap_is_reported_as_the_reason(flag_on, ledger):
    doc = {"schemaVersion": 1,
           "endpoints": {"paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                                      "cost": "paid", "pricePer1kTokens": 0.01}},
           "paidGrants": [{"endpointId": "paid-api", "modelName": "big", "spendCap": 0.01}]}
    ledger.reserve("paid-api", "big", cap=0.01, estimate=0.01)     # cap already used
    router = _router(_registry(_record("paid-api", "big", network="cloud")),
                     policy_doc=doc)
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert [e.reason for e in decision.exclusions] == ["spend-cap-exceeded"]


def test_unknown_cost_is_never_treated_as_free(flag_on, ledger):
    router = _router(_registry(_record("unknown-ep", "m", network="private")))
    decision = router.route("Summarise this report")
    assert decision.record is None
    assert "cost-unknown" in [e.reason for e in decision.exclusions]


def test_unhealthy_candidate_is_unavailable(flag_on, ledger):
    doc = {"schemaVersion": 1, "endpoints": {"ep": {"networkClass": "private", "cost": "free"}}}
    router = _router(_registry(_record("ep", "m", network="private", healthy=False)),
                     policy_doc=doc)
    decision = router.route("Summarise this report")
    assert decision.record is None


def test_candidate_without_the_required_capability_is_not_routed(flag_on, ledger):
    router = _router(_registry(_record("ollama-local", "m", caps={"embedding": "ollama:/api/show"})),
                     ledger=ledger)
    decision = router.route("Summarise this report")      # needs text-generation
    assert decision.record is None


def test_name_hint_only_json_mode_does_not_route_a_structured_task(flag_on, ledger):
    rec = _record("ollama-local", "m", caps={"text-generation": "ollama:/api/show",
                                             "json-mode": "name-hint"},
                  sources={"text-generation": "ollama:/api/show", "json-mode": "name-hint"})
    router = _router(_registry(rec))
    decision = router.route("Extract the invoice fields as structured data")
    assert decision.record is None


# ── flag on: fail closed on configuration or accounting errors ──────────


def test_malformed_policy_fails_closed_rather_than_becoming_permissive(flag_on, tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "model_policy.json").write_text('{"schemaVersion": 1, "x": 1}')
    router = ModelRouter(_registry(_record("ollama-local", "m")))
    decision = router.route("Summarise this report")
    assert decision.record is None
    assert "fails closed" in decision.reason


def test_ledger_failure_fails_closed(flag_on, tmp_path):
    doc = {"schemaVersion": 1,
           "endpoints": {"paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                                      "cost": "paid", "pricePer1kTokens": 0.01}},
           "paidGrants": [{"endpointId": "paid-api", "modelName": "big", "spendCap": 5.0}]}

    class BrokenLedger:
        def spent(self, endpoint_id, model_name):
            raise OSError("usage database unreadable")

    router = _router(_registry(_record("paid-api", "big", network="cloud")),
                     policy_doc=doc, ledger=BrokenLedger())
    decision = router.route("Summarise this report", network_classes=frozenset({"cloud"}))
    assert decision.record is None
    assert "fails closed" in decision.reason and "unreadable" in decision.reason


def test_enabled_route_with_no_candidates_says_so(flag_on, ledger):
    decision = _router(_registry()).route("Summarise this report")
    assert decision.record is None
    assert "no candidates" in decision.reason
