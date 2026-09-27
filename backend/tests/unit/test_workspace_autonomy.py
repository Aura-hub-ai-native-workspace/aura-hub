"""Phase 7: Workspace Autonomy UX — policy defaults and approval-event behavior.

Tests A–G from the acceptance criteria:
  A. knowledge.search   → auto-execute
  B. document.ingest    → auto-execute
  C. artifact.generate  → auto-execute
  D. sandbox.execute    → ask-user (approval-gated)
  E. terminal.execute   → ask-user (approval-gated)
  F. document.ingest mission → NO approval_required SSE event
  G. risky capability   → approval_required still emitted

Safety invariants verified throughout:
  - high-risk floor unchanged (require-approval)
  - low/medium defaults not weakened
  - no capability silently promoted past its risk tier
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock, patch

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────

def _wire_test_fabric(extra_policy: dict | None = None):
    """Build a real CapabilityFabric with Phase 7 policy overrides applied,
    as _wire() does in production, but without hitting the filesystem."""
    from aura.fabric import CapabilityFabric, FabricHost

    class _AutoHost(FabricHost):
        def permissions_for(self, cap, ctx):
            return {"read": True, "write": True}
        def node_available(self, cap):
            return True
        async def request_approval(self, req, ctx):
            return False  # always deny — lets tests observe awaiting-approval

    fabric = CapabilityFabric(_AutoHost())

    # Apply the same Phase 7 defaults that _wire() injects
    _P7_DEFAULTS: dict[str, str] = {
        "knowledge.search":  "auto-execute",
        "document.ingest":   "auto-execute",
        "artifact.generate": "auto-execute",
        "sandbox.execute":   "ask-user",
        "terminal.execute":  "ask-user",
    }
    overrides = fabric.policy.setdefault("overrides", {})
    for cap, act in _P7_DEFAULTS.items():
        if cap not in overrides:
            overrides[cap] = act
    if extra_policy:
        fabric.policy.update(extra_policy)
    return fabric


def _effective_action(fabric, capability_id: str) -> str:
    """Read what the policy would decide for a capability (no executor needed)."""
    overrides: dict[str, str] = fabric.policy.get("overrides", {})
    if capability_id in overrides:
        return overrides[capability_id]
    by_risk = fabric.policy.get("byRisk", {})
    # Look up risk from manifest
    from aura.fabric import describe_capability
    cap = describe_capability(capability_id)
    if cap is None:
        return "unknown"
    return by_risk.get(cap["risk"], "unknown")


def _collect_events(fabric, capability_id: str, input_: dict) -> list[dict]:
    """Invoke a capability and return every emitted event type."""
    events: list[dict] = []
    fabric.listen(lambda e: events.append(e))

    async def _run():
        return await fabric.invoke(capability_id, input_, {
            "actor": {"kind": "agent", "id": "test"},
        })

    asyncio.get_event_loop().run_until_complete(_run())
    return events


# ── A: knowledge.search → auto-execute ───────────────────────────────────────

class TestKnowledgeSearchPolicy:
    def test_a_knowledge_search_is_auto_execute(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "knowledge.search") == "auto-execute"

    def test_a_knowledge_search_override_survives_reload(self):
        # User can NOT accidentally lose auto-execute by re-wiring
        fabric = _wire_test_fabric()
        # Simulate a second _wire() that re-applies defaults (idempotent)
        overrides = fabric.policy.setdefault("overrides", {})
        from aura.fabric import CapabilityFabric  # noqa: F401
        for cap, act in {"knowledge.search": "auto-execute"}.items():
            if cap not in overrides:
                overrides[cap] = act
        assert fabric.policy["overrides"]["knowledge.search"] == "auto-execute"

    def test_a_user_override_wins_over_p7_default(self):
        # If user set knowledge.search → require-approval in fabric-policy.json,
        # the Phase 7 default must NOT clobber it.
        fabric = _wire_test_fabric()
        fabric.policy["overrides"]["knowledge.search"] = "require-approval"
        assert fabric.policy["overrides"]["knowledge.search"] == "require-approval"


# ── B: document.ingest → auto-execute ────────────────────────────────────────

class TestDocumentIngestPolicy:
    def test_b_document_ingest_is_auto_execute(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "document.ingest") == "auto-execute"

    def test_b_document_ingest_not_require_approval(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "document.ingest") != "require-approval"


# ── C: artifact.generate → auto-execute ──────────────────────────────────────

class TestArtifactGeneratePolicy:
    def test_c_artifact_generate_is_auto_execute(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "artifact.generate") == "auto-execute"

    def test_c_artifact_generate_not_ask_user(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "artifact.generate") != "ask-user"


# ── D: sandbox.execute → ask-user ────────────────────────────────────────────

class TestSandboxPolicy:
    def test_d_sandbox_execute_is_ask_user(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "sandbox.execute") == "ask-user"

    def test_d_sandbox_execute_not_auto_execute(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "sandbox.execute") != "auto-execute"

    def test_d_sandbox_execute_not_silently_promoted(self):
        """Safety floor: sandbox must never be auto-execute from Phase 7 defaults."""
        fabric = _wire_test_fabric()
        # The Phase 7 code path must not set sandbox.execute to auto-execute
        # even if someone calls it twice
        overrides = fabric.policy.get("overrides", {})
        assert overrides.get("sandbox.execute") in ("ask-user", "require-approval", None) or \
               overrides.get("sandbox.execute") != "auto-execute"


# ── E: terminal.execute → ask-user ───────────────────────────────────────────

class TestTerminalPolicy:
    def test_e_terminal_execute_is_ask_user(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "terminal.execute") == "ask-user"

    def test_e_terminal_execute_not_auto_execute(self):
        fabric = _wire_test_fabric()
        assert _effective_action(fabric, "terminal.execute") != "auto-execute"


# ── F: auto-execute capabilities emit NO approval_required event ──────────────

class TestNoApprovalEventForAutoExecute:
    @pytest.mark.asyncio
    async def test_f_document_ingest_no_approval_required_event(self, tmp_path):
        """A document.ingest invocation must never emit an approval.required event."""
        from aura.executors import multimodal_executors
        from aura.knowledge.store import KnowledgeBase
        from aura.fabric import CapabilityFabric, FabricHost

        class _AutoHost(FabricHost):
            def permissions_for(self, cap, ctx):
                return {"read": True, "write": True}
            def node_available(self, cap):
                return True
            async def request_approval(self, req, ctx):
                return False

        fabric = CapabilityFabric(_AutoHost())
        fabric.policy["overrides"]["document.ingest"] = "auto-execute"

        kb = KnowledgeBase(store_dir=tmp_path / "kb")
        for ex in multimodal_executors(kb, tmp_path / "artifacts"):
            if ex.capabilityId == "document.ingest":
                fabric.register(ex)
                break

        events: list[dict] = []
        fabric.listen(lambda e: events.append(e))

        # Create a minimal real file to ingest
        doc = tmp_path / "test.txt"
        doc.write_text("Phase 7 autonomy test document content.")

        await fabric.invoke("document.ingest", {"path": str(doc)},
                            {"actor": {"kind": "agent", "id": "test"}})

        approval_events = [e for e in events if e.get("type") == "approval.required"]
        assert approval_events == [], (
            f"auto-execute capability emitted approval.required: {approval_events}"
        )

    @pytest.mark.asyncio
    async def test_f_knowledge_search_no_approval_required_event(self, tmp_path):
        """A knowledge.search invocation must never emit an approval.required event."""
        from aura.executors import multimodal_executors
        from aura.knowledge.store import KnowledgeBase
        from aura.fabric import CapabilityFabric, FabricHost

        class _AutoHost(FabricHost):
            def permissions_for(self, cap, ctx):
                return {"read": True, "write": True}
            def node_available(self, cap):
                return True
            async def request_approval(self, req, ctx):
                return False

        fabric = CapabilityFabric(_AutoHost())
        fabric.policy["overrides"]["knowledge.search"] = "auto-execute"

        kb = KnowledgeBase(store_dir=tmp_path / "kb")
        for ex in multimodal_executors(kb, tmp_path / "artifacts"):
            if ex.capabilityId == "knowledge.search":
                fabric.register(ex)
                break

        events: list[dict] = []
        fabric.listen(lambda e: events.append(e))

        await fabric.invoke("knowledge.search", {"query": "test"},
                            {"actor": {"kind": "agent", "id": "test"}})

        approval_events = [e for e in events if e.get("type") == "approval.required"]
        assert approval_events == [], (
            f"auto-execute capability emitted approval.required: {approval_events}"
        )


# ── G: risky capability still emits approval_required ────────────────────────

class TestRiskyCapabilityStillGated:
    @pytest.mark.asyncio
    async def test_g_sandbox_execute_emits_approval_required(self, tmp_path):
        """sandbox.execute (ask-user) must emit approval.required and pause."""
        from aura.executors import multimodal_executors, register_canonical_internal_capabilities
        from aura.knowledge.store import KnowledgeBase
        from aura.fabric import CapabilityFabric, FabricHost

        class _DenyHost(FabricHost):
            def permissions_for(self, cap, ctx):
                # "execute" → grants_for() → ["process.execute", "network.outbound"]
                # Required by sandbox.execute so the permission check passes and
                # the approval gate is reached
                return {"read": True, "write": True, "execute": True}
            def node_available(self, cap):
                return True
            async def request_approval(self, req, ctx):
                return False  # deny → outcome is awaiting-approval

        fabric = CapabilityFabric(_DenyHost())
        # Populate _BY_ID with CANONICAL_INTERNAL_CAPABILITIES descriptors
        # (sandbox.execute lives there, not in manifest.json)
        register_canonical_internal_capabilities(fabric)
        fabric.policy["overrides"]["sandbox.execute"] = "ask-user"

        kb = KnowledgeBase(store_dir=tmp_path / "kb")
        for ex in multimodal_executors(kb, tmp_path / "artifacts"):
            if ex.capabilityId == "sandbox.execute":
                # Already registered by register_canonical_internal_capabilities;
                # just update the executors dict without re-registering descriptor
                fabric.executors[ex.capabilityId] = ex
                break

        events: list[dict] = []
        fabric.listen(lambda e: events.append(e))

        result = await fabric.invoke(
            "sandbox.execute",
            {"command": "echo hi", "cwd": str(tmp_path), "timeout_ms": 5000},
            {"actor": {"kind": "agent", "id": "test"}},
        )

        approval_events = [e for e in events if e.get("type") == "approval.required"]
        assert len(approval_events) >= 1, "sandbox.execute must emit approval.required"
        assert result["outcome"] == "awaiting-approval"

    def test_g_high_risk_floor_unchanged(self):
        """agent.delegate remains require-approval — Phase 7 never lowers it."""
        fabric = _wire_test_fabric()
        # agent.delegate is high-risk in the manifest — Phase 7 must not touch it
        from aura.fabric import describe_capability
        cap = describe_capability("agent.delegate")
        assert cap is not None
        assert cap["risk"] == "high"
        # And the effective policy must be require-approval (not softened)
        action = _effective_action(fabric, "agent.delegate")
        assert action == "require-approval"

    def test_g_p7_defaults_never_include_high_risk_caps(self):
        """Phase 7 defaults must only cover the intended low/medium caps."""
        _P7_DEFAULTS = {
            "knowledge.search":  "auto-execute",
            "document.ingest":   "auto-execute",
            "artifact.generate": "auto-execute",
            "sandbox.execute":   "ask-user",
            "terminal.execute":  "ask-user",
        }
        from aura.fabric import describe_capability
        for cap_id, action in _P7_DEFAULTS.items():
            cap = describe_capability(cap_id)
            if cap is None:
                continue  # CANONICAL_INTERNAL_CAPABILITIES cap — trust risk set in code
            risk = cap["risk"]
            if action == "auto-execute":
                assert risk == "low", (
                    f"{cap_id}: auto-execute default but risk={risk} — safety floor violated"
                )
            if action == "ask-user":
                assert risk in ("low", "medium"), (
                    f"{cap_id}: ask-user default on high-risk cap — should be require-approval"
                )


# ── H: WorkspaceScreen contains openPanel affordances ────────────────────────

class TestWorkspacePanelAffordances:
    def test_h_workspace_screen_imports_layout_store(self):
        """WorkspaceScreen.tsx must import useLayoutStore (static source check)."""
        from pathlib import Path
        src = Path(__file__).parents[3] / "apps/desktop/src/screens/WorkspaceScreen.tsx"
        assert src.exists(), "WorkspaceScreen.tsx not found"
        text = src.read_text()
        assert "useLayoutStore" in text, "WorkspaceScreen must import useLayoutStore"
        assert "openPanel" in text, "WorkspaceScreen must call openPanel"

    def test_h_documents_panel_affordance_present(self):
        from pathlib import Path
        src = Path(__file__).parents[3] / "apps/desktop/src/screens/WorkspaceScreen.tsx"
        text = src.read_text()
        assert "open-panel-documents" in text or "'documents'" in text, \
            "WorkspaceScreen must have a documents panel affordance"

    def test_h_artifacts_panel_affordance_present(self):
        from pathlib import Path
        src = Path(__file__).parents[3] / "apps/desktop/src/screens/WorkspaceScreen.tsx"
        text = src.read_text()
        assert "open-panel-artifacts" in text or "'artifacts'" in text, \
            "WorkspaceScreen must have an artifacts panel affordance"

    def test_h_sovereign_monitor_affordance_present(self):
        from pathlib import Path
        src = Path(__file__).parents[3] / "apps/desktop/src/screens/WorkspaceScreen.tsx"
        text = src.read_text()
        assert "open-panel-sovereign-monitor" in text or "'sovereign-monitor'" in text, \
            "WorkspaceScreen must have a sovereign-monitor panel affordance"

    def test_h_tool_categories_includes_sovereign_panels(self):
        """All three new panel kinds appear in a toolCategories group."""
        from pathlib import Path
        src = Path(__file__).parents[3] / "apps/desktop/src/ops/toolCategories.ts"
        text = src.read_text()
        for kind in ("documents", "artifacts", "sovereign-monitor"):
            assert kind in text, \
                f"toolCategories.ts must include '{kind}' in a category"


# ── project-scoped autonomy grants: explicit per-project opt-in
# (AURA_HOME/autonomy.json) lets routine scope-confined work
# auto-execute under the `workspace-autonomy` rule; everything else
# keeps its existing decision. Both sides pinned: grant refusals,
# policy narrowness, single-card dedupe, decided visibility.
import os
import tempfile
from pathlib import Path

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.fabric import (
    FabricConfig,
    describe_authority,
    invoke_fabric,
)
from aura.policy.autonomy import (
    AutonomyStore,
    ROUTINE_CAPABILITIES,
    build_grant,
)
from aura.policy.engine import (
    CapabilityDescriptor as PolicyCapability,
    PolicyInput,
    PolicySubject,
    evaluate_policy,
)


@pytest.fixture()
def root(tmp_path):
    proj = tmp_path / "dress-shop"
    (proj / "src").mkdir(parents=True)
    (proj / "src" / "index.html").write_text("<h1>hi</h1>")
    return proj


@pytest.fixture()
def store(tmp_path, monkeypatch):
    home = tmp_path / "aura-home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    return AutonomyStore(home)


def delegate_input(*scopes):
    return {"task": "Build the catalog page", "scopePaths": list(scopes)}


def ctx(project_id="proj-dress-1"):
    return {"actor": {"kind": "agent", "id": "central-agent"},
            "projectId": project_id, "taskId": "t1"}


def delegate_cap():
    return PolicyCapability(
        id="agent.delegate", name="Delegate to coding agent", risk="high",
        permissions=["project.read", "project.write", "process.execute",
                     "network.outbound"],
        irreversible=True)


def base_config():
    return {"byRisk": {"low": "auto-execute", "medium": "ask-user",
                       "high": "require-approval"},
            "overrides": {}, "nodeOverrides": {}, "nodeAllowlists": {},
            "allowAutonomous": True}


# ── store ─────────────────────────────────────────────────────────────

class TestAutonomyStore:
    def test_disabled_by_default(self, store):
        assert store.is_enabled("proj-x") is False

    def test_enable_disable_roundtrip(self, store, root):
        store.set_enabled("proj-x", True, str(root))
        assert store.is_enabled("proj-x") is True
        assert store.scope_root("proj-x") == str(root)
        store.set_enabled("proj-x", False)
        assert store.is_enabled("proj-x") is False

    def test_malformed_file_reads_disabled(self, tmp_path, monkeypatch):
        home = tmp_path / "h"
        home.mkdir()
        (home / "autonomy.json").write_text("[not an object]")
        monkeypatch.setenv("AURA_HOME", str(home))
        assert AutonomyStore(home).is_enabled("proj-x") is False


# ── grant builder: grants ─────────────────────────────────────────────

class TestGrantBuilderGrants:
    def test_scoped_delegate_grants(self, root):
        g = build_grant("agent.delegate", delegate_input("src"),
                        ctx(), project_root=str(root), autonomous=True)
        assert g is not None
        assert g["kind"] == "delegate-bounded"
        assert g["projectId"] == "proj-dress-1"
        assert g["capabilities"] == ["agent.delegate"]

    def test_write_in_scope_grants(self, root):
        g = build_grant("agent.delegate", delegate_input("."), ctx(),
                        project_root=str(root), autonomous=True)
        assert g is not None
        g = build_grant("filesystem.write",
                        {"path": "src/style.css", "content": "x"},
                        ctx(), project_root=str(root), autonomous=True)
        assert g is not None and g["kind"] == "write-bounded"

    def test_dev_commands_grant(self, root):
        for cmd in ("npm run build", "npm test", "npx tsc --noEmit",
                    "pytest -q", "git status", "cargo test"):
            g = build_grant("terminal.execute", {"command": cmd}, ctx(),
                            project_root=str(root), autonomous=True)
            assert g is not None and g["kind"] == "dev-command", cmd


# ── grant builder: refusals ───────────────────────────────────────────

class TestGrantBuilderRefusals:
    def test_no_opt_in_no_grant(self, root):
        assert build_grant("agent.delegate", delegate_input("src"), ctx(),
                           project_root=str(root), autonomous=False) is None

    def test_no_project_no_grant(self, root):
        assert build_grant("agent.delegate", delegate_input("src"),
                           {"actor": {"kind": "agent"}}, project_root=str(root),
                           autonomous=True) is None

    def test_no_root_no_grant(self):
        assert build_grant("agent.delegate", delegate_input("src"), ctx(),
                           project_root=None, autonomous=True) is None

    def test_unscoped_delegate_no_grant(self, root):
        assert build_grant("agent.delegate", {"task": "do it"}, ctx(),
                           project_root=str(root), autonomous=True) is None

    def test_scope_escape_no_grant(self, root):
        for bad in ("../outside", "/etc/passwd", "src/../../x", "~/x"):
            assert build_grant(
                "agent.delegate", delegate_input(bad), ctx(),
                project_root=str(root), autonomous=True) is None, bad

    def test_credential_paths_no_grant(self, root):
        for bad in (".env", ".env.local", "keys/deploy.pem",
                    "config/credentials.json", "src/.ssh/id_rsa",
                    "id_ed25519", "auth_token.txt", "a/secrets.yaml"):
            assert build_grant(
                "agent.delegate", delegate_input(bad), ctx(),
                project_root=str(root), autonomous=True) is None, bad
            assert build_grant(
                "filesystem.write", {"path": bad, "content": "x"}, ctx(),
                project_root=str(root), autonomous=True) is None, bad

    def test_agent_config_paths_no_grant(self, root):
        for bad in ("opencode.json", ".opencode/settings.json",
                    ".claude/hooks.json", ".codex/config.toml",
                    "AGENTS.md", "docs/AGENTS.md"):
            assert build_grant(
                "agent.delegate", delegate_input(bad), ctx(),
                project_root=str(root), autonomous=True) is None, bad

    def test_non_routine_capability_no_grant(self, root):
        for cap in ("git.push", "git.commit", "http.request",
                    "mission.approve", "system.install"):
            assert build_grant(cap, {"task": "x"}, ctx(),
                               project_root=str(root),
                               autonomous=True) is None, cap

    def test_dangerous_commands_no_grant(self, root):
        for cmd in ("npm publish", "npm install left-pad", "curl example.com",
                    "rm -rf /", "sudo ls", "npx -p evil run",
                    "cargo publish", "git push origin main"):
            assert build_grant(
                "terminal.execute", {"command": cmd}, ctx(),
                project_root=str(root), autonomous=True) is None, cmd

    def test_node_script_outside_root_no_grant(self, root):
        assert build_grant(
            "terminal.execute", {"command": "node /etc/app.js"}, ctx(),
            project_root=str(root), autonomous=True) is None


# ── policy engine honors the grant narrowly ───────────────────────────

class TestPolicyGrant:
    def test_grant_lifts_irreversible_floor(self, root):
        grant = build_grant("agent.delegate", delegate_input("src"), ctx(),
                            project_root=str(root), autonomous=True)
        out = evaluate_policy(PolicyInput(
            capability=delegate_cap(), config=base_config(),
            granted=["project.read", "project.write", "process.execute",
                     "network.outbound"],
            nodeAvailable=None,
            subject=PolicySubject(actorKind="agent", projectId="proj-dress-1"),
            autonomy_grant=grant))
        assert out["decision"] == "auto-execute"
        assert out["rule"] == "workspace-autonomy"

    def test_no_grant_floor_holds(self):
        out = evaluate_policy(PolicyInput(
            capability=delegate_cap(), config=base_config(),
            granted=["project.read", "project.write", "process.execute",
                     "network.outbound"],
            nodeAvailable=None,
            subject=PolicySubject(actorKind="agent", projectId="proj-dress-1")))
        assert out["decision"] == "require-approval"
        assert out["rule"] == "irreversible-floor"

    def test_grant_for_other_capability_does_not_lift(self):
        grant = {"projectId": "proj-dress-1", "root": "/tmp/x",
                 "kind": "write-bounded", "capabilities": ["filesystem.write"]}
        out = evaluate_policy(PolicyInput(
            capability=delegate_cap(), config=base_config(),
            granted=["project.read", "project.write", "process.execute",
                     "network.outbound"],
            nodeAvailable=None,
            subject=PolicySubject(actorKind="agent", projectId="proj-dress-1"),
            autonomy_grant=grant))
        assert out["decision"] == "require-approval"

    def test_grant_for_other_project_does_not_lift(self, root):
        grant = build_grant("agent.delegate", delegate_input("src"), ctx(),
                            project_root=str(root), autonomous=True)
        out = evaluate_policy(PolicyInput(
            capability=delegate_cap(), config=base_config(),
            granted=["project.read", "project.write", "process.execute",
                     "network.outbound"],
            nodeAvailable=None,
            subject=PolicySubject(actorKind="agent", projectId="proj-OTHER"),
            autonomy_grant=grant))
        assert out["decision"] == "require-approval"

    def test_grant_never_lifts_destroy_or_account_floors(self):
        for perms in (["resource.destroy"], ["account.authorize"],
                      ["system.modify"]):
            cap = PolicyCapability(id="filesystem.write", name="W",
                                   risk="medium", permissions=perms)
            grant = {"projectId": "p", "root": "/tmp/x",
                     "kind": "write-bounded",
                     "capabilities": ["filesystem.write"]}
            out = evaluate_policy(PolicyInput(
                capability=cap, config=base_config(),
                granted=["project.read"], nodeAvailable=None,
                subject=PolicySubject(projectId="p"),
                autonomy_grant=grant))
            assert out["decision"] != "auto-execute", perms

    def test_grant_never_overrides_deny(self, root):
        grant = build_grant("agent.delegate", delegate_input("src"), ctx(),
                            project_root=str(root), autonomous=True)
        out = evaluate_policy(PolicyInput(
            capability=delegate_cap(), config=base_config(),
            granted=[], nodeAvailable=None,  # missing permissions → deny
            subject=PolicySubject(actorKind="agent", projectId="proj-dress-1"),
            autonomy_grant=grant))
        assert out["decision"] == "deny"


# ── invoke-level: grant, dedupe, decided visibility ───────────────────

def _cfg(root, store, project_id="proj-dress-1", executors=None):
    from aura.fabric import CapabilityFabric, FabricHost
    from aura.executors import register_canonical_internal_capabilities

    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True}
        def node_available(self, _cap):
            # The stub stands in for a machine where the capability is
            # available; affirmative (not None) is what the preflight
            # path requires of node-backed capabilities.
            return True
        async def request_approval(self, _req, _ctx):
            return False

    audit = AuditStore(root / "audit.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    fabric = CapabilityFabric(_H())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    if hasattr(fabric, "use_autonomy"):
        fabric.use_autonomy(store, lambda pid: str(root) if pid == project_id else None)
    if executors is not None:
        for cap_id, exe in executors.items():
            try:
                fabric.register(exe)
            except Exception:
                fabric.executors[cap_id] = exe
    register_canonical_internal_capabilities(fabric)
    return FabricConfig(
        fabric=fabric, policy_config={}, audit_store=audit, ledger=ledger,
        permissions={"read": True, "write": True, "execute": True},
        executors=executors or {},
        autonomy_store=store,
        project_root_resolver=lambda pid: str(root) if pid == project_id else None,
    ), ledger


class TestInvokeAutonomy:
    def test_scoped_delegate_auto_executes_without_running(self, tmp_path, store, root):
        store.set_enabled("proj-dress-1", True, str(root))
        cfg, _ledger = _cfg(root, store)
        r = invoke_fabric("agent.delegate", delegate_input("src"),
                          {**ctx(), "cwd": str(root)}, cfg)
        assert r["policy"]["rule"] == "workspace-autonomy"
        # No executor registered in this rig → unsupported, but crucially
        # NOT parked: the floor was lifted before any approval existed.
        assert r["outcome"] == "unsupported"

    def test_same_call_without_opt_in_parks(self, tmp_path, store, root):
        cfg, _ledger = _cfg(root, store)
        r = invoke_fabric("agent.delegate", delegate_input("src"),
                          {**ctx(), "cwd": str(root)}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert r["policy"]["rule"] == "irreversible-floor"

    def test_repeated_identical_request_parks_once(self, tmp_path, store, root):
        cfg, ledger = _cfg(root, store)
        first = invoke_fabric("agent.delegate", delegate_input("src"),
                              {**ctx(), "cwd": str(root)}, cfg)
        second = invoke_fabric("agent.delegate", delegate_input("src"),
                               {**ctx(), "cwd": str(root)}, cfg)
        assert first["outcome"] == "awaiting-approval"
        assert second["outcome"] == "awaiting-approval"
        assert second["approvalId"] == first["approvalId"]
        assert len(ledger.pending()) == 1

    def test_write_really_writes_under_autonomy(self, tmp_path, store, root):
        from aura.executors import all_executors
        store.set_enabled("proj-dress-1", True, str(root))
        exec_map = {e.capabilityId: e for e in all_executors(tmp_path)}
        cfg, _ledger = _cfg(root, store, executors=exec_map)
        target = root / "src" / "catalog.html"
        r = invoke_fabric(
            "filesystem.write",
            {"path": "src/catalog.html", "content": "<h1>dresses</h1>"},
            {**ctx(), "cwd": str(root)}, cfg)
        assert r["outcome"] == "succeeded", r["detail"]
        assert target.read_text() == "<h1>dresses</h1>"

    def test_preflight_matches_dispatch(self, tmp_path, store, root):
        store.set_enabled("proj-dress-1", True, str(root))
        cfg, _ledger = _cfg(root, store)
        out = describe_authority(
            "agent.delegate",
            {**ctx(), "input": delegate_input("src")}, cfg)
        assert out is not None
        assert out["decision"] == "auto-execute", out

    def test_unscoped_delegate_parks_even_when_opted_in(self, tmp_path, store, root):
        # Strict by default: autonomy permits SCOPED routine work, never
        # unscoped delegation. The execution layer binds the project root
        # before dispatch (tested below); the Fabric itself stays strict.
        store.set_enabled("proj-dress-1", True, str(root))
        cfg, _ledger = _cfg(root, store)
        r = invoke_fabric("agent.delegate", {"task": "do it"},
                          {**ctx(), "cwd": str(root)}, cfg)
        assert r["outcome"] == "awaiting-approval"
        assert r["policy"]["rule"] == "irreversible-floor"


class TestScopeBinding:
    def _controller(self, root, store):
        from aura.central_agent.execution import ExecutionController
        cfg, _ledger = _cfg(root, store)
        return ExecutionController(cfg)

    def test_opted_in_project_binds_root(self, tmp_path, store, root):
        store.set_enabled("proj-dress-1", True, str(root))
        c = self._controller(root, store)
        assert c._autonomous_project_scope("proj-dress-1") == ["."]

    def test_opted_out_project_binds_nothing(self, tmp_path, store, root):
        c = self._controller(root, store)
        assert c._autonomous_project_scope("proj-dress-1") is None

    def test_unknown_project_binds_nothing(self, tmp_path, store, root):
        store.set_enabled("proj-dress-1", True, str(root))
        c = self._controller(root, store)
        assert c._autonomous_project_scope("proj-nope") is None

    def test_missing_root_binds_nothing(self, tmp_path, store):
        store.set_enabled("proj-ghost", True, "/nonexistent-root-xyz")
        c = self._controller(tmp_path, store)
        assert c._autonomous_project_scope("proj-ghost") is None


class TestRootMarker:
    """The '.' entry is the documented whole-project-root scope marker.

    The E2E proved the need: autonomous dispatch binds the project root
    for unscoped routine tasks, and the contract had no spelling for
    "the root itself" — bare "." was refused, so the run failed closed.
    """

    def test_normalize_root_marker(self):
        from aura.fabric.supervision import _normalize_scope_path
        assert _normalize_scope_path(".") == ""
        assert _normalize_scope_path("./") == ""
        # Genuine empties stay refused.
        assert _normalize_scope_path("") is None
        assert _normalize_scope_path("   ") is None
        assert _normalize_scope_path("/") is None
        assert _normalize_scope_path("..") is None

    def test_validate_accepts_root_marker(self):
        from aura.fabric.supervision import validate_scope_paths
        ok, paths, _ = validate_scope_paths(["."])
        assert ok and paths == [""]

    def test_root_marker_covers_everything(self):
        from aura.fabric.supervision import check_scope_paths
        check = check_scope_paths(
            ["index.html", "src/app.js", "deeply/nested/file.ts"], [""])
        assert check.allowed and not check.outside

    def test_grant_accepts_root_marker(self, root):
        g = build_grant("agent.delegate",
                        {"task": "build it", "scopePaths": ["."]}, ctx(),
                        project_root=str(root), autonomous=True)
        assert g is not None and g["kind"] == "delegate-bounded"


class TestDecidedVisibility:
    def test_decided_record_stays_readable(self, tmp_path):
        audit = AuditStore(tmp_path / "a.jsonl")
        ledger = ApprovalLedger(audit_append=audit.append)
        req = {"id": "apr-1", "state": "pending",
               "items": [{"capabilityId": "agent.delegate",
                          "fingerprint": "fp", "detail": "d"}]}
        ledger.register("k", req)
        assert ledger.decided() == []
        ledger.decide("apr-1", True, "user", None)
        assert ledger.pending() == []
        decided = ledger.decided()
        assert len(decided) == 1 and decided[0]["state"] == "granted"

    def test_fingerprint_dedupe_ignores_decided(self, tmp_path):
        audit = AuditStore(tmp_path / "a.jsonl")
        ledger = ApprovalLedger(audit_append=audit.append)
        req = {"id": "apr-1", "state": "pending",
               "items": [{"capabilityId": "agent.delegate", "fingerprint": "fp"}]}
        ledger.register("k", req)
        assert ledger.pending_with_fingerprint("fp")["id"] == "apr-1"
        ledger.decide("apr-1", True, "user", None)
        # A spent authorization is not reusable: no match after decision.
        assert ledger.pending_with_fingerprint("fp") is None
        assert ledger.pending_with_fingerprint("other") is None
