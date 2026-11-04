"""Audit fixes for the shadow view: distinct authoritative states, sanitized probe errors,
and numeric evidence ages.

Guarantees under test:
  * three authoritative states stay distinct: error, not-computed, and a valid result;
  * the AURA-mediated path is never dispatchable;
  * probe failures are recorded as stable categories, never as raw text that can hold
    an address, a path, or a credential;
  * evidence ages are numeric and present, and existing fields are unchanged.
"""

from __future__ import annotations

import json
import socket
import ssl
import time
import types
import urllib.error

import pytest

from aura.sovereign import model_router as mr
from aura.sovereign import shadow_view as sv
from aura.sovereign.candidate_policy import CostState
from aura.sovereign.inventory_state import PATH_AURA_MEDIATED, PATH_WORKER_CLI, dispatch_for
from aura.sovereign.model_registry import ModelRecord, ModelRegistry, probe_error_category
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy

MSG = "Summarise this report"


def _plan():
    return types.SimpleNamespace(tasks=[types.SimpleNamespace(capabilityId="agent.delegate")])


def _rec(model="chat", caps=None, healthy=True, last_checked=None, last_error="",
         category="", metadata_checked=None, base="http://10.1.2.3:11434"):
    now = time.monotonic()
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    return ModelRecord(
        id=f"loopback/{model}", model_name=model, endpoint_id="loopback",
        base_url=base, network_class="local", capabilities=frozenset(caps),
        capability_sources=dict(caps), healthy=healthy,
        last_checked=now if last_checked is None else last_checked,
        metadata_checked=now if metadata_checked is None else metadata_checked,
        last_error=last_error, last_error_category=category)


def _reg(*records):
    reg = ModelRegistry()
    for r in records:
        reg.register_manual(r)
    return reg


def _view(reg, tmp_path, plan=_plan()):
    return sv.build_request_view(
        reg, MSG, plan=plan, policy=parse_model_policy({"schemaVersion": 1}),
        sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3")


# ── 1. three distinct authoritative states ──────────────────────────────


def test_a_legacy_router_exception_is_recorded_as_an_error_basis(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)

    def broken(self, *a, **k):
        raise RuntimeError("internal failure at /home/Groot/secret/path")

    monkeypatch.setattr(mr.ModelRouter, "_route_legacy", broken)
    result = _view(_reg(_rec()), tmp_path)
    assert result.view.authoritative_basis == "legacy-router-error"
    assert result.view.authoritative_choice is None
    record = json.dumps(sv.view_to_record(result.view))
    assert "/home/Groot" not in record and "internal failure" not in record


def test_a_valid_empty_legacy_result_is_distinct_from_an_error(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    # No candidate can serve this request, so the legacy router validly returns nothing.
    empty = _reg(_rec(model="embed", caps={"embedding": "ollama:/api/show"}))
    result = _view(empty, tmp_path)
    assert result.view.authoritative_basis == "legacy-router"
    assert result.view.authoritative_choice is None


def test_a_flagged_view_is_not_computed_rather_than_empty(tmp_path, monkeypatch):
    monkeypatch.setenv(mr.POLICY_ROUTING_ENV, "1")
    result = _view(_reg(_rec()), tmp_path)
    assert result.view.authoritative_basis == "not-computed"
    assert result.view.authoritative_choice is None


def test_the_three_states_serialise_distinctly(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    chosen = sv.view_to_record(_view(_reg(_rec()), tmp_path).view)
    assert chosen["authoritativeBasis"] == "legacy-router"
    assert chosen["authoritativeChoice"] == ["loopback", "chat"]
    monkeypatch.setenv(mr.POLICY_ROUTING_ENV, "1")
    flagged = sv.view_to_record(_view(_reg(_rec()), tmp_path).view)
    assert flagged["authoritativeBasis"] == "not-computed"


# ── 2. the AURA-mediated path is never dispatchable ─────────────────────


@pytest.mark.parametrize("cost", [CostState.FREE_VERIFIED, CostState.PAID, CostState.UNKNOWN])
def test_aura_mediated_is_never_dispatchable(cost):
    assert dispatch_for(PATH_AURA_MEDIATED, cost).supported is False


def test_a_worker_free_candidate_remains_dispatchable(tmp_path):
    snap = _view(_reg(_rec()), tmp_path).view.candidates[0]
    assert snap.execution_path == PATH_WORKER_CLI
    assert snap.dispatch_supported is True


# ── 3. probe errors are categories, never raw text ──────────────────────


@pytest.mark.parametrize("exc,expected", [
    (TimeoutError("timed out"), "timeout"),
    (socket.timeout("timed out"), "timeout"),
    (ConnectionRefusedError(111, "Connection refused"), "connection-refused"),
    (socket.gaierror(-2, "Name or service not known"), "name-resolution"),
    (ssl.SSLError("EOF occurred in violation of protocol"), "tls-error"),
    (urllib.error.HTTPError("http://10.1.2.3/x", 404, "Not Found", {}, None), "http-error"),
    (urllib.error.URLError(ConnectionRefusedError(111, "refused")), "connection-refused"),
    (urllib.error.URLError("no route to 10.1.2.3 via /home/Groot/.aura key=abc"), "network-error"),
    (ValueError("anything at all"), "probe-failed"),
])
def test_probe_errors_map_to_stable_categories(exc, expected):
    assert probe_error_category(exc) == expected


def test_a_failed_probe_records_a_category_and_keeps_the_raw_text_for_the_api():
    reg = ModelRegistry()
    rec = _rec(healthy=None)
    reg.register_manual(rec)
    assert reg.verify_health(rec, timeout_s=1.0) is False
    assert rec.last_error_category in ("connection-refused", "timeout", "network-error",
                                       "name-resolution")
    assert rec.last_error                              # the API still gets its field
    payload = rec.to_dict()
    assert payload["lastErrorCategory"] == rec.last_error_category
    assert payload["lastError"] == rec.last_error      # unchanged compatibility field


def test_the_view_never_carries_probe_text_even_when_the_record_holds_it(tmp_path):
    leaked = "connect to 10.1.2.3 failed with key sk-leaked-abcdef and /home/Groot/.aura"
    rec = _rec(healthy=False, last_error=leaked, category="connection-refused")
    dumped = json.dumps(sv.view_to_record(_view(_reg(rec), tmp_path).view))
    assert "10.1.2.3" not in dumped
    assert "sk-leaked" not in dumped
    assert "/home/Groot" not in dumped
    assert "connection-refused" in dumped


def test_a_real_refused_probe_end_to_end_stays_sanitized(tmp_path):
    # A real connection-refused endpoint, probed through the registry itself.
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    closed.close()
    reg = ModelRegistry()
    rec = _rec(healthy=None, base=f"http://127.0.0.1:{port}")
    reg.register_manual(rec)
    reg.verify_health(rec, timeout_s=2.0)
    dumped = json.dumps(sv.view_to_record(_view(reg, tmp_path).view))
    assert f"127.0.0.1:{port}" not in dumped
    assert str(port) not in dumped


# ── 4. numeric evidence ages, and existing fields are preserved ─────────


def test_evidence_ages_are_numeric_and_present(tmp_path):
    rec = _rec(last_checked=time.monotonic() - 5.0, metadata_checked=time.monotonic() - 7.0)
    cand = sv.view_to_record(_view(_reg(rec), tmp_path).view)["candidates"][0]
    assert isinstance(cand["reachableAgeSeconds"], float)
    assert isinstance(cand["metadataAgeSeconds"], float)
    assert 4.0 <= cand["reachableAgeSeconds"] <= 60.0
    assert 6.0 <= cand["metadataAgeSeconds"] <= 60.0


def test_a_never_probed_record_has_no_probe_age(tmp_path):
    rec = _rec(healthy=None, last_checked=0.0)
    cand = sv.view_to_record(_view(_reg(rec), tmp_path).view)["candidates"][0]
    assert cand["reachableAgeSeconds"] is None
    assert cand["reachableFreshness"] == "unknown" or cand["reachableFreshness"] == "none"


def test_existing_candidate_fields_are_still_present(tmp_path):
    cand = sv.view_to_record(_view(_reg(_rec()), tmp_path).view)["candidates"][0]
    for key in ("endpointId", "modelName", "networkClass", "executionPath",
                "reachableFreshness", "metadataFreshness", "taskCapabilities",
                "policyEligible", "exclusion", "dispatchSupported", "dispatchReason",
                "grantValid", "grantAvailable", "taskReady", "notReadyReasons"):
        assert key in cand, key


def test_the_authoritative_router_is_unchanged_by_building_the_view(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    reg = _reg(_rec(model="a"), _rec(model="b"))
    before = mr.ModelRouter(reg).route(MSG)
    _view(reg, tmp_path)
    after = mr.ModelRouter(reg).route(MSG)
    assert before.record is after.record and before.reason == after.reason


# ── 5. the accounting side effects, pinned to what was measured ─────────


def test_a_read_leaves_the_database_file_and_every_row_unchanged(tmp_path):
    from aura.sovereign.candidate_policy import PaidGrant
    from aura.sovereign.usage_ledger import UsageLedger, read_spent_bounded

    db = tmp_path / "usage.sqlite3"
    ledger = UsageLedger(db)
    rid = ledger.reserve("gpu", "chat", cap=5.0, estimate=1.0)
    del ledger
    main_before = db.read_bytes()
    read_spent_bounded(db, [PaidGrant("gpu", "chat", 5.0)])
    assert db.read_bytes() == main_before
    reread = UsageLedger(db)
    assert reread.report("gpu", "chat")["breakdown"][0]["state"] == "reserved"
    assert reread.settle(rid, output_tokens=10, price_per_1k_tokens=0.01) == "provider-reported"


def test_the_only_file_side_effect_is_sqlite_sidecars(tmp_path):
    """Documents the measured limitation: sidecars may appear, and nothing else may."""
    from aura.sovereign.candidate_policy import PaidGrant
    from aura.sovereign.usage_ledger import UsageLedger, read_spent_bounded

    db = tmp_path / "usage.sqlite3"
    ledger = UsageLedger(db)
    ledger.reserve("gpu", "chat", cap=5.0, estimate=1.0)
    del ledger
    import gc
    gc.collect()
    before = set(p.name for p in tmp_path.iterdir())
    read_spent_bounded(db, [PaidGrant("gpu", "chat", 5.0)])
    added = set(p.name for p in tmp_path.iterdir()) - before
    assert added <= {"usage.sqlite3-wal", "usage.sqlite3-shm"}, added


def test_a_missing_database_is_never_created_by_the_read(tmp_path):
    from aura.sovereign.candidate_policy import PaidGrant
    from aura.sovereign.usage_ledger import read_spent_bounded

    result = read_spent_bounded(tmp_path / "absent.sqlite3", [PaidGrant("gpu", "chat", 5.0)])
    assert result.status == "ledger-absent"
    assert list(tmp_path.iterdir()) == []
