"""THE Phase 3 differential gate.

Identical persistence op-scripts run through the REAL TypeScript stores
(esbuild bundles) and the Python ports, on isolated AURA_HOMEs, with shared
deterministic clock/PRNG sequences. Compared on:

  1. every returned value (ids, summaries, lists),
  2. the ENTIRE AURA_HOME tree afterwards — file by file, byte for byte,
  3. recovery paths: corrupt index → silent rebuild; deleted index → rebuild;
     interrupted runs → reconcileInterrupted with exact strings.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from _tsrun import run_store_ops

from conftest import tsref  # noqa: F401  (session fixture)

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stores._pyops import run_py_store_ops  # noqa: E402

START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)

DEMO_WF = {
    "name": "  Demo  ", "description": "d", "category": "Eng",
    "nodes": [
        {"id": "a", "type": "agent", "x": 10, "y": -4,
         "config": {"task": "T", "maxIterations": 5}},
        {"id": "b", "type": "output", "config": {}},
        {"id": "c", "type": "condition"},
    ],
    "edges": [
        {"from": "a", "to": "b"},
        {"id": "e9", "from": "a", "fromPort": "true", "to": "c"},
    ],
}

JUNK_WF = {
    "name": "   ", "description": None, "category": "", "favorite": "yes",
    "webhookToken": "",
    "nodes": [
        {"id": "a", "type": "agent", "x": "12", "y": None, "config": {"k": "v"}},
        {"junk": True},
        {"id": "zz", "type": "agent"},                       # kept; x/y → 0
    ],
    "edges": [
        {"from": "a", "to": "nowhere"},                       # dropped
        {"from": "ghost", "to": "a"},                         # dropped
        {"from": "a", "to": "zz", "fromPort": 7},             # port coerced 'out'
    ],
}


def script() -> list[dict]:
    ops = [
        {"op": "wf.create", "args": [DEMO_WF]},                    # r0
        {"op": "wf.create", "args": [JUNK_WF]},                    # r1 sanitize torture
        {"op": "wf.list", "args": []},                             # r2
        {"op": "wf.save", "args": ["$r0.id", {"name": "Renamed", "favorite": True}]},   # r3
        {"op": "wf.patch", "args": ["$r0.id", {"category": "Ops"}]},                     # r4
        {"op": "wf.duplicate", "args": ["$r0.id"]},                                      # r5
        {"op": "wf.import", "args": [{"name": "", "description": "x"}]},        # r6
        {"op": "wf.get", "args": ["$r0.id"]},                                            # r7
        # versions — publish, reuse-when-hash-equal, restore-forward
        {"op": "ver.publish", "args": ["$r7", "user"]},                                  # r8
        {"op": "ver.ensureVersionForRun", "args": ["$r7", "run:<auto>"]},             # r9 reuse latest
        {"op": "obj.merge", "args": ["$r7", {"nodes.a.config": {"task": "T2"}}]},
        {"op": "ver.ensureVersionForRun", "args": ["$r7", "run:<auto>"]},             # r11 new version
        {"op": "ver.restore", "args": ["$r7", "$r8.id", "user"]},                        # r12
        {"op": "ver.list", "args": ["$r7.id"]},                                          # r13
        # runs — create, mutate-in-place via obj.merge, checkpoint bytes
        {"op": "runs.create", "args": [{
            "workflowId": "$r7.id", "versionId": "$r9.id", "workflowName": "$r7.name",
            "projectId": "p1", "projectPath": "/projects/p1",
            "trigger": {"kind": "manual", "by": "user"}, "inputs": {"q": "hi"},
        }]},                                                                             # r14 leg1
        {"op": "helpers.emptyNodeRecord", "args": ["n-ag", "agent"]},                    # r15
        {"op": "obj.merge", "args": ["$r14", {"nodes": {"n-ag": "$r15"}}]},
        {"op": "helpers.transitionNode", "args": ["$r15", "running"]},
        {"op": "helpers.transitionNode", "args": ["$r14.nodes.n-ag", "awaiting-approval", "policy gate"]},
        {"op": "runs.save", "args": ["$r14"]},                                           # r? null
        {"op": "helpers.appendLog", "args": ["$r14", None, "info", "hello"]},
        {"op": "helpers.appendLog", "args": ["$r14", "n-ag", "warn", "careful"]},
        {"op": "runs.save", "args": ["$r14"]},
        {"op": "helpers.attachEvidence", "args": ["$r14", "n-ag", {
            "invocationId": "invX", "capabilityId": "filesystem.write",
            "outcome": "succeeded", "decision": "auto-execute", "decisionRule": "risk-default:low",
            "risk": "low", "verified": True, "at": "2026-08-24T10:05:00.000Z", "durationMs": 3,
        }]},
        {"op": "obj.merge", "args": ["$r14.nodes.n-ag", {"state": "succeeded"}]},
        {"op": "helpers.transitionNode", "args": ["$r14.nodes.n-ag", "succeeded"]},
        {"op": "runs.checkpoint", "args": ["$r14"]},
        {"op": "runs.get", "args": ["$r14.workflowId", "$r14.id"]},                      # full byte-shaped record
        # resume chain: leg2 supersedes leg1
        {"op": "runs.create", "args": [{
            "workflowId": "$r14.workflowId", "versionId": "$r9.id", "workflowName": "$r7.name",
            "projectId": "p1", "projectPath": "/projects/p1",
            "trigger": {"kind": "resume", "of": "$r14.id"},
        }]},                                                                             # r-leg2
        {"op": "runs.markSuperseded", "args": ["$r14.workflowId", "$r14.id", "$r28.id"]},
        {"op": "runs.resumeChain", "args": ["$r14.workflowId", "$r14.id"]},
        {"op": "runs.listAwaitingApproval", "args": []},
        {"op": "runs.stats", "args": []},
        {"op": "runs.index", "args": [{"limit": 2, "offset": 0, "q": "demo"}]},
        {"op": "runs.index", "args": [{"state": "failed", "workflowId": "$r14.workflowId"}]},
        # orphan run left queued → recovery
        {"op": "runs.create", "args": [{
            "workflowId": "$r14.workflowId", "versionId": "$r9.id", "workflowName": "$r7.name",
            "projectId": "p1", "projectPath": "/projects/p1",
            "trigger": {"kind": "manual", "by": "user"},
        }]},
        {"op": "runs.reconcileInterrupted", "args": []},
        {"op": "helpers.summarizeRun", "args": ["$r14"]},
        {"op": "helpers.runStateFor", "args": ["denied"]},
        # automation — rules torture + runs + index
        {"op": "auto.createRule", "args": [{
            "name": "Rule A", "enabled": False,
            "trigger": {"type": "schedule", "cron": " 0 9 * * 1-5 ", "projectId": "p1"},
            "conditions": [{"field": "f", "op": "equals", "value": 1}, {"junk": True}],
            "chain": [{"id": "a1", "action": "run-workflow", "label": "L",
                       "config": {"workflowId": "$r0.id"}, "continueOnError": True},
                      {"bad": "entry"}],
            "retry": {"maxAttempts": 0, "delayMs": -5, "backoffFactor": "x"},
        }]},                                                                              # rA
        {"op": "auto.saveRule", "args": ["$rA.id", {"enabled": True, "category": "Ops"}]},
        {"op": "auto.createRule", "args": [{}]},
        {"op": "auto.listRules", "args": []},
        {"op": "auto.createRun", "args": ["$r39", {
            "type": "schedule", "projectId": "p1", "projectPath": "/projects/p1",
            "at": "2026-08-24T09:00:00.000Z", "payload": {"cron": "0 9 * * 1-5"},
        }]},
        {"op": "obj.merge", "args": ["$r43", {
            "status": "completed", "finishedAt": "2026-08-24T09:01:00.000Z", "ms": 60000,
            "produced": [{"kind": "workflow-run", "workflowId": "$r0.id"}],
        }]},
        {"op": "auto.saveRun", "args": ["$r43"]},
        {"op": "auto.indexRuns", "args": [{"status": "completed", "limit": 10}]},
        {"op": "auto.runStats", "args": []},
        {"op": "auto.rebuildRunIndex", "args": []},
        {"op": "auto.indexRuns", "args": [{"q": "rule a", "workflowId": "$r0.id"}]},
        # ── recovery: corrupt index → list() silently rebuilds ──
        {"op": "fs.write", "path": "workflow-runs/index.json", "data": "{corrupt!!"},
        {"op": "runs.list", "args": []},
        {"op": "fs.rm", "path": "automation/runs-index.json"},
        {"op": "auto.indexRuns", "args": [{"limit": 500}]},
        {"op": "runs.removeAll", "args": ["$r14.workflowId"]},
        {"op": "wf.remove", "args": ["$r1.id"]},
        {"op": "wf.list", "args": []},
    ]
    return ops



@pytest.fixture(scope="module")
def diff_run(tsref, tmp_path_factory):  # noqa: F811
    ops = script()

    ts_home = str(tmp_path_factory.mktemp("ts-home"))
    py_home = str(tmp_path_factory.mktemp("py-home"))

    ts_out = run_store_ops(tsref, ops, ts_home, START_MS)
    py_out = run_py_store_ops(py_home, START_MS, ops)
    ts_out["home"], py_out["home"] = ts_home, py_home
    return ts_out, py_out


def test_returned_values_identical(diff_run):
    ts_out, py_out = diff_run
    assert len(ts_out["results"]) == len(py_out["results"]), "result count diverged"
    for i, (t, p) in enumerate(zip(ts_out["results"], py_out["results"])):
        assert t == p, f"op #{i} returned values differ:\nTS : {t!r}\nPY : {p!r}"


def test_aura_home_trees_byte_identical(diff_run):
    ts_out, py_out = diff_run
    only_ts = set(ts_out["tree"]) - set(py_out["tree"])
    only_py = set(py_out["tree"]) - set(ts_out["tree"])
    assert not only_ts and not only_py, f"file sets differ: TS-only={only_ts} PY-only={only_py}"
    mismatches = [rel for rel in sorted(ts_out["tree"]) if ts_out["tree"][rel] != py_out["tree"][rel]]
    assert not mismatches, f"byte differences in: {mismatches}"
