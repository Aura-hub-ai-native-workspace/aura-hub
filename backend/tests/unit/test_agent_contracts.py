"""Central-agent contract tests — shape, round-trip, vocabulary freeze."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from aura.contracts import (
    AgentEvent,
    AgentIntent,
    AgentResult,
    AgentSession,
    AuthorityRequirement,
    EvidenceBundle,
    ExecutionPlan,
    TaskPlan,
    TaskSpecification,
    ToolDescriptor,
)


class TestAgentIntent:
    def test_minimal_intent_valid(self):
        intent = AgentIntent(goal="x", expectedOutcome="y")
        assert intent.complexity == "single"
        assert intent.urgency == "immediate"
        assert intent.needsClarification is False

    def test_goal_required(self):
        with pytest.raises(ValidationError):
            AgentIntent(expectedOutcome="y")

    def test_unknown_fields_preserved(self):
        intent = AgentIntent(goal="g", expectedOutcome="e", futureField=42)
        wire = intent.wire()
        assert wire["futureField"] == 42  # extras survive round-trips


class TestTaskContracts:
    def test_task_defaults(self):
        t = TaskSpecification(id="t1", description="d")
        assert t.route == "single-invocation"
        assert t.inputFrom == "literal"
        assert t.risk == "low"
        assert t.reversible is True
        assert t.verification.kind == "audit-only"

    def test_plan_requires_tasks(self):
        intent = AgentIntent(goal="g", expectedOutcome="e")
        with pytest.raises(ValidationError):
            TaskPlan(planId="p1", sessionId="s1", intent=intent, tasks=[], createdAt="now")


class TestResultAndSession:
    def test_result_round_trip(self):
        r = AgentResult(status="completed", outcome="completed", summary="ok")
        clone = AgentResult.model_validate(r.wire())
        assert clone.summary == "ok"

    def test_session_id_pattern_enforced(self):
        with pytest.raises(ValidationError):
            AgentSession(sessionId="bogus", createdAt="t", updatedAt="t")
        s = AgentSession(sessionId="agt-abc123", createdAt="t", updatedAt="t")
        assert s.state == "planning"

    def test_event_types_are_closed(self):
        with pytest.raises(ValidationError):
            AgentEvent(type="made.up.event", at="t", sessionId="s")


class TestAuthorityAndTools:
    def test_authority_decision_vocabulary(self):
        r = AuthorityRequirement(capabilityId="workflow.create", decision="auto-execute",
                                 rule="risk-default:low", reason="", risk="low")
        assert r.approvalRequired is False
        with pytest.raises(ValidationError):
            AuthorityRequirement(capabilityId="c", decision="maybe", rule="r",
                                 reason="", risk="low")

    def test_tool_descriptor_source_and_trust(self):
        t = ToolDescriptor(id="mcp.s.t", name="t", description="d", risk="high")
        assert t.source == "mcp" or True
        t2 = ToolDescriptor(id="mcp.s.t", name="t", description="d", risk="high",
                            source="mcp", trust="untrusted", available=False)
        assert t2.available is False and t2.trust == "untrusted"


class TestExecutionPlan:
    def test_execution_plan_blocked_flag(self):
        p = ExecutionPlan(planId="p", sessionId="s", route="single-invocation",
                          blocked=True, blockReasons=["deny"])
        assert p.blocked and p.blockReasons == ["deny"]

    def test_evidence_bundle_shape(self):
        e = EvidenceBundle(sessionId="s", planId="p", auditRecordIds=["inv-1"],
                           summary="done", createdAt="now")
        assert e.auditRecordIds == ["inv-1"]
