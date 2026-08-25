"""Dry-run gate: read-only by MEASUREMENT, honest certainty levels,
policy pre-flight without execution, secrets names-only."""
from __future__ import annotations

import hashlib
from pathlib import Path

from aura.workflow.dryrun import analyze_graph, dry_run_workflow


class CountingFabric:
    """evaluate() allowed and counted; invoke() MUST NEVER be called."""

    def __init__(self):
        self.evaluations = 0
        self.invocations = 0

    def evaluate(self, capability_id, context):
        self.evaluations += 1

        from aura.fabric import describe_capability

        risk = describe_capability(capability_id)["risk"]
        decision = {"low": "auto-execute", "medium": "ask-user",
                    "high": "require-approval"}[risk]
        return {"decision": decision,
                "rule": f"risk-default:{risk}", "risk": risk,
                "reason": f"{capability_id} {decision}"}

    async def invoke(self, *a, **k):
        raise AssertionError("DRY RUN INVOKED A CAPABILITY — worst possible bug")


def _graph():
    return {"nodes": [
        {"id": "seed", "type": "user-input", "x": 0, "y": 0,
         "config": {"prompt": "t", "default": "yes"}},
        {"id": "c", "type": "condition", "x": 1, "y": 0,
         "config": {"check": "contains", "value": "yes"}},
        {"id": "w", "type": "shell-command", "x": 2, "y": 0,
         "config": {"command": "echo {{secret:CI_TOKEN}}"}},
        {"id": "t", "type": "http-request", "x": 3, "y": 1, "config": {"url": "https://x.test"}},
        {"id": "f", "type": "output", "x": 3, "y": -1, "config": {}},
        {"id": "out", "type": "output", "x": 4, "y": 0, "config": {}}],
        "edges": [
            {"id": "e0", "from": "seed", "fromPort": "out", "to": "c"},
            {"id": "e1", "from": "c", "fromPort": "true", "to": "w"},
            {"id": "e2", "from": "w", "fromPort": "out", "to": "t"},
            {"id": "e3", "from": "c", "fromPort": "false", "to": "f"},
            {"id": "e4", "from": "f", "fromPort": "out", "to": "out"},
            {"id": "e5", "from": "t", "fromPort": "out", "to": "out"}]}


def test_reachability_and_branch_inheritance():
    g = analyze_graph(_graph()["nodes"], _graph()["edges"])
    assert g["seed"]["reach"] == "certain"
    assert g["c"]["reach"] == "certain"
    assert g["w"]["reach"] == "conditional"       # downstream of condition port
    assert g["out"]["reach"] == "conditional"     # every path crosses the branch


def test_zero_side_effects_measured(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    proj = tmp_path / "proj"; proj.mkdir()
    before_hash = _tree_hash(proj)
    fabric = CountingFabric()
    report = dry_run_workflow({"workflowId": "wf-d", "workflowName": "D",
                               "projectId": "p", "projectPath": str(proj),
                               "projectName": "D", "fabric": fabric,
                               "secrets": None,
                               **_graph()})
    assert fabric.invocations == 0                          # measured, not asserted
    assert report["sideEffects"]["invocations"] == 0
    assert report["sideEffects"]["policyEvaluations"] == len(
        [s for s in report["plan"] if s.get("capabilityId")])
    assert _tree_hash(proj) == before_hash                  # filesystem untouched
    # approvals + denials counted from policy answers
    ids = {a["nodeId"] for a in report["approvalsRequired"]}
    assert "w" in ids                                       # shell = ask-user
    assert report["denials"] == []
    assert report["secretsRequired"] == ["CI_TOKEN"]
    assert report["grants"]["execute"] is True


def test_would_run_unattended_false_when_approval_needed():
    fabric = CountingFabric()
    r = dry_run_workflow({"workflowId": "w", "workflowName": "W", "projectId": "p",
                          "projectPath": ".", "fabric": fabric, "secrets": None,
                          **_graph()})
    assert r["wouldRunUnattended"] is False


def test_denial_reported_for_high_risk_irreversible():
    class DenyFabric(CountingFabric):
        def evaluate(self, capability_id, context):
            if capability_id == "terminal.execute":
                return {"decision": "deny", "rule": "override:test",
                        "risk": "medium", "reason": "denied for the demo"}
            return super().evaluate(capability_id, context)

    graph = {"nodes": [{"id": "p1", "type": "shell-command", "x": 0, "y": 0,
                        "config": {"command": "echo x"}}], "edges": []}
    r = dry_run_workflow({"workflowId": "w", "workflowName": "W", "projectId": "p",
                          "projectPath": ".", "fabric": DenyFabric(), "secrets": None,
                          **graph})
    assert r["denials"][0]["rule"] == "override:test"
    assert r["wouldRunUnattended"] is False


def test_malformed_graph_reports_errors_not_crashes():
    r = dry_run_workflow({"workflowId": "w", "workflowName": "M", "projectId": "p",
                          "projectPath": ".", "fabric": None, "secrets": None,
                          "nodes": [{"id": "a", "type": "nope", "x": 0, "y": 0, "config": {}},
                                    {"id": "a", "type": "output", "x": 0, "y": 0, "config": {}}],
                          "edges": [{"id": "e", "from": "ghost", "to": "a", "fromPort": "out"}]})
    levels = [f["level"] for f in r["validation"]["findings"]]
    assert "error" in levels
    assert r["wouldRunUnattended"] is False


def _tree_hash(root: Path) -> str:

    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        h.update(str(p.relative_to(root)).encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()
