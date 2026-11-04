"""Nothing that might cost money runs by default.

Mocks only: no worker binary is ever started and no paid API is called.
These tests run under the product's real deny-by-default policy.
"""
from __future__ import annotations

import asyncio
import json

import pytest

import aura.executors as ex
from aura.central_agent.worker_match import match_worker
from aura.workers import billing

pytestmark = pytest.mark.real_billing_policy


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return tmp_path


def policy(home, **body):
    (home / billing.POLICY_FILE).write_text(json.dumps(body))


NODES = [
    {"id": "claude-code", "name": "Claude Code", "binary": "claude", "capabilities": ["coding-agent"]},
    {"id": "opencode", "name": "OpenCode", "binary": "opencode", "capabilities": ["coding-agent"]},
]


# ── the decision ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("worker", ["claude-code", "codex-cli", "gemini-cli", "opencode", "kilo-code", "some-new-worker", ""])
def test_with_no_policy_every_worker_is_denied(home, worker):
    d = billing.decide(worker)
    assert d.allowed is False and "was not run" in d.reason


def test_known_billable_is_named_as_such_and_unknown_is_treated_as_paid(home):
    assert billing.decide("claude-code").billing == billing.BILLABLE
    d = billing.decide("opencode")
    assert d.billing == billing.UNKNOWN and "potentially paid" in d.reason


@pytest.mark.parametrize("junk", ["not json", "[]", '{"verifiedFree": "opencode"}', '{"authorized": [1, null, {}]}'])
def test_a_broken_policy_file_allows_nothing(home, junk):
    (home / billing.POLICY_FILE).write_text(junk)
    assert not billing.decide("opencode").allowed


def test_the_owner_can_mark_a_worker_free_or_accept_its_cost_and_nothing_else_widens(home):
    policy(home, verifiedFree=["opencode"], authorized=["claude-code"])
    assert billing.decide("opencode") .allowed and billing.decide("opencode").billing == billing.VERIFIED_FREE
    assert billing.decide("claude-code").allowed and billing.decide("claude-code").billing == billing.AUTHORIZED
    assert not billing.decide("codex-cli").allowed


def test_connection_readiness_or_a_free_tier_catalogue_licence_is_not_evidence_of_free(home):
    node = dict(NODES[1], readiness={"proved": True}, license="free-tier", connected=True, lifecycle="CONNECTED")
    assert not billing.decide(billing.worker_id_of(node)).allowed


# ── the dispatch boundary ────────────────────────────────────────────────
class _OkBin:
    ok = True


def _inv(home, node_id="claude-code", **ctx):
    node = next(n for n in NODES if n["id"] == node_id)
    return {"id": "inv-1", "input": {"task": "write a file", "scopePaths": ["src"]},
            "context": {"cwd": str(home), "taskId": "t1", "actor": {"kind": "agent", "id": "t"}, **ctx},
            "node": node}


def _run(monkeypatch, inv):
    spawned = []

    async def fake_run(*a, **kw):
        spawned.append(True)
        raise AssertionError("a denied worker must never be spawned")

    monkeypatch.setattr(ex, "resolve_agent_binary", lambda _: _OkBin())
    monkeypatch.setattr(ex, "run_agent", fake_run)
    return asyncio.run(ex.agent_delegate_run(inv)), spawned


def test_dispatch_refuses_a_billable_worker_and_spawns_nothing(home, monkeypatch):
    out, spawned = _run(monkeypatch, _inv(home))
    assert out["ok"] is False and spawned == []
    assert out["output"]["blocked"] == "billing-policy" and out["output"]["billing"]["billing"] == billing.BILLABLE
    assert "was not run" in out["detail"]


def test_dispatch_refuses_an_unknown_cost_worker_too(home, monkeypatch):
    out, spawned = _run(monkeypatch, _inv(home, "opencode"))
    assert out["ok"] is False and spawned == [] and out["output"]["billing"]["billing"] == billing.UNKNOWN


def test_an_approval_id_does_not_buy_a_billable_worker(home, monkeypatch):
    out, spawned = _run(monkeypatch, _inv(home, approvalId="appr-123"))
    assert out["ok"] is False and spawned == [] and out["output"]["blocked"] == "billing-policy"


def test_a_pinned_denied_worker_is_still_refused_at_dispatch(home, monkeypatch):
    policy(home, authorized=["opencode"])
    out, spawned = _run(monkeypatch, _inv(home, "claude-code"))
    assert out["output"]["blocked"] == "billing-policy" and spawned == []


def test_an_authorized_worker_gets_past_the_billing_check(home, monkeypatch):
    """Allowed means the billing gate steps aside; the other gates still apply."""
    policy(home, verifiedFree=["opencode"])
    out, _ = _run_allowing_spawn(monkeypatch, _inv(home, "opencode"))
    assert (out.get("output") or {}).get("blocked") != "billing-policy"


def _run_allowing_spawn(monkeypatch, inv):
    class _Out:
        out, code, timedOut, signal = "done", 0, False, None

    async def fake_run(*a, **kw):
        return _Out()

    monkeypatch.setattr(ex, "resolve_agent_binary", lambda _: _OkBin())
    monkeypatch.setattr(ex, "run_agent", fake_run)
    return asyncio.run(ex.agent_delegate_run(inv)), None


# ── selection and failover ───────────────────────────────────────────────
@pytest.fixture()
def drivable(monkeypatch):
    monkeypatch.setattr(ex, "agent_delegate_invocation", lambda node: {"args": lambda *a: []})


def test_selection_never_offers_a_denied_worker(home, drivable):
    assert [n["id"] for n in NODES if ex.agent_delegate_supports_node(n)] == []


def test_failover_skips_a_denied_worker_and_lands_on_the_authorized_one(home, drivable):
    policy(home, verifiedFree=["opencode"])
    chosen = match_worker("code", NODES, usable=ex.agent_delegate_supports_node)
    assert chosen and chosen["id"] == "opencode"
    # and the other way round: the denied one is never first-choice even listed first
    assert NODES[0]["id"] == "claude-code"


def test_with_no_authorized_worker_selection_returns_none_so_the_run_stops_with_a_blocker(home, drivable):
    assert match_worker("code", NODES, usable=ex.agent_delegate_supports_node) is None


# ── the readiness probe is a real prompt, so it is gated too ─────────────
def test_the_readiness_probe_does_not_prompt_a_worker_that_is_not_allowed(home):
    from aura.workers.adapters import adapter_for_id
    from aura.workers.readiness import prove_worker

    called = []
    proof = prove_worker(adapter_for_id("claude-code"), str(home), runner=lambda *a, **k: called.append(1))
    assert called == [] and proof.reason == "BILLING_POLICY" and "was not run" in proof.detail


def test_the_worker_listing_says_connected_is_not_allowed(home):
    from aura.workers import WorkerDescriptor

    d = WorkerDescriptor(id="claude-code", name="Claude Code", binary="claude", connected=True, lifecycle="CONNECTED").to_dict()
    assert d["connected"] is True and d["allowedToRun"] is False and d["billing"]["billing"] == billing.BILLABLE
    policy(home, authorized=["claude-code"])
    assert WorkerDescriptor(id="claude-code", name="x", binary="claude").to_dict()["allowedToRun"] is True
