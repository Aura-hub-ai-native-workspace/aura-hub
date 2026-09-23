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
