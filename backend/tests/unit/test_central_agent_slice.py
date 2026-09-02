"""Central agent vertical slice — integration over the real governance spine.

No mocks of authority: real aura.policy evaluation, real append-only audit,
real approval ledger, real workflow persistence. Only the model layer is
deterministic (heuristic mode), which is the point being verified.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.fabric import FabricConfig


@pytest.fixture()
def env(monkeypatch):
    from aura.fabric import CapabilityFabric, FabricHost
    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}
        def node_available(self, _cap):
            return True
        async def request_approval(self, _req, _ctx):
            return False
    home = Path(tempfile.mkdtemp(prefix="agent-slice-"))
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
        fabric=fabric,
        policy_config={},
        permissions={"read": True, "write": True},
        executors=execs,
        audit_store=audit,
        ledger=ledger,
    )
    return home, audit, ledger, cfg, CentralAgent(
        fabric_cfg=cfg, session_store=AgentSessionStore(home))


class TestVerticalSlice:
    def test_status_question_end_to_end(self, env):
        home, audit, _, _, agent = env
        result = agent.submit("list my workflows")
        assert result.outcome == "completed"
        assert result.status == "completed"
        assert result.performed == ["t1"]
        assert result.verified == ["t1"]
        assert len(result.evidence.auditRecordIds) == 1
        # evidence is REAL: the referenced record exists in the trail
        records = {r["invocationId"] for r in audit.load()}
        assert set(result.evidence.auditRecordIds) <= records

    def test_authoring_stores_verified_workflow(self, env):
        home, audit, _, _, agent = env
        result = agent.submit("create a workflow that shows git status every morning")
        assert result.outcome == "completed"
        files = list((home / "workflows").glob("wf-*.json"))
        assert len(files) == 1
        stored = json.loads(files[0].read_text())
        assert stored["nodes"], "stored graph must be present"
        assert stored["category"] == "Agent Generated"
        # read-back verification actually passed inside the fabric
        assert result.verified == ["t1"]

    def test_ambiguous_intent_blocked_without_execution(self, env):
        home, audit, _, _, agent = env
        before = len(audit.load())
        result = agent.submit("   ")
        assert result.outcome == "needs-clarification"
        assert "clarif" in result.summary.lower() or "?" in result.summary
        assert len(audit.load()) == before  # NOTHING ran

    def test_unmappable_intent_never_touches_the_fabric(self, env):
        home, audit, _, _, agent = env
        result = agent.submit("flurb the bazzle quux")
        assert result.outcome == "needs-clarification"
        assert len(audit.load()) == 0

    def test_policy_deny_blocks_plan_before_execution(self, monkeypatch, env):
        home, audit, ledger, cfg, _agent = env
        cfg.policy_config = {"byRisk": {"low": "deny", "medium": "deny",
                                        "high": "deny"}}
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        result = agent.submit("list my workflows")
        assert result.outcome == "failed"
        assert "denies" in result.failureReason.lower()
        # preflight caught it: no invocation was attempted
        invocations = [r for r in audit.load() if r.get("capabilityId")]
        assert invocations == []

    def test_approval_park_surfaces_request_and_waits(self, monkeypatch, env):
        home, audit, ledger, cfg, _ = env
        cfg.policy_config = {"byRisk": {"low": "require-approval",
                                        "medium": "ask-user", "high": "require-approval"}}
        cfg.fabric.set_policy(cfg.sanitized_policy())
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        result = agent.submit("list my workflows")
        assert result.outcome == "awaiting-approval"
        apr_id = result.evidence.approvalIds[0]
        pending = ledger.pending()
        assert [p["id"] for p in pending] == [apr_id]
        assert list((home / "workflows").glob("*")) == [] or "workflow.list" in \
            [p["items"][0]["capabilityId"] for p in pending]

    def test_events_cover_every_boundary(self, env):
        _, _, _, _, agent = env
        seen: list[str] = []
        agent.bus.subscribe(lambda e: seen.append(e.type))
        agent.submit("create a workflow for git status")
        for expected in ("session.started", "intent.compiled", "plan.created",
                         "capability.discovery", "authority.checked",
                         "workflow.compiled", "execution.started",
                         "invocation.observed", "verification.completed",
                         "result.ready"):
            assert expected in seen, f"missing event: {expected}"

    def test_session_state_persisted_and_reloadable(self, env):
        home, _, _, _, agent = env
        result = agent.submit("list my workflows")
        store = AgentSessionStore(home)
        # find the session file the run wrote
        files = sorted((home / "agent" / "sessions").glob("*.json"))
        assert files
        session = store.load(files[-1].stem)
        assert session is not None
        assert session.state == "completed"
        assert session.lastResult.summary == result.summary
        assert session.messages[0].role == "user"

    def test_cli_runs_slice(self, env):
        from aura.central_agent.__main__ import main
        home, *_ = env
        rc = main(["--intent", "create a workflow that lists git status",
                   "--home", str(home)])
        assert rc == 0

    def test_build_fabric_config_smoke(self, env):
        home, audit, ledger, cfg, agent = env
        from aura.central_agent.__main__ import build_fabric_config
        cfg2 = build_fabric_config(audit, ledger)
        assert cfg2 is not None
        assert cfg2.fabric is not None
