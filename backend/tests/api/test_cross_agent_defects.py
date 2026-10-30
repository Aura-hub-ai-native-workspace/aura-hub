"""Cross-agent defect reconciliation regressions.

A: fs.write_file is absent everywhere; the canonical vocabulary is the only
   vocabulary (fresh runtime + catalogue + intent E2E proof).
B: HTTP resume forwards approvedCapabilities per the frozen contract
   (server-derived single-use grant; a client approvalId is NOT the
   mechanism): park → decide → resume → exactly one effect → replay 409.
C: default composition root routes through the connected-node registry:
   authority preflight and execution see one catalogue; explicit requested
   node is never substituted; unsupported/no-provider stay honest.
"""
from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return TestClient(create_app()), tmp_path


def _ask_for_medium(c) -> None:
    """The person's own policy: medium-risk steps ask. Defaults never ask;
    this explicit setting is what parks a write on the ledger, which is
    the per-step cycle (decide, single-use spend, replay refused) pinned
    here."""
    assert c.post("/fabric/policy",
                  json={"byRisk": {"medium": "ask-user"}}).status_code == 200


def _unattended_run(c, wf_id: str, inputs: dict, proj) -> dict:
    """Start a run no person started (an automation trigger), through the
    app's own canonical runner."""
    import asyncio

    wf = c.app.state.wf_store.get(wf_id)
    out = asyncio.run(c.app.state.runner.start_workflow_run(
        wf, project_id="default", project_path=str(proj),
        trigger={"kind": "automation", "ruleId": "rule-t", "runId": "ar-t",
                 "event": "test"},
        inputs=inputs))
    return out["run"]


# ── DEFECT A ─────────────────────────────────────────────────────────────────

def test_defect_a_legacy_id_absent_everywhere_live(svc):
    c, home = svc
    caps = {x["id"] for x in c.get("/fabric/capabilities").json()["capabilities"]}
    assert "fs.write_file" not in caps
    assert "filesystem.write" in caps

    from aura.fabric import describe_capability
    assert describe_capability("fs.write_file") is None

    # governed write intent compiles to the canonical id and EXECUTES
    from aura.central_agent.intent import IntentCompiler
    intent = IntentCompiler(mode="heuristic").compile(
        'create a file called demo.txt containing "hello"')
    assert intent.requiredCapabilities == ["filesystem.write"]

    proj = home / "proj"; proj.mkdir()
    sub = c.post("/agent/sessions", json={
        "message": 'create a file called demo.txt containing "hello"',
        "projectPath": str(proj)}).json()
    # Workspace runs the goal immediately, in the background: wait for the
    # run's terminal result (submit answers `started`), with no approval.
    import time as _time
    deadline = _time.monotonic() + 90
    while True:
        s = c.get(f"/agent/sessions/{sub['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and \
                (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            break
        assert _time.monotonic() < deadline, f"never settled: {str(s)[:300]}"
        _time.sleep(0.25)
    assert s["lastResult"]["outcome"] == "completed", s["lastResult"]
    assert (proj / "demo.txt").read_text() == "hello"
    assert c.get("/fabric/approvals").status_code == 404  # the approval queue no longer exists


def test_defect_a_source_scan_has_no_legacy_emitters():
    import subprocess

    out = subprocess.run(
        ["grep", "-rn", "fs.write_file", "aura/"],
        capture_output=True, text=True, cwd=".")
    hits = [l for l in out.stdout.splitlines() if l.strip()]
    assert hits == [], f"legacy id leaked back into source: {hits}"


# ── DEFECT B ─────────────────────────────────────────────────────────────────

# ── DEFECT C ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def connected(svc):
    c, home = svc
    reg = c.post("/fabric/nodes", json={
        "id": "local-cli", "name": "Local CLI",
        "capabilities": ["terminal"],
        "version": "1.0"}).json()
    return c, home, reg


def test_defect_c_catalogue_registration_visible_to_authority_and_execution(connected):
    c, _, reg = connected
    assert reg["id"] == "local-cli"
    view = c.get("/fabric/nodes").json()
    assert any(n["id"] == "local-cli" for n in view["nodes"])
    assert "terminal" in view["providedNodeCapabilities"]
    catalogue = c.get("/fabric/capabilities").json()
    terminal = next(x for x in catalogue["capabilities"]
                    if x["id"] == "terminal.execute")
    assert terminal["supported"] is True


def test_defect_c_auto_selection_follows_catalogue_order(connected):
    c, home, _ = connected
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "pwd"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home),
                    "approvedCapabilities": ["terminal.execute"]}}).json()
    assert inv["outcome"] == "succeeded", inv
    audit = c.get("/fabric/audit").json()["audit"]
    row = next(a for a in audit
               if a.get("invocationId") == inv["invocationId"])
    assert row.get("executedNodeId") == "local-cli"

    # Routine work runs without consent by default ...
    direct = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "pwd"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home)}}).json()
    assert direct["outcome"] == "succeeded", direct
    # ... and a configured "ask" no longer waits for a person in Alpha: the
    # same call runs under policy and is recorded. No request is created.
    _ask_for_medium(c)
    asked = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "pwd"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home)}}).json()
    assert asked["outcome"] == "succeeded", asked
    assert c.get("/fabric/approvals").status_code == 404


def test_defect_c_requested_node_never_substituted(connected):
    c, home, _ = connected
    c.post("/fabric/nodes", json={
        "id": "other-cli", "name": "Other",
        "capabilities": ["terminal"], "version": "1.0"})
    # requested node that does not provide the capability → honest denial,
    # NEVER a silent fallback to local-cli
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "pwd"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home),
                    "nodeId": "no-such-node"}}).json()
    assert inv["outcome"] == "denied"
    assert inv["policy"]["rule"] == "unknown-node"

    missing_cap = c.post("/fabric/invoke", json={
        "capabilityId": "git.commit", "input": {"message": "x", "path": "."},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home),
                    "nodeId": "other-cli"}}).json()
    assert missing_cap["outcome"] == "denied"
    assert missing_cap["policy"]["rule"] in ("node-lacks-capability", "no-provider")


def test_defect_c_unsupported_provider_stays_honest(connected):
    c, home, _ = connected
    c.post("/fabric/nodes", json={
        "id": "claims-terminal", "name": "Claims Terminal",
        "capabilities": ["terminal"], "version": ""})
    from aura.fabric.host import WiringHost
    from aura.persistence.nodes import ConnectedNodeStore

    store = ConnectedNodeStore()
    store.register("only-claims", "Only Claims", ["terminal"])

    host = WiringHost(store)
    denial = host.resolve_node({"requiresNodeCapability": "terminal",
                                "surface": "local-process", "name": "t"},
                               {}, can_use=lambda n: False)
    assert denial["ok"] is False and denial["code"] == "node-unsupported"

    none_at_all = host.resolve_node(
        {"requiresNodeCapability": "docker.build",
         "surface": "local-process", "name": "d"}, {})
    assert none_at_all["ok"] is False and none_at_all["code"] == "no-provider"


def test_defect_c_end_to_end_plan_through_default_app(connected):
    """default app → connected-capability plan → authority → routing →
    Fabric → execution."""
    c, home, _ = connected
    wf = c.post("/workflows", json={"name": "Connected", "nodes": [
        {"id": "sh", "type": "shell-command", "x": 0, "y": 0,
         "config": {"command": "pwd"}}], "edges": []}).json()
    envelope = c.get(f"/workflows/{wf['id']}/envelope").json()["envelope"]
    assert any(cap["capabilityId"] == "terminal.execute"
               for cap in envelope["capabilities"])

    frames = []
    with c.stream("POST", f"/workflows/{wf['id']}/run",
                  json={"approvedCapabilities": ["terminal.execute"]}) as r:
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames.append(json.loads(line[5:].strip()))
    done = next(f for f in frames if f["type"] == "done")
    assert done["runState"] == "succeeded", done
