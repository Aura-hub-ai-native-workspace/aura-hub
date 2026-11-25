"""A non-agent capability whose named node is unavailable moves to another real provider.

Real ExecutionController, real CapabilityFabric (routing, policy, audit) and the
real billing policy file; only the executors are fakes, so every dispatch that
happens here is one Fabric actually made, and nothing outside the test runs.

Nodes providing `source-control` in these tests:
  git-main   the node the plan names (missing, or present but not driveable)
  git-free   owner-marked verified-free
  git-other  connected, no billing entry (unknown billing == denied)
  gemini-cli owner-authorized, known to bill (allowed, not free)
"""

from __future__ import annotations

import json

import pytest

from aura.central_agent.alternatives import select_alternative
from aura.central_agent.authority import AuthorityChecker
from aura.central_agent.execution import ExecutionController
from aura.contracts import AuthorityRequirement
from aura.contracts.agent import AgentIntent, TaskPlan, TaskSpecification


# The owner's real billing file decides here, not the suite-wide allow-all stub.
pytestmark = pytest.mark.real_billing_policy_off


def _node(node_id, *, caps=("source-control",), driveable=True, name=None):
    return {"id": node_id, "name": name or node_id, "capabilities": list(caps), "driveable": driveable}


class _Executor:
    """A node-routed executor that records every run Fabric hands it."""

    def __init__(self, capability_id, calls, *, ok=True):
        self.capabilityId = capability_id
        self.calls = calls
        self.ok = ok

    def supportsNode(self, node):
        return bool(node.get("driveable", True))

    async def run(self, invocation):
        node = invocation.get("node") or {}
        self.calls.append({"capabilityId": self.capabilityId, "taskId": invocation["context"].get("taskId"),
                           "node": node.get("id"), "requested": invocation["context"].get("nodeId")})
        if not self.ok:
            return {"ok": False, "detail": "the commit hook rejected it"}
        return {"ok": True, "detail": "ran", "output": {"text": f"ran on {node.get('id')}", "nodeId": node.get("id")}}


class _Env:
    def __init__(self, tmp_path, monkeypatch):
        from aura.audit import AuditStore
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.fabric import CapabilityFabric, FabricConfig
        from aura.fabric.host import WiringHost

        monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
        (tmp_path / "home").mkdir()
        self.home = tmp_path / "home"
        self.nodes: list[dict] = []
        self.calls: list[dict] = []
        env = self

        class _Nodes:
            def list_nodes(self):
                return list(env.nodes)

        audit = AuditStore(tmp_path / "audit" / "trail.jsonl")
        self.audit = audit
        fabric = CapabilityFabric(WiringHost(_Nodes()))
        fabric.attach_audit_store(audit.load, audit.append)
        for cap in ("git.diff", "git.status"):
            fabric.register(_Executor(cap, self.calls))
        fabric.register(_Executor("git.commit", self.calls, ok=False))
        cfg = FabricConfig(fabric=fabric, audit_store=audit, permissions={"read": True, "write": True})
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path))
        agent.controller.engine = None
        self.agent = agent
        self.controller: ExecutionController = agent.controller
        self.events: list[tuple[str, dict]] = []
        self.controller.emit = lambda kind, sid, **payload: self.events.append((kind, payload))
        self.billing(free=["git-free", "git-main"], authorized=["gemini-cli"])

    def billing(self, *, free=(), authorized=()):
        (self.home / "worker-policy.json").write_text(
            json.dumps({"verifiedFree": list(free), "authorized": list(authorized)}), encoding="utf-8")

    def plan(self, tasks):
        return TaskPlan(planId="plan-alt", sessionId="agt-aaaaaaaaaaaa",
                        intent=AgentIntent(goal="inspect the repository", expectedOutcome="it is inspected"),
                        tasks=tasks, createdAt="2026-11-15T00:00:00Z")

    def preflight(self, plan):
        """Exactly what the service does before execution."""
        requirements = self.agent.authority.check_plan(plan, "p")
        self.agent.authority.mark_denials(plan, requirements)
        return requirements

    def run(self, plan, **kw):
        return self.controller.execute(plan, "p", project_cwd=None,
                                       correlation={"session_id": "agt-aaaaaaaaaaaa"}, **kw)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    return _Env(tmp_path, monkeypatch)


def _task(tid, cap="git.diff", *, node="git-main", depends=(), inp=None):
    return TaskSpecification(id=tid, description=f"do {tid}", capabilityId=cap, nodeId=node,
                             dependsOn=list(depends), input=dict(inp or {}))


def _final(result, tid):
    return [o for o in result.outcomes if o.taskId == tid][-1]


def _rejections(result, tid):
    return {c["nodeId"]: (c["failed"], c["policy"], c["billing"])
            for c in result.provider_alternatives[tid]["candidates"] if not c["eligible"]}


# 1 ─────────────────────────────────────────────────────────────────────────────
def test_an_unavailable_node_hands_the_task_to_a_free_connected_alternative(env):
    env.nodes[:] = [_node("git-free")]          # git-main is not connected
    plan = env.plan([_task("inspect")])
    requirements = env.preflight(plan)
    assert requirements[0].rule == "unknown-or-unusable-node"
    assert plan.tasks[0].providerUnavailable

    result = env.run(plan)

    assert env.calls == [{"capabilityId": "git.diff", "taskId": "inspect", "node": "git-free", "requested": "git-free"}]
    final = _final(result, "inspect")
    assert (final.state, final.performed) == ("done", True)
    assert len(final.invocationIds) == 1                      # real Fabric evidence
    choice = result.provider_alternatives["inspect"]
    assert (choice["fromNode"], choice["selected"]) == ("git-main", "git-free")
    assert [(r["kind"], r["fromNode"], r["toNode"], r["state"]) for r in result.recovery] == [
        ("alternative-provider", "git-main", "git-free", "selected")]
    assert result.denied is False and result.stopped is False
    assert plan.tasks[0].id == "inspect"                      # identity preserved
    assert any(kind == "capability.alternative" and p["selected"] == "git-free" for kind, p in env.events)
    # The audit trail holds one invocation, on the alternative, and none on the original.
    trail = [r for r in env.audit.load() if r.get("capabilityId") == "git.diff"]
    assert len(trail) == 1 and trail[0]["outcome"] == "succeeded"


# 2 ─────────────────────────────────────────────────────────────────────────────
def test_a_registered_capability_with_no_connected_provider_is_not_an_alternative(env):
    env.nodes[:] = []                            # git.diff is in the manifest; nothing provides it
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan)

    assert env.calls == []
    final = _final(result, "inspect")
    assert (final.state, final.performed) == ("blocked", False)
    assert "'git-main' is not a connected node" in final.detail  # original pin reason is kept
    assert "No alternative provider was used" in final.detail
    assert result.provider_alternatives["inspect"]["selected"] is None
    assert result.provider_alternatives["inspect"]["candidates"] == []


# 3 ─────────────────────────────────────────────────────────────────────────────
def test_a_present_node_the_executor_cannot_drive_is_rejected(env):
    env.nodes[:] = [_node("git-free", driveable=False)]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan)

    assert env.calls == []
    assert _final(result, "inspect").state == "blocked"
    assert _rejections(result, "inspect") == {"git-free": ("execution", "", "")}
    assert "git-free (execution:" in _final(result, "inspect").detail


# 4 ─────────────────────────────────────────────────────────────────────────────
def test_an_alternative_denied_by_policy_is_never_selected_or_invoked(env, monkeypatch):
    env.nodes[:] = [_node("git-free")]
    real = AuthorityChecker.check_plan

    def deny_git_free(self, plan, project_id, project_path=None):
        out = real(self, plan, project_id, project_path)
        return [AuthorityRequirement(capabilityId=r.capabilityId, taskId=r.taskId, decision="deny",
                                     rule="node-rule", reason="git-free may not read this project",
                                     risk=r.risk, available=True)
                if next(t for t in plan.tasks if t.id == r.taskId).nodeId == "git-free" else r
                for r in out]

    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    monkeypatch.setattr(AuthorityChecker, "check_plan", deny_git_free)
    result = env.run(plan)

    assert env.calls == []
    assert _final(result, "inspect").state == "blocked"
    assert _rejections(result, "inspect") == {"git-free": ("policy", "deny", "")}
    assert "may not read this project" in result.provider_alternatives["inspect"]["candidates"][0]["reason"]


# 5 ─────────────────────────────────────────────────────────────────────────────
def test_an_alternative_without_billing_authorization_is_never_selected(env):
    env.nodes[:] = [_node("git-other")]          # connected and driveable, but the owner never allowed it
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan)

    assert env.calls == []
    assert _final(result, "inspect").state == "blocked"
    assert _rejections(result, "inspect") == {"git-other": ("billing", "auto-execute", "unknown")}


# 6 ─────────────────────────────────────────────────────────────────────────────
def test_among_several_alternatives_the_eligible_free_one_is_chosen(env):
    env.nodes[:] = [
        _node("git-broken", driveable=False),    # execution
        _node("git-other"),                      # billing
        _node("gemini-cli"),                     # eligible, but bills an account
        _node("git-free"),                       # eligible and free — listed LAST
        _node("browser", caps=("browser-automation",)),   # not a provider at all
    ]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan)

    assert [c["node"] for c in env.calls] == ["git-free"]
    choice = result.provider_alternatives["inspect"]
    assert choice["selected"] == "git-free"
    assert {c["nodeId"]: (c["eligible"], c["free"]) for c in choice["candidates"]} == {
        "git-broken": (False, False), "git-other": (False, False),
        "gemini-cli": (True, False), "git-free": (True, True)}
    assert "does not bill" in choice["reason"]
    assert _final(result, "inspect").state == "done"


def test_a_paid_but_authorized_alternative_is_used_only_when_no_free_one_exists(env):
    env.nodes[:] = [_node("git-other"), _node("gemini-cli")]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan)
    assert [c["node"] for c in env.calls] == ["gemini-cli"]
    assert "owner-authorized" in result.provider_alternatives["inspect"]["reason"]


# 7 ─────────────────────────────────────────────────────────────────────────────
def test_no_alternatives_keeps_the_original_reason_and_invents_nothing(env):
    env.nodes[:] = [_node("browser", caps=("browser-automation",))]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    original = plan.tasks[0].policyDeniedReason
    result = env.run(plan)

    final = _final(result, "inspect")
    assert (final.state, final.performed, final.verified, final.invocationIds) == ("blocked", False, None, [])
    assert original in final.detail
    assert "inspect" not in result.verified_outputs
    assert result.recovery[0]["state"] == "none-eligible"


# 8 ─────────────────────────────────────────────────────────────────────────────
def test_a_non_agent_task_that_failed_after_dispatch_is_never_replayed(env):
    """git.commit reached its executor and failed there: it may have had effects."""
    env.nodes[:] = [_node("git-main"), _node("git-free")]
    plan = env.plan([_task("publish", cap="git.commit", inp={"message": "wip"})])
    env.preflight(plan)
    assert plan.tasks[0].policyDeniedReason is None
    result = env.run(plan)

    assert [(c["capabilityId"], c["node"]) for c in env.calls] == [("git.commit", "git-main")]
    assert _final(result, "publish").state == "failed"
    assert "the commit hook rejected it" in _final(result, "publish").detail
    assert result.provider_alternatives == {} and result.recovery == []


def test_a_settled_task_is_never_offered_an_alternative(env):
    env.nodes[:] = [_node("git-free")]
    plan = env.plan([_task("inspect")])
    from aura.central_agent.execution import ExecutionOutcome
    from aura.contracts.agent import TaskOutcome

    for settled in ("done", "denied", "cancelled", "failed"):
        result = ExecutionOutcome(outcomes=[TaskOutcome(taskId="inspect", state=settled)])
        result.plan = plan
        assert env.controller._alternative_provider(plan.tasks[0], "p", result, None, "gone") is False
    verified = ExecutionOutcome(verified_outputs={"inspect": {"verified": True}})
    verified.plan = plan
    assert env.controller._alternative_provider(plan.tasks[0], "p", verified, None, "gone") is False
    assert plan.tasks[0].nodeId == "git-main" and env.calls == []


# 9 + 10 ────────────────────────────────────────────────────────────────────────
def test_independent_work_continues_and_dependents_stay_blocked(env):
    env.nodes[:] = [_node("git-status-node")]    # serves the independent task only
    env.billing(free=["git-status-node"])
    plan = env.plan([
        _task("inspect"),                                         # git-main missing, no alternative allowed…
        _task("after", cap="git.status", node=None, depends=["inspect"]),
        _task("independent", cap="git.status", node=None),
    ])
    # …because the only other provider is not driveable for git.diff in this scenario.
    env.controller._cfg.fabric.executors["git.diff"].supportsNode = lambda node: False
    env.preflight(plan)
    result = env.run(plan)

    assert [(c["taskId"], c["node"]) for c in env.calls] == [("independent", "git-status-node")]
    assert _final(result, "inspect").state == "blocked"
    assert _final(result, "independent").state == "done"
    blocked = _final(result, "after")
    assert blocked.state == "blocked" and "depends on inspect" in blocked.detail


def test_a_dependent_runs_once_its_upstream_was_recovered_on_an_alternative(env):
    env.nodes[:] = [_node("git-free")]
    plan = env.plan([_task("inspect"), _task("after", cap="git.status", node=None, depends=["inspect"])])
    env.preflight(plan)
    result = env.run(plan)
    assert [(c["taskId"], c["node"]) for c in env.calls] == [("inspect", "git-free"), ("after", "git-free")]
    assert _final(result, "after").state == "done"


def test_unpinned_task_keeps_successful_fabric_default_routing(env):
    env.nodes[:] = [_node("git-free")]
    plan = env.plan([_task("inspect", node=None)])
    env.preflight(plan)

    result = env.run(plan)

    assert [(c["taskId"], c["node"]) for c in env.calls] == [("inspect", "git-free")]
    assert result.provider_alternatives == {}
    assert plan.tasks[0].nodeId is None
    assert _final(result, "inspect").state == "done"


def test_unpinned_billing_rejection_selects_an_eligible_free_alternative(env):
    # Fabric's regular first route is connected and executable, but unknown
    # billing prevents it from being invoked. The next candidate is free.
    env.nodes[:] = [_node("git-other"), _node("git-free")]
    env.billing(free=["git-free"])
    plan = env.plan([_task("inspect", node=None)])
    env.preflight(plan)

    result = env.run(plan)

    assert [(c["taskId"], c["node"]) for c in env.calls] == [("inspect", "git-free")]
    choice = result.provider_alternatives["inspect"]
    assert (choice["fromNode"], choice["selected"]) == ("git-other", "git-free")
    assert [(c["nodeId"], c["eligible"], c["free"])
            for c in choice["candidates"]] == [("git-free", True, True)]
    assert _final(result, "inspect").state == "done"


def test_unpinned_route_with_no_billing_eligible_alternative_stays_blocked(env):
    env.nodes[:] = [_node("git-other")]
    plan = env.plan([_task("inspect", node=None)])
    env.preflight(plan)

    result = env.run(plan)

    assert env.calls == []
    assert _final(result, "inspect").state == "blocked"
    assert result.provider_alternatives["inspect"]["selected"] is None
    assert "git-other" in _final(result, "inspect").detail


def test_named_billing_ineligible_provider_can_handoff_to_eligible_candidate(env):
    env.nodes[:] = [_node("git-other"), _node("git-free")]
    env.billing(free=["git-free"])
    plan = env.plan([_task("inspect", node="git-other")])
    env.preflight(plan)

    result = env.run(plan)

    assert [(c["taskId"], c["node"]) for c in env.calls] == [("inspect", "git-free")]
    assert result.provider_alternatives["inspect"]["fromNode"] == "git-other"
    assert result.provider_alternatives["inspect"]["selected"] == "git-free"
    assert _final(result, "inspect").state == "done"


def test_cancellation_after_alternative_selection_prevents_fabric_invocation(env):
    class Token:
        cancelled = False

        def request(self, reason="Stopped before invocation."):
            self.cancelled = True
            self.reason = reason

        def snapshot(self):
            return {"reason": getattr(self, "reason", "Stopped before dispatch.")}

        def note_dispatch(self, *_args, **_kwargs):
            pass

    env.nodes[:] = [_node("git-other"), _node("git-free")]
    env.billing(free=["git-free"])
    plan = env.plan([_task("inspect", node=None)])
    env.preflight(plan)
    token = Token()
    select = env.controller._alternative_provider

    def select_then_stop(*args, **kwargs):
        selected = select(*args, **kwargs)
        token.request()
        return selected

    env.controller._alternative_provider = select_then_stop
    result = env.run(plan, cancel_token=token)

    assert env.calls == []
    assert result.cancelled is True
    assert _final(result, "inspect").state == "cancelled"
    assert _final(result, "inspect").performed is False


# 11 ────────────────────────────────────────────────────────────────────────────
def test_a_stop_before_the_alternative_is_dispatched_runs_nothing(env):
    env.nodes[:] = [_node("git-free")]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    result = env.run(plan, cancel_check=lambda: True)

    assert env.calls == []
    assert result.cancelled is True and result.cancelled_before == ["inspect"]
    assert result.provider_alternatives == {}                  # not even selected
    assert plan.tasks[0].nodeId == "git-main"


# 12 ────────────────────────────────────────────────────────────────────────────
def test_fabric_revalidates_the_pinned_alternative_at_invocation(env):
    """The alternative is selected, then disappears before Fabric routes it."""
    env.nodes[:] = [_node("git-free")]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    controller = env.controller
    select = controller._alternative_provider

    def select_then_disconnect(*args, **kwargs):
        picked = select(*args, **kwargs)
        env.nodes[:] = []                        # gone between selection and invocation
        return picked

    controller._alternative_provider = select_then_disconnect
    result = env.run(plan)

    assert result.provider_alternatives["inspect"]["selected"] == "git-free"
    assert env.calls == []                        # Fabric refused; the executor never ran
    final = _final(result, "inspect")
    assert final.state == "blocked" and final.performed is False
    assert "git-free" in final.detail
    # One decision per task: the refusal is not followed by another selection.
    assert len([r for r in result.recovery if r["kind"] == "alternative-provider"]) == 1


def test_fabric_itself_refuses_a_pin_that_is_not_connected(env):
    env.nodes[:] = []
    from aura.fabric import invoke_fabric

    got = invoke_fabric("git.diff", {}, {"actor": {"kind": "agent", "id": "central-agent"},
                                         "projectId": "p", "taskId": "t", "nodeId": "git-free"},
                        env.controller._cfg)
    assert (got["outcome"], got["policy"]["rule"]) == ("denied", "unknown-node")
    assert env.calls == []


# dispatch-time: the node disappears after preflight passed ─────────────────────
def test_a_node_that_vanishes_after_preflight_is_replaced_before_any_invocation(env):
    env.nodes[:] = [_node("git-main"), _node("git-free")]
    plan = env.plan([_task("inspect")])
    env.preflight(plan)
    assert plan.tasks[0].policyDeniedReason is None
    env.nodes[:] = [_node("git-free")]           # git-main drops out before dispatch
    result = env.run(plan)

    assert [c["node"] for c in env.calls] == ["git-free"]
    assert _final(result, "inspect").state == "done"
    assert result.provider_alternatives["inspect"]["fromNode"] == "git-main"


def test_a_real_policy_denial_is_not_treated_as_an_unavailable_provider(env):
    env.nodes[:] = [_node("git-main"), _node("git-free")]
    plan = env.plan([_task("inspect")])
    plan.tasks[0].policyDeniedReason = "git.diff: reading this project is not permitted"
    result = env.run(plan)
    assert env.calls == []
    assert _final(result, "inspect").state == "denied"
    assert result.provider_alternatives == {}


@pytest.mark.parametrize("rule", [
    "unknown-or-unusable-node", "unknown-node", "node-lacks-capability",
    "node-unsupported", "no-provider",
])
def test_authority_marks_only_fabric_route_failures_as_provider_unavailability(env, rule):
    plan = env.plan([_task("inspect", node=None)])
    requirement = AuthorityRequirement(
        capabilityId="git.diff", taskId="inspect", decision="deny",
        rule=rule, reason=f"route unavailable: {rule}", risk="low", available=False)

    AuthorityChecker.mark_denials(plan, [requirement])

    assert plan.tasks[0].providerUnavailable == f"route unavailable: {rule}"
    assert "route unavailable" in plan.tasks[0].policyDeniedReason


def test_authority_does_not_relabel_permission_denial_as_unavailability(env):
    plan = env.plan([_task("inspect", node=None)])
    requirement = AuthorityRequirement(
        capabilityId="git.diff", taskId="inspect", decision="deny",
        rule="permission-denied", reason="project access prohibited",
        risk="low", available=True)

    AuthorityChecker.mark_denials(plan, [requirement])

    assert plan.tasks[0].policyDeniedReason
    assert plan.tasks[0].providerUnavailable is None


def test_agent_tasks_are_left_to_the_existing_worker_recovery(env):
    env.nodes[:] = [_node("kilo-code", caps=("coding-agent",))]
    plan = env.plan([TaskSpecification(id="build", description="build it", capabilityId="agent.delegate",
                                       nodeId="claude-code", input={"task": "build it"})])
    env.preflight(plan)
    assert plan.tasks[0].policyDeniedReason and plan.tasks[0].providerUnavailable is None


# the selection chain on its own ────────────────────────────────────────────────
def test_selection_refuses_when_the_capability_itself_is_unavailable():
    choice = select_alternative(
        capability_id="git.diff", needed="source-control", original_node="git-main",
        capability_available=(False, "measured machine lacks git"), present_nodes=[_node("git-free")],
        can_use=None, has_executor=True, policy_for=lambda n: ("auto-execute", ""),
        billing_for=lambda n: None, is_free=lambda n: True)
    assert choice.selected is None and "measured machine lacks git" in choice.reason


def test_selection_never_offers_the_original_node_and_fails_closed_on_errors():
    def boom(node_id):
        raise RuntimeError("policy store unreadable")

    choice = select_alternative(
        capability_id="git.diff", needed="source-control", original_node="git-main",
        capability_available=(True, ""), present_nodes=[_node("git-main"), _node("git-free")],
        can_use=None, has_executor=True, policy_for=boom,
        billing_for=lambda n: None, is_free=lambda n: True)
    assert choice.selected is None
    assert [(c.nodeId, c.failed) for c in choice.candidates] == [("git-free", "policy")]
