"""Governed invocation pipeline — order, floors, approval semantics.

Mirrors the reference order: unknown → contract → policy → approval →
execute → verify → settle(audit). Every early return must still leave an
audit record.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
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
        async def request_approval(self, _req, _ctx):
            return False
    audit = AuditStore(tmp_home / "audit.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    host = _H(permissions or {"read": True, "write": True})
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
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
        cfg = make_cfg(home, policy=self.POLICY)
        apr = invoke_fabric("workflow.create", self.PAYLOAD, {"taskId": "t"},
                            cfg)["approvalId"]
        decided = cfg.ledger.decide(apr, False, "user", "not today")
        assert decided["state"] == "denied"
        records = AuditStore(home / "audit.jsonl").load()
        decisions = [x for x in records if x.get("approvalDecision")]
        assert decisions and decisions[-1]["approvalDecision"] == "denied"


class TestAutonomyOverrides:
    """Normal operations run without parking; destruction still parks.

    The shipped default policy carries explicit auto-execute overrides
    for delegation, mission control, writes, terminal use and git —
    each reversible through version control or bounded by allow-lists.
    The irreversible-floor (filesystem.delete) is not listed and could
    not be lowered by listing it.
    """

    AUTO = ["agent.delegate", "mission.approve", "mission.start",
            "filesystem.write", "terminal.execute", "git.commit", "git.push"]
    FULL_PERMS = {"read": True, "write": True, "execute": True}

    def _connected(self, cfg):
        # Capabilities that need a node (delegation, terminal) deny
        # without one — correctly. Connect a node so the test measures
        # policy, not routing.
        cfg.fabric.host.node_available = lambda _cap: {"id": "opencode"}
        return cfg

    def test_normal_operations_are_auto_execute(self, home):
        cfg = self._connected(make_cfg(home, permissions=self.FULL_PERMS))
        for cap in self.AUTO:
            pre = describe_authority(cap, {"taskId": "t"}, cfg)
            assert pre is not None, cap
            assert pre["decision"] == "auto-execute", (cap, pre)

    def test_delegation_runs_without_creating_an_approval(self, home, tmp_path):
        ran = []

        class _Delegate:
            capabilityId = "agent.delegate"

            async def run(self, invocation):
                ran.append(invocation)
                return {"ok": True, "detail": "delegated",
                        "output": {"stdout": "ok", "exitCode": 0}}

            async def verify(self, _inv, _res):
                return {"passed": True, "kind": "exit-code", "detail": "0"}

        cfg = self._connected(make_cfg(
            home, executors={"agent.delegate": _Delegate()},
            permissions=self.FULL_PERMS))
        r = invoke_fabric("agent.delegate", {"task": "do the thing"},
                          {"taskId": "t", "cwd": str(tmp_path)}, cfg)
        assert r["outcome"] == "succeeded", r["detail"]
        assert len(ran) == 1
        assert cfg.ledger.pending() == []

    def test_destructive_operations_still_park(self, home):
        cfg = self._connected(make_cfg(home, permissions=self.FULL_PERMS))
        for cap in ("filesystem.delete", "system.install", "provider.connect"):
            pre = describe_authority(cap, {"taskId": "t"}, cfg)
            assert pre is not None, cap
            assert pre["decision"] == "require-approval", (cap, pre)

    def test_floors_beat_grants(self, home):
        cfg = self._connected(make_cfg(home, permissions=self.FULL_PERMS))
        cfg.fabric.policy["autonomy"] = [
            *cfg.fabric.policy.get("autonomy", []), "filesystem.delete"]
        pre = describe_authority("filesystem.delete", {"taskId": "t"}, cfg)
        assert pre["decision"] == "require-approval"


class TestParkedSessionLinkage:
    """A parked request carries the owning sessionId when the invocation
    context has one, so the unified approvals inbox can route the
    decision to /agent/sessions/{sid}/approve. Absent context → absent
    field (never an empty or guessed value)."""

    POLICY = {"byRisk": {"low": "require-approval", "medium": "ask-user",
                         "high": "deny"}}
    PAYLOAD = {"name": "g", "description": "", "nodes": NODES, "edges": []}

    def test_parked_request_carries_session_id(self, home):
        cfg = make_cfg(home, policy=self.POLICY)
        r = invoke_fabric("workflow.create", self.PAYLOAD,
                          {"taskId": "t", "sessionId": "ses-9"}, cfg)
        assert r["outcome"] == "awaiting-approval"
        pending = cfg.ledger.pending()
        assert len(pending) == 1
        assert pending[0]["sessionId"] == "ses-9"

    def test_no_session_context_means_no_session_field(self, home):
        cfg = make_cfg(home, policy=self.POLICY)
        r = invoke_fabric("workflow.create", self.PAYLOAD,
                          {"taskId": "t"}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert "sessionId" not in cfg.ledger.pending()[0]


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


class TestFilesystemDeleteGate:
    """Deletion always parks, under every policy.

    filesystem.delete sits behind two independent floors (irreversible
    + resource.destroy), so even a machine configured with every risk
    level at auto-execute still parks deletes. The executor itself only
    confines the granted deletion and proves the absence afterwards.
    """

    PERMISSIVE = {"byRisk": {"low": "auto-execute", "medium": "auto-execute",
                             "high": "auto-execute"}}

    def _proj(self, home, tmp_path):
        proj = tmp_path / "proj"
        proj.mkdir()
        target = proj / "doomed.txt"
        target.write_text("bye\n")
        return proj, target

    def test_parks_without_grant_and_deletes_nothing(self, home, tmp_path):
        cfg = make_cfg(home)
        proj, target = self._proj(home, tmp_path)
        r = invoke_fabric("filesystem.delete", {"path": "doomed.txt"},
                          {"taskId": "t", "cwd": str(proj)}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert r.get("approvalId")
        assert target.exists()

    def test_floor_holds_under_fully_permissive_policy(self, home, tmp_path):
        cfg = make_cfg(home, policy=self.PERMISSIVE)
        proj, target = self._proj(home, tmp_path)
        pre = describe_authority(
            "filesystem.delete", {"taskId": "t", "cwd": str(proj)}, cfg)
        assert pre["decision"] == "require-approval"
        r = invoke_fabric("filesystem.delete", {"path": "doomed.txt"},
                          {"taskId": "t", "cwd": str(proj)}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert target.exists()

    def test_granted_delete_removes_and_verifies_absence(self, home, tmp_path):
        cfg = make_cfg(home)
        proj, target = self._proj(home, tmp_path)
        ctx = {"taskId": "t", "cwd": str(proj)}
        apr = invoke_fabric("filesystem.delete", {"path": "doomed.txt"},
                            ctx, cfg)["approvalId"]
        cfg.ledger.decide(apr, True, "user")
        ok = invoke_fabric("filesystem.delete", {"path": "doomed.txt"},
                           {**ctx, "approvalId": apr}, cfg)
        assert ok["outcome"] == "succeeded"
        assert not target.exists()

    def test_traversal_is_refused_not_parked(self, home, tmp_path):
        from aura.executors import EXECUTOR_TABLE, ExecutorAdapter
        import asyncio

        proj = tmp_path / "proj"
        proj.mkdir()
        adapter = ExecutorAdapter(
            "filesystem.delete", EXECUTOR_TABLE["filesystem.delete"])
        inv = {"input": {"path": "../escape.txt"},
               "context": {"cwd": str(proj)}}
        out = asyncio.run(adapter.run(inv))
        assert out["ok"] is False
        assert "leaves the project" in out["detail"]

    def test_directories_are_never_removed(self, home, tmp_path):
        from aura.executors import EXECUTOR_TABLE
        import asyncio

        proj = tmp_path / "proj"
        (proj / "subdir").mkdir(parents=True)
        inv = {"input": {"path": "subdir"},
               "context": {"cwd": str(proj)}}
        out = asyncio.run(EXECUTOR_TABLE["filesystem.delete"]["run"](inv))
        assert out["ok"] is False
        assert (proj / "subdir").exists()
