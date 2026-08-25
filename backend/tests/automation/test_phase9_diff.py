"""PHASE 9 gates: agent-loop + scheduler-fire TS↔Python differentials.

REAL bundled TS oracles; deterministic clock/PRNG/model; compares traces,
stop reasons, beats, effective bounds, fired events, persisted state.
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import json as _j

import pytest

START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)
DRIVER = Path(__file__).resolve().parents[1] / "differential" / "ts_driver.mjs"
assert DRIVER.exists(), DRIVER
ENV = {"TSREF_AGENTRUNNER": "/tmp/opencode/tsref/agentrunner.mjs",
       "TSREF_SCHED": "/tmp/opencode/tsref/sched.mjs",
       "TSREF_AUTOSTORE": "/tmp/opencode/tsref/autostore.mjs",
       "PATH": "/usr/bin:/bin:/usr/local/bin"}


def _run_driver(func, payload):
    proc = subprocess.run(["node", str(DRIVER)],
                          input=json.dumps({"func": func, **payload}),
                          capture_output=True, text=True,
                          env={**ENV, "AURA_TRACE_EVAL": ""}, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"{func} rc={proc.returncode}: {proc.stderr[-900:]}")
    return json.loads(proc.stdout)


AGENT_NODE = {"id": "ag", "type": "agent", "x": 0, "y": 0,
              "config": {"task": "do it", "maxIterations": 3,
                         "tools": ["filesystem.read"]}}
ENVELOPE = {"capabilities": [{"capabilityId": "filesystem.read",
                              "permissions": ["project.read"]}],
            "scopes": []}

# scripted model: step dicts consumed per cycle; last repeats
MODEL_DONE = [{"text": "reading", "tokens": 10,
               "toolCall": {"capabilityId": "filesystem.read", "input": {"path": "README"}}},
              {"text": "finished", "final": True, "tokens": 5}]
MODEL_PARK = [{"text": "", "toolCall":
               {"capabilityId": "filesystem.read", "input": {"path": "README"}}}]
MODEL_DENY = [{"text": "try fs", "toolCall":
               {"capabilityId": "filesystem.read", "input": {"path": "README"}}}]


@pytest.fixture(scope="module")
def agent_ran(tmp_path_factory):
    scenarios = [
        ("completed-cycle", MODEL_DONE, []),
        ("approval-park", MODEL_PARK, [{"park": True}]),
        ("denied-capability", MODEL_DENY, [{"deny": True}]),
    ]
    outs = []
    for name, model, fabric_script in scenarios:
        h_ts = tmp_path_factory.mktemp(f"ag-ts-{name}")
        h_py = tmp_path_factory.mktemp(f"ag-py-{name}")
        fs_script = fabric_script or [{"ok": True}]
        ts = _run_driver("agentops", {
            "home": str(h_ts), "startMs": START_MS,
            "node": AGENT_NODE, "model": model,
            "fabricScript": fs_script, "envelope": ENVELOPE})
        py = _py_agentops(str(h_py), START_MS, model, fabric_script)
        outs.append((name, ts, py))
    return outs


def _py_agentops(home, start_ms, model_steps, fabric_script):
    import os

    os.environ["AURA_HOME"] = home
    from aura.persistence._common import counter_rand, iso_from_ms, stepped_clock

    clock = stepped_clock(start_ms)
    rand = counter_rand()
    from aura.workflow.agent.runner import AgentRunner
    from aura.fabric import NO_VERIFICATION

    script = [dict(s) for s in (fabric_script or [{"succeeded": True}])]

    inv_seq = [0]
    class Fabric:
        async def invoke(self, cap, inp, ctx):
            self.last = (cap, inp)
            inv_seq[0] += 1
            step = script.pop(0) if len(script) > 1 else script[0]
            base = {"invocationId": f"inv-{inv_seq[0]}", "capabilityId": cap,
                    "detail": "executed",
                    "verification": dict(NO_VERIFICATION),
                    "policy": {"decision": "auto-execute", "rule": "risk-default:low",
                               "risk": "low", "reason": "low"},
                    "startedAt": iso_from_ms(clock()), "endedAt": iso_from_ms(clock()),
                    "durationMs": 1, "attempts": 1}
            if step.get("park"):
                base.update(outcome="awaiting-approval", approvalId="apr-1")
            elif step.get("deny"):
                base.update(outcome="denied")
            else:
                base.update(outcome="succeeded", output={"stdout": "ok"})
            return base
    fab = Fabric()

    steps = [dict(s) for s in model_steps]

    class Model:
        async def __call__(self, prompt):
            step = steps.pop(0) if len(steps) > 1 else steps[0]
            if "toolCall" in step:
                body = {"plan": "step",
                        "tool": {"name": step["toolCall"]["capabilityId"],
                                 "input": step["toolCall"]["input"]}}
            else:
                body = {"final": step.get("text", "")}
            return _j.dumps(body)

    envelope_caps = [{"capabilityId": "filesystem.read"},
                     {"capabilityId": "terminal.execute"}]
    from aura.fabric import describe_capability as _dc

    def supported(cid):
        return _dc(cid)

    from aura.workflow.agent.bounds import resolve_tools

    resolved = resolve_tools(["filesystem.read"], envelope_caps, supported)

    envelope_full = {"capabilities": [
        {"capabilityId": "filesystem.read", "permissions": ["project.read"]},
        {"capabilityId": "terminal.execute", "permissions": ["process.execute"]}]}
    runner = AgentRunner(fabric=fab, envelope=envelope_full,
                         redact=lambda t: t, workflow_id="wf", run_id="wr",
                         project_id="p", project_path="/p", model=Model())
    node = {"id": "ag", "type": "agent", "x": 0, "y": 0,
            "config": {"task": "do it", "maxIterations": 3, "tools": ["filesystem.read"]}}
    out = asyncio_run(runner.run(node, {}, {"text": ""}, {}))
    return {"result": out}


def asyncio_run(c):
    import inspect

    if inspect.iscoroutine(c):
        import asyncio

        return asyncio.run(c)
    return c


def test_agent_loop_parity(agent_ran):
    problems = []
    for name, ts, py in agent_ran:
        t, p = ts["result"], py["result"]
        for key in ("stopReason", "port", "iterations"):
            tv = t.get(key)
            pv = p.get(key)
            if key == "iterations":
                tv = t.get("trace", {}).get("iterations", tv)
                pv = p.get("trace", {}).get("iterations", pv)
            # None == absent (TS drops undefined via JSON.stringify)
            if tv != pv and not (tv is None and pv is None):
                problems.append(f"{name}.{key}: TS={tv} PY={pv}")
        tb = [(b["kind"], b.get("capabilityId")) for b in (t.get("trace") or t).get("beats", [])]
        pb = [(b["kind"], b.get("capabilityId")) for b in p["trace"]["beats"]]
        if tb != pb:
            problems.append(f"{name}.beats:\n TS={tb}\n PY={pb}")
        te = [(e["capabilityId"], e["outcome"]) for e in (t.get("trace") or t).get("evidence", [])]
        pe = [(e["capabilityId"], e["outcome"]) for e in p["trace"]["evidence"]]
        if te != pe:
            problems.append(f"{name}.evidence: TS={te} PY={pe}")
        eb_t = (t.get("trace") or t).get("effectiveBounds", {})
        eb_p = p["trace"]["effectiveBounds"]
        for k in ("maxIterations", "timeoutMs", "maxTokens", "maxConsecutiveFailures"):
            if eb_t.get(k) != eb_p.get(k):
                problems.append(f"{name}.bounds.{k}: TS={eb_t.get(k)} PY={eb_p.get(k)}")
    assert not problems, "\n\n".join(problems)
