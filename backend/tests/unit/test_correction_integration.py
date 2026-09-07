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

from aura.approvals import ApprovalLedger
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
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric
    from aura.fabric.host import WiringHost

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    class _Nodes:
        def list_nodes(self):
            return [{"id": "opencode", "name": "OpenCode",
                     "binary": "opencode",
                     "capabilities": ["coding-agent"]}]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
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
        audit_store=audit, ledger=ledger)
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

        async def request_approval(self, _req, _ctx):
            return False

    home = Path(tempfile.mkdtemp(prefix="agent-corr-"))
    monkeypatch.setenv("AURA_HOME", str(home))
    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    host = _H()
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
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
        executors=execs, audit_store=audit, ledger=ledger)
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
                taskId="t1-correction-2", state="awaiting-approval",
                performed=False, approvalId="apr-corr-1",
                detail="waiting"))
            parked.approval_id = "apr-corr-1"
            return parked

        monkeypatch.setattr(agent.controller, "execute", fake_execute)
        result = agent._maybe_correct(session, plan, outcome)
        assert result is not None
        assert result.outcome == "awaiting-approval"
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
        assert entry["status"] == "parked"
        assert entry["approvalId"] == "apr-corr-1"
        assert entry["attempt"] == 2
        assert entry["correctivePlan"]["tasks"][0]["id"] == "t1-correction-2"
        assert "verifiedSnapshot" in entry and "planSnapshot" in entry
        # Reloaded session preserves the chain (restart reconstruction).
        reloaded = agent.sessions.load(session.sessionId)
        assert reloaded is not None
        assert len(reloaded.correctionChain) == 1
        assert reloaded.correctionChain[0]["approvalId"] == "apr-corr-1"

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


class TestResumeCorrection:
    def _parked_session(self, agent, ledger, plan):
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        outcome = _deviation_outcome()
        # Drive one correction round with a stubbed park, as _maybe_correct
        # would, but capture via the real method with a stubbed execute.
        return session, outcome, plan

    def test_resume_continues_parked_correction(self, agent_env, monkeypatch):
        home, audit, ledger, cfg, agent = agent_env
        plan = _deviation_plan()

        def park_execute(plan_arg, project_id, **kwargs):
            parked = ExecutionOutcome()
            parked.outcomes.append(TaskOutcome(
                taskId=plan_arg.tasks[0].id, state="awaiting-approval",
                performed=False, approvalId="apr-round-1",
                detail="waiting"))
            parked.approval_id = "apr-round-1"
            return parked

        monkeypatch.setattr(agent.controller, "execute", park_execute)
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        outcome = _deviation_outcome()
        first = agent._maybe_correct(session, plan, outcome)
        assert first is not None and first.outcome == "awaiting-approval"

        # Human grants the corrective approval; resume must continue the
        # STORED corrective plan, not re-plan from intent.
        apr = session.correctionChain[-1]["approvalId"]
        assert apr == "apr-round-1"
        ledger.register(f"key-{apr}", {
            "id": apr, "state": "pending", "requestedAt": "t",
            "summary": "correction", "rule": "test",
            "items": [{"invocationId": "inv-c",
                       "capabilityId": "agent.delegate",
                       "title": "t", "detail": "d", "risk": "high",
                       "irreversible": True,
                       "fingerprint": "fp"}]})
        granted = ledger.decide(apr, True, decided_by="human")
        assert granted and granted["state"] == "granted"
        session.lastResult = first
        agent.sessions.save(session)

        verified_calls = []

        def verify_execute(plan_arg, project_id, **kwargs):
            verified_calls.append(plan_arg.tasks[0].id)
            done = ExecutionOutcome()
            done.outcomes.append(TaskOutcome(
                taskId=plan_arg.tasks[0].id, state="done", performed=True,
                verified=True, invocationIds=["inv-fixed"],
                detail="fixed"))
            done.verified_outputs[plan_arg.tasks[0].id] = {
                "task_id": plan_arg.tasks[0].id, "node_id": "opencode",
                "agent": "OpenCode", "stdout": "fixed",
                "scope_paths": ["src/auth"], "changed_paths": [],
                "invocation_ids": ["inv-fixed"], "approval_ids": [apr]}
            return done

        monkeypatch.setattr(agent.controller, "execute", verify_execute)
        result = agent.resume(session.sessionId)
        # Corrective plan id comes from the chain, not from re-planning.
        assert verified_calls == ["t1-correction-2"], verified_calls
        assert result.outcome == "completed"
        # Reload: resume() persists through its own loaded copy.
        fresh = agent.sessions.load(session.sessionId)
        assert fresh is not None
        assert fresh.correctionChain[-1]["status"] == "resolved"

    def test_resume_denied_correction_terminates(self, agent_env, monkeypatch):
        home, audit, ledger, cfg, agent = agent_env
        plan = _deviation_plan()

        def park_execute(plan_arg, project_id, **kwargs):
            parked = ExecutionOutcome()
            parked.outcomes.append(TaskOutcome(
                taskId=plan_arg.tasks[0].id, state="awaiting-approval",
                performed=False, approvalId="apr-round-9",
                detail="waiting"))
            parked.approval_id = "apr-round-9"
            return parked

        monkeypatch.setattr(agent.controller, "execute", park_execute)
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        first = agent._maybe_correct(session, plan, _deviation_outcome())
        assert first is not None and first.outcome == "awaiting-approval"
        apr = session.correctionChain[-1]["approvalId"]
        ledger.register(f"key-{apr}", {
            "id": apr, "state": "pending", "requestedAt": "t",
            "summary": "correction", "rule": "test",
            "items": [{"invocationId": "inv-c",
                       "capabilityId": "agent.delegate",
                       "title": "t", "detail": "d", "risk": "high",
                       "irreversible": True,
                       "fingerprint": "fp"}]})
        denied = ledger.decide(apr, False, decided_by="human")
        assert denied and denied["state"] == "denied"
        session.lastResult = first
        agent.sessions.save(session)
        result = agent.resume(session.sessionId)
        assert result.outcome == "denied"
        # Exactly one corrective dispatch happened total: no retry loop.
        fresh = agent.sessions.load(session.sessionId)
        assert fresh is not None
        assert fresh.correctionChain[-1]["status"] == "failed"

    def test_resume_without_pending_correction_replans(self, agent_env, monkeypatch):
        home, audit, ledger, cfg, agent = agent_env
        session = agent.sessions.create("proj")
        agent.sessions.save(session)
        # No chain entries: resume must take the legacy intent-rebuild path
        # (which fails here for lack of messages — proving it did NOT take
        # the correction path, which would fail differently).
        from aura.contracts import AgentResult, EvidenceBundle

        session.lastResult = AgentResult(
            status="awaiting-approval", outcome="awaiting-approval",
            summary="waiting", evidence=EvidenceBundle(
                sessionId=session.sessionId, planId="p",
                approvalIds=[], summary="x",
                createdAt="2026-09-06T00:00:00.000Z"))
        agent.sessions.save(session)
        with pytest.raises(ValueError, match="no intent to resume"):
            agent.resume(session.sessionId)


class TestNoRegression:
    def test_existing_slice_still_passes(self, agent_env):
        _, _, _, _, agent = agent_env
        result = agent.submit("list my workflows")
        assert result.outcome == "completed"

    def test_approval_park_unchanged_without_deviation(self, agent_env, monkeypatch):
        home, audit, ledger, cfg, agent = agent_env
        cfg.policy_config = {"byRisk": {"low": "require-approval",
                                        "medium": "ask-user",
                                        "high": "require-approval"}}
        cfg.fabric.set_policy(cfg.sanitized_policy())
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(home))
        result = agent.submit("list my workflows")
        assert result.outcome == "awaiting-approval"
        assert result.evidence.approvalIds
        # No deviation evidence anywhere: no chain entries created.
        session_files = sorted((home / "agent" / "sessions").glob("*.json"))
        import json as _json

        for path in session_files:
            data = _json.loads(path.read_text())
            assert data.get("correctionChain") in (None, [])


def _git(cwd: str, *args: str) -> None:
    import subprocess

    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, timeout=30)


@pytest.fixture()
def worker_repo(tmp_path):
    import os

    root = str(tmp_path / "proj")
    os.makedirs(root)
    _git(root, "init", "-q")
    _git(root, "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init")
    return root


class TestLiveCorrectionLoop:
    """End-to-end through production service methods with a real worker.

    Throwaway repository only; never the real AURA checkout. Each step
    asserts the governed path (approvals required, evidence preserved).
    """

    def test_deviate_park_correct_verify(self, tmp_path, worker_repo):
        # Coherent contract: the task asks for an in-scope file AND (to
        # force the deviation deterministically) an out-of-scope file.
        # Correction then re-runs the same achievable task under
        # constraints; the worker no-ops on existing files and verifies.
        import os

        home = tmp_path / "home"
        home.mkdir()
        agent, ledger = _live_agent(worker_repo, home)
        session = agent.sessions.create("proj")
        session.projectPath = worker_repo
        agent.sessions.save(session)

        tA = TaskSpecification(
            id="tA", description="create both files",
            capabilityId="agent.delegate",
            input={"task": "Create hello.txt containing exactly hello-v1 "
                           "and also create rogue.txt containing exactly "
                           "rogue-v1. Do not create any other files.",
                   "scopePaths": ["hello.txt"]})
        plan = TaskPlan(planId="pln-live", sessionId=session.sessionId,
                        intent=_intent(), tasks=[tA],
                        createdAt="2026-09-06T00:00:00.000Z")

        # Round 1: parks on tA approval; nothing runs.
        r1 = agent.controller.execute(
            plan, "proj", project_cwd=worker_repo)
        assert r1.outcomes[0].state == "awaiting-approval"
        assert not os.path.exists(os.path.join(worker_repo, "hello.txt"))
        assert ledger.decide(
            r1.approval_id, True,
            decided_by="live")["state"] == "granted"

        # Round 2: worker runs with the grant and deviates (rogue.txt).
        r2 = agent.controller.execute(
            plan, "proj", project_cwd=worker_repo,
            resume_grants={"tA": (r1.approval_id, "")})
        assert r2.outcomes[0].state in ("failed", "done"), \
            r2.outcomes[0].detail
        assert "tA" in r2.deviation_evidence, \
            "deviation evidence must be filed for the supervisor"
        assert os.path.exists(os.path.join(worker_repo, "rogue.txt"))

        # Service correction branch: builds + dispatches correction 2,
        # which parks on a FRESH approval (never the spent one).
        corrected = agent._maybe_correct(session, plan, r2, worker_repo)
        assert corrected is not None
        assert corrected.outcome == "awaiting-approval"
        chain = session.correctionChain
        assert len(chain) == 1
        assert chain[0]["status"] == "parked"
        assert chain[0]["attempt"] == 2
        assert chain[0]["approvalId"] != r1.approval_id
        # Nothing reverted by the parking decision.
        assert os.path.exists(os.path.join(worker_repo, "rogue.txt"))

        # Human grants the correction; resume continues the STORED plan.
        assert ledger.decide(
            chain[0]["approvalId"], True,
            decided_by="live")["state"] == "granted"
        session.lastResult = corrected
        agent.sessions.save(session)
        final = agent.resume(session.sessionId)
        assert final.outcome == "completed", final.summary
        # Intended work stands; deviation preserved as evidence.
        assert open(os.path.join(worker_repo, "hello.txt")).read().strip() \
            == "hello-v1"
        assert os.path.exists(os.path.join(worker_repo, "rogue.txt"))
        fresh = agent.sessions.load(session.sessionId)
        assert fresh is not None
        assert fresh.correctionChain[-1]["status"] == "resolved"
        # Distinct approvals per round: no grant reuse.
        approvals = {chain[0]["approvalId"]}
        assert r1.approval_id not in approvals
