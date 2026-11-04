"""Operator policy validation and the usage ledger for paid grants.

These tests check that a misconfigured or unbounded paid path is refused with a
location-specific error, that spend is never counted from an estimate as if it
were measured, and that concurrent reservations cannot overspend a cap.
"""

from __future__ import annotations

import json
import threading

import pytest

from aura.sovereign.policy_config import (
    PolicyConfigError,
    load_model_policy,
    parse_model_policy,
)
from aura.sovereign.usage_ledger import (
    BASIS_ESTIMATE,
    BASIS_FAILED_UNKNOWN,
    BASIS_NOT_BILLED,
    BASIS_PROVIDER,
    DuplicateUsage,
    LedgerError,
    SpendCapExceeded,
    UsageLedger,
    estimate_cost,
)


def _valid() -> dict:
    return {
        "schemaVersion": 1,
        "endpoints": {
            "gpu-lan": {"networkClass": "private", "cost": "free"},
            "paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                         "cost": "paid", "pricePer1kTokens": 0.002,
                         "capabilityOverrides": {"tool-calling": True}},
        },
        "paidGrants": [{"endpointId": "paid-api", "modelName": "big-model", "spendCap": 5.0}],
    }


# ── configuration: valid input ───────────────────────────────────────────


def test_valid_policy_is_parsed_into_endpoint_policy_and_grants():
    policy = parse_model_policy(_valid())
    assert policy.endpoints["gpu-lan"].declared_free is True
    assert policy.endpoints["paid-api"].cloud_enabled is True
    assert policy.endpoints["paid-api"].price_per_1k_tokens == 0.002
    assert policy.grants[0].spend_cap == 5.0
    assert policy.overrides == {"paid-api": {"tool-calling": True}}


def test_missing_file_is_the_empty_default(tmp_path):
    policy = load_model_policy(tmp_path / "absent.json")
    assert policy.endpoints == {} and policy.grants == ()


# ── configuration: malformed and contradictory input is refused ─────────


@pytest.mark.parametrize("mutate,expected", [
    (lambda d: d.update(extra=1), "unknown key(s) ['extra']"),
    (lambda d: d.update(schemaVersion=2), "schemaVersion: must be 1"),
    (lambda d: d["endpoints"]["gpu-lan"].update(networkClass="moon"), "networkClass"),
    (lambda d: d["endpoints"]["gpu-lan"].update(cloudEnabled=True),
     "cloudEnabled: is set on a non-cloud endpoint"),
    (lambda d: d["endpoints"]["paid-api"].update(pricePer1kTokens=None, cost="paid"),
     "pricePer1kTokens: required when cost is 'paid'"),
    (lambda d: d["endpoints"]["gpu-lan"].update(pricePer1kTokens=0.01),
     "contradicts cost 'free'"),
    (lambda d: d["endpoints"]["paid-api"].update(pricePer1kTokens=-1),
     "must be a finite number greater than zero"),
    (lambda d: d["endpoints"]["paid-api"].update(pricePer1kTokens=True),
     "must be a number"),
    (lambda d: d["endpoints"]["paid-api"].update(capabilityOverrides={"wizardry": True}),
     "unknown tag 'wizardry'"),
    (lambda d: d["endpoints"]["paid-api"].update(capabilityOverrides={"vision": "yes"}),
     "must be true or false"),
    (lambda d: d["paidGrants"][0].update(endpointId="nope"),
     "endpoint 'nope' is not declared"),
    (lambda d: d["paidGrants"][0].update(endpointId="gpu-lan"),
     "is not cost 'paid'"),
    (lambda d: d["paidGrants"][0].update(modelName=""), "exact-model"),
    (lambda d: d["paidGrants"][0].update(spendCap=0), "greater than zero"),
    (lambda d: d["paidGrants"][0].update(spendCap=float("inf")), "finite"),
    (lambda d: d["paidGrants"].append(dict(d["paidGrants"][0])), "duplicate grant"),
    (lambda d: d["paidGrants"][0].update(budgetSomething=1), "unknown key(s)"),
])
def test_malformed_or_contradictory_policy_is_refused_with_its_location(mutate, expected):
    raw = _valid()
    mutate(raw)
    with pytest.raises(PolicyConfigError) as err:
        parse_model_policy(raw)
    assert expected in str(err.value)


def test_top_level_must_be_an_object():
    with pytest.raises(PolicyConfigError, match="top level must be a JSON object"):
        parse_model_policy([])


def test_unreadable_json_fails_closed_with_the_file_named(tmp_path):
    path = tmp_path / "model_policy.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(PolicyConfigError, match="model_policy.json: cannot read or parse"):
        load_model_policy(path)


def test_invalid_file_is_not_silently_replaced_by_the_default(tmp_path):
    path = tmp_path / "model_policy.json"
    raw = _valid()
    raw["paidGrants"][0]["spendCap"] = "lots"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(PolicyConfigError):
        load_model_policy(path)


# ── ledger: reservation and caps ─────────────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    return UsageLedger(tmp_path / "usage.sqlite3")


def test_reservation_within_cap_is_recorded(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=1.0)
    assert ledger.spent("paid-api", "big-model") == pytest.approx(1.0)
    assert rid


def test_reservation_beyond_cap_is_refused_and_records_nothing(ledger):
    ledger.reserve("paid-api", "big-model", cap=1.0, estimate=0.9)
    with pytest.raises(SpendCapExceeded):
        ledger.reserve("paid-api", "big-model", cap=1.0, estimate=0.2)
    assert ledger.spent("paid-api", "big-model") == pytest.approx(0.9)


def test_a_grant_is_scoped_to_its_exact_endpoint_and_model(ledger):
    ledger.reserve("paid-api", "big-model", cap=1.0, estimate=1.0)
    ledger.reserve("paid-api", "other-model", cap=1.0, estimate=1.0)   # different grant
    assert ledger.spent("paid-api", "other-model") == pytest.approx(1.0)
    assert ledger.spent("paid-api", "big-model") == pytest.approx(1.0)


def test_invalid_reservation_inputs_are_refused(ledger):
    with pytest.raises(LedgerError):
        ledger.reserve("paid-api", "big-model", cap=float("nan"), estimate=1.0)
    with pytest.raises(LedgerError):
        ledger.reserve("paid-api", "big-model", cap=1.0, estimate=0)
    assert ledger.spent("paid-api", "big-model") == 0.0


def test_estimate_needs_a_declared_price_and_a_ceiling():
    assert estimate_cost(0.002, 1000) == pytest.approx(0.002)
    with pytest.raises(LedgerError):
        estimate_cost(None, 1000)
    with pytest.raises(LedgerError):
        estimate_cost(0.002, 0)


# ── ledger: settlement, basis and missing usage ──────────────────────────


def test_provider_usage_with_a_declared_price_is_recorded_as_reported(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    basis = ledger.settle(rid, output_tokens=500, price_per_1k_tokens=0.002,
                          provider_event_id="evt-1")
    assert basis == BASIS_PROVIDER
    assert ledger.spent("paid-api", "big-model") == pytest.approx(0.001)


def test_missing_usage_keeps_the_estimate_and_says_so(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    basis = ledger.settle(rid)                  # no usage reported
    assert basis == BASIS_ESTIMATE
    report = ledger.report("paid-api", "big-model")
    assert report["breakdown"][0]["basis"] == BASIS_ESTIMATE
    assert ledger.spent("paid-api", "big-model") == pytest.approx(2.0)


def test_repeated_settlement_with_the_same_values_does_not_double_count(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    ledger.settle(rid, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="e1")
    ledger.settle(rid, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="e1")
    assert ledger.spent("paid-api", "big-model") == pytest.approx(0.001)


def test_conflicting_second_settlement_is_refused(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    ledger.settle(rid, output_tokens=100, price_per_1k_tokens=0.01)
    with pytest.raises(LedgerError, match="already settled differently"):
        ledger.settle(rid, output_tokens=900, price_per_1k_tokens=0.01)


def test_the_same_provider_event_cannot_be_counted_twice(ledger):
    first = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    second = ledger.reserve("paid-api", "big-model", cap=5.0, estimate=2.0)
    ledger.settle(first, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="dup")
    with pytest.raises(DuplicateUsage):
        ledger.settle(second, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="dup")
    assert ledger.spent("paid-api", "big-model") == pytest.approx(0.001 + 2.0)


def test_unknown_reservation_cannot_be_settled(ledger):
    with pytest.raises(LedgerError, match="unknown reservation"):
        ledger.settle("does-not-exist", output_tokens=1, price_per_1k_tokens=0.01)


# ── ledger: failed requests ─────────────────────────────────────────────


def test_failure_known_not_to_bill_frees_the_reservation(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=1.0, estimate=1.0)
    assert ledger.release(rid, not_billed=True) == BASIS_NOT_BILLED
    assert ledger.spent("paid-api", "big-model") == 0.0


def test_failure_of_unknown_billing_keeps_the_estimate(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=1.0, estimate=1.0)
    assert ledger.release(rid, not_billed=False) == BASIS_FAILED_UNKNOWN
    assert ledger.spent("paid-api", "big-model") == pytest.approx(1.0)


def test_a_released_reservation_cannot_be_settled_again(ledger):
    rid = ledger.reserve("paid-api", "big-model", cap=1.0, estimate=1.0)
    ledger.release(rid, not_billed=True)
    with pytest.raises(LedgerError, match="was released|already released"):
        ledger.settle(rid, output_tokens=1, price_per_1k_tokens=0.01)


def test_a_failed_reservation_leaves_no_partial_row(ledger, monkeypatch):
    import aura.sovereign.usage_ledger as ul

    real_spent = ul.UsageLedger._spent_in

    def boom(conn, endpoint_id, model_name):
        raise RuntimeError("disk I/O error")

    monkeypatch.setattr(ul.UsageLedger, "_spent_in", staticmethod(boom))
    with pytest.raises(RuntimeError):
        ledger.reserve("paid-api", "big-model", cap=5.0, estimate=1.0)
    monkeypatch.setattr(ul.UsageLedger, "_spent_in", staticmethod(real_spent))
    assert ledger.spent("paid-api", "big-model") == 0.0


# ── ledger: concurrency ─────────────────────────────────────────────────


def test_concurrent_reservations_cannot_overspend_a_cap(tmp_path):
    path = tmp_path / "usage.sqlite3"
    UsageLedger(path)                         # create the schema once
    cap, estimate, attempts = 3.0, 1.0, 12    # room for exactly three
    accepted: list[str] = []
    refused: list[str] = []
    gate = threading.Barrier(attempts)
    guard = threading.Lock()

    def attempt():
        local = UsageLedger(path)
        gate.wait()
        try:
            local.reserve("paid-api", "big-model", cap=cap, estimate=estimate)
            with guard:
                accepted.append("ok")
        except SpendCapExceeded:
            with guard:
                refused.append("no")

    threads = [threading.Thread(target=attempt) for _ in range(attempts)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert len(accepted) == 3
    assert len(refused) == attempts - 3
    assert UsageLedger(path).spent("paid-api", "big-model") == pytest.approx(3.0)


def test_report_separates_bases_so_estimates_are_never_shown_as_usage(ledger):
    a = ledger.reserve("paid-api", "big-model", cap=10.0, estimate=1.0)
    b = ledger.reserve("paid-api", "big-model", cap=10.0, estimate=1.0)
    ledger.settle(a, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="r1")
    ledger.settle(b)
    bases = {row["basis"] for row in ledger.report("paid-api", "big-model")["breakdown"]}
    assert bases == {BASIS_PROVIDER, BASIS_ESTIMATE}
