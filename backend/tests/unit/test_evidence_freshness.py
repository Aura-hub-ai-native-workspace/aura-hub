"""Phase 2: evidence freshness and bounded on-demand refresh.

Guarantees under test:
  * reachability and metadata freshness come from their own explicit evidence;
  * a failure newer than a success is failed, never fresh;
  * name hints and discovery timestamps are not server metadata;
  * refresh is bounded: timeouts, concurrency slots, coalesced duplicates, backoff;
  * refresh never contacts an unauthorised or unregistered endpoint and never adds one;
  * read-only views and diagnostics neither mutate sources nor expose addresses or secrets.
"""

from __future__ import annotations

import json
import threading
import time

import pytest

from aura.agent_runtime.model_metadata import parse_ollama_show
from aura.sovereign import evidence as ev
from aura.sovereign import model_router as mr
from aura.sovereign import refresh as rf
from aura.sovereign import shadow_view as sv
from aura.sovereign.evidence import DEFAULT_POLICY, FreshnessPolicy
from aura.sovereign.inventory_state import StateName, assess_candidate
from aura.sovereign.model_registry import ModelRecord, ModelRegistry
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy
from test_provider_discovery import _FakeOllama  # the same local fake server the discovery tests use

SECRET = "sk-PHASE2-SECRET"
TTL = DEFAULT_POLICY.reachability_ttl_s


def _rec(model="chat", endpoint="gpu", network="private", base="http://127.0.0.1:1",
         caps=None, absent=(), **times):
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    rec = ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint, base_url=base,
        network_class=network, capabilities=frozenset(caps), capability_sources=dict(caps),
        verified_absent=frozenset(absent))
    for name, value in times.items():
        setattr(rec, name, value)
    return rec


def _reg(*records):
    reg = ModelRegistry()
    for r in records:
        reg.register_manual(r)
    return reg


def _fail(category="connection-refused"):
    return lambda base, timeout: (False, category)


def _ok():
    return lambda base, timeout: (True, "")


# ── 1. freshness classification ─────────────────────────────────────────


def test_never_observed_is_unknown_not_false():
    assert ev.classify(None, None, 100.0, TTL) == ev.UNKNOWN


def test_a_recent_success_is_fresh_and_an_old_one_is_stale():
    assert ev.classify(90.0, None, 100.0, TTL) == ev.FRESH
    assert ev.classify(0.0, None, 100.0, TTL) == ev.STALE


def test_a_newer_failure_is_failed_even_when_the_last_success_is_fresh():
    assert ev.classify(99.0, 100.0, 100.5, TTL) == ev.FAILED


def test_equal_success_and_failure_times_count_as_failed():
    assert ev.classify(100.0, 100.0, 100.0, TTL) == ev.FAILED


def test_a_failure_alone_is_failed():
    assert ev.classify(None, 50.0, 100.0, TTL) == ev.FAILED


def test_legacy_healthy_flag_without_explicit_times_is_read_as_evidence():
    rec = _rec(healthy=True, last_checked=time.monotonic())
    success, failure, _ = ev.probe_times(rec)
    assert success is not None and failure is None


def test_the_policy_values_are_centralised_and_documented_as_starting_points():
    policy = FreshnessPolicy()
    assert policy.reachability_ttl_s == 90.0
    assert policy.metadata_ttl_s == 600.0
    assert policy.max_concurrent_refreshes == 2


# ── 2. lifecycle reads explicit evidence ────────────────────────────────


def _assess(rec, now):
    return assess_candidate(
        rec, task_caps=frozenset({"text-generation"}), policy=SovereignPolicy(),
        endpoints={}, configured_endpoints=frozenset({rec.endpoint_id}),
        now=now, probe_ttl=TTL, metadata_ttl=DEFAULT_POLICY.metadata_ttl_s, path="worker-cli")


def test_fresh_probe_and_metadata_make_a_candidate_ready():
    now = 1000.0
    # A loopback runtime is free by structure; an undeclared private endpoint is cost-unknown.
    rec = _rec(network="local", endpoint="loopback", probe_success_at=now - 5,
               metadata_success_at=now - 5)
    a = _assess(rec, now)
    assert a.states[StateName.REACHABLE].freshness == "fresh"
    assert a.states[StateName.METADATA_VERIFIED].freshness == "fresh"
    assert a.task_ready is True


def test_a_stale_probe_is_unknown_for_readiness():
    now = 1000.0
    rec = _rec(probe_success_at=now - TTL - 10, metadata_success_at=now - 5)
    a = _assess(rec, now)
    assert a.states[StateName.REACHABLE].freshness == "stale"
    assert a.states[StateName.REACHABLE].value is None
    assert a.task_ready is False


def test_a_failed_probe_is_false_with_a_category_and_no_raw_text():
    now = 1000.0
    rec = _rec(probe_success_at=now - 5, probe_failure_at=now - 1,
               probe_failure_category="timeout")
    a = _assess(rec, now)
    fact = a.states[StateName.REACHABLE]
    assert fact.freshness == "failed" and fact.value is False
    assert fact.detail == "timeout"
    assert a.task_ready is False


def test_a_failed_refresh_never_leaves_an_old_success_looking_fresh():
    now = 1000.0
    rec = _rec(probe_success_at=now - 2, probe_failure_at=now - 1, probe_failure_category="timeout",
               metadata_success_at=now - 5)
    a = _assess(rec, now)
    assert a.states[StateName.REACHABLE].freshness == "failed"
    assert a.task_ready is False


def test_discovery_timestamp_alone_is_not_current_readiness():
    now = 1000.0
    rec = _rec(metadata_checked=now - TTL - 60, probe_success_at=now - TTL - 60,
               metadata_success_at=now - TTL - 60)
    assert _assess(rec, now).task_ready is False


def test_never_probed_records_report_unknown_reachability():
    a = _assess(_rec(), 1000.0)
    assert a.states[StateName.REACHABLE].freshness == "unknown"
    assert a.states[StateName.REACHABLE].value is None


def test_evidence_ages_come_from_the_success_and_failure_times():
    now = 1000.0
    rec = _rec(probe_success_at=now - 7, probe_failure_at=now - 3, probe_failure_category="timeout",
               metadata_success_at=now - 11)
    a = _assess(rec, now)
    assert a.reachable_age_seconds == 7.0
    assert a.reachable_failure_age_seconds == 3.0
    assert a.metadata_age_seconds == 11.0
    assert a.metadata_failure_age_seconds is None


# ── 3. name hints and server-verified capabilities ──────────────────────


def test_name_hint_only_capability_is_not_server_metadata_even_when_discovery_is_recent():
    now = 1000.0
    rec = _rec(caps={"text-generation": "name-hint"}, metadata_checked=now - 1,
               metadata_success_at=now - 1)
    a = _assess(rec, now)
    assert a.states[StateName.METADATA_VERIFIED].value is None
    assert a.states[StateName.METADATA_VERIFIED].freshness == "unknown"
    assert a.task_ready is False


def test_server_verified_capability_counts_only_while_its_metadata_is_fresh():
    now = 1000.0
    fresh = _assess(_rec(network="local", endpoint="loopback", metadata_success_at=now - 5,
                         probe_success_at=now - 5), now)
    stale = _assess(_rec(network="local", endpoint="loopback", metadata_success_at=now - 2000,
                         probe_success_at=now - 5), now)
    assert fresh.task_ready is True
    assert stale.states[StateName.METADATA_VERIFIED].freshness == "stale"
    assert stale.task_ready is False


def test_a_failed_metadata_read_is_failed_not_verified():
    now = 1000.0
    rec = _rec(metadata_success_at=now - 5, metadata_failure_at=now - 1,
               metadata_failure_category="unavailable", probe_success_at=now - 5)
    a = _assess(rec, now)
    assert a.states[StateName.METADATA_VERIFIED].freshness == "failed"
    assert a.task_ready is False


def test_verified_absence_is_preserved_and_missing_evidence_stays_unknown():
    now = 1000.0
    absent = _rec(caps={"text-generation": "ollama:/api/show"}, absent={"tool-calling"},
                  metadata_success_at=now - 5, probe_success_at=now - 5)
    assert "tool-calling" in absent.verified_absent
    unknown = _rec(caps={"text-generation": "ollama:/api/show"}, metadata_failure_at=now - 1,
                   metadata_failure_category="unavailable", probe_success_at=now - 5)
    assert unknown.verified_absent == frozenset()        # a failed read proves no absence


# ── 4. bounded refresh ──────────────────────────────────────────────────


def test_a_successful_refresh_records_fresh_evidence_and_updates_metadata():
    rec = _rec(base="http://gpu:11434")
    reg = _reg(rec)
    meta = parse_ollama_show("chat", {"capabilities": ["completion", "tools"],
                                      "model_info": {"q.context_length": 8192}})
    refresher = rf.EvidenceRefresher(reg, probe=_ok(), metadata=lambda *a, **k: meta)
    result = refresher.refresh(rec)
    assert result.outcome == rf.REFRESHED
    assert result.reachability == "fresh" and result.metadata == "fresh"
    assert rec.probe_success_at is not None and rec.metadata_success_at is not None
    assert "tool-calling" in rec.capabilities and rec.context_length == 8192


def test_a_failed_refresh_records_a_failure_and_a_sanitized_category():
    rec = _rec(base="http://10.1.2.3:11434")
    reg = _reg(rec)
    refresher = rf.EvidenceRefresher(reg, probe=_fail("connection-refused"))
    result = refresher.refresh(rec)
    assert result.outcome == rf.PROBE_FAILED
    assert result.reachability == "failed"
    assert rec.probe_failure_category == "connection-refused"
    assert "10.1.2.3" not in repr(result) and "10.1.2.3" not in rec.last_error


def test_the_probe_is_called_with_the_policy_timeout():
    seen = []
    policy = FreshnessPolicy(probe_timeout_s=1.25)
    rec = _rec()
    refresher = rf.EvidenceRefresher(_reg(rec), policy,
                                     probe=lambda base, t: (seen.append(t) or True, ""),
                                     metadata=lambda *a, **k: parse_ollama_show("m", {}))
    refresher.refresh(rec, want_metadata=False)
    assert seen == [1.25]


def test_backoff_stops_repeated_probes_and_then_recovery_clears_it():
    clock = {"t": 0.0}
    calls = []
    outcomes = iter([(False, "timeout"), (True, "")])

    def probe(base, timeout):
        calls.append(base)
        return next(outcomes)

    rec = _rec()
    refresher = rf.EvidenceRefresher(_reg(rec), FreshnessPolicy(backoff_base_s=30),
                                     probe=probe, clock=lambda: clock["t"],
                                     metadata=lambda *a, **k: parse_ollama_show("m", {}))
    assert refresher.refresh(rec, want_metadata=False).outcome == rf.PROBE_FAILED
    clock["t"] = 10.0
    assert refresher.refresh(rec, want_metadata=False).outcome == rf.BACKOFF
    assert len(calls) == 1                             # no probe during backoff
    clock["t"] = 31.0
    assert refresher.refresh(rec, want_metadata=False).outcome == rf.REFRESHED
    assert len(calls) == 2
    assert rec.probe_failure_at is None                # recovery clears the failure


def test_backoff_doubles_with_each_failure_up_to_its_cap():
    clock = {"t": 0.0}
    rec = _rec()
    policy = FreshnessPolicy(backoff_base_s=10, backoff_max_s=25)
    refresher = rf.EvidenceRefresher(_reg(rec), policy, probe=_fail(),
                                     clock=lambda: clock["t"])
    delays = []
    for _ in range(4):
        refresher.refresh(rec, want_metadata=False)
        delays.append(refresher._retry_at[rec.endpoint_id] - clock["t"])
        clock["t"] = refresher._retry_at[rec.endpoint_id]
    assert delays == [10, 20, 25, 25]


def test_concurrent_requests_for_one_endpoint_share_a_single_probe():
    release = threading.Event()
    calls = []

    def slow_probe(base, timeout):
        calls.append(base)
        release.wait(timeout=5)
        return True, ""

    rec = _rec()
    refresher = rf.EvidenceRefresher(_reg(rec), FreshnessPolicy(acquire_wait_s=2.0),
                                     probe=slow_probe,
                                     metadata=lambda *a, **k: parse_ollama_show("m", {}))
    results = {}

    def first():
        results["first"] = refresher.refresh(rec, want_metadata=False)

    def second():
        results["second"] = refresher.refresh(rec, want_metadata=False)

    t1 = threading.Thread(target=first)
    t1.start()
    while not calls:
        time.sleep(0.01)
    t2 = threading.Thread(target=second)
    t2.start()
    time.sleep(0.05)
    release.set()
    t1.join(5)
    t2.join(5)
    assert len(calls) == 1, "a duplicate probe was sent"
    assert results["second"].outcome == rf.COALESCED


def test_global_concurrency_is_bounded_and_a_saturated_caller_is_told_so():
    release = threading.Event()
    recs = [_rec(model=f"m{i}", endpoint=f"ep{i}") for i in range(2)]
    reg = _reg(*recs)

    def slow_probe(base, timeout):
        release.wait(timeout=5)
        return True, ""

    refresher = rf.EvidenceRefresher(
        reg, FreshnessPolicy(max_concurrent_refreshes=1, acquire_wait_s=0.1),
        probe=slow_probe, metadata=lambda *a, **k: parse_ollama_show("m", {}))
    box = {}
    t = threading.Thread(target=lambda: box.update(first=refresher.refresh(recs[0],
                                                                           want_metadata=False)))
    t.start()
    time.sleep(0.05)
    second = refresher.refresh(recs[1], want_metadata=False)
    release.set()
    t.join(5)
    assert second.outcome == rf.BUSY
    assert box["first"].outcome == rf.REFRESHED


def test_a_cloud_endpoint_is_never_contacted_and_refresh_refuses_it():
    seen = []
    rec = _rec(network="cloud", endpoint="api")
    result = rf.EvidenceRefresher(_reg(rec), probe=lambda b, t: (seen.append(b) or True, "")
                                  ).refresh(rec)
    assert result.outcome == rf.REFUSED and seen == []


def test_an_unregistered_record_is_never_probed_and_is_not_added():
    seen = []
    reg = ModelRegistry()
    rec = _rec()
    result = rf.EvidenceRefresher(reg, probe=lambda b, t: (seen.append(b) or True, "")
                                  ).refresh(rec)
    assert result.outcome == rf.NOT_REGISTERED and seen == []
    assert reg._records == {}


def test_constructing_the_refresher_contacts_nothing():
    seen = []
    rf.EvidenceRefresher(_reg(_rec()), probe=lambda b, t: (seen.append(b) or True, ""))
    assert seen == []


# ── 5. read-only views and diagnostics ──────────────────────────────────


def _snapshot(reg):
    return [(r.id, r.healthy, r.probe_success_at, r.probe_failure_at, frozenset(r.capabilities),
             r.probe_failure_category) for r in reg._records.values()]


def test_building_a_view_does_not_refresh_or_mutate_the_registry(tmp_path):
    rec = _rec(base="http://10.9.8.7:11434", probe_success_at=1.0, metadata_success_at=1.0)
    reg = _reg(rec)
    before = _snapshot(reg)
    policy = parse_model_policy({"schemaVersion": 1})
    sv.build_request_view(reg, "Summarise this report", plan=None, policy=policy,
                          sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3")
    assert _snapshot(reg) == before


def test_refresh_and_views_never_expose_addresses_or_secrets(tmp_path):
    address = "http://10.9.8.7:11434/v1?token=" + SECRET
    rec = _rec(base=address)
    reg = _reg(rec)
    result = rf.EvidenceRefresher(reg, probe=_fail("name-resolution")).refresh(rec)
    view = sv.build_request_view(reg, "Summarise this report", plan=None,
                                 policy=parse_model_policy({"schemaVersion": 1}),
                                 sovereign=SovereignPolicy(),
                                 ledger_path=tmp_path / "u.sqlite3")
    dumped = json.dumps(sv.view_to_record(view.view)) + repr(result) + repr(view)
    for forbidden in ("10.9.8.7", SECRET, "token=", "11434"):
        assert forbidden not in dumped, forbidden


def test_a_real_refresh_against_an_unreachable_address_is_sanitized(tmp_path):
    rec = _rec(base="http://127.0.0.1:1")          # nothing listens on port 1
    reg = _reg(rec)
    result = rf.EvidenceRefresher(reg, FreshnessPolicy(probe_timeout_s=1.0),
                                  metadata=lambda *a, **k: parse_ollama_show("m", {})).refresh(rec)
    assert result.outcome == rf.PROBE_FAILED
    assert result.category in ("connection-refused", "timeout", "network-error")
    assert "127.0.0.1" not in repr(result) and "127.0.0.1" not in rec.last_error


def test_refreshed_evidence_changes_legacy_routing_only_through_the_healthy_flag(monkeypatch):
    """Flag-off routing is unchanged in code. It now sees corrected evidence: a candidate whose
    refresh failed is excluded, where a discovery-time success used to keep it routable."""
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    rec = _rec(network="local", endpoint="loopback", base="http://127.0.0.1:1",
               healthy=True, last_checked=time.monotonic())
    reg = _reg(rec)
    before = mr.ModelRouter(reg).route("Summarise this report")
    assert before.record is not None
    rf.EvidenceRefresher(reg, probe=_fail("connection-refused")).refresh(rec)
    after = mr.ModelRouter(reg).route("Summarise this report")
    assert after.record is None
    assert rec.probe_failure_category == "connection-refused"


# ── 6. the startup discovery wiring, end to end ─────────────────────────


@pytest.mark.parametrize("shape", ["wrapped", "bare"])
def test_startup_discovery_records_fresh_evidence_for_a_configured_endpoint(tmp_path, shape):
    from aura.sovereign.discovery_config import discover_configured_endpoints

    server = _FakeOllama()
    try:
        entry = {"id": "gpu-lan", "baseUrl": server.url, "networkClass": "private"}
        document = {"providers": [entry]} if shape == "wrapped" else [entry]
        path = tmp_path / "agent" / "providers.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document), encoding="utf-8")
        reg = ModelRegistry()
        report = discover_configured_endpoints(reg, path=path)
        assert report.discovered == ["gpu-lan"]
        rec = next(iter(reg._records.values()))
        assert rec.probe_success_at is not None and rec.metadata_success_at is not None
        assert reg is not None and rec.is_stale() is False
    finally:
        server.close()


def test_startup_discovery_accepts_an_openai_style_v1_base(tmp_path):
    from aura.sovereign.discovery_config import discover_configured_endpoints

    server = _FakeOllama()
    try:
        path = tmp_path / "agent" / "providers.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"providers": [
            {"id": "gpu-lan", "baseUrl": server.url + "/v1", "networkClass": "private"}]}),
            encoding="utf-8")
        report = discover_configured_endpoints(ModelRegistry(), path=path)
        assert report.discovered == ["gpu-lan"]
        assert "/v1/api/tags" not in server.hits
    finally:
        server.close()
