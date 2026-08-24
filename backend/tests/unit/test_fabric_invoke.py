"""Governed invocation pipeline — order, floors, approval semantics.

Mirrors the reference order: unknown → contract → policy → approval →
execute → verify → settle(audit). Every early return must still leave an
audit record.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from aura.audit import AuditStore
from aura.approvals import ApprovalLedger
from aura.fabric import (
    FabricConfig,
    builtin_executors,
    describe_authority,
    invoke_fabric,
)

NODES = [{"id": "a", "type": "current-project", "x": 0, "y": 0, "config": {}}]


def make_cfg(tmp_home: Path, policy=None, executors=None,
             permissions=None) -> FabricConfig:
    audit = AuditStore(tmp_home / "audit.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    return FabricConfig(
        policy_config=policy or {},
        permissions=permissions or {"read": True, "write": True},
        executors=executors if executors is not None else builtin_executors(tmp_home),
        audit_store=audit,
        ledger=ledger,
    )


@pytest.fixture()
def home(monkeypatch):
    d = Path(tempfile.mkdtemp(prefix="fabric-tests-"))
    monkeypatch.setenv("AURA_HOME", str(d))
    return d


class TestOrder:
    def test_unknown_capability_fails_with_audit(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("no.such.capability", {}, {}, cfg)
        assert r["outcome"] == "failed"
        assert r["policy"]["rule"] == "unknown-capability"
        assert len(AuditStore(home / "audit.jsonl").load()) == 1

    def test_contract_checked_before_execution(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("workflow.create", {"nodes": NODES}, {}, cfg)  # name missing
        assert r["outcome"] == "failed"
        assert r["policy"]["rule"] == "invalid-input"
        assert list((home / "workflows").glob("*.json")) == []

    def test_type_mismatch_rejected(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("workflow.create",
                          {"name": 5, "nodes": NODES, "edges": []}, {}, cfg)
        assert r["policy"]["rule"] == "invalid-input"
        assert "should be a string" in r["detail"]

    def test_deny_leaves_no_side_effect(self, home):
        cfg = make_cfg(home, policy={"byRisk": {"low": "deny", "medium": "deny",
                                                "high": "deny"}})
        r = invoke_fabric("workflow.create",
                          {"name": "x", "nodes": NODES, "edges": []}, {}, cfg)
        assert r["outcome"] == "denied"
        assert list((home / "workflows").glob("*")) == []


class TestExecutionAndVerification:
    def test_create_succeeds_and_verifies_read_back(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("workflow.create",
                          {"name": "w", "description": "", "nodes": NODES,
                           "edges": []}, {}, cfg)
        assert r["outcome"] == "succeeded"
        assert r["verification"]["passed"] is True
        assert r["verification"]["kind"] == "read-back"

    def test_list_has_null_verification_but_succeeds(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("workflow.list", {}, {}, cfg)
        assert r["outcome"] == "succeeded"
        assert r["verification"]["passed"] is None

    def test_missing_executor_is_unsupported(self, home):
        cfg = make_cfg(home, executors={})
        r = invoke_fabric("workflow.create",
                          {"name": "x", "nodes": NODES, "edges": []}, {}, cfg)
        assert r["outcome"] == "unsupported"

    def test_executor_fault_becomes_failed_settlement(self, home):
        class Boom:
            def run(self, input, context):
                raise RuntimeError("disk gone")

            def verify(self, input, context, output):
                return None

        cfg = make_cfg(home, executors={"workflow.create": Boom()})
        r = invoke_fabric("workflow.create",
                          {"name": "x", "nodes": NODES, "edges": []}, {}, cfg)
        assert r["outcome"] == "failed"
        assert "disk gone" in r["detail"]
        assert len(AuditStore(home / "audit.jsonl").load()) == 1


class TestApprovalGate:
    PAYLOAD = {"name": "g", "description": "", "nodes": NODES, "edges": []}
    POLICY = {"byRisk": {"low": "require-approval", "medium": "ask-user",
                         "high": "deny"}}

    def test_parks_without_deciding(self, home):
        cfg = make_cfg(home, policy=self.POLICY)
        r = invoke_fabric("workflow.create", self.PAYLOAD,
                          {"taskId": "t"}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert r.get("approvalId")
        # parked, not performed
        assert list((home / "workflows").glob("*")) == []

    def test_named_grant_spends_once_then_replay_refused(self, home):
        cfg = make_cfg(home, policy=self.POLICY)
        ctx = {"taskId": "t"}
        first = invoke_fabric("workflow.create", self.PAYLOAD, ctx, cfg)
        apr = first["approvalId"]
        cfg.ledger.decide(apr, True, "user")
        ok = invoke_fabric("workflow.create", self.PAYLOAD,
                           {"taskId": "t", "approvalId": apr}, cfg)
        assert ok["outcome"] == "succeeded"
        replay = invoke_fabric("workflow.create", self.PAYLOAD,
                               {"taskId": "t", "approvalId": apr}, cfg)
        assert replay["outcome"] == "awaiting-approval"
        assert "different action" in replay["detail"] or "no longer" in replay["detail"]

    def test_tampered_arguments_fail_fingerprint_binding(self, home):
        cfg = make_cfg(home, policy=self.POLICY)
        ctx = {"taskId": "t"}
        apr = invoke_fabric("workflow.create", self.PAYLOAD, ctx, cfg)["approvalId"]
        cfg.ledger.decide(apr, True, "user")
        tampered = dict(self.PAYLOAD, name="renamed-after-grant")
        r = invoke_fabric("workflow.create", tampered,
                          {"taskId": "t", "approvalId": apr}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert list((home / "workflows").glob("*")) == []

    def test_denied_decision_records_audit_with_reason(self, home):
        ledger_decided = []
        cfg = make_cfg(home, policy=self.POLICY)
        apr = invoke_fabric("workflow.create", self.PAYLOAD, {"taskId": "t"},
                            cfg)["approvalId"]
        decided = cfg.ledger.decide(apr, False, "user", "not today")
        assert decided["state"] == "denied"
        records = AuditStore(home / "audit.jsonl").load()
        decisions = [x for x in records if x.get("approvalDecision")]
        assert decisions and decisions[-1]["approvalDecision"] == "denied"


class TestPreflight:
    def test_describe_authority_matches_invoke(self, home):
        cfg = make_cfg(home)
        pre = describe_authority("workflow.create", {}, cfg)
        assert pre["decision"] == "auto-execute"
        unknown = describe_authority("nope", {}, cfg)
        assert unknown is None

    def test_permission_gap_denies(self, home):
        cfg = make_cfg(home, permissions={"read": True, "write": False})
        pre = describe_authority("workflow.create", {}, cfg)
        assert pre["decision"] == "deny"
        assert pre["rule"] == "permission-denied"

    def test_input_summary_redacts_secretish_fields(self, home):
        from aura.fabric.invoke import summarize_input
        from aura.fabric.manifest import CapabilityDescriptor, CapabilityField
        cap = CapabilityDescriptor(
            id="t.x", name="T", description="", category="t", surface="aura-internal",
            risk="low",
            input=(CapabilityField(name="apiKey", type="string", required=False,
                                   description=""),),
        )
        s = summarize_input(cap, {"apiKey": "super-secret-value"})
        assert "super-secret-value" not in s
        assert "<redacted>" in s

    def test_input_summary_bounds_long_values(self, home):
        from aura.fabric.invoke import summarize_input
        from aura.fabric.manifest import CapabilityDescriptor, CapabilityField
        cap = CapabilityDescriptor(
            id="t.x", name="T", description="", category="t", surface="aura-internal",
            risk="low",
            input=(CapabilityField(name="name", type="string", required=False,
                                   description=""),),
        )
        s = summarize_input(cap, {"name": "x" * 500})
        assert len(s) < 80 and "…" in s
