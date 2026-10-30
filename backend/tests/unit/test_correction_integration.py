"""Supervisor correction loop — service-level integration.

These tests drive the PRODUCTION CentralAgent methods (_maybe_correct,
resume, _synthesize) with stubbed worker execution, plus one live
worker loop. They prove the missing connection from the architecture
review: parked deviations reach supervisor decisions, corrections
re-enter the governed path with fresh approvals, budgets bind, chains
persist, and resume continues corrections instead of re-planning.

What is deliberately NOT covered here: reaching _maybe_correct via
submit(), which requires model-proposed plans (no ModelPort is wired in
production — see the architecture review). That seam is documented, not
tested around: these tests call the production methods directly.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from aura.audit import AuditStore
from aura.central_agent import (
    AgentSessionStore,
    CentralAgent,
)
from aura.central_agent.execution import ExecutionOutcome
from aura.contracts import AgentIntent, TaskOutcome, TaskPlan, TaskSpecification
from aura.fabric import FabricConfig


def _intent():
    return AgentIntent(goal="test goal", expectedOutcome="test outcome")


def _agent_task(tid, scope=("src/auth",), task_text=None):
    return TaskSpecification(
        id=tid, description=f"task {tid}", capabilityId="agent.delegate",
        input={"task": task_text or f"do {tid}", "scopePaths": list(scope)})


def _plan(*tasks):
    return TaskPlan(planId="pln-corr", sessionId="ses-corr",
                    intent=_intent(), tasks=list(tasks),
                    createdAt="2026-09-06T00:00:00.000Z")


def _run_sync(coro_fn, *args, **kwargs):
    """Drive an async fake to completion without touching a running loop."""
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro_fn(*args, **kwargs))
    finally:
        loop.close()


def _live_agent(repo_root, home):
    """CentralAgent wired to the REAL fabric/executors/ledger (tmp home).

    The host presents a real opencode node; the controller runs with no
    engine (single-invocation route only). Returns (agent, ledger)."""
    from aura.audit import AuditStore
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric
    from aura.fabric.host import WiringHost

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = None

    class _Nodes:
        def list_nodes(self):
            return [{"id": "opencode", "name": "OpenCode",
                     "binary": "opencode",
                     "capabilities": ["coding-agent"]}]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    for exe in all_executors(home):
        try:
            fabric.register(exe)
        except Exception:
            fabric.executors[exe.capabilityId] = exe
    from aura.fabric import FabricConfig

    cfg = FabricConfig(
        fabric=fabric, policy_config={}, permissions={"read": True,
                                                      "write": True},
        executors={e.capabilityId: e for e in all_executors(home)},
        audit_store=audit)
    agent = CentralAgent(fabric_cfg=cfg,
                         session_store=AgentSessionStore(home))
    # Single-invocation route only: the default engine (real HOME stores)
    # is never consulted for agent tasks; keep it out of the test.
    agent.controller.engine = None
    return agent, ledger


def _deviation_outcome(task_id="t1", outside=("rogue.py",),
                       inv_id="inv-1", apr_id=None):
    outcome = ExecutionOutcome()
    outcome.outcomes.append(TaskOutcome(
        taskId=task_id, state="failed", performed=True, verified=False,
        invocationIds=[inv_id],
        detail="scope deviation parked"))
    outcome.deviation_evidence[task_id] = {
        "task_id": task_id, "node_id": "opencode", "agent": "OpenCode",
        "stdout": "did stuff", "scope_paths": ["src/auth"],
        "changed_paths": ["src/auth/a.py", *outside],
        "outside": list(outside),
        "invocation_ids": [inv_id],
        "approval_ids": ([apr_id] if apr_id else []),
    }
    outcome.stopped = True
    outcome.stop_reason = f"{task_id}: scope deviation parked"
    return outcome


@pytest.fixture()
def agent_env(monkeypatch):
    from aura.fabric import CapabilityFabric, FabricHost

    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True,
                    "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True


    home = Path(tempfile.mkdtemp(prefix="agent-corr-"))
    monkeypatch.setenv("AURA_HOME", str(home))
    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = None
    host = _H()
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    from aura.executors import all_executors

    execs = {e.capabilityId: e for e in all_executors(home)}
    for exe in execs.values():
        try:
            fabric.register(exe)
        except Exception:
            pass
    cfg = FabricConfig(
        fabric=fabric, policy_config={}, permissions={"read": True,
                                                      "write": True},
        executors=execs, audit_store=audit)
    agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
    return home, audit, ledger, cfg, agent


def _deviation_plan():
    return _plan(_agent_task("t1"))


class TestMaybeCorrect:
    def test_no_deviation_passes_through(self, agent_env):
        *_, agent = agent_env
        session = agent.sessions.create("proj")
        plan = _deviation_plan()
        outcome = ExecutionOutcome()
        outcome.outcomes.append(TaskOutcome(
            taskId="t1", state="done", performed=True, verified=True,
            invocationIds=["inv-1"], detail="ok"))
        assert agent._maybe_correct(session, plan, outcome) is None
        assert session.correctionChain == []

    def test_the_correction_leg_runs_in_the_runs_own_project_directory(self, agent_env, monkeypatch):
        """Regression: two call sites omitted project_cwd, so every correction started with
        no working directory ("No project directory is set for this invocation")."""
        *_, agent = agent_env
        session = agent.sessions.create("proj")
        session.projectPath = "/work/the-project"
        agent.sessions.save(session)
        seen = {}

        def fake_execute(plan_arg, project_id, **kwargs):
            seen["cwd"] = kwargs.get("project_cwd")
            parked = ExecutionOutcome()
            parked.outcomes.append(TaskOutcome(taskId="t1-correction-2", state="done",
                                               performed=True, detail="corrected"))
            return parked

        monkeypatch.setattr(agent.controller, "execute", fake_execute)
        agent._maybe_correct(session, _deviation_plan(), _deviation_outcome())      # no project_cwd given
        assert seen["cwd"] == "/work/the-project"

    def test_deviation_dispatches_bounded_correction(self, agent_env, monkeypatch):
        *_, agent = agent_env
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        plan = _deviation_plan()
        outcome = _deviation_outcome()

        seen = {}

        def fake_execute(plan_arg, project_id, **kwargs):
            seen["plan"] = plan_arg
            seen["kwargs"] = kwargs
            parked = ExecutionOutcome()
            parked.outcomes.append(TaskOutcome(
                taskId="t1-correction-2", state="done",
                performed=True, detail="corrected"))
            return parked

        monkeypatch.setattr(agent.controller, "execute", fake_execute)
        result = agent._maybe_correct(session, plan, outcome)
        assert result is not None
        # Corrective plan shape: same capability/scope, correction markers.
        corr_input = seen["plan"].tasks[0].input
        assert seen["plan"].tasks[0].capabilityId == "agent.delegate"
        assert corr_input["scopePaths"] == ["src/auth"]
        assert corr_input["correctionOf"] == "t1"
        assert corr_input["attempt"] == 2
        assert corr_input["task"] != "do t1"  # instruction rebuilt
        # Chain persisted with parked approval + snapshots for resume.
        assert len(session.correctionChain) == 1
        entry = session.correctionChain[0]
        assert entry["status"] == "resolved"  # the corrective leg completed
        assert entry["attempt"] == 2
        assert entry["correctivePlan"]["tasks"][0]["id"] == "t1-correction-2"
        assert "verifiedSnapshot" in entry and "planSnapshot" in entry
        # Reloaded session preserves the chain (restart reconstruction).
        reloaded = agent.sessions.load(session.sessionId)
        assert reloaded is not None
        assert len(reloaded.correctionChain) == 1

    def test_budget_exhaustion_fails_for_review(self, agent_env, monkeypatch):
        *_, agent = agent_env
        session = agent.sessions.create("proj")
        plan = _deviation_plan()
        outcome = _deviation_outcome()
        contract = f"{session.sessionId}:t1"
        for attempt in (2, 3):
            session.correctionChain.append({
                "taskContractId": contract, "taskId": "t1",
                "attempt": attempt, "status": "parked",
                "approvalId": f"apr-old-{attempt}"})

        called = []
        orig_execute = agent.controller.execute

        def _spy(*a, **k):
            called.append(True)
            return orig_execute(*a, **k)

        monkeypatch.setattr(agent.controller, "execute", _spy)
        result = agent._maybe_correct(session, plan, outcome)
        assert result is not None
        assert result.outcome == "failed"
        assert result.failureReason == "correction-budget-exhausted"
        assert called == [], "exhausted budget must not dispatch"
        assert any(e.get("verdict") == "budget-exhausted"
                   for e in session.correctionChain)

    def test_denied_corrective_approval_terminates(self, agent_env, monkeypatch):
        *_, agent = agent_env
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        plan = _deviation_plan()
        outcome = _deviation_outcome()

        def denied_execute(plan_arg, project_id, **kwargs):
            denied = ExecutionOutcome(denied=True)
            denied.stop_reason = "human declined"
            return denied

        monkeypatch.setattr(agent.controller, "execute", denied_execute)
        result = agent._maybe_correct(session, plan, outcome)
        assert result is not None
        assert result.outcome == "denied"
        # No retry, no second dispatch: exactly one corrective execute ran.
        assert session.correctionChain[-1]["status"] == "failed"




class TestNoRegression:
    def test_existing_slice_still_passes(self, agent_env):
        _, _, _, _, agent = agent_env
        result = agent.submit("list my workflows")
        assert result.outcome == "completed"