"""Integration blocker regressions.

B1: automation run-now returns the ACTUAL persisted run (flat AutomationRun).
B2: Central Agent speaks the canonical Fabric vocabulary — read-only intent
    and governed write intent compile to REAL registered capabilities; the
    restored workflow.create/list capabilities execute through the ONE
    WorkflowStore.
B3: /projects is the migrated ProjectRegistry contract (one store);
    /missions/* stays honestly unsupported (501, documented dependency).
"""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return TestClient(create_app()), tmp_path


# ── BLOCKER 1 ────────────────────────────────────────────────────────────────

def _rule_for(svc, wf_id):
    c, _ = svc
    return c.post("/automation/rules", json={
        "name": "RunNow", "enabled": True,
        "trigger": {"type": "manual"},
        "conditions": [],
        "chain": [{"id": "a1", "action": "run-workflow", "label": "go",
                   "config": {"workflowId": wf_id}, "continueOnError": False}],
    }).json()


def test_b1_run_now_returns_persisted_run_flat(svc):
    c, home = svc
    wf = c.post("/workflows", json={"name": "RW", "nodes": [
        {"id": "d", "type": "delay", "x": 0, "y": 0, "config": {"ms": 1}}],
        "edges": []}).json()
    rule = _rule_for(svc, wf["id"])

    r = c.post(f"/automation/rules/{rule['id']}/run",
               json={"projectId": "default"})
    assert r.status_code == 200, r.text
    body = r.json()
    # Flat AutomationRun — not wrapped, no false 'conditions not met'.
    assert body.get("id", "").startswith("run-")
    assert body.get("status") in ("running", "completed")

    resolved = c.get(f"/automation/rules/{rule['id']}/runs/{body['id']}").json()
    assert resolved is not None, "returned run must resolve to persisted state"
    assert resolved == body, "route must return the PERSISTED run verbatim"
    index = c.get(f"/automation/rules/{rule['id']}/runs").json()["runs"]
    assert any(x["id"] == body["id"] for x in index)


def test_b1_unmatched_rule_reports_conditions_not_met_with_run_null(svc):
    c, _ = svc
    wf = c.post("/workflows", json={"name": "CW", "nodes": [], "edges": []}).json()
    rule = c.post("/automation/rules", json={
        "name": "Gated", "enabled": True,
        "trigger": {"type": "git.push"},
        "conditions": [{"field": "payload.branch", "op": "equals",
                        "value": "main"}],
        "chain": [{"id": "a1", "action": "run-workflow", "label": "go",
                   "config": {"workflowId": wf["id"]}, "continueOnError": False}],
    }).json()
    r = c.post(f"/automation/rules/{rule['id']}/run",
               json={"projectId": "default", "payload": {"branch": "dev"}})
    assert r.status_code == 200
    body = r.json()
    assert body == {"error": "conditions not met", "run": None}


def test_b1_unknown_rule_404(svc):
    c, _ = svc
    assert c.post("/automation/rules/rule-nope/run", json={}).status_code == 404


# ── BLOCKER 2 ────────────────────────────────────────────────────────────────

def test_b2_canonical_vocabulary_registered_and_executable(svc):
    from aura.fabric.manifest import describe_capability

    for cid in ("filesystem.write", "workflow.create", "workflow.list"):
        d = describe_capability(cid)
        assert d is not None, f"{cid} missing from canonical manifest"
    fabric_desc = describe_capability("fs.write_file")
    assert fabric_desc is None, "legacy id must NOT exist as an alias"


def test_b2_write_intent_compiles_to_canonical_capability(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.central_agent.intent import IntentCompiler
    from aura.central_agent.planner import TaskPlanner

    intent = IntentCompiler(mode="heuristic").compile(
        'create a file called demo.txt containing "hello"')
    assert intent.requiredCapabilities == ["filesystem.write"]

    planner = TaskPlanner(
        workflow_resolver=lambda ref: None,
        known_capabilities=lambda: {"filesystem.write", "workflow.create",
                                    "workflow.list", "git.status"})
    from datetime import datetime

    plan = planner.plan(intent, "agt-test",
                        datetime.now().astimezone().isoformat())
    task = plan.tasks[0]
    assert task.capabilityId == "filesystem.write"


def test_b2_workflow_create_executes_through_fabric_read_back(svc):
    c, home = svc
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "workflow.create",
        "input": {"name": "FromAgent", "description": "",
                  "nodes": [{"id": "a", "type": "delay", "x": 0, "y": 0,
                             "config": {}}], "edges": []},
        "context": {"actor": {"kind": "agent", "id": "central-agent"}}}).json()
    assert inv["outcome"] == "succeeded", inv
    wid = inv["output"]["workflowId"]
    stored = c.get(f"/workflows/{wid}").json()
    assert stored["name"] == "FromAgent"  # read-back verify passed


def test_b2_workflow_list_is_low_risk_inventory(svc):
    c, _ = svc
    c.post("/workflows", json={"name": "L1", "nodes": [], "edges": []})
    inv = c.post("/fabric/invoke", json={
        "capabilityId": "workflow.list", "input": {},
        "context": {"actor": {"kind": "agent", "id": "central-agent"}}}).json()
    assert inv["outcome"] == "succeeded"
    assert inv["policy"]["risk"] == "low"
    assert inv["policy"]["decision"] == "auto-execute"  # read-only inventory
    assert any(w["name"] == "L1" for w in inv["output"]["workflows"])


# ── BLOCKER 3 ────────────────────────────────────────────────────────────────

def test_b3_projects_roundtrip_through_one_registry(svc):
    c, home = svc
    proj_dir = home / "ws-proj"
    proj_dir.mkdir()
    created = c.post("/projects", json={"name": "Workspace",
                                        "path": str(proj_dir)})
    assert created.status_code == 200
    record = created.json()
    assert record["id"].startswith("proj-")

    listing = c.get("/projects").json()
    assert any(p["id"] == record["id"] for p in listing["projects"])

    opened = c.post(f"/projects/{record['id']}/open", json={})
    assert opened.status_code == 200
    current = c.get("/projects").json()["current"]
    assert current and current["id"] == record["id"]

    dup = c.post("/projects", json={"name": "Dupe", "path": str(proj_dir)})
    assert dup.status_code == 400
    assert "already registered" in dup.json()["error"]


def test_b3_projects_survive_restart(svc):
    c, home = svc
    proj_dir = home / "persist-proj"; proj_dir.mkdir()
    rec = c.post("/projects", json={"path": str(proj_dir)}).json()
    fresh = TestClient(create_app())  # same AURA_HOME, new process state
    listing = fresh.get("/projects").json()
    assert any(p["id"] == rec["id"] for p in listing["projects"])


def test_b3_missions_stay_honestly_unsupported(svc):
    c, _ = svc
    for path in ("/missions/dashboard", "/projects/p1/missions",
                 "/projects/p1/missions/m1"):
        r = c.get(path)
        assert r.status_code == 501, path
        assert "no canonical backend implementation" in r.json()["error"]


# ── BLOCKER 4 — automation runs index (cross-rule) ─────────────────────────
# GET /automation/runs was returning 500 when query params (offset/limit)
# were provided as strings. Root cause: index_runs() used max(0, query.get())
# without int() conversion. Fixed by converting offset/limit to int.
# Also fixed double-pagination in the HTTP handler.

def _make_rules_and_runs(svc, n_rules=2, n_runs=3):
    """Create n_rules rules with n_runs each. Returns (client, rule_ids)."""
    c, _ = svc
    rule_ids = []
    # Need a workflow for run-workflow action
    wf = c.post("/workflows", json={"name": "Helper", "nodes": [
        {"id": "d", "type": "delay", "x": 0, "y": 0, "config": {"ms": 1}}],
        "edges": []}).json()
    for i in range(n_rules):
        rule = c.post("/automation/rules", json={
            "name": f"Rule {i+1}", "enabled": True,
            "trigger": {"type": "manual"},
            "conditions": [],
            "chain": [{"id": "a1", "action": "run-workflow", "label": "go",
                       "config": {"workflowId": wf["id"]},
                       "continueOnError": False}],
        }).json()
        rule_ids.append(rule["id"])
        for _ in range(n_runs):
            c.post(f"/automation/rules/{rule['id']}/run", json={})
    return c, rule_ids


def test_b4_automation_runs_index_empty(svc):
    c, _ = svc
    r = c.get("/automation/runs")
    assert r.status_code == 200
    body = r.json()
    assert body == {"runs": [], "total": 0, "offset": 0, "limit": 100}


def test_b4_automation_runs_index_one_rule_with_runs(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=1, n_runs=3)
    r = c.get("/automation/runs")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert len(body["runs"]) == 3
    assert body["offset"] == 0
    assert body["limit"] == 100


def test_b4_automation_runs_index_multiple_rules_with_runs(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=2, n_runs=3)
    r = c.get("/automation/runs")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 6
    assert len(body["runs"]) == 6
    # Cross-rule ordering: newest first
    for i in range(5):
        assert body["runs"][i]["startedAt"] >= body["runs"][i+1]["startedAt"]


def test_b4_automation_runs_index_pagination(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=2, n_runs=3)
    # Page 1: 2 items
    r = c.get("/automation/runs", params={"offset": "0", "limit": "2"})
    body = r.json()
    assert body["total"] == 6
    assert len(body["runs"]) == 2
    assert body["offset"] == 0
    assert body["limit"] == 2
    # Page 2: 2 items
    r = c.get("/automation/runs", params={"offset": "2", "limit": "2"})
    body = r.json()
    assert body["total"] == 6
    assert len(body["runs"]) == 2
    assert body["offset"] == 2
    assert body["limit"] == 2
    # Page 3: 2 items
    r = c.get("/automation/runs", params={"offset": "4", "limit": "2"})
    body = r.json()
    assert body["total"] == 6
    assert len(body["runs"]) == 2
    assert body["offset"] == 4
    assert body["limit"] == 2
    # Beyond end: empty
    r = c.get("/automation/runs", params={"offset": "10", "limit": "10"})
    body = r.json()
    assert body["total"] == 6
    assert len(body["runs"]) == 0
    assert body["offset"] == 10


def test_b4_automation_runs_index_filter_by_rule_id(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=2, n_runs=3)
    r = c.get("/automation/runs", params={"ruleId": rule_ids[0]})
    body = r.json()
    assert body["total"] == 3
    assert len(body["runs"]) == 3
    assert all(run["ruleId"] == rule_ids[0] for run in body["runs"])
    # Pagination with filter
    r = c.get("/automation/runs", params={"ruleId": rule_ids[1], "offset": "0", "limit": "2"})
    body = r.json()
    assert body["total"] == 3
    assert len(body["runs"]) == 2


def test_b4_automation_runs_index_corrupt_index_recovery(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=1, n_runs=2)
    # Corrupt the index file
    from pathlib import Path
    index_file = Path(svc[1]) / "automation" / "runs-index.json"
    index_file.write_text("not valid json")
    # Request should auto-rebuild
    r = c.get("/automation/runs")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert len(body["runs"]) == 2


def test_b4_automation_runs_index_persisted_run_reload(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=1, n_runs=2)
    # New client = new process state, same AURA_HOME
    from starlette.testclient import TestClient
    from aura.api.server import create_app
    fresh = TestClient(create_app())
    r = fresh.get("/automation/runs")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert len(body["runs"]) == 2


def test_b4_automation_runs_index_response_shape(svc):
    c, rule_ids = _make_rules_and_runs(svc, n_rules=1, n_runs=1)
    r = c.get("/automation/runs", params={"limit": "1"})
    body = r.json()
    run = body["runs"][0]
    expected_keys = {"id", "ruleId", "ruleName", "trigger", "status",
                     "projectId", "actionCount", "startedAt", "finishedAt",
                     "ms", "produced"}
    assert set(run.keys()) == expected_keys
    assert run["id"].startswith("run-")
    assert run["ruleId"] in rule_ids
    assert run["status"] in ("completed", "running", "failed")
    assert isinstance(run["actionCount"], int)
    assert isinstance(run["ms"], int)
    assert isinstance(run["produced"], list)
    # error field only present when there's an actual error
    if "error" in run:
        assert run["error"] is None or isinstance(run["error"], str)
