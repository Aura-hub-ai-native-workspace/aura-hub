"""Slice A: spend accounting connected to the validated policy.

Covers restart recovery, grant identity, stale reservations, the derivation of
spent-by-grant from a loaded policy, and the difference between measured and
estimated amounts.
"""

from __future__ import annotations

import pytest

from aura.sovereign.policy_config import parse_model_policy
from aura.sovereign.usage_ledger import (
    BASIS_ESTIMATE,
    BASIS_FAILED_UNKNOWN,
    BASIS_PROVIDER,
    DuplicateUsage,
    LedgerError,
    UsageLedger,
    spent_for_grants,
)


def _policy():
    return parse_model_policy({
        "schemaVersion": 1,
        "endpoints": {
            "paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                         "cost": "paid", "pricePer1kTokens": 0.01},
        },
        "paidGrants": [
            {"endpointId": "paid-api", "modelName": "big", "spendCap": 1.0},
            {"endpointId": "paid-api", "modelName": "small", "spendCap": 0.5},
        ],
    })


@pytest.fixture
def path(tmp_path):
    return tmp_path / "agent" / "usage.sqlite3"


# ── restart recovery ────────────────────────────────────────────────────


def test_open_reservation_survives_a_restart_and_still_counts(path):
    first = UsageLedger(path)
    rid = first.reserve("paid-api", "big", cap=1.0, estimate=0.4)
    del first                                       # process restart

    second = UsageLedger(path)
    assert second.spent("paid-api", "big") == pytest.approx(0.4)
    assert second.settle(rid, output_tokens=100, price_per_1k_tokens=0.01,
                         provider_event_id="after-restart") == BASIS_PROVIDER
    assert second.spent("paid-api", "big") == pytest.approx(0.001)


def test_restart_does_not_free_reserved_capacity(path):
    UsageLedger(path).reserve("paid-api", "big", cap=1.0, estimate=0.9)
    from aura.sovereign.usage_ledger import SpendCapExceeded
    with pytest.raises(SpendCapExceeded):
        UsageLedger(path).reserve("paid-api", "big", cap=1.0, estimate=0.2)


# ── stale reservations are reported, never released ─────────────────────


def test_stale_reservation_is_reported_and_still_counted(path, monkeypatch):
    import aura.sovereign.usage_ledger as ul

    ledger = UsageLedger(path)
    monkeypatch.setattr(ul.time, "time", lambda: 1_000_000.0)
    rid = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    monkeypatch.setattr(ul.time, "time", lambda: 1_000_000.0 + 7200)

    stale = ledger.stale_reservations(older_than_seconds=3600)
    assert [s["reservationId"] for s in stale] == [rid]
    assert ledger.spent("paid-api", "big") == pytest.approx(0.3)   # not released


def test_recent_reservation_is_not_reported_stale(path):
    ledger = UsageLedger(path)
    ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    assert ledger.stale_reservations(older_than_seconds=3600) == []


def test_stale_threshold_must_be_a_sane_number(path):
    with pytest.raises(LedgerError):
        UsageLedger(path).stale_reservations(older_than_seconds=-1)


# ── grant identity ──────────────────────────────────────────────────────


def test_settlement_refused_when_the_reservation_belongs_to_another_grant(path):
    ledger = UsageLedger(path)
    rid = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    with pytest.raises(LedgerError, match="belongs to grant"):
        ledger.settle(rid, expect_grant=("paid-api", "small"))
    assert ledger.report("paid-api", "big")["breakdown"][0]["state"] == "reserved"


def test_settlement_accepted_for_the_matching_grant(path):
    ledger = UsageLedger(path)
    rid = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    assert ledger.settle(rid, expect_grant=("paid-api", "big")) == BASIS_ESTIMATE


def test_the_same_provider_event_cannot_be_counted_against_a_second_grant(path):
    ledger = UsageLedger(path)
    a = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    b = ledger.reserve("paid-api", "small", cap=0.5, estimate=0.3)
    ledger.settle(a, output_tokens=10, price_per_1k_tokens=0.01, provider_event_id="evt-x")
    with pytest.raises(DuplicateUsage):
        ledger.settle(b, output_tokens=10, price_per_1k_tokens=0.01, provider_event_id="evt-x")
    assert ledger.spent("paid-api", "small") == pytest.approx(0.3)


# ── spent-by-grant derived from the loaded policy ───────────────────────


def test_spent_for_grants_uses_exact_identity_and_basis_rules(path):
    ledger = UsageLedger(path)
    measured = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    ledger.settle(measured, output_tokens=1000, price_per_1k_tokens=0.01, provider_event_id="m1")
    unverified = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.2)
    ledger.settle(unverified)                       # no usage reported: estimate kept
    failed = ledger.reserve("paid-api", "small", cap=0.5, estimate=0.1)
    ledger.release(failed, not_billed=False)        # failure, billing unknown: estimate kept
    freed = ledger.reserve("paid-api", "small", cap=0.5, estimate=0.4)
    ledger.release(freed, not_billed=True)          # known not billed: freed

    spent = spent_for_grants(ledger, _policy().grants)
    assert spent[("paid-api", "big")] == pytest.approx(0.01 * 1000 / 1000 + 0.2)
    assert spent[("paid-api", "small")] == pytest.approx(0.1)


def test_grant_with_no_usage_maps_to_zero(path):
    spent = spent_for_grants(UsageLedger(path), _policy().grants)
    assert spent == {("paid-api", "big"): 0.0, ("paid-api", "small"): 0.0}


def test_estimate_basis_is_reported_separately_from_provider_basis(path):
    ledger = UsageLedger(path)
    a = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    ledger.settle(a, output_tokens=100, price_per_1k_tokens=0.01, provider_event_id="p1")
    b = ledger.reserve("paid-api", "big", cap=1.0, estimate=0.3)
    ledger.release(b, not_billed=False)
    bases = {row["basis"] for row in ledger.report("paid-api", "big")["breakdown"]}
    assert bases == {BASIS_PROVIDER, BASIS_FAILED_UNKNOWN}
