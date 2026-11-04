"""ARCHITECTURAL CONVERGENCE: manual / scheduler / automation entries all
pass through the ONE canonical WorkflowRunner.start_workflow_run."""
from __future__ import annotations

import json

import asyncio

import pytest

from aura.fabric.scopes import RunScopeRegistry
from aura.persistence.runs import WorkflowRunStore
from aura.persistence.versions import WorkflowVersionStore
from aura.workflow.runner import WorkflowRunner
from aura.workflow.scheduler_seam import fire_scheduled_workflow


class NullFabric:
    async def invoke(self, *a, **k):
        raise AssertionError("fabric must not be reached by pure-logic workflows")




class _IdentitySecrets:
    """No secrets stored: redactor is identity, resolve passes text through
    and fails closed on any {{secret:}} reference (matches TS behavior)."""
    def known_values(self):
        return []
    def redactor(self):
        return lambda t: t
    def resolve(self, text):
        if "{{secret:" in text:
            raise RuntimeError("not stored")
        return {"text": text, "used": []}


def _runner(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return WorkflowRunner(fabric=None, secrets=_IdentitySecrets(), run_scopes=RunScopeRegistry(),
                          versions=WorkflowVersionStore(), runs=WorkflowRunStore())


def _wf():
    return {"id": "wf-c", "name": "Conv", "description": "",
            "nodes": [{"id": "i", "type": "user-input", "x": 0, "y": 0,
                       "config": {"prompt": "v", "default": "ok"}},
                      {"id": "o", "type": "output", "x": 1, "y": 0, "config": {}}],
            "edges": [{"id": "e", "from": "i", "fromPort": "out", "to": "o"}]}


ENTRY_CALLS = []


@pytest.fixture(autouse=True)
def instrument(monkeypatch):
    # instrument the canonical seam itself: every entry must cross it
    orig = WorkflowRunner.start_workflow_run
    def spy(self, workflow, **kw):
        ENTRY_CALLS.append((kw.get("trigger") or {}).get("kind"))
        return orig(self, workflow, **kw)
    monkeypatch.setattr(WorkflowRunner, "start_workflow_run", spy)
    ENTRY_CALLS.clear()
    yield
    ENTRY_CALLS.clear()


def test_manual_scheduler_automation_converge(tmp_path, monkeypatch):
    r = _runner(tmp_path, monkeypatch)
    wf = _wf()
    proj = {"id": "p", "path": str(tmp_path)}

    async def drive():
        inputs = {"i": "ok"}          # user-input node id → value
        manual = await r.start_workflow_run(wf, project_id="p", project_path=proj["path"],
                                            inputs=inputs,
                                            trigger={"kind": "manual", "by": "user"})
        sched = await fire_scheduled_workflow(r, workflow=wf, project_id="p",
                                              project_path=proj["path"], inputs={"i": "ok"},
                                              rule_id="rule-1",
                                              automation_run_id="ar-1", cron="0 9 * * 1")
        auto = await r.start_workflow_run(wf, project_id="p", project_path=proj["path"],
                                          inputs={"i": "ok"},
                                          trigger={"kind": "automation", "ruleId": "rule-2",
                                                   "runId": "ar-2", "event": "file-changed"})
        return manual, sched, auto

    m, s, a = asyncio.run(drive())
    assert ENTRY_CALLS == ["manual", "automation", "automation"]
    for label, started in (("m", m), ("s", s), ("a", a)):
        assert started["result"]["runState"] == "succeeded", (label, started["result"])
        assert [o["text"] for o in started["result"]["outputs"]] == ["ok"], (label, started["result"]["outputs"])
    # run records carry structured linkage (no summary parsing)
    assert s["run"]["trigger"]["kind"] == "automation"
    assert s["run"]["trigger"]["ruleId"] == "rule-1"
    assert s["run"]["trigger"]["runId"] == "ar-1"


def test_resume_chain_semantics(tmp_path, monkeypatch):
    """A step the policy refuses ends the run as refused. It never parks, so
    there is no paused run to resume: a resume with no completed checkpoint
    is refused honestly."""
    r = _runner(tmp_path, monkeypatch)

    class RefuseFabric:
        async def invoke(self, cap, inp, ctx):
            from aura.fabric import NO_VERIFICATION
            return {"invocationId": "inv-refused", "capabilityId": cap,
                    "outcome": "denied", "detail": "refused by policy",
                    "verification": dict(NO_VERIFICATION),
                    "policy": {"decision": "deny", "rule": "risk-default:high",
                               "risk": "high", "reason": "not permitted"},
                    "startedAt": "t", "endedAt": "t", "durationMs": 1, "attempts": 1}
    r.fabric = RefuseFabric()
    wf_gov = {"id": "wf-r", "name": "R", "description": "",
              "nodes": [{"id": "s", "type": "shell-command", "x": 0, "y": 0,
                         "config": {"command": "echo hi"}}], "edges": []}

    async def drive():
        first = await r.start_workflow_run(wf_gov, project_id="p",
                                           project_path=str(tmp_path),
                                           trigger={"kind": "manual", "by": "user"})
        resumed = await r.resume(wf_gov, first["run"]["id"], lambda e: None)
        return first, resumed

    first, resumed = asyncio.run(drive())
    assert first["result"]["runState"] in ("failed", "denied"), first["result"]
    assert "awaiting" not in json.dumps(first["result"]).lower()
    assert "no checkpoint to resume from" in resumed["error"]
