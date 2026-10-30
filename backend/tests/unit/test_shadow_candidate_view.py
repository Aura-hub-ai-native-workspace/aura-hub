"""Candidate snapshot wired into shadow evaluation. Observational only.

Proves: the snapshot is for the request's task type; it is immutable and does not
follow registry changes; name hints can make a candidate eligible but never ready;
paid candidates on an unmetered path stay unsupported; a failing view never breaks
dispatch or the authoritative plan; the snapshot is built on the shadow thread; the
serialised form is redacted; shadow output cannot change routing; and legacy
routing is unchanged with the flag off.
"""

from __future__ import annotations

import dataclasses
import threading
import time

import pytest

from aura.central_agent import shadow_planner as sp
from aura.central_agent.planner import TaskPlanner
from aura.contracts import AgentIntent
from aura.sovereign import model_router as mr
from aura.sovereign.model_registry import ModelRecord, ModelRegistry
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy
from aura.sovereign.shadow_view import build_request_view, view_to_record

MSG = "Summarise this report"
SESSION = "agt-view"


def _rec(model, endpoint="loopback", network="local", caps=None, healthy=True,
         absent=(), base="http://127.0.0.1:11434"):
    now = time.monotonic()
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    return ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint,
        base_url=base, network_class=network,
        capabilities=frozenset(caps), capability_sources=dict(caps),
        healthy=healthy, last_checked=now, metadata_checked=now,
        verified_absent=frozenset(absent))


def _registry(*records):
    reg = ModelRegistry()
    for r in records:
        reg.register_manual(r)
    return reg


def _plan(*capabilities):
    """A minimal authoritative plan: one task per capability."""
    import types
    return types.SimpleNamespace(tasks=[types.SimpleNamespace(capabilityId=c) for c in capabilities])


DELEGATING = _plan("agent.delegate")


def _view(registry, tmp_path, policy_doc=None, message=MSG, plan=DELEGATING):
    policy = parse_model_policy(policy_doc or {"schemaVersion": 1})
    return build_request_view(registry, message, plan=plan, policy=policy,
                              sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3")


# ── the snapshot is for this request's task type ────────────────────────


def test_snapshot_contains_only_candidates_that_can_serve_the_request(tmp_path):
    reg = _registry(
        _rec("chat-a"),
        _rec("embed-b", caps={"embedding": "ollama:/api/show"}),
        _rec("chat-sick", healthy=False))
    result = _view(reg, tmp_path)
    names = [c.model_name for c in result.view.candidates]
    assert "embed-b" not in names                  # cannot serve text-generation
    assert set(names) == {"chat-a", "chat-sick"}
    assert result.view.required_tags == ("text-generation",)
    assert result.status == "ok"


def test_snapshot_reports_no_candidates_when_nothing_can_serve_the_task(tmp_path):
    result = _view(_registry(_rec("embed-only", caps={"embedding": "ollama:/api/show"})), tmp_path)
    assert result.view.candidates == ()
    assert result.status == "no-candidates"


def test_a_coding_request_is_scoped_to_code_capable_candidates(tmp_path):
    reg = _registry(_rec("plain", caps={"text-generation": "ollama:/api/show"}),
                    _rec("coder", caps={"text-generation": "ollama:/api/show",
                                        "code-generation": "name-hint"},
                         ))
    result = _view(reg, tmp_path, message="Implement a parser function in Python")
    assert "code-generation" in result.view.required_tags
    assert [c.model_name for c in result.view.candidates] == ["coder"]


# ── immutability and independence ───────────────────────────────────────


def test_snapshot_is_immutable(tmp_path):
    view = _view(_registry(_rec("chat-a")), tmp_path).view
    with pytest.raises(dataclasses.FrozenInstanceError):
        view.authoritative_choice = None
    with pytest.raises(dataclasses.FrozenInstanceError):
        view.candidates[0].task_ready = True


def test_snapshot_does_not_change_when_the_registry_changes_afterwards(tmp_path):
    rec = _rec("chat-a")
    reg = _registry(rec)
    view = _view(reg, tmp_path).view
    before = view_to_record(view)
    rec.healthy = False
    rec.capabilities = frozenset()
    reg.register_manual(_rec("late-arrival"))
    assert view_to_record(view) == before


def test_building_the_snapshot_does_not_modify_the_registry_or_the_router(tmp_path):
    rec = _rec("chat-a")
    reg = _registry(rec)
    snapshot = (rec.healthy, rec.capabilities, rec.last_checked, rec.capability_sources)
    before = mr.ModelRouter(reg).route(MSG)
    _view(reg, tmp_path)
    assert (rec.healthy, rec.capabilities, rec.last_checked, rec.capability_sources) == snapshot
    after = mr.ModelRouter(reg).route(MSG)
    assert before.record is after.record and before.reason == after.reason


# ── eligibility, readiness and dispatchability are separate ─────────────


def test_name_hint_only_candidate_is_policy_eligible_but_not_task_ready(tmp_path):
    """Decision A: the legacy text-generation exception keeps eligibility; readiness stays strict."""
    rec = _rec("chat-hint", caps={"text-generation": "name-hint"})
    snap = _view(_registry(rec), tmp_path).view.candidates[0]
    assert snap.policy_eligible is True
    assert snap.task_ready is False
    assert snap.task_capabilities[0].provenance == "name-hint"
    assert any("name hint only" in r for r in snap.not_ready_reasons)


def test_name_hint_json_mode_is_not_eligible_for_a_structured_task(tmp_path):
    rec = _rec("json-hint", caps={"text-generation": "ollama:/api/show",
                                  "json-mode": "name-hint"})
    snap = _view(_registry(rec), tmp_path,
                 message="Extract the invoice fields as structured data").view.candidates[0]
    assert snap.policy_eligible is False
    assert snap.task_ready is False


def test_paid_candidate_with_a_grant_is_unsupported_on_the_unmetered_path(tmp_path):
    doc = {"schemaVersion": 1,
           "endpoints": {"gpu-paid": {"networkClass": "private", "cost": "paid",
                                      "pricePer1kTokens": 0.01}},
           "paidGrants": [{"endpointId": "gpu-paid", "modelName": "chat-a", "spendCap": 5.0}]}
    reg = _registry(_rec("chat-a", endpoint="gpu-paid", network="private"))
    snap = _view(reg, tmp_path, policy_doc=doc).view.candidates[0]
    assert snap.grant_valid is True
    assert snap.policy_eligible is True
    assert snap.dispatch_supported is False
    assert snap.task_ready is False
    assert snap.execution_path == "worker-cli"
    assert snap.dispatch_reason == "paid-dispatch-not-metered"


def test_unknown_cost_candidate_is_never_dispatchable(tmp_path):
    reg = _registry(_rec("gpu-undeclared", endpoint="gpu-lan", network="private"))
    snap = _view(reg, tmp_path).view.candidates[0]
    assert snap.dispatch_supported is False
    assert snap.policy_eligible is False


# ── shadow evaluation carries the snapshot and nothing else ─────────────


class _Port:
    """Returns a valid proposal for one agent.delegate task, the same shape the planner accepts."""

    def __init__(self):
        self.calls = 0

    def complete_json(self, system, user):
        self.calls += 1
        return {"tasks": [{"id": "summarise", "description": "summarise the report",
                           "capabilityId": "agent.delegate",
                           "input": {"task": "summarise the report"},
                           "verificationKind": "exit-code",
                           "verification": "the worker exits 0"}]}


def _shadow(tmp_path):
    return sp.ShadowPlanner(_Port(), sp.ShadowPlanStore(tmp_path))


def _authoritative(planner):
    intent = AgentIntent(goal="summarise", expectedOutcome="done")
    return intent, planner.plan_from_model(intent, SESSION, "2026-01-01T00:00:00Z",
                                           {"tasks": [{"id": "a", "description": "a",
                                                       "capabilityId": "agent.delegate",
                                                       "input": {"task": "a"},
                                                       "verificationKind": "exit-code",
                                                       "verification": "exit 0"}]})


def test_shadow_record_carries_the_snapshot_and_still_does_not_execute(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    reg = _registry(_rec("chat-a"))
    shadow = _shadow(tmp_path)
    future = shadow.observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r1",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=lambda: build_request_view(
            reg, MSG, policy=parse_model_policy({"schemaVersion": 1}),
            sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3"))
    record = future.result(timeout=10)
    assert record.executed is False
    assert record.candidateViewStatus == "ok"
    assert record.candidateView["candidates"][0]["modelName"] == "chat-a"


def test_the_authoritative_plan_is_unchanged_by_shadow_evaluation(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    before = [(t.id, t.capabilityId, tuple(t.dependsOn)) for t in auth.tasks]
    reg = _registry(_rec("chat-a"))
    _shadow(tmp_path).observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r2",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=lambda: build_request_view(
            reg, MSG, policy=parse_model_policy({"schemaVersion": 1}),
            sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3")).result(timeout=10)
    assert [(t.id, t.capabilityId, tuple(t.dependsOn)) for t in auth.tasks] == before


def test_a_failing_view_is_a_bounded_status_and_never_an_exception(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)

    def broken():
        raise OSError("registry unreadable")

    record = _shadow(tmp_path).observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r3",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=broken).result(timeout=10)
    assert record.candidateView is None
    assert record.candidateViewStatus.startswith("unavailable: OSError")
    assert record.status in ("validated", "schema-rejected", "model-failed", "internal-error")


def test_the_snapshot_is_built_on_the_shadow_thread_not_the_caller(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    seen = {}

    def provider():
        seen["thread"] = threading.current_thread().name
        return build_request_view(_registry(), MSG,
                                  policy=parse_model_policy({"schemaVersion": 1}),
                                  sovereign=SovereignPolicy(),
                                  ledger_path=tmp_path / "u.sqlite3")

    _shadow(tmp_path).observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r4",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=provider).result(timeout=10)
    assert seen["thread"] == "laya-shadow"


def test_no_provider_means_no_snapshot_and_an_explicit_status(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    record = _shadow(tmp_path).observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r5",
        authoritative_plan=auth, planner=planner).result(timeout=10)
    assert record.candidateView is None and record.candidateViewStatus == "not-provided"


def test_a_skipped_admission_never_builds_the_snapshot(tmp_path):
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    calls = []
    shadow = sp.ShadowPlanner(_Port(), sp.ShadowPlanStore(tmp_path))
    shadow._admit = lambda: False          # admission refused: budget exhausted
    record = shadow.observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r6",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=lambda: calls.append(1)).result(timeout=10)
    assert record.status == "skipped"
    assert calls == []


# ── redaction ───────────────────────────────────────────────────────────


def test_the_serialised_snapshot_has_no_endpoint_address_or_key_names(tmp_path):
    secret_base = "http://10.9.8.7:11434/v1"
    reg = _registry(_rec("chat-a", base=secret_base))
    dumped = str(view_to_record(_view(reg, tmp_path).view))
    assert "10.9.8.7" not in dumped
    assert "base_url" not in dumped and "baseUrl" not in dumped
    assert "api_key" not in dumped.lower()


def test_reason_text_is_scrubbed_before_it_is_recorded(tmp_path):
    from aura.sovereign.laya_view import CandidateSnapshot, CandidateView
    snap = CandidateSnapshot(
        endpoint_id="ep", model_name="m", network_class="local", task_capabilities=(),
        policy_eligible=False, exclusion="x", dispatch_supported=False,
        dispatch_reason="Bearer abcdefghijklmnop1234567890", grant_valid=None,
        grant_available=None, task_ready=False,
        not_ready_reasons=("token Bearer abcdefghijklmnop1234567890 leaked",))
    dumped = str(view_to_record(CandidateView(("text-generation",), (snap,), None)))
    assert "abcdefghijklmnop1234567890" not in dumped


# ── Laya and shadow output cannot change routing; flag off is legacy ────


def test_recording_a_shadow_result_does_not_change_the_router(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)
    reg = _registry(_rec("chat-a"), _rec("chat-b", healthy=True))
    router = mr.ModelRouter(reg)
    before = router.route(MSG)
    planner = TaskPlanner(known_capabilities=lambda: {"agent.delegate"})
    intent, auth = _authoritative(planner)
    _shadow(tmp_path).observe(
        intent=intent, system="sys", user=MSG, session_id=SESSION, request_id="r7",
        authoritative_plan=auth, planner=planner,
        candidate_view_provider=lambda: build_request_view(
            reg, MSG, policy=parse_model_policy({"schemaVersion": 1}),
            sovereign=SovereignPolicy(), ledger_path=tmp_path / "u.sqlite3")).result(timeout=10)
    after = router.route(MSG)
    assert before.record is after.record and before.reason == after.reason


def test_flag_off_routing_ignores_the_snapshot_machinery_entirely(tmp_path, monkeypatch):
    monkeypatch.delenv(mr.POLICY_ROUTING_ENV, raising=False)

    def forbidden(*a, **k):
        raise AssertionError("policy or ledger touched while the flag is off")

    monkeypatch.setattr(mr, "load_model_policy", forbidden)
    monkeypatch.setattr(mr, "UsageLedger", forbidden)
    reg = _registry(_rec("chat-a"))
    _view(reg, tmp_path)                  # builds a snapshot with an explicit policy
    assert mr.ModelRouter(reg).route(MSG).record is not None


def test_the_agent_still_dispatches_when_the_registry_is_broken(tmp_path):
    """A registry that raises must not stop shadow scheduling or the request."""
    from aura.central_agent.service import CentralAgent

    class BrokenRegistry:
        def query(self, *a, **k):
            raise RuntimeError("registry offline")

    captured = {}

    class FakeShadow:
        enabled = True

        def observe(self, **kwargs):
            captured.update(kwargs)
            return None

    agent = object.__new__(CentralAgent)
    agent._shadow = FakeShadow()
    agent._model_registry = BrokenRegistry()
    agent._shadow_system_prompt = lambda: "sys"
    agent.planner = None
    session = type("S", (), {"sessionId": SESSION, "lastRequestId": "r8"})()
    intent = AgentIntent(goal="summarise", expectedOutcome="done")
    # Must not raise: the request path is unaffected.
    agent._observe_shadow(intent, MSG, session, plan=None)
    assert callable(captured["candidate_view_provider"])
    with pytest.raises(RuntimeError):     # the failure is contained to the shadow thread
        captured["candidate_view_provider"]()
