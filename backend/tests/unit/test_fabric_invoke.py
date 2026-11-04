"""Governed invocation pipeline — order, floors, approval semantics.

Mirrors the reference order: unknown → contract → policy → approval →
execute → verify → settle(audit). Every early return must still leave an
audit record.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from aura.audit import AuditStore
from aura.fabric import (
    FabricConfig,
    describe_authority,
    invoke_fabric,
)

NODES = [{"id": "a", "type": "current-project", "x": 0, "y": 0, "config": {}}]


def make_cfg(tmp_home: Path, policy=None, executors=None,
             permissions=None) -> FabricConfig:
    from aura.executors import register_canonical_internal_capabilities
    from aura.fabric import CapabilityFabric, FabricHost
    class _H(FabricHost):
        def __init__(self, perms):
            self._perms = perms
        def permissions_for(self, _cap, _ctx):
            return self._perms
        def node_available(self, _cap):
            return None
    audit = AuditStore(tmp_home / "audit.jsonl")
    ledger = None
    host = _H(permissions or {"read": True, "write": True})
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    if executors is not None:
        exec_map = executors
    else:
        from aura.executors import all_executors
        exec_map = {e.capabilityId: e for e in all_executors(tmp_home)}
    for cap_id, exe in exec_map.items():
        try:
            fabric.register(exe)
        except Exception:
            fabric.executors[cap_id] = exe
    register_canonical_internal_capabilities(fabric)
    if policy is not None:
        fabric.policy = policy
    return FabricConfig(
        fabric=fabric,
        policy_config=policy or {},
        permissions=permissions or {"read": True, "write": True},
        executors=exec_map,
        audit_store=audit,
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
            async def run(self, invocation):
                raise RuntimeError("disk gone")

            async def verify(self, invocation, result):
                return None

        cfg = make_cfg(home, executors={"workflow.create": Boom()})
        r = invoke_fabric("workflow.create",
                          {"name": "x", "nodes": NODES, "edges": []}, {}, cfg)
        assert r["outcome"] == "failed"
        assert "disk gone" in r["detail"]
        assert len(AuditStore(home / "audit.jsonl").load()) == 1


class TestAuditDegradation:
    """A lost journal write degrades visibly instead of silently.

    The execution still succeeds (liveness over logging), but the
    record is marked and the result carries the degradation — no code
    downstream can assert an audit trail that is not there.
    """

    def test_failed_append_marks_record_and_result(self, home, monkeypatch):
        cfg = make_cfg(home)

        def boom(_record):
            raise OSError("disk read-only")

        # The fabric captured the store's append at attach time: patch
        # the stored callable, not the store attribute.
        monkeypatch.setattr(cfg.fabric, "_audit_store_append", boom)
        r = invoke_fabric("workflow.list", {}, {"taskId": "t"}, cfg)
        assert r["outcome"] == "succeeded"
        assert r.get("auditDegraded") is True
        assert r.get("auditError") == "disk read-only"

    def test_healthy_append_leaves_no_markers(self, home):
        cfg = make_cfg(home)
        r = invoke_fabric("workflow.list", {}, {"taskId": "t"}, cfg)
        assert r["outcome"] == "succeeded"
        assert "auditDegraded" not in r


class TestPreflight:
    def test_describe_authority_matches_invoke(self, home):
        cfg = make_cfg(home)
        pre = describe_authority("workflow.create", {}, cfg)
        assert pre["decision"] == "auto-execute"
        unknown = describe_authority("nope", {}, cfg)
        assert unknown is None

    def test_permission_gap_denies(self, home):
        cfg = make_cfg(home, permissions={"read": True, "write": False})
        pre = describe_authority("filesystem.write", {}, cfg)
        assert pre["decision"] == "deny"
        assert pre["rule"] == "permission-denied"

    def test_input_summary_redacts_secretish_fields(self, home):
        from aura.fabric import summarize_input
        cap = {"id": "t.x", "name": "T", "description": "", "category": "t", "surface": "aura-internal", "risk": "low", "input": [{"name": "apiKey", "type": "string", "required": False, "description": ""}]}
        s = summarize_input(cap, {"apiKey": "super-secret-value"})
        assert "super-secret-value" not in s
        assert "<redacted>" in s

    def test_input_summary_bounds_long_values(self, home):
        from aura.fabric import summarize_input
        cap = {"id": "t.x", "name": "T", "description": "", "category": "t", "surface": "aura-internal", "risk": "low", "input": [{"name": "name", "type": "string", "required": False, "description": ""}]}
        s = summarize_input(cap, {"name": "x" * 500})
        assert len(s) < 80 and "…" in s
