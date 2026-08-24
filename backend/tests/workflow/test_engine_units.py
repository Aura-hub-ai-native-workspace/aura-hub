"""Engine/runner units: conditions, branching, loops, cancel, scopes, versions."""
from __future__ import annotations

import asyncio

import pytest

from aura.fabric.scopes import LOCAL_GRANTS, grants_for_scopes
from aura.persistence.versions import WorkflowVersionStore
from aura.workflow.engine import run_workflow


def _wf(nodes, edges):
    return {"id": "wf-t", "name": "T", "nodes": nodes, "edges": edges}


def _node(nid, ntype, cfg=None):
    return {"id": nid, "type": ntype, "x": 0, "y": 0, "config": cfg or {}}


def test_condition_branch_selection():
    wf = _wf(
        [_node("seed", "output", {"template": "yes"}),
         _node("c", "condition", {"check": "contains", "value": "yes"}),
         _node("t", "output", {"template": "said yes"}),
         _node("f", "output", {"template": "said no"})],
        [{"id": "e0", "from": "seed", "fromPort": "out", "to": "c"},
         {"id": "e1", "from": "c", "fromPort": "true", "to": "t"},
         {"id": "e2", "from": "c", "fromPort": "false", "to": "f"}])
    events = []
    r = asyncio.run(run_workflow(
        wf, {"projectId": "p", "projectPath": ".",
             "inputs": {}, "projectName": "T"}, events.append))
    assert r["runState"] == "succeeded"
    st = {k: v["status"] for k, v in r["nodes"].items()}
    assert st["t"] == "completed" and st["f"] == "skipped"
    assert any(e["type"] == "output" and e["text"] == "said yes" for e in events)


def test_condition_malformed_check_fails_run():
    wf = _wf([_node("bad", "condition", {"check": "nope", "value": ""})], [])
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": "."}, []))
    assert r["runState"] == "failed"
    assert "unknown check: nope" in (r.get("error") or "")


def test_condition_missing_value_is_empty_string():
    wf = _wf([_node("c", "condition", {"check": "is-empty"})], [])
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": "."}, []))
    assert r["runState"] == "succeeded"


def test_cycle_terminates():
    wf = _wf([_node("out", "output", {"template": "done"}),
              _node("c1", "condition", {"check": "is-empty"}),
              _node("c2", "condition", {"check": "is-empty"})],
             [{"id": "e1", "from": "out", "fromPort": "out", "to": "c1"},
              {"id": "e2", "from": "c1", "fromPort": "true", "to": "c2"},
              {"id": "e3", "from": "c2", "fromPort": "true", "to": "c1"}])
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": "."}, []))
    assert r["ms"] >= 0  # terminates; unreachable nodes marked skipped


def test_loop_for_each_line_bounded():
    wf = _wf([_node("seed", "output", {"template": "a\nb\nc"}),
              _node("l", "loop", {"mode": "for-each-line"}),
              _node("o", "output", {"template": "{{input}}"})],
             [{"id": "e0", "from": "seed", "fromPort": "out", "to": "l"},
              {"id": "e1", "from": "l", "fromPort": "each", "to": "o"}])
    events: list[dict] = []
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": ".",
                                      "projectName": "T"}, events.append))
    assert r["runState"] == "succeeded"
    outs = [e for e in events if e["type"] == "output"]   # one per iteration
    assert [o["text"] for o in outs][-3:] == ["a", "b", "c"]


def test_governed_requires_governor():
    # TS parity: a governed node with no attached governor fails THE RUN with
    # the refusal message — there is no fallback path and no silent skip.
    wf = _wf([_node("s", "shell-command", {"command": "echo hi"})], [])
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": "."}, []))
    assert r["runState"] == "failed"
    assert "Capability Fabric" in (r.get("error") or "")


def test_cancel_truthful():
    wf = _wf([_node("d", "delay", {"ms": 10}),
              _node("o", "output", {"template": "x"})],
             [{"id": "e", "from": "d", "fromPort": "out", "to": "o"}])
    r = asyncio.run(run_workflow(wf, {"projectId": "p", "projectPath": ".",
                                      "signal": {"aborted": True}}, []))
    assert r["runState"] == "cancelled"


def test_scopes_narrow_only():
    g = grants_for_scopes(["project.read"])
    assert g == {"read": True, "write": False, "execute": False, "autonomous": False}
    assert LOCAL_GRANTS["autonomous"] is False


def test_version_reuse_and_immutability(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    vs = WorkflowVersionStore()
    wf = {"id": "wf-v", "name": "V", "description": "",
          "nodes": [_node("a", "output", {"template": "x"})], "edges": []}
    v1 = vs.publish(wf, "user")
    assert vs.ensure_version_for_run(wf, "run:user")["id"] == v1["id"]
    wf["nodes"][0]["config"]["template"] = "changed"
    v3 = vs.ensure_version_for_run(wf, "run:user")
    assert v3["id"] != v1["id"] and v3["number"] == 2
    assert vs.get(wf["id"], v1["id"])["nodes"][0]["config"]["template"] == "x"
