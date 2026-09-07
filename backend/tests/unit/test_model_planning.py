"""Phase F — governed model-proposed planning (MODEL PROPOSES → AURA OWNS).

Focused coverage only: valid delegate plans (single + A→B DAG), every
fail-closed validation rule, Fabric reachability of validated plans,
deterministic-template preservation, and Phase E correction compat with
model-generated agent tasks.
"""

from __future__ import annotations

import pytest

from aura.central_agent.planner import (
    MAX_TASKS,
    PlanningError,
    TaskPlanner,
)
from aura.contracts import AgentIntent


def _intent():
    return AgentIntent(goal="fix auth and review", expectedOutcome="done")


def _planner(nodes=("opencode", "claude")):
    return TaskPlanner(
        known_capabilities=lambda: {
            "agent.delegate", "git.status", "filesystem.write",
            "workflow.list",
        },
        known_nodes=lambda: set(nodes),
    )


def _delegate(label, task_text="do work", **kw):
    base = {
        "id": label,
        "description": f"{label} work",
        "capabilityId": "agent.delegate",
        "input": {"task": task_text},
        "verificationKind": "exit-code",
        "verification": "worker exits 0 with the change in place",
    }
    base.update(kw)
    return base


# ── 1. valid single agent.delegate model plan ─────────────────────────

class TestValidSingleDelegate:
    def test_single_delegate_validates(self):
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [_delegate("fix", task_text="fix the auth bug",
                                 scopePaths=["src/auth"])]})
        assert len(plan.tasks) == 1
        t = plan.tasks[0]
        assert t.capabilityId == "agent.delegate"
        assert t.input["task"] == "fix the auth bug"
        assert t.input["scopePaths"] == ["src/auth"]
        # AURA owns identity: canonical id, not the model label.
        assert t.id == "t1"


# ── 2. valid A → B multi-worker DAG ───────────────────────────────────

class TestMultiWorkerDag:
    def test_ab_dag_owned_by_aura(self):
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [
                _delegate("fix", task_text="investigate/fix auth issue",
                          nodeId="opencode", scopePaths=["src/auth"]),
                _delegate("review", task_text="review the auth change",
                          nodeId="claude", dependsOn=["fix"],
                          inputFrom="upstream-output",
                          scopePaths=["src/auth"]),
            ]})
        assert [t.id for t in plan.tasks] == ["t1", "t2"]
        assert plan.tasks[0].nodeId == "opencode"
        assert plan.tasks[1].nodeId == "claude"
        assert plan.tasks[1].dependsOn == ["t1"]
        assert plan.tasks[1].inputFrom == "upstream-output"

    def test_forward_reference_ordered_by_aura(self):
        # Model declares B before A; AURA still orders A first.
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [
                _delegate("review", task_text="review it",
                          dependsOn=["fix"], inputFrom="upstream-output"),
                _delegate("fix", task_text="fix it"),
            ]})
        assert [t.description for t in plan.tasks] == \
            ["fix work", "review work"]
        assert plan.tasks[1].dependsOn == ["t1"]


# ── 3. upstream-output requires dependsOn ─────────────────────────────

class TestUpstreamRequiresDeps:
    def test_bare_upstream_rejected(self):
        with pytest.raises(PlanningError, match="upstream-output"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("b", inputFrom="upstream-output")]})
        with pytest.raises(PlanningError, match="unknown"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("b", dependsOn=["ghost"],
                                      inputFrom="upstream-output")]})


# ── 4. circular dependency rejected ───────────────────────────────────

class TestCycles:
    def test_cycle_rejected(self):
        with pytest.raises(PlanningError, match="[Cc]ycle"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [
                    _delegate("a", dependsOn=["b"]),
                    _delegate("b", dependsOn=["a"]),
                ]})

    def test_self_dependency_rejected(self):
        with pytest.raises(PlanningError, match="[Dd]epends on itself"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("a", dependsOn=["a"])]})


# ── 5. invalid capability rejected ────────────────────────────────────

class TestCapabilities:
    def test_unknown_capability_rejected(self):
        with pytest.raises(PlanningError, match="unknown capability"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", capabilityId="terminal.execute")]})

    def test_bounds_enforced(self):
        with pytest.raises(PlanningError, match="bound"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate(f"t{i}") for i in range(MAX_TASKS + 1)]})

    def test_duplicate_ids_rejected(self):
        with pytest.raises(PlanningError, match="[Dd]uplicate"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("same"), _delegate("same")]})

    def test_compiled_workflow_not_proposable(self):
        with pytest.raises(PlanningError, match="inputFrom"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", inputFrom="compiled-workflow")]})


# ── 6. invalid nodeId rejected ────────────────────────────────────────

class TestNodePins:
    def test_unknown_node_rejected(self):
        with pytest.raises(PlanningError, match="unknown node"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", nodeId="evilbox")]})

    def test_node_unverifiable_without_catalogue(self):
        planner = TaskPlanner(
            known_capabilities=lambda: {"agent.delegate"})
        with pytest.raises(PlanningError, match="cannot verify"):
            planner.plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", nodeId="opencode")]})

    def test_omitted_node_stays_valid(self):
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now", {"tasks": [_delegate("x")]})
        assert plan.tasks[0].nodeId is None


# ── 7. arbitrary executable rejected ──────────────────────────────────

class TestDelegateInputShape:
    @pytest.mark.parametrize("evil", [
        {"task": "x", "binary": "opencode"},
        {"task": "x", "command": "rm -rf /"},
        {"task": "x", "argv": ["--evil"]},
        {"task": "x", "approvalId": "apr-1"},
        {"task": "x", "policy": "auto"},
        {"task": "x", "secret": "s3cr3t"},
        {"task": "x", "node": {"binary": "sh"}},
    ])
    def test_authority_bearing_input_rejected(self, evil):
        bad = _delegate("x")
        bad["input"] = evil
        with pytest.raises(PlanningError, match="unsupported fields"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now", {"tasks": [bad]})

    def test_empty_task_text_rejected(self):
        bad = _delegate("x")
        bad["input"] = {"task": "   "}
        with pytest.raises(PlanningError, match="no task text"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now", {"tasks": [bad]})


# ── 8. scope expansion rejected ───────────────────────────────────────

class TestScope:
    @pytest.mark.parametrize("scope", [
        ["/etc/passwd"], ["../outside"], ["~/x"], ["."], [""],
        ["a/../../b"],
    ])
    def test_escaping_scope_rejected(self, scope):
        with pytest.raises(PlanningError, match="[Ss]cope"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", scopePaths=scope)]})

    def test_downstream_widening_rejected(self):
        with pytest.raises(PlanningError, match="same or narrower"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [
                    _delegate("a", scopePaths=["src/auth"]),
                    _delegate("b", dependsOn=["a"],
                              inputFrom="upstream-output",
                              scopePaths=["src"]),
                ]})

    def test_same_or_narrower_accepted(self):
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [
                _delegate("a", scopePaths=["src/auth"]),
                _delegate("b", dependsOn=["a"],
                          inputFrom="upstream-output",
                          scopePaths=["src/auth/login.py"]),
            ]})
        assert plan.tasks[1].input["scopePaths"] == ["src/auth/login.py"]


# ── 9. malformed verification rejected ────────────────────────────────

class TestVerification:
    def test_bad_kind_rejected(self):
        with pytest.raises(PlanningError, match="[Ii]nvalid model plan"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x", verificationKind="vibes")]})

    def test_delegate_requires_verification_text(self):
        bad = _delegate("x")
        del bad["verification"]
        with pytest.raises(PlanningError, match="verification requirement"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now", {"tasks": [bad]})


# ── 10. model cannot create approval/policy authority ─────────────────

class TestNoAuthoritySmuggling:
    def test_top_level_approval_rejected(self):
        with pytest.raises(PlanningError, match="unsupported fields"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_delegate("x")],
                 "approvedCapabilities": ["agent.delegate"]})

    @pytest.mark.parametrize("field", [
        "approval", "approvalRequired", "policy",
        "grantedCapabilities", "secret", "credentials",
    ])
    def test_task_level_authority_rejected(self, field):
        bad = _delegate("x")
        bad[field] = True
        with pytest.raises(PlanningError, match="unsupported fields"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now", {"tasks": [bad]})


# ── 11. valid plan reaches the existing Fabric path ───────────────────

class TestFabricReachability:
    def test_node_pin_and_scope_reach_invoke(self, monkeypatch):
        from aura.central_agent.execution import ExecutionController

        seen: list[tuple[str, dict, dict]] = []

        def fake_invoke(capability_id, payload, context, cfg):
            seen.append((capability_id, dict(payload), dict(context)))
            return {"invocationId": "inv-1", "outcome": "succeeded",
                    "detail": "done",
                    "verification": {"passed": True, "kind": "exit-code",
                                     "detail": ""},
                    "policy": {"decision": "auto-execute", "rule": "x",
                               "risk": "low", "reason": ""},
                    "at": "now",
                    "output": {"stdout": "fixed", "exitCode": 0}}

        monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                            fake_invoke)
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [_delegate("fix", task_text="fix auth",
                                 nodeId="opencode",
                                 scopePaths=["src/auth"])]})
        controller = ExecutionController.__new__(ExecutionController)
        controller._cfg = object()
        controller.engine = None
        result = controller.execute(plan, project_id="p")
        assert result.outcomes[0].state == "done"
        assert result.outcomes[0].verified is True
        cap, payload, context = seen[0]
        assert cap == "agent.delegate"
        assert payload["task"] == "fix auth"
        assert payload["scopePaths"] == ["src/auth"]
        # The AURA-validated worker pin travels to Fabric routing.
        assert context["nodeId"] == "opencode"


# ── 12. deterministic templates unchanged ─────────────────────────────

class TestDeterministicPreserved:
    def test_templates_still_plan(self):
        planner = TaskPlanner(
            known_capabilities=lambda: {"git.status", "workflow.list"})
        intent = AgentIntent(
            goal="git status", expectedOutcome="status",
            requiredCapabilities=["git.status"])
        plan = planner.plan(intent, "ses-1", "now")
        assert [t.capabilityId for t in plan.tasks] == ["git.status"]

    def test_legacy_proposal_shape_still_validates(self):
        planner = TaskPlanner(
            known_capabilities=lambda: {"git.status", "filesystem.write"})
        intent = AgentIntent(goal="x", expectedOutcome="y")
        plan = planner.plan_from_model(intent, "agt-x", "now", {
            "tasks": [
                {"description": "Read status", "capabilityId": "git.status",
                 "risk": "low", "verificationKind": "exit-code"},
                {"description": "Write report",
                 "capabilityId": "filesystem.write", "risk": "medium",
                 "input": {"path": "report.md", "content": "# Status\n"},
                 "dependsOn": [0], "verificationKind": "read-back"},
            ]})
        assert [t.capabilityId for t in plan.tasks] == \
            ["git.status", "filesystem.write"]
        assert plan.tasks[1].dependsOn == ["t1"]


# ── REAL VALIDATION: submit() with a model-proposed A→B plan ──────────
# No manually constructed TaskPlan anywhere in this class: the model
# proposes, AURA validates, owns, and executes.


def _submit_agent(tmp_home, monkeypatch, port):
    """CentralAgent over a stub-node fabric with a scripted Fabric edge."""
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.intent import IntentCompiler
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricConfig
    from aura.fabric.host import WiringHost

    audit = AuditStore(tmp_home / "audit" / "trail.jsonl")
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
    return agent


def _submit_invocation(inv_id, stdout):
    return {"invocationId": inv_id, "outcome": "succeeded",
            "detail": "done",
            "verification": {"passed": True, "kind": "exit-code",
                             "detail": "exit 0"},
            "policy": {"decision": "auto-execute", "rule": "x",
                       "risk": "high", "reason": ""},
            "at": "2026-09-07T00:00:00.000Z",
            "output": {"stdout": stdout, "exitCode": 0,
                       "nodeId": "opencode", "agent": "OpenCode"}}


class TestModelProposedSubmit:
    def test_submit_runs_model_proposed_ab_dag(self, tmp_path, monkeypatch):
        from aura.central_agent.intent import ScriptedModelPort

        calls: list[tuple[str, dict, dict]] = []

        def fake_invoke(capability_id, payload, context, cfg):
            calls.append((capability_id, dict(payload), dict(context)))
            if payload.get("task", "").startswith("investigate"):
                return _submit_invocation("inv-a", "root cause: off-by-one")
            return _submit_invocation("inv-b", "review: looks correct")

        monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                            fake_invoke)
        port = ScriptedModelPort([
            ("CONTEXT:", {
                "goal": "Fix the authentication bug and review the change",
                "expectedOutcome": "bug fixed and reviewed",
                "ambiguity": "clear", "confidence": 0.9,
                "requiredCapabilities": ["agent.delegate"],
            }),
            ("INTENT GOAL:", {
                "tasks": [
                    {"id": "fix", "description": "investigate/fix auth",
                     "capabilityId": "agent.delegate", "nodeId": "opencode",
                     "input": {"task": "investigate and fix the auth bug"},
                     "scopePaths": ["src/auth"],
                     "verificationKind": "exit-code",
                     "verification": "worker exits 0, bug fixed"},
                    {"id": "review", "description": "review the fix",
                     "capabilityId": "agent.delegate",
                     "dependsOn": ["fix"], "inputFrom": "upstream-output",
                     "input": {"task": "review the completed auth change"},
                     "scopePaths": ["src/auth"],
                     "verificationKind": "exit-code",
                     "verification": "worker exits 0, review recorded"},
                ]}),
        ])
        agent = _submit_agent(tmp_path, monkeypatch, port)
        result = agent.submit("Fix the authentication bug and review it.",
                              project_path=str(tmp_path))
        assert result.outcome == "completed", result.summary
        # MODEL PROPOSED → AURA VALIDATED → AURA OWNED → AURA EXECUTED:
        # canonical ids, A then B, handoff consumed, fresh scope kept.
        assert [c for c, _, _ in calls] == \
            ["agent.delegate", "agent.delegate"]
        assert "off-by-one" in calls[1][1]["task"]  # bounded handoff data
        assert calls[1][1]["task"].endswith(
            "review the completed auth change")
        assert calls[0][2].get("nodeId") == "opencode"  # validated pin
        assert "nodeId" not in calls[1][2]  # omitted → AURA routing
        assert calls[1][1]["scopePaths"] == ["src/auth"]
        assert set(result.verified) == {"t1", "t2"}


# ── 13. Phase E correction intact for model-generated tasks ───────────

class TestCorrectionCompat:
    def test_deviation_parks_model_task(self):
        from aura.central_agent.supervisor import (
            TASK_PARKED_DEVIATION,
            decide_task,
        )

        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [_delegate("fix", scopePaths=["src/auth"])]})
        assert plan.tasks[0].id == "t1"
        verdict = decide_task(
            "failed",
            {"taskId": "t1", "scopeDeviation": True,
             "scopeCheck": {"outside": ["rogue.py"]}},
            verified=False)
        assert verdict.status == TASK_PARKED_DEVIATION
        assert verdict.correctable is True
        assert "rogue.py" in " ".join(verdict.reasons)
