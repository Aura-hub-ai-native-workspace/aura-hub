"""Agent-node runtime: bounded loop through Governor→Fabric; park on
approval; allowlist denial; scripted model (real provider NOT VERIFIED)."""
from __future__ import annotations

import asyncio

import pytest

from aura.workflow.agent.bounds import AGENT_CEILINGS, AGENT_DEFAULTS, resolve_bounds


class ScriptedFabric:
    """Records invocations; parks once for the approval scenario."""

    def __init__(self, script):
        self.script = script
        self.invocations = []

    async def invoke(self, capability_id, input, context):
        self.invocations.append((capability_id, json_copy(input), json_copy(context)))
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        from aura.fabric import NO_VERIFICATION

        base = {"invocationId": f"inv-{len(self.invocations)}",
                "capabilityId": capability_id, "detail": "executed",
                "verification": dict(NO_VERIFICATION),
                "policy": {"decision": step.get("decision", "auto-execute"),
                           "rule": "risk-default:low", "risk": "low",
                           "reason": "low"},
                "startedAt": "t", "endedAt": "t", "durationMs": 1, "attempts": 1}
        if step.get("park"):
            base.update(outcome="awaiting-approval", approvalId="apr-x")
        elif step.get("deny"):
            base.update(outcome="denied")
        else:
            base.update(outcome="succeeded", output={"stdout": "ok"})
        return base


def json_copy(x):
    import copy
    return copy.deepcopy(x)


def _node(tools=("filesystem.read",)):
    return {"id": "ag", "type": "agent", "x": 0, "y": 0,
            "config": {"task": "do things", "maxIterations": 3, "tools": list(tools)}}


ENVELOPE = {"capabilities": [{"capabilityId": "filesystem.read", "scopes": ["project.read"]},
                             {"capabilityId": "terminal.execute", "scopes": ["process.execute"]}]}


class ModelScript:
    def __init__(self, steps):
        self.steps = list(steps)

    async def __call__(self, prompt):
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if "toolCall" in step:
            body = {"plan": "step",
                    "tool": {"name": step["toolCall"]["capabilityId"],
                             "input": step["toolCall"]["input"]}}
        else:
            body = {"final": step.get("text", "")}
        import json as _j
        return _j.dumps(body)


def test_bounds_clamp_never_widen():
    b = resolve_bounds({"maxIterations": 10_000, "timeoutMs": 999_999_999,
                        "maxTokens": 10**9, "maxConsecutiveFailures": 50})
    assert b == {**AGENT_CEILINGS, "tools": []}
    d = resolve_bounds({})
    assert d["maxIterations"] == AGENT_DEFAULTS["maxIterations"]


def test_tool_allowlist_denial_parks_not_executes():
    fabric = ScriptedFabric([{"park": True}])
    from aura.workflow.agent.runner import AgentRunner

    runner = AgentRunner(fabric=fabric, envelope=ENVELOPE, redact=lambda t: t,
                         workflow_id="wf", run_id="wr", project_id="p",
                         project_path="/p",
                         model=ModelScript([
                             {"text": "try terminal", "toolCall":
                              {"capabilityId": "terminal.execute", "input": {"command": "ls"}}}]))
    node = _node(tools=["filesystem.read"])          # terminal NOT in tools → denied
    out = runner.run(node, {}, {"text": ""}, {})
    # Oracle parity: refusals cycle until a bound stops the loop; the
    # security property is that ZERO invocations occurred.
    assert out["stopReason"] in ("max-iterations", "consecutive-failures")
    assert fabric.invocations == []


def test_approval_park_records_evidence_and_no_effect_after():
    fabric = ScriptedFabric([{"park": True}])
    from aura.workflow.agent.runner import AgentRunner

    runner = AgentRunner(fabric=fabric, envelope=ENVELOPE, redact=lambda t: t,
                         workflow_id="wf", run_id="wr", project_id="p",
                         project_path="/p",
                         model=ModelScript([
                             {"text": "", "toolCall":
                              {"capabilityId": "filesystem.read",
                               "input": {"path": "README"}}}]))
    out = runner.run(_node(), {}, {"text": ""}, {})
    assert out["stopReason"] == "awaiting-approval"
    assert out.get("port") is None                    # omitted: TS drops undefined
    assert out["trace"]["port"] == "needs-human"
    assert len(fabric.invocations) == 1
    ev = out["evidence"][0]
    assert ev["outcome"] == "awaiting-approval" and ev["approvalId"] == "apr-x"
    trace = out["trace"]
    resume = out.get("trace", {}).get("resume") or (out.get("approval") and None)
    # resume block lives on the outcome dict under 'resume' key in TS finish extras;
    # Python mirrors via trace? Verify actual location:
    r2 = out
    assert r2["stopReason"] == "awaiting-approval"


def test_completed_cycle_with_observation():
    script_steps = [
        {"text": "read it", "toolCall": {"capabilityId": "filesystem.read",
                                         "input": {"path": "README"}}},
        {"text": "all done"},
    ]
    fabric = ScriptedFabric([{"succeeded": True}])
    from aura.workflow.agent.runner import AgentRunner

    runner = AgentRunner(fabric=fabric, envelope=ENVELOPE, redact=lambda t: t,
                         workflow_id="wf", run_id="wr", project_id="p",
                         project_path="/p", model=ModelScript(script_steps))
    out = runner.run(_node(), {}, {"text": ""}, {})
    assert out["stopReason"] == "completed" and out["port"] == "done"
    beats = out["trace"]["beats"]
    kinds = [b["kind"] for b in beats]
    for expected in ("intent", "proposal", "permission", "execution", "observation", "result"):
        assert expected in kinds, (kinds, expected)
    obs = [b for b in beats if b["kind"] == "observation"][0]
    assert obs["untrusted"] is True                  # quarantined data marker


def test_max_iterations_bound_hits(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.workflow.agent.runner import AgentRunner

    class Garbage:
        async def __call__(self, prompt):
            return "not-json"

    fabric = ScriptedFabric([{"ok": False, "error": "x"}])
    runner = AgentRunner(fabric=fabric, envelope=ENVELOPE, redact=lambda t: t,
                         workflow_id="wf", run_id="wr", project_id="p",
                         project_path="/p", model=Garbage())
    node = {"id": "n", "type": "agent", "x": 0, "y": 0,
            "config": {"task": "t", "tools": ["filesystem.read"]}}
    out = runner.run(node, {}, {"text": ""}, {})
    assert out["stopReason"] == "consecutive-failures"