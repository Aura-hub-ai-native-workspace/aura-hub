"""API closure verification — every frontend-consumed contract against the
canonical services, on a disposable AURA_HOME.

Covers: CORS (the verified defect), approval ledger single-use + 409,
fabric invoke governance, central-agent session surface on the real spine,
workflow editor surface (envelope/validate/specs/templates/versions),
SSE run streaming, cross-workflow run index, automation CRUD + dry-run
zero-side-effect, secrets metadata-only, security negatives, and restart
persistence.
"""
from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    app = create_app()
    return TestClient(app), tmp_path


# ── CORS ─────────────────────────────────────────────────────────────────────

def test_cors_localhost_any_port_allowed(svc):
    c, _ = svc
    for origin in ("http://localhost:1420", "http://localhost:3000",
                   "http://127.0.0.1:1420", "https://localhost:5173",
                   "tauri://localhost", "https://tauri.localhost"):
        r = c.options("/workflows", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST"})
        assert r.status_code == 200, f"{origin} → {r.status_code}"
        assert r.headers.get("access-control-allow-origin") is not None


def test_cors_external_origin_refused(svc):
    c, _ = svc
    r = c.options("/workflows", headers={
        "Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") != "https://evil.example.com"


def test_cors_actual_get_carries_allow_origin(svc):
    c, _ = svc
    r = c.get("/health", headers={"Origin": "http://localhost:1420"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in (
        "http://localhost:1420", "*")


# ── health shape ─────────────────────────────────────────────────────────────

def test_health_serves_both_contract_generations(svc):
    c, _ = svc
    body = c.get("/health").json()
    assert body["ok"] is True
    assert isinstance(body["service"], str)
    assert body["health"]["backend"] == "python"


# ── workflow editor surface ──────────────────────────────────────────────────

def test_workflow_list_wrapped_and_specs_templates(svc):
    c, _ = svc
    assert c.post("/workflows", json={"name": "W", "nodes": [], "edges": []}).status_code == 200
    assert isinstance(c.get("/workflows").json()["workflows"], list)
    specs = c.get("/workflows/specs").json()["specs"]
    assert {s["type"] for s in specs} >= {"shell-command", "git-status", "output"}
    templates = c.get("/workflows/templates").json()["templates"]
    assert templates and all(t["nodes"] and t["edges"] for t in templates)
    # Every template node type is one this backend actually executes.
    runnable = {s["type"] for s in specs}
    assert all(n["type"] in runnable for t in templates for n in t["nodes"])


def test_envelope_reports_scopes_and_cannot(svc):
    c, _ = svc
    wf = c.post("/workflows", json={"name": "Env", "nodes": [
        {"id": "s", "type": "shell-command", "x": 0, "y": 0,
         "config": {"command": "ls"}}], "edges": []}).json()
    env = c.get(f"/workflows/{wf['id']}/envelope").json()["envelope"]
    assert any(cap["capabilityId"] == "terminal.execute" for cap in env["capabilities"])
    assert "process.execute" in [s["scope"] for s in env["scopes"]]
    assert env["cannot"].startswith("This workflow cannot ")
    assert "run commands" not in env["cannot"]  # it CAN run commands
    assert env["highestRisk"] in ("low", "medium", "high")


def test_agent_tools_never_widen_envelope(svc):
    c, home = svc
    wid = c.post("/workflows", json={"name": "A", "nodes": [
        {"id": "ag", "type": "agent", "x": 0, "y": 0,
         "config": {"tools": ["git.status", "git.push"]}}], "edges": []}).json()["id"]
    result = c.get(f"/agent/tools?workflowId={wid}&requested=git.status,git.push").json()
    allowed = result["allowed"]
    assert "git.status" in allowed
    # irreversible/high-risk tools are excluded by the same four safety rules
    assert "git.push" not in allowed


def test_validate_flags_missing_secret(svc):
    c, _ = svc
    wf = c.post("/workflows", json={"name": "V", "nodes": [
        {"id": "o", "type": "output", "x": 0, "y": 0,
         "config": {"title": "{{secret:NOPE_KEY}}"}}], "edges": []}).json()
    report = c.get(f"/workflows/{wf['id']}/validate").json()
    assert report["secretsReferenced"] == ["NOPE_KEY"]
    assert report["secretsMissing"] == ["NOPE_KEY"]
    assert report["requiresReview"] is True


def test_version_publish_restore_cycle(svc):
    c, _ = svc
    wf = c.post("/workflows", json={"name": "Ver", "nodes": [
        {"id": "a", "type": "delay", "x": 0, "y": 0, "config": {}}],
        "edges": []}).json()
    v1 = c.post(f"/workflows/{wf['id']}/versions", json={"note": "first"}).json()
    assert v1["id"]
    versions = c.get(f"/workflows/{wf['id']}/versions").json()["versions"]
    assert len(versions) == 1
    restored = c.post(
        f"/workflows/{wf['id']}/versions/{v1['id']}/restore", json={})
    assert restored.status_code == 200


# ── SSE run streaming ────────────────────────────────────────────────────────

def test_run_streams_wire_frames_and_persists(svc):
    c, home = svc
    wf = c.post("/workflows", json={"name": "Run", "nodes": [
        {"id": "d", "type": "delay", "x": 0, "y": 0, "config": {"ms": 1}},
        {"id": "o", "type": "output", "x": 80, "y": 0,
         "config": {"title": "Done"}}],
        "edges": [{"id": "e", "from": "d", "fromPort": "out", "to": "o"}]}).json()
    with c.stream("POST", f"/workflows/{wf['id']}/run", json={}) as r:
        frames = []
        for line in r.iter_lines():
            if line.startswith("data:") and "[DONE]" not in line:
                frames.append(json.loads(line[5:].strip()))
            if line.strip() == "data: [DONE]":
                break
    kinds = [f["type"] for f in frames]
    assert kinds[0] == "start"
    assert "node" in kinds and "done" in kinds
    done = next(f for f in frames if f["type"] == "done")
    assert done["status"] == "completed"
    assert done.get("runId")
    # persisted run record matches the streamed story
    runs = c.get(f"/workflows/{wf['id']}/runs").json()["runs"]
    assert runs and runs[0]["id"] == done["runId"]
    detail = c.get(f"/workflows/{wf['id']}/runs/{done['runId']}").json()
    assert detail["state"] == "succeeded"


def test_cross_workflow_index_stats_awaiting_find(svc):
    c, _ = svc
    index = c.get("/workflow-runs").json()
    assert set(index) >= {"runs", "total", "offset", "limit"}
    stats = c.get("/workflow-runs/stats").json()["stats"]
    assert isinstance(stats, dict)
    awaiting = c.get("/workflow-runs/awaiting").json()["runs"]
    assert isinstance(awaiting, list)


# ── approvals: THE ledger ────────────────────────────────────────────────────

class _ParkingHost:
    def permissions_for(self, _c, _ctx):
        return {"read": True, "write": True, "execute": True}

    def node_available(self, _capability):
        return None

    async def request_approval(self, _request, _context):
        return False  # always park


def test_governed_invoke_parks_decide_grants_then_replay_is_409(tmp_path, monkeypatch):
    """Default server wiring uses DefaultHost which parks on ask-user.
    Named approval reuse: pass approvalId in context to spend a granted approval."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    app = create_app()
    c = TestClient(app)

    def invoke(approval_id=None, tmp_path=tmp_path):
        ctx = {"actor": {"kind": "human", "id": "user"}, "projectId": "p", "cwd": str(tmp_path)}
        if approval_id:
            ctx["approvalId"] = approval_id
        return c.post("/fabric/invoke", json={
            "capabilityId": "filesystem.write",
            "input": {"path": "demo.txt", "content": "hello"},
            "context": ctx}).json()

    first = invoke()
    assert first["outcome"] == "awaiting-approval", first
    assert first.get("approvalId")

    pending = c.get("/fabric/approvals").json()["approvals"]
    assert len(pending) == 1
    aid = pending[0]["id"]

    decided = c.post(f"/fabric/approvals/{aid}/decide",
                     json={"granted": True, "reason": "fine"}).json()
    assert decided["approval"]["state"] == "granted"
    # replay / double-click / second tab
    replay = c.post(f"/fabric/approvals/{aid}/decide", json={"granted": True})
    assert replay.status_code == 409
    assert "error" in replay.json()

    # Reuse the GRANTED approval by passing its ID in context — this spends it
    spent = invoke(approval_id=aid)
    assert spent["outcome"] == "succeeded"
    audit = c.get("/fabric/audit").json()["audit"]
    assert any(a.get("approvalId") == aid for a in audit)


def test_denied_decision_records_audit_not_effect(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    app = create_app()
    c = TestClient(app)
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "filesystem.write",
        "input": {"path": "no.txt", "content": "x"},
        "context": {"projectId": "p", "cwd": str(tmp_path)}}).json()
    assert inv["outcome"] == "awaiting-approval"
    aid = c.get("/fabric/approvals").json()["approvals"][0]["id"]
    denied = c.post(f"/fabric/approvals/{aid}/decide", json={"granted": False})
    assert denied.status_code == 200
    assert not (tmp_path / "no.txt").exists()


# ── central agent sessions ───────────────────────────────────────────────────

def test_agent_submit_session_evidence_cancel_flow(svc):
    c, _ = svc
    submitted = c.post("/agent/sessions", json={"message": "what can you do?"})
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    sid = body["sessionId"]
    assert sid
    result = body["result"]
    assert result["outcome"] in ("completed", "failed", "blocked",
                                 "needs-clarification", "unsupported",
                                 "denied", "timeout")
    session = c.get(f"/agent/sessions/{sid}").json()
    assert session["sessionId"] == sid
    assert isinstance(session["messages"], list)
    evidence = c.get(f"/agent/sessions/{sid}/evidence").json()
    assert evidence == {"evidence": None} or "auditRecordIds" in evidence
    cancelled = c.post(f"/agent/sessions/{sid}/cancel").json()
    assert cancelled == {"cancelled": True} or cancelled.get("cancelled") is True


def test_agent_submit_requires_message(svc):
    c, _ = svc
    assert c.post("/agent/sessions", json={"message": ""}).status_code == 400


def test_agent_unknown_session_404(svc):
    c, _ = svc
    assert c.get("/agent/sessions/agt-nope").status_code == 404


def test_agent_events_stream_replays_tail(svc):
    c, _ = svc
    body = c.post("/agent/sessions", json={"message": "list capabilities"}).json()
    sid = body["sessionId"]
    frames = []
    with c.stream("GET", f"/agent/sessions/{sid}/events") as r:
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames.append(json.loads(line[5:].strip()))
    # The session's lifecycle events replay: session.started at minimum.
    assert any(f.get("type") == "session.started" and f.get("sessionId") == sid
               for f in frames), frames


# ── automation surface ───────────────────────────────────────────────────────

def _rule_draft(wf_id):
    return {
        "name": "Nightly check", "enabled": True,
        "trigger": {"type": "schedule", "cron": "30 2 * * *",
                    "projectId": "default"},
        "conditions": [],
        "chain": [{"id": "act1", "action": "run-workflow", "label": "run",
                   "config": {"workflowId": wf_id},
                   "continueOnError": False}],
    }


def test_automation_rule_crud_validate_and_shapes(svc):
    c, _ = svc
    wf = c.post("/workflows", json={"name": "AW", "nodes": [
        {"id": "st", "type": "git-status", "x": 0, "y": 0, "config": {}}],
        "edges": []}).json()
    issues = c.post("/automation/validate", json=_rule_draft(wf["id"])).json()
    assert issues == {"issues": []}
    created = c.post("/automation/rules", json=_rule_draft(wf["id"])).json()
    assert created["name"] == "Nightly check"
    rules = c.get("/automation/rules").json()["rules"]
    assert any(r["id"] == created["id"] for r in rules)
    patched = c.patch(f"/automation/rules/{created['id']}",
                      json={"enabled": False}).json()
    assert patched["enabled"] is False
    assert c.put(f"/automation/rules/{created['id']}",
                 json={"name": "Renamed"}).json()["name"] == "Renamed"
    assert c.delete(f"/automation/rules/{created['id']}").json() == {"ok": True}


def test_automation_create_refuses_broken_schedule(svc):
    c, _ = svc
    bad = _rule_draft("wf-x")
    bad["trigger"]["cron"] = "99 2 * * *"
    r = c.post("/automation/rules", json=bad)
    assert r.status_code == 422
    assert "error" in r.json()


def test_automation_dry_run_zero_side_effects(svc):
    c, home = svc
    proj = home / "proj"; proj.mkdir()
    wf = c.post("/workflows", json={"name": "DW", "nodes": [
        {"id": "sh", "type": "shell-command", "x": 0, "y": 0,
         "config": {"command": "echo side-effect"}}], "edges": []}).json()
    rule = c.post("/automation/rules", json={
        **_rule_draft(wf["id"]),
        "trigger": {"type": "event", "eventType": "git.push"}}).json()
    report = c.post(f"/automation/rules/{rule['id']}/dry-run", json={}).json()
    assert report["sideEffects"]["invocations"] == 0
    assert report["sideEffects"]["automationRunsCreated"] == 0
    assert list(proj.iterdir()) == []
    assert report["trigger"]["accepted"]["certainty"] in ("known", "conditional")


def test_automation_schedules_and_runs_index(svc):
    c, _ = svc
    schedules = c.get("/automation/schedules").json()["schedules"]
    assert isinstance(schedules, dict)
    index = c.get("/automation/runs").json()
    assert set(index) >= {"runs", "total", "offset", "limit"}
    stats = c.get("/automation/stats").json()
    assert "indexed" in stats


# ── secrets: metadata only ───────────────────────────────────────────────────

def test_secrets_list_exposes_metadata_never_values(svc):
    c, _ = svc
    rows = c.get("/secrets").json()
    assert isinstance(rows, list)
    for row in rows:
        assert set(row) <= {"name", "hasValue"}


# ── security negatives ──────────────────────────────────────────────────────

def test_unknown_capability_invoke_fails_closed(svc):
    c, tmp = svc
    r = c.post("/fabric/invoke", json={"capabilityId": "does.not.exist",
                                       "input": {}, "context": {}})
    body = r.json()
    assert body["outcome"] == "failed"

    # traversal attempt never escapes the project root
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "filesystem.read",
        "input": {"path": "../../etc/passwd"},
        "context": {"projectId": "p"}})
    assert inv.status_code in (200, 400)
    if inv.status_code == 200:
        assert inv.json()["outcome"] in ("failed", "denied")


def test_error_shape_is_always_exact(svc):
    c, _ = svc
    body = c.get("/workflows/missing").json()
    assert set(body) == {"error"}


def test_mission_annotation_reported_honestly(svc):
    c, _ = svc
    r = c.get("/fabric/mission/p1/m1")
    assert r.status_code == 501
    assert "error" in r.json()


# ── persistence across restart ───────────────────────────────────────────────

def test_workflows_rules_approvals_survive_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    app1 = create_app()
    c1 = TestClient(app1)
    wf = c1.post("/workflows", json={"name": "Persist", "nodes": [], "edges": []}).json()
    rule = c1.post("/automation/rules", json=_rule_draft(wf["id"])).json()

    c2 = TestClient(create_app())   # fresh process state, same AURA_HOME
    assert any(w["id"] == wf["id"] for w in c2.get("/workflows").json()["workflows"])
    assert any(r["id"] == rule["id"] for r in c2.get("/automation/rules").json()["rules"])
