"""Web Research is excluded from this release: it must FAIL CLOSED.

The capability's executor was removed from ``aura.executors`` because the
capability is not in any manifest and has no complete governed execution
path. The planner still knows how to *build* a web-research plan, so the
question this file answers is what the orchestrator does with one.

The contract under test, end to end through the real CentralAgent:

  * the capability is not registered as an executor;
  * capability discovery does not offer it;
  * a mission that needs it stops at the discovery gate, BEFORE authority,
    compilation or execution;
  * nothing is performed, audited, or invoked, and no event claims otherwise;
  * no network egress is attempted — an unavailable capability must not
    reach the network on its way to failing;
  * the caller receives a clear, controlled failure rather than a fabricated
    answer; and
  * capabilities that ARE registered are unaffected.

This asserts the exclusion is real. It does not assert Web Research works,
and it must not be edited to do so: the capability is excluded until its
implementation is explicitly reviewed and approved.
"""

from __future__ import annotations

import socket

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.executors import all_executors
from aura.fabric import CapabilityFabric, FabricConfig
from aura.fabric.host import WiringHost

CAPABILITY = "web.research"


def _agent(tmp_path):
    audit = AuditStore(tmp_path / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    class _Nodes:
        def list_nodes(self):
            return [{"id": "opencode", "name": "OpenCode",
                     "binary": "opencode", "capabilities": ["coding-agent"]}]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda _r: None)
    fabric._ledger = ledger
    cfg = FabricConfig(
        fabric=fabric, policy_config={},
        permissions={"read": True, "write": True},
        executors={e.capabilityId: e for e in all_executors(None)},
        audit_store=audit, ledger=ledger)
    return CentralAgent(fabric_cfg=cfg,
                        session_store=AgentSessionStore(tmp_path)), audit


def _plan_web_research(agent):
    """Force the real planner to build a real web-research plan."""
    from aura.central_agent.planner import plan_web_research

    built: list = []

    def _plan(intent, session_id, now):
        plan = plan_web_research(intent, session_id, now)
        built.append(plan)
        return plan

    agent.planner.plan = _plan
    return built


@pytest.fixture()
def no_network(monkeypatch):
    """Any outbound connect attempt fails the test rather than the run."""
    def _blocked(self, address, *args, **kwargs):
        raise AssertionError(f"network egress attempted: {address!r}")

    monkeypatch.setattr(socket.socket, "connect", _blocked)


class TestExclusion:
    def test_capability_is_not_a_registered_executor(self, tmp_path):
        agent, _ = _agent(tmp_path)
        assert CAPABILITY not in agent.fabric_cfg.executors

    def test_capability_is_not_offered_by_discovery(self, tmp_path):
        agent, _ = _agent(tmp_path)
        assert agent.discovery.available_for([CAPABILITY]) == []

    def test_capability_is_not_in_the_manifest(self):
        from aura.fabric import describe_capability
        assert describe_capability(CAPABILITY) is None

    def test_capability_is_not_in_the_internal_registry(self):
        from aura.executors import CANONICAL_INTERNAL_CAPABILITIES
        assert CAPABILITY not in {c["id"] for c in CANONICAL_INTERNAL_CAPABILITIES}


class TestFailClosed:
    def test_a_web_research_mission_fails_with_a_clear_reason(
            self, tmp_path, no_network):
        agent, _ = _agent(tmp_path)
        _plan_web_research(agent)
        result = agent.submit(
            "search the web for the AURA release notes",
            project_id="p", web_research=True)
        assert result.outcome == "failed"
        assert CAPABILITY in result.summary
        assert result.failureReason == f"No available capability for: {CAPABILITY}"
        assert result.performed == []

    def test_nothing_is_executed_audited_or_invoked(self, tmp_path, no_network):
        agent, audit = _agent(tmp_path)
        _plan_web_research(agent)
        agent.submit("search the web for the AURA release notes",
                     project_id="p", web_research=True)
        assert [r for r in audit.load() if r.get("capabilityId")] == []
        assert audit.load() == []

    def test_execution_is_never_announced(self, tmp_path, no_network):
        agent, _ = _agent(tmp_path)
        _plan_web_research(agent)
        seen: list[str] = []
        agent.bus.subscribe(lambda e: seen.append(e.type))
        agent.submit("search the web for the AURA release notes",
                     project_id="p", web_research=True)
        assert "execution.started" not in seen
        assert "invocation.observed" not in seen
        assert "verification.completed" not in seen
        assert "result.ready" not in seen

    def test_the_fabric_is_never_bypassed(self, tmp_path, no_network):
        agent, _ = _agent(tmp_path)
        _plan_web_research(agent)

        def _explode(*args, **kwargs):
            raise AssertionError("execution controller was reached")

        agent.controller.execute = _explode
        result = agent.submit("search the web for the AURA release notes",
                             project_id="p", web_research=True)
        assert result.outcome == "failed"

    def test_no_answer_is_fabricated_from_recollection(
            self, tmp_path, no_network):
        agent, _ = _agent(tmp_path)
        _plan_web_research(agent)
        result = agent.submit("search the web for the AURA release notes",
                             project_id="p", web_research=True)
        assert result.status != "completed"
        assert result.evidence is None or not result.evidence.invocationIds


class TestUnaffectedCapabilities:
    def test_a_registered_capability_still_runs(self, tmp_path):
        agent, audit = _agent(tmp_path)
        agent.submit("list my workflows")
        assert [r.get("capabilityId") for r in audit.load() if r.get("capabilityId")]
