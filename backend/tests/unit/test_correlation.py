"""P1-C/P1-D: correlation identity + model telemetry contracts.

Every leg carries one server-generated request id from the HTTP
boundary through session events, Fabric invocations, worker
assignments, and evidence — reusing session/approval/invocation ids
everywhere else. Model telemetry is metadata-only and honest about
absence. No secrets may appear in any of it.
"""

import json
import tempfile
from pathlib import Path

import pytest

from aura.central_agent.correlation import is_request_id, new_request_id


def test_request_id_shape_and_validation() -> None:
    rid = new_request_id()
    assert is_request_id(rid)
    assert new_request_id() != rid
    for bad in (None, "", "req-xyz", "agt-123456789012", "req-ABCDEF123456",
                "req-123", " req-123456789012", "req-123456789012 "):
        assert not is_request_id(bad), bad


def _agent(home: Path, **kw):
    from aura.approvals import ApprovalLedger
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.fabric import FabricConfig

    cfg = FabricConfig(fabric=None, audit_store=None,
                       ledger=ApprovalLedger(), permissions={},
                       executors={}, secrets=None)
    return CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))


def test_malformed_request_id_rejected(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    with pytest.raises(ValueError, match="malformed request_id"):
        agent.submit("hello there friend", request_id="forged")
    with pytest.raises(ValueError, match="malformed request_id"):
        agent.resume("agt-000000000000", request_id="forged")


def test_leg_correlation_on_session_and_events(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    # Capture what actually rides the bus (post-injection), not the
    # pre-injection call args: the bus is the wire.
    frames: list = []
    agent.bus.subscribe(lambda e: frames.append(e))
    res = agent.submit("Explain this project briefly")
    sid = agent.sessions.last_session_id
    assert sid is not None
    session = agent.sessions.load(sid)
    assert session is not None
    rid = session.lastRequestId
    assert is_request_id(rid), rid
    started = [f for f in frames if f.type == "session.started"]
    assert started and started[0].payload.get("requestId") == rid
    # Every frame on this leg carries the same id.
    assert frames, "expected lifecycle frames on the bus"
    for f in frames:
        if f.sessionId in (sid, "-"):
            assert f.payload.get("requestId") == rid, (f.type, f.payload)


def test_followup_leg_gets_fresh_id(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    agent.submit("Explain this project briefly")
    sid = agent.sessions.last_session_id
    assert sid is not None
    first = agent.sessions.load(sid).lastRequestId
    agent.message(sid, "Tell me more")
    second = agent.sessions.load(sid).lastRequestId
    assert is_request_id(first) and is_request_id(second)
    assert first != second


def test_evidence_carries_leg_ids(tmp_path: Path) -> None:
    from aura.contracts import EvidenceBundle, TaskOutcome

    agent = _agent(tmp_path)
    session = agent.sessions.create("proj-1")
    agent.sessions.save(session)
    agent._request_ids[session.sessionId] = "req-aaaaaaaaaaaa"
    row = TaskOutcome.model_validate({
        "taskId": "t1", "state": "done", "performed": True,
        "verified": True})
    bundle = agent._collect_evidence(session.sessionId, "pln-1", [row],
                                     "done.", "2026-01-01T00:00:00Z")
    assert isinstance(bundle, EvidenceBundle)
    assert bundle.requestIds == ["req-aaaaaaaaaaaa"]


def test_fabric_audit_carries_session_and_request(tmp_path, monkeypatch) -> None:
    from aura.audit import AuditStore
    from aura.fabric import FabricConfig, invoke_fabric

    from test_fabric_invoke import make_cfg

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    home = tmp_path
    cfg = make_cfg(home)
    store = AuditStore(home / "audit.jsonl")
    out = invoke_fabric(
        "nope.unknown", {},
        {"actor": {"kind": "agent", "id": "central-agent"},
         "projectId": "proj-a", "taskId": "t1",
         "sessionId": "agt-aaaaaaaaaaaa", "requestId": "req-bbbbbbbbbbbb"},
        cfg)
    assert out["outcome"] == "failed"
    records = store.load()
    assert records, "denied/failed invocations must still audit"
    rec = records[-1]
    assert rec["sessionId"] == "agt-aaaaaaaaaaaa"
    assert rec["requestId"] == "req-bbbbbbbbbbbb"
    assert rec["projectId"] == "proj-a"


def test_execution_outcome_and_assignments_carry_ids(
        tmp_path, monkeypatch) -> None:
    from aura.central_agent.execution import ExecutionController
    from aura.contracts import TaskPlan

    from test_fabric_invoke import make_cfg

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    cfg = make_cfg(tmp_path)
    agent = _agent(tmp_path)
    agent.controller = ExecutionController(cfg, engine=None)
    plan = TaskPlan.model_validate({
        "planId": "pln-1", "sessionId": "agt-aaaaaaaaaaaa",
        "intent": {"goal": "g", "expectedOutcome": "e"},
        "tasks": [{"id": "t1", "description": "d",
                   "capabilityId": "nope.unknown",
                   "verification": {"kind": "audit-only"}}],
        "createdAt": "2026-01-01T00:00:00Z"})
    outcome = agent.controller.execute(
        plan, "proj-a",
        correlation={"session_id": "agt-aaaaaaaaaaaa",
                     "request_id": "req-cccccccccccc"})
    assert outcome.request_id == "req-cccccccccccc"
    assert outcome.outcomes and outcome.outcomes[0].state == "failed"


def test_telemetry_absent_without_provider() -> None:
    from aura.central_agent.model_routing import RoutedModelPort

    port = RoutedModelPort([])
    tel = port.telemetry()
    assert tel["configured"] is False
    assert tel["providers"] == []
    assert tel["lastCall"] is None
    blob = json.dumps(tel).lower()
    for forbidden in ("bearer", "api_key", "apikey", "secret", "prompt",
                      "completion", "authorization"):
        assert forbidden not in blob, forbidden


def test_telemetry_records_calls_without_secrets() -> None:
    import os

    from aura.central_agent.model_routing import (
        ProviderSpec,
        RoutedModelPort,
    )

    os.environ["AURA_P1_TEST_KEY"] = "k"
    try:
        spec = ProviderSpec(id="p", base_url="http://x", model="m",
                            api_key_env="AURA_P1_TEST_KEY")
        port = RoutedModelPort([spec])

        def fake_post(url, payload, headers, timeout):
            assert "authorization" in headers  # key travels, never logged
            return {"choices": [{"message": {"content": '{"a": 1}'}}]}

        port._post = fake_post
        assert port.complete_json("s", "u") == {"a": 1}
        tel = port.telemetry()
        assert tel["configured"] is True
        assert tel["lastCall"]["provider"] == "p"
        assert tel["lastCall"]["model"] == "m"
        assert tel["lastCall"]["ok"] is True
        assert isinstance(tel["lastCall"]["latencyMs"], float)
        blob = json.dumps(tel)
        assert "k" not in blob.replace('"ok": true', "")
    finally:
        del os.environ["AURA_P1_TEST_KEY"]


def test_http_responses_carry_request_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    c = TestClient(create_app())
    r = c.post("/agent/sessions",
               json={"message": "Explain this project briefly"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert is_request_id(body.get("requestId")), body
    assert r.headers.get("x-aura-request") == body["requestId"]
    sid = body["sessionId"]
    r2 = c.post(f"/agent/sessions/{sid}/message",
                json={"message": "Tell me more", "projectId": None})
    assert r2.status_code == 200, r2.text
    assert is_request_id(r2.json().get("requestId"))
    assert r2.json()["requestId"] != body["requestId"]
    r3 = c.post(f"/agent/sessions/{sid}/cancel", json={})
    assert r3.status_code == 200
    assert is_request_id(r3.json().get("requestId"))
    r4 = c.get("/agent/model")
    assert r4.status_code == 200
    assert r4.json()["configured"] is False
    assert r4.json()["lastCall"] is None


def test_session_last_request_id_visible(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    c = TestClient(create_app())
    r = c.post("/agent/sessions",
               json={"message": "Explain this project briefly"})
    sid = r.json()["sessionId"]
    sess = c.get(f"/agent/sessions/{sid}").json()
    assert sess["lastRequestId"] == r.json()["requestId"]
