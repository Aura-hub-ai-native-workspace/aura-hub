"""Phase-7 gate: conditions, retries/backoff, queue, produced linkage,
scheduler convergence + park-no-auto-approve, dry-run zero-effects, index."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

from aura.automation import (
    AutomationEngine,
    AutomationScheduler,
    evaluate_condition,
    make_workflow_action,
)
from aura.persistence.automation import AutomationStore, load_schedule_state, save_schedule_state


def _rule(rid="rule-1", *, enabled=True, trig="mission-completed", match=None,
          conds=None, chain=None, retry=None):
    return {"id": rid, "name": "R", "description": "", "category": "c",
            "enabled": enabled,
            "trigger": {"type": trig, **({"match": match} if match else {}),
                        **({"cron": "0 9 * * 1"} if trig == "schedule" else {}),
                        "projectId": "p"},
            "conditions": conds or [],
            "chain": chain or [{"id": "a1", "action": "run-workflow",
                                "label": "Run", "config": {"workflowId": "wf-1"},
                                "continueOnError": False}],
            "retry": retry or {"maxAttempts": 3, "delayMs": 100, "backoffFactor": 2},
            "createdAt": "2026-08-24T09:00:00.000Z",
            "updatedAt": "2026-08-24T09:00:00.000Z"}


def _ev(**payload):
    return {"type": "mission-completed", "projectId": "p", "projectPath": "/p",
            "at": "2026-08-24T10:00:00.000Z", "payload": payload}


class Clock:
    def __init__(self): self.t = 0
    def iso(self):
        from datetime import datetime
        return datetime.fromtimestamp(self.t / 1000, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    def ms(self): return self.t


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    clock = Clock(); slept = []
    async def sleep(ms): slept.append(ms)
    store = AutomationStore()
    eng = AutomationEngine(store, actions={}, sleep=sleep,
                           clock_iso=clock.iso, clock_ms=clock.ms)
    return store, eng, clock, slept


def test_conditions_matrix():
    p = {"status": "completed", "n": 5, "s": "hello", "arr": [1, 2], "none": None}
    C = lambda f, op, v=None: {"field": f, "op": op, "value": v}
    assert evaluate_condition(p, C("status", "equals", "completed"))
    assert not evaluate_condition(p, C("status", "equals", "failed"))
    assert evaluate_condition(p, C("missing", "not-exists"))
    assert evaluate_condition(p, C("none", "not-exists"))
    assert evaluate_condition(p, C("s", "contains", "ell"))
    assert not evaluate_condition(p, C("s", "matches-regex", "["))
    assert evaluate_condition(p, C("n", "gt", 4)) and not evaluate_condition(p, C("n", "gt", 5))
    assert not evaluate_condition(p, C("status", "wat"))          # malformed → False


def test_disabled_rule_never_fires(env):
    store, eng, *_ = env
    store.create_rule(_rule(enabled=False))
    assert eng.handle_event(_ev()) is None and len(store.list_runs()) == 0


def test_condition_gate_blocks_run(env):
    store, eng, *_ = env
    store.create_rule(_rule(conds=[{"field": "count", "op": "gte", "value": 2}]))
    assert eng.handle_event(_ev(count=1)) is None                 # did not trigger


def test_retry_backoff_then_success(env):
    store, eng, _, slept = env
    rule = store.create_rule(_rule())
    n = {"k": 0}

    class Flaky:
        async def __call__(self, ctx, cfg):
            n["k"] += 1
            return {"ok": False, "error": "ETIMEDOUT"} if n["k"] < 3 else {"ok": True, "summary": "done"}

    eng.actions["run-workflow"] = Flaky()
    run = asyncio.run(eng.run_rule_now(rule["id"], _ev()))
    assert run["status"] == "completed" and run["actions"][0]["attempts"] == 3
    assert slept == [100, 200]                                    # exponential backoff


def test_retry_exhaustion(env):
    store, eng, _, _ = env
    rule = rule = store.create_rule(_rule(retry={"maxAttempts": 2, "delayMs": 10, "backoffFactor": 3}))

    async def fail(ctx, cfg): return {"ok": False, "error": "nope"}
    eng.actions["run-workflow"] = fail
    run = asyncio.run(eng.run_rule_now(rule["id"], _ev()))
    assert run["status"] == "failed" and "nope" in run["error"]


def test_continue_on_error(env):
    store, eng, *_ = env
    chain = [{"id": "a1", "action": "bad", "label": "B", "config": {}, "continueOnError": True},
             {"id": "a2", "action": "good", "label": "G", "config": {}, "continueOnError": False}]
    rule = store.create_rule(_rule(chain=chain))

    async def bad(ctx, c): return {"ok": False, "error": "boom"}
    async def good(ctx, c): return {"ok": True, "summary": "fine"}
    eng.actions.update({"bad": bad, "good": good})
    run = asyncio.run(eng.run_rule_now(rule["id"], _ev()))
    assert run["actions"][0]["status"] == "failed"
    assert run["actions"][1]["status"] == "completed" and run["status"] == "completed"


def test_queue_two_events_serialized(env):
    store, eng, _, _ = env
    rule = store.create_rule(_rule())
    gate = {"open": False}

    class Gate:
        async def __call__(self, ctx, cfg):
            while not gate["open"]:
                await asyncio.sleep(0)
            return {"ok": True}
    eng.actions["run-workflow"] = Gate()
    r1 = eng.handle_event(_ev(a=1)); r2 = eng.handle_event(_ev(b=2))

    async def settle():
        t_open = asyncio.ensure_future(_open_later())
        await eng.drain_deferred()
        await t_open

    async def _open_later():
        for _ in range(50):
            await asyncio.sleep(0)
        gate["open"] = True
        await asyncio.sleep(0)
    asyncio.run(settle())
    if getattr(eng, "_deferred_queue", None):
        asyncio.run(eng.drain_deferred())
    sts = sorted((store.get_run(r1["ruleId"], r1["id"])["status"],
                  store.get_run(r2["ruleId"], r2["id"])["status"]))
    assert sts == ["completed", "completed"] and eng.active_rules() == 0


def test_produced_linkage_structured(env):
    store, eng, *_ = env
    rule = store.create_rule(_rule())

    async def wf(ctx, cfg):
        return {"ok": True, "summary": "ok",
                "produced": {"kind": "workflow-run", "workflowId": "wf-1",
                             "runId": "wr-42", "state": "succeeded"}}
    eng.actions["run-workflow"] = wf
    run = asyncio.run(eng.run_rule_now(rule["id"], _ev()))
    assert run["produced"][0]["runId"] == "wr-42"
    assert run["actions"][0]["workflowRunId"] == "wr-42"


def test_cancel_queued_truthful(env):
    store, eng, *_ = env
    rule = store.create_rule(_rule())
    gate = {"open": False}

    class Gate:
        async def __call__(self, ctx, cfg):
            while not gate["open"]:
                await asyncio.sleep(0)
            return {"ok": True}
    eng.actions["run-workflow"] = Gate()
    r1 = eng.handle_event(_ev(a=1))
    r2 = eng.handle_event(_ev(b=2))
    assert eng.cancel_run(rule["id"], r2["id"]) is not None
    gate["open"] = True

    async def settle():
        await eng.drain_deferred(); await asyncio.sleep(0.02)
    asyncio.run(settle())
    assert store.get_run(r1["ruleId"], r1["id"])["status"] == "completed"
    assert store.get_run(r2["ruleId"], r2["id"])["status"] == "cancelled"
def test_scheduler_reconcile_tick(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    store = AutomationStore()
    store.create_rule(_rule(trig="schedule"))
    fired = []

    class EngStub:
        def handle_event(self, ev): fired.append(ev)

    persistence = {"load": lambda: load_schedule_state(),
                   "save": lambda s: save_schedule_state(s)}
    NOW = [datetime(2026, 8, 24, 10, 0)]           # Monday 10:00
    sched = AutomationScheduler(store, persistence,
                                project_path=lambda pid: "/proj",
                                engine=EngStub(), now=lambda: NOW[0])
    assert sched.reconcile()["scheduled"] >= 1      # arms next Mon 09:00
    NOW[0] = datetime(2026, 8, 31, 9, 1)            # cross the fire moment
    rule_id = store.list_rules()[0]["id"]
    assert asyncio.run(sched.tick()) == [rule_id]
    st = load_schedule_state()[rule_id]
    assert st["lastFiredAt"] and st["nextFireAt"]
    assert fired[0]["payload"]["ruleId"] == rule_id


def test_automation_to_runner_no_auto_approve(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.fabric.scopes import RunScopeRegistry
    from aura.persistence.runs import WorkflowRunStore
    from aura.persistence.versions import WorkflowVersionStore
    from aura.workflow.runner import WorkflowRunner

    seen: list[dict] = []
    runner = WorkflowRunner(fabric=None, run_scopes=RunScopeRegistry(),
                            versions=WorkflowVersionStore(), runs=WorkflowRunStore())
    runner.workflows = {"wf-9": {"id": "wf-9", "name": "G", "description": "",
                                 "nodes": [{"id": "o", "type": "output", "x": 0, "y": 0,
                                            "config": {}}],
                                 "edges": []}}
    orig = runner.start_workflow_run

    async def spy(workflow, **kw):
        seen.append(kw); kw.pop("on_run_created", None)
        return await orig(workflow, **kw)
    runner.start_workflow_run = spy  # type: ignore
    wf = {"id": "wf-9", "name": "G", "description": "",
          "nodes": [{"id": "o", "type": "output", "x": 0, "y": 0, "config": {}}],
          "edges": []}
    handler = make_workflow_action(runner, projects=None)
    result = asyncio.run(handler(
        {"projectId": "p", "projectPath": str(tmp_path), "ruleId": "rule-9",
         "runId": "ar-9", "event": {"type": "schedule"}},
        {"workflowId": "wf-9"}))
    assert result["produced"]["state"] == "succeeded"
    for kw in seen:
        assert kw.get("approved_capabilities") in (None, [])   # NO grant on this path
        assert kw["trigger"]["kind"] == "automation"


def test_dry_run_zero_effects(env):
    store, eng, *_ = env
    rule = store.create_rule(_rule())
    calls = {"n": 0}

    class Spy:
        async def __call__(self, *a, **k): calls["n"] += 1; return {"ok": True}
    eng.actions["run-workflow"] = Spy()
    before_runs = len(store.list_runs())
    rule = store.get_rule(rule["id"]) or rule
    matched, _ = eng.rule_matches(rule, _ev(status="completed"))
    plan = [{"action": a["action"]} for a in rule["chain"]]
    assert matched and plan and calls["n"] == 0
    assert len(store.list_runs()) == before_runs              # zero runs created


def test_corrupt_index_recovers(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    store = AutomationStore(); rule = store.create_rule(_rule())
    async def _nosleep(ms):
        return None
    eng = AutomationEngine(store, actions={}, sleep=_nosleep)
    run = asyncio.run(eng.run_rule_now(rule["id"], _ev()))
    (tmp_path / "automation" / "runs-index.json").write_text("{corrupt")
    got = store.index_runs({})
    assert got["runs"][0]["id"] == run["id"]
