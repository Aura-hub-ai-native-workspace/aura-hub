"""The owner's standing decision: no approval for any worker; a paid agent that hits its limit hands over to a free one."""
import json

import pytest

from aura.workers import billing

pytestmark = pytest.mark.real_billing_policy_off


def test_known_workers_run_without_any_approval(tmp_path):
    for wid in ("opencode", "kilo-code", "claude-code", "codex-cli"):
        d = billing.decide(wid, tmp_path)
        assert d.allowed and d.billing == billing.STANDING


def test_an_unknown_worker_is_still_refused(tmp_path):
    assert not billing.decide("not-a-worker", tmp_path).allowed


def test_the_owner_can_bring_the_gate_back(tmp_path):
    (tmp_path / billing.POLICY_FILE).write_text(json.dumps({"requireApproval": True}))
    assert not billing.decide("claude-code", tmp_path).allowed


def test_free_tier_means_not_a_known_paid_cli(tmp_path):
    assert billing.is_free_tier("opencode", tmp_path) and billing.is_free_tier("kilo-code", tmp_path)
    assert not billing.is_free_tier("claude-code", tmp_path)
