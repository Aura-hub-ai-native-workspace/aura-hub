"""Phase I — persisted recovery: restart restores plan + verified work.

Verified handoff evidence and the validated plan body ride the session
file (no new store). Resume seeds prior_verified so verified tasks skip
instead of re-executing; correction chains and budgets survive reload.
"""

from __future__ import annotations

from aura.central_agent.events import EventBus
from aura.central_agent.evidence import EvidenceCollector
from aura.central_agent.execution import ExecutionController
from aura.central_agent.service import CentralAgent
from aura.central_agent.session import AgentSessionStore
from aura.central_agent.verification import VerificationEngine
from aura.contracts import (
    AgentIntent,
    AgentResult,
    EvidenceBundle,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)


def _intent():
    return AgentIntent(goal="g", expectedOutcome="o")


def _task(tid, **kw):
    base = dict(id=tid, description=f"task {tid}",
                capabilityId="agent.delegate",
                input={"task": f"do {tid}"},
                verification=VerificationRequirement(
                    kind="exit-code", description="exit 0"))
    base.update(kw)
    return TaskSpecification(**base)


def _plan():
    return TaskPlan(
        planId="pln-i", sessionId="ses-i", intent=_intent(),
        tasks=[
            _task("t1"),
            _task("t2", inputFrom="upstream-output", dependsOn=["t1"]),
        ],
        createdAt="now")


def _evidence(stdout="A-result"):
    return {"task_id": "t1", "node_id": "opencode", "agent": "OpenCode",
            "stdout": stdout, "scope_paths": [], "changed_paths": [],
            "invocation_ids": ["inv-a"], "approval_ids": []}


class _Ledger:
    def __init__(self, state="granted"):
        self._state = state

    def by_id(self, _apr):
        return {"state": self._state}


class _Cfg:
    def __init__(self, ledger):
        self.ledger = ledger
        self.fabric = None
        self.executors = {}


def _service(home, ledger=None):
    svc = CentralAgent.__new__(CentralAgent)
    svc.fabric_cfg = _Cfg(ledger or _Ledger())
    svc.sessions = AgentSessionStore(home)
    svc.bus = EventBus()
    svc.controller = ExecutionController.__new__(ExecutionController)
    svc.controller._cfg = svc.fabric_cfg
    svc.controller.engine = None
    from aura.central_agent.intent import IntentCompiler
    svc.intents = IntentCompiler(mode="heuristic")
    svc.verifier = VerificationEngine()
    svc.evidence = EvidenceCollector(lambda: [])
    return svc


def _parked_session(svc, plan, verified):
    session = svc.sessions.create(None)
    session.messages.append(
        __import__("aura.contracts", fromlist=["AgentMessage"])
        .AgentMessage(role="user", content="do it", at="now"))
    session.activePlanId = plan.planId
    session.activePlan = plan.model_dump()
    CentralAgent._stash_verified(session, verified)
    session.lastResult = AgentResult(
        status="awaiting-approval", outcome="awaiting-approval",
        summary="parked", runId="run-1",
        evidence=EvidenceBundle(
            sessionId=session.sessionId, planId=plan.planId,
            auditRecordIds=["inv-a"], approvalIds=["apr-1"],
            summary="parked", createdAt="now"))
    svc.sessions.save(session)
    return session


# ── stash / restore ───────────────────────────────────────────────────

class TestStash:
    def test_stdout_bounded_for_persistence(self, tmp_path):
        svc = _service(tmp_path)
        session = svc.sessions.create(None)
        big = "x" * 20000
        CentralAgent._stash_verified(session, {"t1": _evidence(big)})
        stored = session.verifiedEvidence["t1"]["stdout"]
        assert len(stored) < len(big)
        assert "truncated by AURA" in stored
        assert session.verifiedEvidence["t1"]["invocation_ids"] == ["inv-a"]

    def test_malformed_entries_dropped(self, tmp_path):
        svc = _service(tmp_path)
        session = svc.sessions.create(None)
        CentralAgent._stash_verified(
            session, {"t1": _evidence(), "bad": "not-a-dict"})
        assert set(session.verifiedEvidence) == {"t1"}
        assert CentralAgent._restored_verified(session)["t1"]["stdout"] \
            == "A-result"


# ── resume restores, skips, continues ─────────────────────────────────

class TestResumeRestores:
    def test_verified_skipped_handoff_resolved(self, tmp_path, monkeypatch):
        seen = []

        def fake_invoke(capability_id, payload, context, cfg):
            seen.append((capability_id, dict(payload), dict(context)))
            approval = context.get("approvalId")
            return {"invocationId": "inv-b", "outcome": "succeeded",
                    "detail": "done",
                    "verification": {"passed": True, "kind": "exit-code",
                                     "detail": ""},
                    "policy": {"decision": "auto-execute", "rule": "x",
                               "risk": "low", "reason": ""},
                    "at": "now",
                    **({"approvalId": approval} if approval else {}),
                    "output": {"stdout": "B-result", "exitCode": 0}}

        monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                            fake_invoke)
        svc = _service(tmp_path)
        plan = _plan()
        session = _parked_session(svc, plan, {"t1": _evidence()})
        result = svc.resume(session.sessionId)
        # t1 was verified pre-restart: never re-dispatched.
        assert [c for c, _, _ in seen] == ["agent.delegate"]
        assert seen[0][1]["task"].endswith("do t2")
        # Downstream handoff resolved from RESTORED evidence.
        assert "A-result" in seen[0][1]["task"]
        assert result.outcome == "completed"
        assert set(result.verified) == {"t1", "t2"}
        # Terminal outcome clears the stash.
        reloaded = svc.sessions.load(session.sessionId)
        assert reloaded.verifiedEvidence == {}

    def test_stored_plan_used_without_recompile(
            self, tmp_path, monkeypatch):
        seen = []
        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric",
            lambda *a: (seen.append(a) or {
                "invocationId": "inv-b", "outcome": "succeeded",
                "detail": "done",
                "verification": {"passed": True, "kind": "exit-code",
                                 "detail": ""},
                "policy": {"decision": "auto-execute", "rule": "x",
                           "risk": "low", "reason": ""},
                "at": "now",
                "output": {"stdout": "B", "exitCode": 0}}))
        svc = _service(tmp_path)

        compiled = []

        class _SpyIntents:
            def compile(self, *a, **k):
                compiled.append(a)
                raise AssertionError("must not recompile")

        svc.intents = _SpyIntents()
        session = _parked_session(svc, _plan(), {"t1": _evidence()})
        result = svc.resume(session.sessionId)
        assert compiled == []
        assert result.outcome == "completed"

    def test_denied_grant_still_fails_closed(self, tmp_path):
        svc = _service(tmp_path, ledger=_Ledger(state="denied"))
        session = _parked_session(svc, _plan(), {"t1": _evidence()})
        result = svc.resume(session.sessionId)
        assert result.outcome == "denied"


# ── restart round-trip ────────────────────────────────────────────────

class TestRestartRoundTrip:
    def test_plan_chain_evidence_survive_reload(self, tmp_path):
        svc = _service(tmp_path)
        plan = _plan()
        session = _parked_session(svc, plan, {"t1": _evidence()})
        session.correctionChain.append({
            "taskContractId": "c", "taskId": "t1", "attempt": 2,
            "parent_attempt": 1, "status": "parked",
            "approvalId": "apr-9", "verdict": "parked-deviation",
            "reasons": [], "evidence": {},
            "corrective_plan": {"planId": "p", "sessionId": "s",
                                "intent": _intent().model_dump(),
                                "tasks": [], "createdAt": "now"},
            "verified_snapshot": {"t1": _evidence()},
            "plan_snapshot": plan.model_dump()})
        svc.sessions.save(session)

        fresh = AgentSessionStore(tmp_path)
        reloaded = fresh.load(session.sessionId)
        assert reloaded is not None
        # Same plan validates: restart resumes THIS plan.
        restored = TaskPlan.model_validate(reloaded.activePlan)
        assert [t.id for t in restored.tasks] == ["t1", "t2"]
        assert restored.tasks[1].dependsOn == ["t1"]
        # Correction attempt chain intact with budget continuity.
        assert len(reloaded.correctionChain) == 1
        entry = reloaded.correctionChain[0]
        assert (entry["attempt"], entry["parent_attempt"],
                entry["status"]) == (2, 1, "parked")
        assert entry["verified_snapshot"]["t1"]["stdout"] == "A-result"
        # Verified handoff evidence intact.
        assert CentralAgent._restored_verified(reloaded)["t1"][
            "invocation_ids"] == ["inv-a"]
