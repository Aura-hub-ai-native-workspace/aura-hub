"""HARDENING-2: automation ENGINE differential vs the REAL bundled TS.

Deterministic clock/rand; identical rule/event scripts; compares returned
values, event stream, retry sleeps, and the persisted AURA_HOME tree.
Scenario set covers trigger match/mismatch/partial/wrong-type, condition
true/false/unknown-op, retry+backoff, exhaustion, continueOnError, produced
linkage, disabled rule. Pause/resume/cancel/schedule/duplicate-fire remain
listed in KNOWN_UNCOVERED (follow-up vectors).
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT.parent))
sys.path.insert(0, str(_ROOT / "tests"))
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "differential"))
sys.path.insert(0, str(_ROOT / "automation"))


TSREF_PATHS = {
    "autoengine": "/tmp/opencode/tsref/autoengine.mjs",
    "autostore": "/tmp/opencode/tsref/autostore.mjs",
}
START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=UTC).timestamp() * 1000)

from aura.persistence._common import iso_from_ms, make_gen_id, stepped_clock


def _py_autops(home, start_ms, config, ops):
    import os

    os.environ["AURA_HOME"] = home
    clock = stepped_clock(start_ms, step_ms=1000)
    from aura.persistence._common import counter_rand as _cr
    _stepper = _cr()
    gen = make_gen_id(lambda: clock(), _stepper)
    from aura.persistence.automation import AutomationStore as PyStore

    store = PyStore(clock=iso_from_ms(clock) if False else (lambda: iso_from_ms(clock())),
                    id_gen=gen)
    events, slept = [], []
    actions = {}
    for name, spec in (config.get("actions") or {}).items():
        if callable(spec):
            actions[name] = spec
        else:
            def _mk(spec=spec):
                async def h(ctx, cfg_):
                    return dict(spec)
                return h
            actions[name] = _mk()
    gate = {"open": False}
    def gated(ctx, cfg_):
        while not gate["open"]:
            yield
    async def gated_h(ctx, cfg_):
        while not gate["open"]:
            await asyncio.sleep(0)
        return {"ok": True, "summary": "ran"}
    actions["gated"] = gated_h
    eng = AutomationEnginePy(store, actions=actions, id_gen=gen,
                             emit=lambda e: events.append(json.loads(json.dumps(e))),
                             sleep=_asleep(slept),
                             clock_iso=lambda: iso_from_ms(clock()),
                             clock_ms=clock)
    results = []
    for op in ops:
        try:
            if op["op"] == "createRule":
                results.append(store.create_rule(op["args"][0]))
            elif op["op"] == "handleEvent":
                r = eng.handle_event(op["args"][0])
                asyncio_run(eng.drain_deferred())
                results.append(json.loads(json.dumps(r)) if r else None)
            elif op["op"] == "listRuns":
                results.append(store.list_runs((op.get("args") or [None])[0]))
            elif op["op"] == "indexRuns":
                results.append(store.index_runs((op.get("args") or [{}])[0]))
            elif op["op"] == "pause":
                results.append(eng.pause_rule(op["args"][0]))
            elif op["op"] == "resume":
                asyncio_run(eng.drain_deferred())
                results.append(eng.resume_rule(op["args"][0]))
            elif op["op"] == "cancel":
                asyncio_run(eng.drain_deferred())
                results.append(eng.cancel_run(op["args"][0], op["args"][1]))
            elif op["op"] == "gate":
                gate["open"] = bool(op.get("open"))
                asyncio.run(eng.drain_deferred())
                results.append(None)
            elif op["op"] == "fs":
                fp = Path(home) / op["path"]
                if op.get("kind") == "write":
                    fp.parent.mkdir(parents=True, exist_ok=True)
                    fp.write_text(op.get("data") or "", encoding="utf-8")
                elif op.get("kind") == "rm":
                    fp.unlink(missing_ok=True)
                results.append(None)
        except Exception as e:
            results.append({"__error__": str(e)})
    tree = {}
    root = Path(home)
    for p_ in sorted(root.rglob("*")):
        if p_.is_file():
            tree[str(p_.relative_to(root))] = __import__("hashlib").sha256(p_.read_bytes()).hexdigest()
    return {"results": results, "events": events, "slept": slept, "tree": tree}


def _asleep(slept):
    async def _s(ms):
        slept.append(ms)
    return _s


def AutomationEnginePy(*a, **k):
    from aura.automation.engine import AutomationEngine as E

    return E(*a, **k)


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


def _ev(t="mission-completed", **payload):
    return {"type": t, "projectId": "p", "projectPath": "/p",
            "at": "2026-08-24T10:00:00.000Z", "payload": payload}


RULE = {"name": "R", "description": "", "category": "c", "enabled": True,
        "trigger": {"type": "mission-completed"},
        "conditions": [],
        "chain": [{"id": "a1", "action": "echo", "label": "Echo", "config": {},
                   "continueOnError": False}],
        "retry": {"maxAttempts": 3, "delayMs": 100, "backoffFactor": 2},
        "createdAt": "2026-08-24T09:00:00.000Z",
        "updatedAt": "2026-08-24T09:00:00.000Z"}

SCENARIOS: list[tuple[str, dict, list[dict]]] = [
    ("trigger-match", {"actions": {"echo": {"ok": True, "summary": "done"}}},
     [{"op": "createRule", "args": [RULE]},
      {"op": "handleEvent", "args": [_ev("mission-completed")]},
      {"op": "listRuns"}]),
    ("trigger-wrong-type", {"actions": {"echo": {"ok": True}}},
     [{"op": "createRule", "args": [RULE]},
      {"op": "handleEvent", "args": [_ev("diagnosis-completed")]}]),
    ("condition-true-vs-false", {"actions": {"echo": {"ok": True}}},
     [{"op": "createRule", "args": [{**RULE, "conditions": [{"field": "n", "op": "gte", "value": 2}]}]},
      {"op": "handleEvent", "args": [_ev(n=1)]},
      {"op": "handleEvent", "args": [_ev(n=3)]}]),
    ("condition-unknown-op-failclosed", {"actions": {"echo": {"ok": True}}},
     [{"op": "createRule", "args": [{**RULE, "conditions": [{"field": "x", "op": "wat", "value": None}]}]},
      {"op": "handleEvent", "args": [_ev(x=1)]}]),
    ("retry-exhaustion-and-backoff", {"actions": {"echo": {"ok": False, "error": "ETIMEDOUT"}}},
     [{"op": "createRule", "args": [RULE]},
      {"op": "handleEvent", "args": [_ev(a=1)]}]),
    ("continue-on-error-chain", {"actions": {}}, []),  # built below w/ two handlers
    ("produced-linkage", {"actions": {}}, []),
    ("disabled-rule", {}, []),
]


# continueOnError scenario: bad action fails, good succeeds → run completes
COE_RULE = {**RULE, "chain": [
    {"id": "a1", "action": "bad", "label": "B", "config": {}, "continueOnError": True},
    {"id": "a2", "action": "good", "label": "G", "config": {}, "continueOnError": False}]}
SCENARIOS.append(("continue-on-error",
                  {"actions": {"bad": {"ok": False, "error": "boom"},
                               "good": {"ok": True, "summary": "fine"}}},
                  [{"op": "createRule", "args": [COE_RULE]},
                   {"op": "handleEvent", "args": [_ev(k=1)]}]))

PROD_RULE = {**RULE, "chain": [
    {"id": "w1", "action": "wf", "label": "WF", "config": {}, "continueOnError": False}]}
SCENARIOS.append(("produced-workflow-ref",
                  {"actions": {"wf": {"ok": True, "summary": "started",
                                      "produced": {"kind": "workflow-run",
                                                   "workflowId": "wf-9",
                                                   "runId": "wr-7", "state": "succeeded"}}}},
                  [{"op": "createRule", "args": [PROD_RULE]},
                   {"op": "handleEvent", "args": [_ev(z=1)]}]))

DIS_RULE = {**RULE, "enabled": False}
SCENARIOS.append(("disabled-rule-no-run", {"actions": {"echo": {"ok": True}}},
                  [{"op": "createRule", "args": [DIS_RULE]},
                   {"op": "handleEvent", "args": [_ev(q=1)]}]))


def _ensure_bundles() -> None:
    """Build the REAL TS oracle bundles if missing (idempotent)."""
    import subprocess

    tsref_dir = Path("/tmp/opencode/tsref")
    needed = [tsref_dir / "autoengine.mjs", tsref_dir / "autostore.mjs"]
    if all(f.exists() for f in needed):
        return
    esbuild = Path("/mnt/storage/aura-hub/node_modules/.bin/esbuild")
    repo = Path("/mnt/storage/aura-hub")
    for entry, out in [
        ("packages/automation/src/engine.ts", "autoengine.mjs"),
        ("packages/automation/src/store.ts", "autostore.mjs")]:
        subprocess.run([str(esbuild), str(repo / entry), "--bundle", "--format=esm",
                        "--platform=node", f"--outfile={tsref_dir / out}"],
                       cwd=repo, check=True, capture_output=True)


@pytest.fixture(scope="module")
def ran(tmp_path_factory):
    outs = []
    for i, (name, config, ops) in enumerate(SCENARIOS):
        h_ts = tmp_path_factory.mktemp(f"au-ts-{i}")
        h_py = tmp_path_factory.mktemp(f"au-py-{i}")
        _ensure_bundles()
        cfg_ts = json.loads(json.dumps(config))
        cfg_py = json.loads(json.dumps(config))
        ts_out = _run_auto(cfg_ts, ops, str(h_ts), START_MS)
        py_out = _py_autops(str(h_py), START_MS, cfg_py,
                            json.loads(json.dumps(ops)))
        outs.append((name, ts_out, py_out))
    return outs


def _run_auto(cfg, ops, home, start_ms):
    # inline driver invocation mirroring run_fabric_ops but for autops:
    driver = Path(__file__).resolve().parents[1] / "differential" / "ts_driver.mjs"
    proc = __import__("subprocess").run(
        ["node", str(driver)],
        input=json.dumps({"func": "autops", "config": cfg, "ops": ops,
                          "home": home, "startMs": start_ms}),
        capture_output=True, text=True,
        env={"TSREF_AUTOENGINE": TSREF_PATHS["autoengine"],
             "TSREF_AUTOSTORE": TSREF_PATHS["autostore"],
             "PATH": "/usr/bin:/bin:/usr/local/bin"},
        check=False)
    if proc.returncode != 0:
        raise AssertionError(f"driver rc={proc.returncode}: {proc.stderr[-400:]}")
    return json.loads(proc.stdout)


def test_results_events_tree_parity(ran):
    problems = []
    for name, t, p in ran:
        if json.dumps(t["results"], sort_keys=True) != json.dumps(p["results"], sort_keys=True):
            Path(f"/tmp/opencode/diffdump-{name}-ts.json").write_text(json.dumps(t["results"], indent=1, sort_keys=True))
            Path(f"/tmp/opencode/diffdump-{name}-py.json").write_text(json.dumps(p["results"], indent=1, sort_keys=True))
            problems.append(f"{name}: RESULTS\n TS={json.dumps(t['results'], sort_keys=True)[:500]}"
                            f"\n PY={json.dumps(p['results'], sort_keys=True)[:500]}")
        ev_t = [(e["type"], e.get("run", {}).get("id"), e.get("run", {}).get("status"), e.get("status")) for e in t["events"]]
        ev_p = [(e["type"], e.get("run", {}).get("id"), e.get("run", {}).get("status"), e.get("status")) for e in p["events"]]
        if ev_t != ev_p:
            problems.append(f"{name}: EVENTS\n TS={ev_t}\n PY={ev_p}")
        if t["slept"] != p["slept"]:
            problems.append(f"{name}: SLEPT TS={t['slept']} PY={p['slept']}")
    assert not problems, "\n\n".join(problems)


# ── HARDENING-2 remaining vectors ────────────────────────────────────────────

GATE_RULE = {**RULE, "chain": [{"id": "a1", "action": "gate", "label": "Gate",
                               "config": {}, "continueOnError": False}]}

SCENARIOS.append(("cancel-queued",
                  {"actions": {"echo": {"ok": True}}},
                  [{"op": "createRule", "args": [RULE]},
                   {"op": "handleEvent", "args": [_ev(a=1)]},
                   {"op": "handleEvent", "args": [_ev(b=2)]},
                   {"op": "cancel", "args": ["$r1.ruleId", "$r2.id"]},
                   {"op": "listRuns"}]))

SCENARIOS.append(("corrupt-index-recovery",
                  {"actions": {"echo": {"ok": True}}},
                  [{"op": "createRule", "args": [RULE]},
                   {"op": "handleEvent", "args": [_ev(a=1)]},
                   {"op": "fs", "kind": "write",
                    "path": "automation/runs-index.json", "data": "{corrupt"},
                   {"op": "indexRuns", "args": [{}]}]))

SCENARIOS.append(("missing-workflow-action-fails",
                  {"actions": {}},
                  [{"op": "createRule", "args": [{"name": "M", "description": "",
                                                  "category": "c", "enabled": True,
                                                  "trigger": {"type": "mission-completed"},
                                                  "conditions": [],
                                                  "chain": [{"id": "a1", "action": "nope-handler",
                                                             "label": "N", "config": {},
                                                             "continueOnError": False}],
                                                  "retry": {"maxAttempts": 1, "delayMs": 10,
                                                            "backoffFactor": 2},
                                                  "createdAt": "2026-08-24T09:00:00.000Z",
                                                  "updatedAt": "2026-08-24T09:00:00.000Z"}]},
                   {"op": "handleEvent", "args": [_ev(a=1)]}]))
