"""Negative controls for the Capability Fabric.

The Fabric is the single governance authority. These tests assert the
properties that make that claim true — every one of them describes
something an attacker, a bug, or a careless configuration would otherwise
get away with.

The differential harness proves the Python fabric behaves like the
TypeScript one. These prove the behaviour is the *right* one, and cover
the host-side stores that live outside the reference's pure-domain
package.
"""

from __future__ import annotations

import json

import pytest

from aura_backend.fabric import (
    CAPABILITY_MANIFEST,
    LOCAL_GRANTS,
    NO_GRANTS,
    ApprovalItem,
    ApprovalRequest,
    ApprovalStore,
    AuditRecord,
    AuditStore,
    CapabilityFabric,
    ExecutorResult,
    InvocationActor,
    InvocationContext,
    NodeRef,
    RunScopeRegistry,
    ServiceFabricHost,
    describe_fabric_capability,
    grants_for_scopes,
    load_policy,
    resolve_node_for,
    save_policy,
)
from aura_backend.fabric.stores import MAX_RECORDS, TRIM_TRIGGER
from aura_backend.policy import PermissionScope, PolicyDecision, RiskLevel

AGENT = InvocationActor(kind="agent", id="mission:m1")
GIT = NodeRef(id="git", name="Git", capabilities=("source-control",))
OPENCODE = NodeRef(id="opencode", name="OpenCode", capabilities=("coding-agent",))


def ctx(**kw) -> InvocationContext:
    return InvocationContext(actor=AGENT, project_id="proj", **kw)


class Recording:
    """An executor that records whether it ever ran."""

    def __init__(self, capability_id: str) -> None:
        self.capability_id = capability_id
        self.ran = 0

    async def run(self, _invocation) -> ExecutorResult:
        self.ran += 1
        return ExecutorResult(True, "done")


def make_fabric(nodes: list[NodeRef] | None = None) -> CapabilityFabric:
    host = ServiceFabricHost(
        present_nodes=lambda: list(nodes or []),
        provided_node_capabilities=lambda: {c for n in (nodes or []) for c in n.capabilities},
    )
    return CapabilityFabric(host)


# --------------------------------------------------------------------------
# Nothing executes without passing the whole pipeline.
# --------------------------------------------------------------------------


async def test_a_gated_capability_never_reaches_its_executor():
    fabric = make_fabric([OPENCODE])
    executor = Recording("agent.delegate")
    fabric.register(executor)
    result = await fabric.invoke("agent.delegate", {"task": "rewrite it all"}, ctx())
    assert result.outcome == "awaiting-approval"
    assert executor.ran == 0, "an unapproved irreversible action reached the executor"


async def test_a_denied_capability_never_reaches_its_executor():
    fabric = make_fabric([])  # no source-control node
    executor = Recording("git.status")
    fabric.register(executor)
    result = await fabric.invoke("git.status", {}, ctx())
    assert result.outcome == "denied"
    assert executor.ran == 0


async def test_an_invalid_argument_never_reaches_its_executor():
    fabric = make_fabric([GIT])
    executor = Recording("git.commit")
    fabric.register(executor)
    result = await fabric.invoke("git.commit", {}, ctx())
    assert result.outcome == "failed"
    assert result.policy.rule == "invalid-input"
    assert executor.ran == 0


async def test_an_unknown_capability_is_refused_by_name():
    fabric = make_fabric()
    result = await fabric.invoke("shell.anything", {"command": "rm -rf /"}, ctx())
    assert result.outcome == "failed"
    assert result.policy.rule == "unknown-capability"


# --------------------------------------------------------------------------
# Approvals cannot be forged, reused or inferred.
# --------------------------------------------------------------------------


async def test_a_grant_for_one_capability_does_not_cover_another():
    fabric = make_fabric([GIT])
    commit, branch = Recording("git.commit"), Recording("git.branch")
    fabric.register(commit)
    fabric.register(branch)

    approved = ctx(approved_capabilities=("git.commit",))
    assert (await fabric.invoke("git.commit", {"message": "x"}, approved)).outcome == "succeeded"
    parked = await fabric.invoke("git.branch", {"name": "feat"}, approved)
    assert parked.outcome == "awaiting-approval"
    assert branch.ran == 0


async def test_a_client_can_approve_a_request_but_never_name_a_capability():
    """The grant is derived from the STORED request. That asymmetry is what
    stops an approval from becoming an arbitrary authorization."""
    fabric = make_fabric([GIT])
    fabric.register(Recording("git.commit"))
    await fabric.invoke("git.commit", {"message": "x"}, ctx(mission_id="m", task_id="t"))
    request = fabric.pending_approvals()[0]
    assert [i.capability_id for i in request.items] == ["git.commit"]
    # There is no API surface by which a decision names a capability.
    decided = fabric.decide_approval(request.id, True)
    assert decided is not None
    assert [i.capability_id for i in decided.items] == ["git.commit"]


async def test_a_spent_grant_cannot_be_spent_again():
    fabric = make_fabric([GIT])
    executor = Recording("git.commit")
    fabric.register(executor)
    context = ctx(mission_id="m", task_id="t")

    await fabric.invoke("git.commit", {"message": "x"}, context)
    request = fabric.pending_approvals()[0]
    fabric.decide_approval(request.id, True)

    assert (await fabric.invoke("git.commit", {"message": "x"}, context)).outcome == "succeeded"
    again = await fabric.invoke("git.commit", {"message": "x"}, context)
    assert again.outcome == "awaiting-approval", "a spent grant re-authorized an action"
    assert executor.ran == 1


async def test_deciding_an_already_decided_request_is_a_no_op():
    fabric = make_fabric([GIT])
    fabric.register(Recording("git.commit"))
    await fabric.invoke("git.commit", {"message": "x"}, ctx(mission_id="m", task_id="t"))
    request = fabric.pending_approvals()[0]
    assert fabric.decide_approval(request.id, True) is not None
    assert fabric.decide_approval(request.id, True) is None, "double-click re-authorized"
    assert fabric.decide_approval(request.id, False) is None
    assert fabric.decide_approval("apr-does-not-exist", True) is None


async def test_a_declined_request_runs_nothing_and_is_recorded():
    fabric = make_fabric([GIT])
    executor = Recording("git.commit")
    fabric.register(executor)
    context = ctx(mission_id="m", task_id="t")
    await fabric.invoke("git.commit", {"message": "x"}, context)
    request = fabric.pending_approvals()[0]
    fabric.decide_approval(request.id, False, "user", "not now")

    assert executor.ran == 0
    declined = [r for r in fabric.audit() if r.approval_decision == "denied"]
    assert len(declined) == 1
    assert declined[0].decided_by == "user"
    assert declined[0].outcome == "denied"


async def test_a_throwing_host_is_a_refusal_never_a_bypass():
    class ExplodingHost(ServiceFabricHost):
        async def request_approval(self, request, context):
            raise RuntimeError("the approval UI fell over")

    fabric = CapabilityFabric(ExplodingHost(present_nodes=lambda: [GIT]))
    executor = Recording("git.commit")
    fabric.register(executor)
    result = await fabric.invoke("git.commit", {"message": "x"}, ctx())
    assert result.outcome == "awaiting-approval"
    assert executor.ran == 0


# --------------------------------------------------------------------------
# Routing refuses; it never substitutes.
# --------------------------------------------------------------------------


def test_a_requested_node_is_never_silently_swapped():
    capability = describe_fabric_capability("agent.delegate")
    resolution = resolve_node_for(
        capability, ctx(node_id="claude"), [OPENCODE], can_use=lambda n: n.id == "opencode"
    )
    assert resolution.ok is False
    assert resolution.code == "unknown-node"


def test_an_undrivable_requested_node_is_refused_not_redirected():
    capability = describe_fabric_capability("agent.delegate")
    claude = NodeRef(id="claude", name="Claude Code", capabilities=("coding-agent",))
    resolution = resolve_node_for(
        capability, ctx(node_id="claude"), [OPENCODE, claude],
        can_use=lambda n: n.id == "opencode",
    )
    assert resolution.ok is False
    assert resolution.code == "node-unsupported"


def test_catalogue_order_is_the_documented_tiebreak():
    capability = describe_fabric_capability("agent.delegate")
    claude = NodeRef(id="claude", name="Claude Code", capabilities=("coding-agent",))
    first = resolve_node_for(capability, ctx(), [claude, OPENCODE])
    second = resolve_node_for(capability, ctx(), [OPENCODE, claude])
    assert first.node.id == "claude"
    assert second.node.id == "opencode"


# --------------------------------------------------------------------------
# Run scopes narrow; they never widen.
# --------------------------------------------------------------------------


def test_an_unregistered_run_gets_nothing_not_the_ceiling():
    """'I do not know what this is allowed to do' means 'nothing'."""
    registry = RunScopeRegistry()
    assert registry.for_run("never-registered") == NO_GRANTS
    assert registry.for_run(None) is None


def test_no_scope_set_can_exceed_the_ceiling():
    every = list(PermissionScope)
    grants = grants_for_scopes(every)
    assert grants.autonomous is False, "autonomous is never grantable by a scope"
    for flag in ("read", "write", "execute", "autonomous"):
        assert getattr(grants, flag) <= getattr(LOCAL_GRANTS, flag)


def test_human_only_scopes_grant_nothing():
    for scope in (
        PermissionScope.ACCOUNT_AUTHORIZE,
        PermissionScope.RESOURCE_DESTROY,
        PermissionScope.SYSTEM_MODIFY,
    ):
        assert grants_for_scopes([scope]) == NO_GRANTS


def test_a_released_run_keeps_nothing():
    registry = RunScopeRegistry()
    registry.register("r1", [PermissionScope.PROJECT_WRITE])
    assert registry.for_run("r1").write is True
    registry.release("r1")
    assert registry.for_run("r1") == NO_GRANTS


# --------------------------------------------------------------------------
# Secrets never reach the trail.
# --------------------------------------------------------------------------


async def test_an_api_key_is_redacted_in_the_approval_request_and_the_audit():
    fabric = make_fabric()
    fabric.register(Recording("provider.connect"))
    await fabric.invoke(
        "provider.connect",
        {"providerId": "groq", "apiKey": "sk-super-secret-never-log-me"},
        ctx(mission_id="m", task_id="t"),
    )
    request = fabric.pending_approvals()[0]
    blob = json.dumps(request.to_json()) + json.dumps(
        [r.to_json() for r in fabric.audit()]
    )
    assert "sk-super-secret-never-log-me" not in blob
    assert "<redacted>" in blob


async def test_a_long_argument_is_bounded_in_the_trail():
    fabric = make_fabric()
    fabric.register(Recording("filesystem.write"))
    await fabric.invoke(
        "filesystem.write",
        {"path": "a.txt", "content": "y" * 5000},
        ctx(approved_capabilities=("filesystem.write",)),
    )
    summary = fabric.audit()[-1].input_summary
    assert len(summary) < 200
    assert "…" in summary


# --------------------------------------------------------------------------
# Attribution is never invented.
# --------------------------------------------------------------------------


async def test_a_parked_call_records_no_executed_node():
    fabric = make_fabric([OPENCODE])
    fabric.register(Recording("agent.delegate"))
    await fabric.invoke("agent.delegate", {"task": "x"}, ctx())
    record = fabric.audit()[-1]
    assert record.executed_node_id is None
    assert record.node_id is None


async def test_a_nodeless_capability_never_claims_a_node():
    """system.install's output names the node being INSTALLED — the object
    of the work, not the actor. It must not become attribution."""

    class Installer:
        capability_id = "system.install"

        async def run(self, _invocation):
            return ExecutorResult(True, "installed", {"nodeId": "pnpm"})

    fabric = make_fabric()
    fabric.register(Installer())
    await fabric.invoke(
        "system.install", {"nodeId": "pnpm"},
        ctx(approved_capabilities=("system.install",)),
    )
    record = fabric.audit()[-1]
    assert record.executed_node_id is None, "an installed tool was credited as the actor"


# --------------------------------------------------------------------------
# The manifest stays honest.
# --------------------------------------------------------------------------


def test_every_high_risk_capability_reaches_a_human_under_the_default_policy():
    fabric = make_fabric()
    for capability in CAPABILITY_MANIFEST:
        if capability.risk is not RiskLevel.HIGH:
            continue
        evaluation = fabric.evaluate(capability.id, ctx())
        # Either it needs authorization, or it is denied outright for want
        # of a provider. Neither is silent.
        assert evaluation.decision in (
            PolicyDecision.REQUIRE_APPROVAL,
            PolicyDecision.DENY,
        ), capability.id


def test_a_capability_with_no_executor_reports_unsupported_rather_than_pretending():
    fabric = make_fabric()
    assert fabric.supported() == []
    for capability in CAPABILITY_MANIFEST:
        assert fabric.is_supported(capability.id) is False


def test_capability_ids_are_unique():
    ids = [c.id for c in CAPABILITY_MANIFEST]
    assert len(ids) == len(set(ids))


# --------------------------------------------------------------------------
# Persistence: the stores are host-side and unreachable by the differential
# harness, so they get their own controls.
# --------------------------------------------------------------------------


def _request(state: str, approval_id: str = "apr-1", consumed: str | None = None):
    return ApprovalRequest(
        id=approval_id, state=state, requested_at="2026-01-01T00:00:00.000Z",
        summary="s", rule="irreversible-floor", mission_id="m", task_id="t",
        consumed_at=consumed,
        items=[ApprovalItem("inv1", "agent.delegate", "Delegate", "task=x",
                            RiskLevel.HIGH, True)],
    )


def test_only_pending_approvals_survive_a_restart(tmp_path):
    """An unspent grant must not survive. Reinstating it would mean a
    restart silently re-authorizing an action whose user is no longer there
    to see it happen."""
    store = ApprovalStore(tmp_path)
    store.save([_request("pending", "apr-1"), _request("granted", "apr-2")])
    reloaded = store.load()
    assert [r.id for r in reloaded] == ["apr-1"]


def test_an_unspent_grant_is_dropped_on_reattach(tmp_path):
    store = ApprovalStore(tmp_path)
    store.save([_request("pending")])
    # Simulate a grant written by a process that then died.
    raw = json.loads((tmp_path / "fabric-approvals.json").read_text())
    raw[0]["state"] = "granted"
    (tmp_path / "fabric-approvals.json").write_text(json.dumps(raw))

    fabric = make_fabric([OPENCODE])
    fabric.attach_approval_store(ApprovalStore(tmp_path))
    assert fabric.pending_approvals() == []
    assert fabric.approval_by_id("apr-1") is None


def test_a_malformed_approval_file_yields_nothing_rather_than_crashing(tmp_path):
    (tmp_path / "fabric-approvals.json").write_text("{not json", encoding="utf-8")
    assert ApprovalStore(tmp_path).load() == []


def test_the_audit_trail_is_append_only(tmp_path):
    store = AuditStore(tmp_path)
    for i in range(3):
        store.append(
            AuditRecord(
                invocation_id=f"inv{i}", at="2026-01-01T00:00:00.000Z",
                capability_id="git.status", actor=AGENT, project_id="p",
                risk=RiskLevel.LOW, decision=PolicyDecision.AUTO_EXECUTE,
                decision_rule="risk-default:low", outcome="succeeded", verified=None,
                duration_ms=1, input_summary="(no arguments)",
            )
        )
    lines = (tmp_path / "fabric-audit.jsonl").read_text().strip().split("\n")
    assert len(lines) == 3
    assert [json.loads(x)["invocationId"] for x in lines] == ["inv0", "inv1", "inv2"]
    # There is deliberately no save-all API to rewrite it with.
    assert not hasattr(store, "save")


def test_a_truncated_final_line_costs_one_record_not_the_trail(tmp_path):
    path = tmp_path / "fabric-audit.jsonl"
    good = json.dumps({"invocationId": "inv1", "at": "t", "capabilityId": "git.status"})
    path.write_text(f"{good}\n{{\"invocationId\": \"inv2\", \"at\"", encoding="utf-8")
    loaded = AuditStore(tmp_path).load()
    assert [r.invocation_id for r in loaded] == ["inv1"]


def test_trimming_drops_the_oldest_and_keeps_recent_history(tmp_path):
    path = tmp_path / "fabric-audit.jsonl"
    path.write_text(
        "\n".join(
            json.dumps({"invocationId": f"inv{i}", "at": "t", "capabilityId": "git.status"})
            for i in range(TRIM_TRIGGER + 50)
        )
        + "\n",
        encoding="utf-8",
    )
    store = AuditStore(tmp_path)
    store._since_trim = 999
    store.append(
        AuditRecord(
            invocation_id="newest", at="t", capability_id="git.status", actor=AGENT,
            project_id="p", risk=RiskLevel.LOW, decision=PolicyDecision.AUTO_EXECUTE,
            decision_rule="r", outcome="succeeded", verified=None, duration_ms=0,
            input_summary="",
        )
    )
    kept = [json.loads(x)["invocationId"] for x in path.read_text().strip().split("\n")]
    assert len(kept) == MAX_RECORDS
    assert kept[-1] == "newest", "the newest record was trimmed"
    assert "inv0" not in kept, "trimming did not drop the oldest"


def test_a_failing_audit_store_never_fails_the_action():
    class Broken:
        def load(self):
            return []

        def append(self, record):
            raise OSError("disk full")

    fabric = make_fabric([GIT])
    fabric.attach_audit_store(Broken())
    fabric.register(Recording("git.status"))

    import asyncio

    result = asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        fabric.invoke("git.status", {}, ctx())
    )
    assert result.outcome == "succeeded", "a logging failure took down a real effect"
    assert len(fabric.audit()) == 1


def test_a_corrupt_policy_file_degrades_to_the_shipped_default(tmp_path):
    (tmp_path / "fabric-policy.json").write_text("not json at all", encoding="utf-8")
    policy = load_policy(tmp_path)
    assert policy.by_risk[RiskLevel.HIGH] is PolicyDecision.REQUIRE_APPROVAL


def test_saving_a_policy_returns_what_the_engine_will_actually_use(tmp_path):
    stored = save_policy(tmp_path, {"byRisk": {"high": "yolo"}, "allowAutonomous": "sure"})
    assert stored.by_risk[RiskLevel.HIGH] is PolicyDecision.REQUIRE_APPROVAL
    assert stored.allow_autonomous is False
    assert load_policy(tmp_path).allow_autonomous is False


@pytest.mark.parametrize("hostile", ["../../etc/passwd", "", "  "])
def test_a_policy_file_cannot_smuggle_an_unknown_decision(tmp_path, hostile):
    stored = save_policy(tmp_path, {"overrides": {hostile: "auto-execute"}})
    assert hostile.strip() == "" or stored.overrides.get(hostile) is PolicyDecision.AUTO_EXECUTE
    # Whatever the key, a floor-bearing capability is untouched by it.
    fabric = make_fabric([OPENCODE])
    fabric.set_policy(stored)
    assert fabric.evaluate("agent.delegate", ctx()).rule == "irreversible-floor"
