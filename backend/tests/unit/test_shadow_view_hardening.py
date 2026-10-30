"""Shadow candidate view hardening: execution path, bounded read-only accounting, redaction.

Each test names the guarantee it protects. The view is observational, so nothing here
may change routing, dispatch, the ledger, or any reservation.
"""

from __future__ import annotations

import json
import sqlite3
import time
import types

import pytest

from aura.sovereign import model_router as mr
from aura.sovereign import shadow_view as sv
from aura.sovereign import usage_ledger as ul
from aura.sovereign.candidate_policy import CostState
from aura.sovereign.inventory_state import (
    PATH_UNKNOWN,
    PATH_UNSUPPORTED,
    PATH_WORKER_CLI,
    dispatch_for,
)
from aura.sovereign.model_registry import ModelRecord, ModelRegistry
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy
from aura.sovereign.usage_ledger import UsageLedger

MSG = "Summarise this report"


def _plan(*caps):
    return types.SimpleNamespace(tasks=[types.SimpleNamespace(capabilityId=c) for c in caps])


def _rec(model, endpoint="loopback", network="local", healthy=True):
    now = time.monotonic()
    return ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint,
        base_url="http://10.1.2.3:11434", network_class=network,
        capabilities=frozenset({"text-generation"}),
        capability_sources={"text-generation": "ollama:/api/show"},
        healthy=healthy, last_checked=now, metadata_checked=now)


def _reg(*records):
    reg = ModelRegistry()
    for r in records:
        reg.register_manual(r)
    return reg


PAID_DOC = {
    "schemaVersion": 1,
    "endpoints": {"gpu-paid": {"networkClass": "private", "cost": "paid",
                               "pricePer1kTokens": 0.01}},
    "paidGrants": [{"endpointId": "gpu-paid", "modelName": "chat", "spendCap": 5.0}],
}


def _build(reg, tmp_path, *, plan=_plan("agent.delegate"), doc=None, message=MSG, **kw):
    return sv.build_request_view(
        reg, message, plan=plan,
        policy=parse_model_policy(doc or {"schemaVersion": 1}),
        sovereign=SovereignPolicy(), ledger_path=tmp_path / "agent" / "usage.sqlite3", **kw)


# ── 1. execution path is explicit and comes from the plan ───────────────


def test_a_delegating_plan_uses_the_worker_path(tmp_path):
    result = _build(_reg(_rec("chat")), tmp_path, plan=_plan("agent.delegate"))
    assert result.execution_path == PATH_WORKER_CLI
    assert result.view.candidates[0].execution_path == PATH_WORKER_CLI


def test_a_direct_capability_plan_is_unsupported_for_model_dispatch(tmp_path):
    result = _build(_reg(_rec("chat")), tmp_path, plan=_plan("git.status"))
    snap = result.view.candidates[0]
    assert result.execution_path == PATH_UNSUPPORTED
    assert snap.dispatch_supported is False
    assert snap.task_ready is False


def test_a_missing_plan_is_unknown_and_withholds_readiness_even_for_free_models(tmp_path):
    result = _build(_reg(_rec("chat")), tmp_path, plan=None)
    snap = result.view.candidates[0]
    assert result.execution_path == PATH_UNKNOWN
    assert snap.policy_eligible is True          # eligibility is not dispatchability
    assert snap.dispatch_supported is False
    assert snap.task_ready is False
    assert "execution path unknown" in snap.dispatch_reason


def test_a_plan_with_a_task_lacking_a_capability_is_unknown(tmp_path):
    result = _build(_reg(_rec("chat")), tmp_path, plan=_plan(None))
    assert result.execution_path == PATH_UNKNOWN


def test_an_unrecognised_path_is_never_dispatchable_whatever_the_cost():
    for cost in (CostState.FREE_VERIFIED, CostState.PAID, CostState.UNKNOWN):
        assert dispatch_for("tunnelled", cost).supported is False
        assert dispatch_for(PATH_UNKNOWN, cost).supported is False


def test_dispatchability_is_never_inferred_from_policy_eligibility(tmp_path):
    snap = _build(_reg(_rec("chat")), tmp_path, plan=_plan("git.status")).view.candidates[0]
    assert snap.policy_eligible is True and snap.dispatch_supported is False


# ── 2. paid candidates are unsupported without metering, on every path ──


@pytest.mark.parametrize("plan", [_plan("agent.delegate"), _plan("git.status"), None])
def test_a_paid_candidate_with_a_grant_is_never_dispatchable(tmp_path, plan):
    reg = _reg(_rec("chat", endpoint="gpu-paid", network="private"))
    snap = _build(reg, tmp_path, plan=plan, doc=PAID_DOC).view.candidates[0]
    assert snap.grant_valid is True
    assert snap.dispatch_supported is False
    assert snap.task_ready is False


# ── 3. accounting is bounded, read-only, and never created by the view ──


def test_a_missing_ledger_is_not_created_by_the_view(tmp_path):
    ledger_file = tmp_path / "agent" / "usage.sqlite3"
    result = _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path,
                    doc=PAID_DOC)
    assert not ledger_file.exists()
    assert "ledger-absent" in result.status


def test_the_view_never_writes_a_row_or_changes_a_reservation(tmp_path):
    ledger = UsageLedger(tmp_path / "agent" / "usage.sqlite3")
    rid = ledger.reserve("gpu-paid", "chat", cap=5.0, estimate=1.0)
    before = ledger.report("gpu-paid", "chat")
    raw_before = (tmp_path / "agent" / "usage.sqlite3").read_bytes()
    _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path, doc=PAID_DOC)
    assert ledger.report("gpu-paid", "chat") == before
    assert ledger.spent("gpu-paid", "chat") == pytest.approx(1.0)
    assert ledger.settle(rid, output_tokens=100, price_per_1k_tokens=0.01) == "provider-reported"


def test_the_read_connection_cannot_write(tmp_path):
    ledger = UsageLedger(tmp_path / "usage.sqlite3")
    ledger.reserve("gpu-paid", "chat", cap=5.0, estimate=1.0)
    uri = f"{(tmp_path / 'usage.sqlite3').resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("INSERT INTO usage (reservation_id, endpoint_id, model_name, state, "
                     "reserved, created, updated) VALUES ('x','e','m','reserved',1,0,0)")
    conn.close()


def test_a_busy_ledger_is_a_status_not_an_exception(tmp_path, monkeypatch):
    def busy(*a, **k):
        raise ul.LedgerBusy("ledger busy")

    monkeypatch.setattr(ul, "read_spent_bounded", busy)
    result = _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path,
                    doc=PAID_DOC)
    assert result.status == "ledger-busy"
    assert result.view is None


def test_an_unavailable_ledger_is_a_status_not_an_exception(tmp_path, monkeypatch):
    def broken(*a, **k):
        raise ul.LedgerUnavailable("OperationalError")

    monkeypatch.setattr(ul, "read_spent_bounded", broken)
    result = _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path,
                    doc=PAID_DOC)
    assert result.status == "ledger-unavailable" and result.view is None


def test_a_real_lock_is_bounded_in_time(tmp_path):
    ledger = UsageLedger(tmp_path / "agent" / "usage.sqlite3")
    ledger.reserve("gpu-paid", "chat", cap=5.0, estimate=1.0)
    holder = sqlite3.connect(tmp_path / "agent" / "usage.sqlite3", isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        started = time.monotonic()
        result = _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path,
                        doc=PAID_DOC, busy_timeout_ms=200)
        elapsed = time.monotonic() - started
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert elapsed < 3.0                      # bounded: the lock cannot stall the view
    assert isinstance(result.status, str) and result.status


def test_a_view_that_runs_past_its_deadline_is_dropped(tmp_path):
    ticks = iter([0.0] + [10.0] * 50)        # started at 0; every later check is past the limit
    result = _build(_reg(_rec("chat")), tmp_path, clock=lambda: next(ticks),
                    deadline_s=2.0, now=0.0, wall_now=0.0)
    assert result.status == "timeout" and result.view is None


# ── 4. spend figures and candidates come from one consistent read ───────


def test_spend_summary_and_grant_availability_agree(tmp_path):
    ledger = UsageLedger(tmp_path / "agent" / "usage.sqlite3")
    ledger.reserve("gpu-paid", "chat", cap=5.0, estimate=1.25)
    result = _build(_reg(_rec("chat", endpoint="gpu-paid", network="private")), tmp_path,
                    doc=PAID_DOC)
    spend = result.view.spend[0]
    snap = result.view.candidates[0]
    assert spend.spent == pytest.approx(1.25)
    assert spend.available == pytest.approx(3.75)
    assert snap.grant_available == pytest.approx(spend.available)
    assert result.view.spend_observed_at is not None
    assert spend.observed_at == result.view.spend_observed_at


def test_the_view_reports_freshness_and_read_time(tmp_path):
    record = sv.view_to_record(_build(_reg(_rec("chat")), tmp_path).view)
    cand = record["candidates"][0]
    assert cand["reachableFreshness"] == "fresh"
    assert cand["metadataFreshness"] == "fresh"
    assert record["spendObservedAt"] is None         # no grants, so no spend was read


def test_the_router_never_reads_the_snapshot_so_it_cannot_act_on_a_stale_figure():
    import inspect
    source = inspect.getsource(mr)
    assert "shadow_view" not in source and "build_request_view" not in source
    assert "spent_for_grants" in inspect.getsource(mr.ModelRouter._route_with_policy)


# ── 5. redaction and sanitized errors ───────────────────────────────────


def test_serialised_snapshot_has_no_addresses_paths_keys_or_request_text(tmp_path):
    message = "SECRET-REQUEST-TEXT about /home/Groot/private/notes.md"
    result = _build(_reg(_rec("chat")), tmp_path, message=message)
    dumped = json.dumps(sv.view_to_record(result.view))
    assert "10.1.2.3" not in dumped
    assert "base_url" not in dumped.lower() and "baseurl" not in dumped.lower()
    assert "SECRET-REQUEST-TEXT" not in dumped
    assert "/home/Groot" not in dumped
    assert "api_key" not in dumped.lower() and "apikey" not in dumped.lower()


def test_a_provider_failure_is_recorded_as_a_type_name_only(tmp_path):
    from aura.central_agent import shadow_planner as sp
    from aura.central_agent.planner import TaskPlanner
    from aura.contracts import AgentIntent

    class _Port:
        def complete_json(self, system, user):
            return {"tasks": [{"id": "a", "description": "a", "capabilityId": "agent.delegate",
                               "input": {"task": "a"}, "verificationKind": "exit-code",
                               "verification": "exit 0"}]}

    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent = AgentIntent(goal="summarise", expectedOutcome="done")
    auth = planner.plan_from_model(intent, "agt-x", "2026-01-01T00:00:00Z",
                                   {"tasks": [{"id": "a", "description": "a",
                                               "capabilityId": "agent.delegate",
                                               "input": {"task": "a"},
                                               "verificationKind": "exit-code",
                                               "verification": "exit 0"}]})

    def leaky():
        raise OSError("cannot read /home/Groot/.aura/agent/model_policy.json with key sk-abc")

    record = sp.ShadowPlanner(_Port(), sp.ShadowPlanStore(tmp_path)).observe(
        intent=intent, system="sys", user=MSG, session_id="agt-x", request_id="r",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=leaky).result(timeout=10)
    assert record.candidateView is None
    assert record.candidateViewStatus == "unavailable: OSError"
    dumped = record.model_dump_json()
    assert "/home/Groot" not in dumped and "sk-abc" not in dumped


def test_the_view_status_never_contains_a_path_or_address(tmp_path):
    result = _build(_reg(_rec("chat")), tmp_path)
    assert "/" not in result.status and "10." not in result.status


# ── 6. authoritative routing and dispatch are unchanged ─────────────────


def test_building_the_view_leaves_the_legacy_router_decision_unchanged(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    reg = _reg(_rec("chat-a"), _rec("chat-b"))
    before = mr.ModelRouter(reg).route(MSG)
    _build(reg, tmp_path)
    after = mr.ModelRouter(reg).route(MSG)
    assert before.record is after.record and before.reason == after.reason


def test_with_the_flag_on_the_view_does_not_compute_or_write_the_authoritative_choice(
        tmp_path, monkeypatch):
    monkeypatch.setenv(mr.POLICY_ROUTING_ENV, "1")

    def forbidden(*a, **k):
        raise AssertionError("the flagged router must not run from the view")

    monkeypatch.setattr(mr.ModelRouter, "route", forbidden)
    monkeypatch.setattr(mr.ModelRouter, "_route_with_policy", forbidden)
    result = _build(_reg(_rec("chat")), tmp_path)
    assert result.view.authoritative_basis == "not-computed"
    assert result.view.authoritative_choice is None


def test_with_the_flag_off_the_authoritative_choice_is_the_legacy_one(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    reg = _reg(_rec("chat"))
    result = _build(reg, tmp_path)
    assert result.view.authoritative_basis == "legacy-router"
    assert result.view.authoritative_choice == ("loopback", "chat")


def test_the_flag_is_still_off_by_default(monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    assert mr.policy_routing_enabled() is False


# ── 7. the execution path is decided from the plan, once per request ────


def test_execution_path_for_each_plan_shape():
    assert sv.execution_path_for_plan(_plan("agent.delegate"))[0] == PATH_WORKER_CLI
    assert sv.execution_path_for_plan(_plan("git.status"))[0] == PATH_UNSUPPORTED
    assert sv.execution_path_for_plan(None)[0] == PATH_UNKNOWN
    assert sv.execution_path_for_plan(_plan(None))[0] == PATH_UNKNOWN
    assert sv.execution_path_for_plan(types.SimpleNamespace())[0] == PATH_UNKNOWN
