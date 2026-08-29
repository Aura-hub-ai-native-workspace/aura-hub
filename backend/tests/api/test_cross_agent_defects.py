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
    assert sub["result"]["outcome"] == "awaiting-approval"
    aid = c.get("/fabric/approvals").json()["approvals"][0]["id"]
    assert c.post(f"/fabric/approvals/{aid}/decide",
                  json={"granted": True}).status_code == 200
    resumed = c.post(f"/agent/sessions/{sub['sessionId']}/resume").json()["result"]
    assert resumed["outcome"] == "completed"
    assert (proj / "demo.txt").read_text() == "hello"


def test_defect_a_source_scan_has_no_legacy_emitters():
    import subprocess

    out = subprocess.run(
        ["grep", "-rn", "fs.write_file", "aura/"],
        capture_output=True, text=True, cwd=".")
    hits = [l for l in out.stdout.splitlines() if l.strip()]
    assert hits == [], f"legacy id leaked back into source: {hits}"


# ── DEFECT B ─────────────────────────────────────────────────────────────────

def test_defect_b_park_decide_resume_single_effect_replay_refused(svc):
    c, home = svc
    proj = home / "b1proj"; proj.mkdir()
    c.post("/projects", json={"path": str(proj)})
    # Frozen semantics: export-file writes the UPSTREAM node's text, so the
    # faithful graph seeds it through a user-input node.
    wf = c.post("/workflows", json={"name": "Gated", "nodes": [
        {"id": "seed", "type": "user-input", "x": 0, "y": 0,
         "config": {"prompt": "content", "default": ""}},
        {"id": "n1", "type": "export-file", "x": 80, "y": 0,
         "config": {"path": "out.txt"}}],
        "edges": [{"id": "e", "from": "seed", "fromPort": "out", "to": "n1"}]}).json()

    # 1. run parks for approval — no effect yet
    frames = []
    with c.stream("POST", f"/workflows/{wf['id']}/run",
                  json={"inputs": {"seed": "hello"},
                        "projectPath": str(proj)}) as r:
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames.append(json.loads(line[5:].strip()))
    done = next(f for f in frames if f["type"] == "done")
    rid = done["runId"]
    assert done["runState"] == "awaiting-approval"
    assert not (proj / "out.txt").exists()

    aid = c.get("/fabric/approvals").json()["approvals"][0]["id"]

    # 2. human decides through THE ledger
    assert c.post(f"/fabric/approvals/{aid}/decide",
                  json={"granted": True, "reason": "ok"}).status_code == 200

    # 3. HTTP resume forwards approvedCapabilities (the frozen mechanism)
    with c.stream("POST", f"/workflows/{wf['id']}/runs/{rid}/resume",
                  json={"approvedCapabilities": ["filesystem.write"]}) as r:
        frames2 = []
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames2.append(json.loads(line[5:].strip()))
    done2 = next(f for f in frames2 if f["type"] == "done")
    assert done2["runState"] == "succeeded", done2
    new_rid = done2["runId"]
    assert new_rid != rid, "resumed leg must be a NEW superseding run"
    prev = c.get(f"/workflow-runs/{rid}").json()
    assert prev.get("supersededBy") == new_rid

    # exactly one effect on disk attributable to the leg
    assert (proj / "out.txt").read_text() == "hello"
    runs = c.get(f"/workflows/{wf['id']}/runs").json()["runs"]
    succeeded = [r_ for r_ in runs if r_["state"] == "succeeded"]
    assert len(succeeded) == 1 and succeeded[0]["id"] == new_rid

    # 4. replay of the decision is refused
    replay = c.post(f"/fabric/approvals/{aid}/decide", json={"granted": True})
    assert replay.status_code == 409

    # 5. no standing grant: another gated run still parks without consent
    frames3 = []
    with c.stream("POST", f"/workflows/{wf['id']}/run",
                  json={"inputs": {"seed": "again"},
                        "projectPath": str(proj)}) as r3:
        for line in r3.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames3.append(json.loads(line[5:].strip()))
    done3 = next(f for f in frames3 if f["type"] == "done")
    assert done3["runState"] == "awaiting-approval"


def test_defect_b_resume_without_authorization_parks_again(svc):
    """No standing grant: after a DENIED decision, a resume carrying no
    consent cannot ride anything; and an unrelated grant never covers a
    different capability."""
    c, home = svc
    proj = home / "b2proj"; proj.mkdir()
    c.post("/projects", json={"path": str(proj)})
    wf = c.post("/workflows", json={"name": "G2", "nodes": [
        {"id": "seed", "type": "user-input", "x": 0, "y": 0,
         "config": {"prompt": "content", "default": ""}},
        {"id": "n1", "type": "export-file", "x": 80, "y": 0,
         "config": {"path": "out.txt"}}],
        "edges": [{"id": "e", "from": "seed", "fromPort": "out", "to": "n1"}]}).json()
    frames = []
    with c.stream("POST", f"/workflows/{wf['id']}/run",
                  json={"inputs": {"seed": "x"},
                        "projectPath": str(proj)}) as r:
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames.append(json.loads(line[5:].strip()))
    aid = c.get("/fabric/approvals").json()["approvals"][0]["id"]
    # deny THIS request through the ledger
    c.post(f"/fabric/approvals/{aid}/decide", json={"granted": False})
    # a resume authorizing a DIFFERENT capability grants nothing
    rid = next(f for f in frames if f["type"] == "done")["runId"]
    with c.stream("POST", f"/workflows/{wf['id']}/runs/{rid}/resume",
                  json={"approvedCapabilities": ["git.status"]}) as r2:
        frames2 = []
        for line in r2.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            if line.startswith("data:"):
                frames2.append(json.loads(line[5:].strip()))
    done2 = next(f for f in frames2 if f["type"] == "done")
    assert not (proj / "out.txt").exists()
    assert done2.get("runState") != "succeeded"


def test_defect_b_ledger_decision_attributed_in_audit(svc):
    c, _ = svc
    c.post("/fabric/nodes", json={"id": "cli", "name": "CLI",
                                  "capabilities": ["terminal"]})
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "ls"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": "."}}).json()
    aid = inv["approvalId"]
    dec = c.post(f"/fabric/approvals/{aid}/decide",
                 json={"granted": True, "reason": "operator says ok"}).json()
    assert dec["approval"]["decidedBy"] == "user"
    audit = c.get("/fabric/audit").json()["audit"]
    decisions = [a for a in audit
                 if a.get("approvalId") == aid and "approvalDecision" in a]
    assert len(decisions) == 1
    assert decisions[0]["approvalDecision"] == "granted"
    assert decisions[0]["decidedBy"] == "user"


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

    # without consent the SAME call honestly parks (no standing grant)
    parked = c.post("/fabric/invoke", json={
        "capabilityId": "terminal.execute", "input": {"command": "pwd"},
        "context": {"actor": {"kind": "human", "id": "user"},
                    "projectId": "p", "cwd": str(home)}}).json()
    assert parked["outcome"] == "awaiting-approval"


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
