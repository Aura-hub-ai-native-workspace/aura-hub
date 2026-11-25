"""Billing separates local executables from external model providers."""

from __future__ import annotations

import json

import pytest

from aura.workers.billing import LOCAL, UNKNOWN, decide, is_free_tier

pytestmark = pytest.mark.real_billing_policy_off


def test_catalogued_unauthenticated_local_tool_has_local_billing_class(tmp_path):
    (tmp_path / "worker-policy.json").write_text("{}", encoding="utf-8")

    decision = decide("git", tmp_path)

    assert decision.allowed is True
    assert decision.billing == LOCAL
    assert is_free_tier("git", tmp_path) is True


def test_unknown_and_known_paid_provider_still_need_owner_authorization(tmp_path):
    (tmp_path / "worker-policy.json").write_text(
        json.dumps({"requireApproval": True}), encoding="utf-8")

    unknown = decide("future-model-provider", tmp_path)
    known_paid = decide("claude-code", tmp_path)

    assert (unknown.allowed, unknown.billing) == (False, UNKNOWN)
    assert known_paid.allowed is False


def test_explicit_owner_budget_gate_still_blocks_paid_worker(tmp_path):
    (tmp_path / "worker-policy.json").write_text(json.dumps({
        "authorized": ["claude-code"], "requireApproval": True,
    }), encoding="utf-8")

    # Explicit authorization continues to be the owner's decision, while a
    # fresh unapproved provider remains blocked by the explicit gate.
    assert decide("claude-code", tmp_path).allowed is True
    assert decide("future-model-provider", tmp_path).allowed is False


def test_local_execution_classification_does_not_cover_authenticated_tools(tmp_path):
    (tmp_path / "worker-policy.json").write_text("{}", encoding="utf-8")

    # A local binary that authenticates to an external service is not assumed
    # cost-free; it remains governed by owner policy.
    decision = decide("github-cli", tmp_path)
    assert decision.allowed is False
    assert decision.billing == UNKNOWN
