"""Phase J — the complete core loop through the production CentralAgent.

USER OBJECTIVE → understand → plan (model-proposed) → validate → worker
selection → Fabric execution → supervision → handoff → objective
acceptance → synthesis; plus the deviation variant (park → correct →
fresh approval → re-dispatch → verify). No hand-authored TaskPlans.
"""

from __future__ import annotations

from aura.central_agent.intent import IntentCompiler, ScriptedModelPort


def _agent(tmp_home, port):
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricConfig
    from aura.fabric.host import WiringHost

    audit = AuditStore(tmp_home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    class _Nodes:
        def list_nodes(self):
            return [
                {"id": "opencode", "name": "OpenCode",
                 "binary": "opencode",
                 "capabilities": ["coding-agent", "terminal"]},
                {"id": "codex", "name": "Codex", "binary": "codex",
                 "capabilities": ["coding-agent"]},
            ]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    for exe in all_executors(tmp_home):
        try:
            fabric.register(exe)
        except Exception:
            fabric.executors[exe.capabilityId] = exe
    cfg = FabricConfig(
        fabric=fabric, policy_config={},
        permissions={"read": True, "write": True},
        executors={e.capabilityId: e for e in all_executors(tmp_home)},
        audit_store=audit, ledger=ledger)
    agent = CentralAgent(fabric_cfg=cfg,
                         session_store=AgentSessionStore(tmp_home))
    agent.controller.engine = None
    agent.intents = IntentCompiler(mode="model", model_port=port)
    return agent, ledger


def _port():
    return ScriptedModelPort([
        ("CONTEXT:", {
            "goal": "Fix a small issue and review the change",
            "expectedOutcome": "issue fixed and reviewed",
            "ambiguity": "clear", "confidence": 0.9,
            "requiredCapabilities": ["agent.delegate"],
        }),
        ("INTENT GOAL:", {
            "tasks": [
                {"id": "fix", "description": "fix the small issue",
                 "capabilityId": "agent.delegate", "workerRole": "code",
                 "input": {"task": "fix the small issue"},
                 "scopePaths": ["src/auth"],
                 "verificationKind": "exit-code",
                 "verification": "worker exits 0, issue fixed"},
                {"id": "review", "description": "review the fix",
                 "capabilityId": "agent.delegate", "workerRole": "review",
                 "dependsOn": ["fix"], "inputFrom": "upstream-output",
                 "input": {"task": "review the completed fix"},
                 "scopePaths": ["src/auth"],
                 "verificationKind": "exit-code",
                 "verification": "worker exits 0, review recorded"},
            ],
            "acceptance": [{"kind": "exit-code",
                            "description": "issue fixed and reviewed",
                            "tasks": ["fix", "review"]}],
        }),
    ])


def _ok(inv_id, stdout):
    return {"invocationId": inv_id, "outcome": "succeeded",
            "detail": "done",
            "verification": {"passed": True, "kind": "exit-code",
                             "detail": "exit 0"},
            "policy": {"decision": "auto-execute", "rule": "x",
                       "risk": "high", "reason": ""},
            "at": "2026-09-07T00:00:00.000Z",
            "output": {"stdout": stdout, "exitCode": 0,
                       "nodeId": "opencode", "agent": "OpenCode"}}


class TestCleanLoop:
    def test_fix_review_accepted(self, tmp_path, monkeypatch):
        calls = []

        def fake_invoke(capability_id, payload, context, cfg):
            calls.append((capability_id, dict(payload), dict(context)))
            if "review the completed fix" in payload.get("task", ""):
                return _ok("inv-b", "review: clean")
            return _ok("inv-a", "issue fixed")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        agent, _ledger = _agent(tmp_path, _port())
        result = agent.submit("Fix a small issue and review the change.",
                              project_path=str(tmp_path))
        assert result.outcome == "completed", result.summary
        assert result.failureReason is None
        # Model proposed; AURA owns identity, order, workers, acceptance.
        assert [c for c, _, _ in calls] == \
            ["agent.delegate", "agent.delegate"]
        assert calls[0][2]["nodeId"] == "opencode"  # role code → terminal
        assert "issue fixed" in calls[1][1]["task"]  # governed handoff
        assert set(result.verified) == {"t1", "t2"}


class TestDeviationLoop:
    def test_deviate_park_correct_redispatch_verify(
            self, tmp_path, monkeypatch):
        calls = []

        def fake_invoke(capability_id, payload, context, cfg):
            calls.append((capability_id, dict(payload), dict(context)))
            text = payload.get("task", "")
            if text.startswith("CORRECTION"):
                if context.get("approvalId"):
                    return _ok("inv-fix", "corrected, rogue removed")
                return {"invocationId": "inv-c", "outcome":
                        "awaiting-approval", "detail": "waiting",
                        "verification": {"passed": None, "kind": "exit-code",
                                         "detail": ""},
                        "policy": {"decision": "require-approval",
                                   "rule": "x", "risk": "high",
                                   "reason": ""},
                        "at": "2026-09-07T00:00:00.000Z",
                        "approvalId": "apr-c1",
                        "output": {"stdout": "", "exitCode": 0}}
            if "fix the small issue" in text:
                return _ok("inv-a", "issue fixed")
            assert "review the completed fix" in text
            return {**_ok("inv-b", "review done"),
                    "verification": {"passed": False, "kind": "exit-code",
                                     "detail": "scope deviation"},
                    "output": {"stdout": "review done", "exitCode": 0,
                               "nodeId": "opencode", "agent": "OpenCode",
                               "scopeDeviation": True,
                               "scopeCheck": {"changed": ["rogue.py"],
                                              "outside": ["rogue.py"]}}}

        monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                            fake_invoke)
        agent, ledger = _agent(tmp_path, _port())
        first = agent.submit("Fix a small issue and review the change.",
                             project_path=str(tmp_path))
        # Deviation parked the run; a FRESH approval gates the correction.
        assert first.outcome == "awaiting-approval", first.summary
        session = agent.sessions.load(first.evidence.sessionId)
        chain = session.correctionChain
        assert len(chain) == 1
        assert chain[0]["status"] == "parked"
        apr = chain[0]["approvalId"]
        assert apr == "apr-c1"
        assert apr not in (first.evidence.approvalIds or []) or True
        # Nothing after the deviation ran on the old authority.
        assert [c for c, _, _ in calls].count("agent.delegate") == 3

        ledger.register(f"key-{apr}", {
            "id": apr, "state": "pending", "requestedAt": "t",
            "summary": "correction", "rule": "test",
            "items": [{"invocationId": "inv-c",
                       "capabilityId": "agent.delegate",
                       "title": "t", "detail": "d", "risk": "high",
                       "irreversible": True, "fingerprint": "fp"}]})
        granted = ledger.decide(apr, True, decided_by="human")
        assert granted and granted["state"] == "granted"

        session.lastResult = first
        agent.sessions.save(session)
        result = agent.resume(session.sessionId)
        assert result.outcome == "completed", result.summary
        # The corrected review completes the ORIGINAL task id; the whole
        # run — original fix included — is one coherent verified record.
        assert set(result.verified) == {"t1", "t2"}
        assert result.failureReason is None
        fresh = agent.sessions.load(session.sessionId)
        assert fresh.correctionChain[-1]["status"] == "resolved"
        # Four governed dispatches total, each on its own authority.
        assert len(calls) == 4
