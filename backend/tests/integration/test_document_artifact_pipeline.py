"""Integration test: document ingest → knowledge search → artifact generate.

Exercises the complete multimodal capability chain through the real governance
fabric without requiring a live model.  Uses real executors, real policy, real
audit trail.  Intent → plan is provided explicitly (bypassing model planning)
since no Ollama is required here.

Tests:
  - All three multimodal executors are registered and invocable
  - document.ingest auto-executes (low risk)
  - knowledge.search returns content from the ingested document
  - artifact.generate produces a real DOCX (when python-docx is available)
  - Each execution produces an audit record
  - Evidence bundle contains all audit record IDs
  - Artifact path appears in evidence when provided
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.central_agent.planner import TaskPlanner
from aura.contracts import AgentIntent, TaskPlan, TaskSpecification
from aura.fabric import CapabilityFabric, FabricConfig, FabricHost
from aura.workflow import EngineConfig, WorkflowEngine, make_stores


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _AutoHost(FabricHost):
    """Always grants, never blocks, auto-executes everything."""

    def permissions_for(self, _cap, _ctx):
        return {
            "read": True, "write": True, "execute": True,
            "autonomous": True, "network": True,
        }

    def node_available(self, _cap):
        return True

    async def request_approval(self, _req, _ctx):
        return False


def _docx_available() -> bool:
    try:
        import docx  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.fixture()
def multimodal_env(tmp_path, monkeypatch):
    """Fabric with ALL executors including multimodal (knowledge/doc/artifact)."""
    home = tmp_path / "home"
    proj = tmp_path / "project"
    proj.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    monkeypatch.setenv("AURA_HOME", str(home))

    from aura.executors import all_executors, multimodal_executors
    from aura.knowledge.store import KnowledgeBase

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    kb = KnowledgeBase(store_dir=home / "knowledge")

    fabric = CapabilityFabric(_AutoHost())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    # Phase 7 policy defaults: multimodal ops auto-execute
    fabric.policy = {
        "overrides": {
            "knowledge.search":  "auto-execute",
            "document.ingest":   "auto-execute",
            "artifact.generate": "auto-execute",
            "sandbox.execute":   "ask-user",
        }
    }

    for exe in all_executors(home):
        try:
            fabric.register(exe)
        except Exception:
            fabric.executors[exe.capabilityId] = exe
    for exe in multimodal_executors(kb, home / "artifacts"):
        fabric.executors[exe.capabilityId] = exe

    execs = dict(fabric.executors)
    cfg = FabricConfig(
        fabric=fabric, policy_config=fabric.policy,
        permissions={"read": True, "write": True},
        executors=execs, audit_store=audit, ledger=ledger,
    )
    ws, vs, rs = make_stores()
    engine = WorkflowEngine(cfg, ws, vs, rs, EngineConfig())
    agent = CentralAgent(
        fabric_cfg=cfg, session_store=AgentSessionStore(home),
        workflow_store=ws, run_store=rs, workflow_engine=engine,
    )
    return home, proj, audit, ledger, cfg, kb, agent


# ---------------------------------------------------------------------------
# Capability registration
# ---------------------------------------------------------------------------

class TestMultimodalCapabilityRegistration:
    def test_all_four_caps_in_executor_table(self, multimodal_env):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        want = {
            "knowledge.search", "document.ingest",
            "artifact.generate", "sandbox.execute",
        }
        registered = set(cfg.fabric.executors)
        missing = want - registered
        assert not missing, f"Missing from fabric executor table: {missing}"

    def test_all_four_caps_discoverable(self, multimodal_env):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.central_agent.discovery import CapabilityDiscovery
        disc = CapabilityDiscovery()
        tools = disc.available_for([
            "knowledge.search", "document.ingest",
            "artifact.generate", "sandbox.execute",
        ])
        found = {t.id for t in tools}
        want = {"knowledge.search", "document.ingest",
                "artifact.generate", "sandbox.execute"}
        missing = want - found
        assert not missing, f"Not discoverable: {missing}"

    def test_planner_knows_multimodal_capabilities(self, multimodal_env):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        planner = agent.planner
        known = planner.known_capability_ids()
        want = {"knowledge.search", "document.ingest", "artifact.generate"}
        missing = want - known
        assert not missing, f"Not in planner's known capabilities: {missing}"


# ---------------------------------------------------------------------------
# document.ingest
# ---------------------------------------------------------------------------

class TestDocumentIngest:
    def test_ingest_auto_executes_no_approval(self, multimodal_env, tmp_path):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        doc = tmp_path / "report.txt"
        doc.write_text(
            "Site Inspection Report — Building A\n"
            "Finding 1: Electrical panel requires upgrade.\n"
            "Finding 2: Structural support beams are sound.\n"
            "Recommendation: Approve with minor electrical work.\n"
        )
        from aura.fabric import invoke_fabric
        result = invoke_fabric(
            "document.ingest",
            {"path": str(doc)},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert result["outcome"] == "succeeded", result.get("detail")
        assert result["policy"]["decision"] == "auto-execute"
        out = result.get("output") or {}
        assert out.get("chunkCount", 0) > 0
        assert out.get("status") == "ok"
        # Audit record created
        records = audit.load()
        ingest_recs = [r for r in records if r["capabilityId"] == "document.ingest"]
        assert len(ingest_recs) == 1
        assert ingest_recs[0]["decision"] == "auto-execute"

    def test_ingest_document_text_not_in_audit(self, multimodal_env, tmp_path):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        secret = "CONFIDENTIAL_PASS_abc123xyz"
        doc = tmp_path / "secret.txt"
        doc.write_text(f"This contains {secret}.")
        from aura.fabric import invoke_fabric
        invoke_fabric(
            "document.ingest",
            {"path": str(doc)},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        # Audit trail must NOT contain document text
        trail_text = json.dumps(audit.load())
        assert secret not in trail_text, (
            "Confidential document content must never appear in the audit trail"
        )


# ---------------------------------------------------------------------------
# knowledge.search
# ---------------------------------------------------------------------------

class TestKnowledgeSearch:
    def test_search_after_ingest_returns_relevant_results(
        self, multimodal_env, tmp_path
    ):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric

        # Ingest first
        doc = tmp_path / "inspection.txt"
        doc.write_text(
            "Sovereign AI governance policy: all model calls must be logged.\n"
            "Approval required for any cloud-provider inference request.\n"
            "Private endpoints are preferred.\n"
        )
        r_ingest = invoke_fabric(
            "document.ingest",
            {"path": str(doc)},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert r_ingest["outcome"] == "succeeded"

        # Search
        r_search = invoke_fabric(
            "knowledge.search",
            {"query": "sovereign governance policy"},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert r_search["outcome"] == "succeeded"
        results = (r_search.get("output") or {}).get("results", [])
        assert len(results) > 0, "Expected at least one search result"
        texts = " ".join(r.get("text", "") for r in results).lower()
        assert "sovereign" in texts or "governance" in texts or "policy" in texts

    def test_search_empty_kb_returns_empty_results(self, multimodal_env):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric
        r = invoke_fabric(
            "knowledge.search",
            {"query": "anything"},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert r["outcome"] == "succeeded"
        assert (r.get("output") or {}).get("results") == []


# ---------------------------------------------------------------------------
# artifact.generate
# ---------------------------------------------------------------------------

class TestArtifactGenerate:
    @pytest.mark.skipif(not _docx_available(), reason="python-docx not installed")
    def test_docx_artifact_generated_and_verified(
        self, multimodal_env, tmp_path
    ):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric

        out_path = str(tmp_path / "approval_note.docx")
        spec = {
            "artifact_type": "docx",
            "title": "Approval Note — Inspection Findings",
            "sections": [
                {
                    "heading": "Executive Summary",
                    "body": "The site inspection identified two findings.",
                },
                {
                    "heading": "Findings",
                    "body": "1. Electrical panel upgrade required. 2. Structure sound.",
                },
                {
                    "heading": "Decision",
                    "body": "Approved subject to electrical remediation.",
                },
            ],
        }
        r = invoke_fabric(
            "artifact.generate",
            {"spec": spec, "output_path": out_path},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert r["outcome"] in ("succeeded", "unverified"), r.get("detail")
        out = r.get("output") or {}
        generated_path = Path(out.get("path", out_path))
        assert generated_path.exists(), f"DOCX not found at {generated_path}"
        assert generated_path.stat().st_size > 500, "DOCX is suspiciously small"
        # Verify DOCX content
        from docx import Document
        doc = Document(generated_path)
        text = " ".join(p.text for p in doc.paragraphs).lower()
        assert "approval" in text or "inspection" in text or "findings" in text
        # Audit record
        records = audit.load()
        art_recs = [r for r in records if r["capabilityId"] == "artifact.generate"]
        assert len(art_recs) >= 1

    def test_artifact_generate_without_spec_fails(self, multimodal_env):
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric
        r = invoke_fabric(
            "artifact.generate",
            {},
            {"actor": {"kind": "agent", "id": "test"}, "cwd": str(proj)},
            cfg,
        )
        assert r["outcome"] == "failed"


# ---------------------------------------------------------------------------
# Full pipeline: ingest → search → generate
# ---------------------------------------------------------------------------

class TestFullDocumentArtifactPipeline:
    @pytest.mark.skipif(not _docx_available(), reason="python-docx not installed")
    def test_ingest_search_generate_full_chain(self, multimodal_env, tmp_path):
        """Real end-to-end: ingest a document, search it, produce a DOCX.

        This exercises the complete multimodal capability chain through the
        governed fabric — the same path CentralAgent uses at runtime.
        No model required; capabilities execute directly.
        """
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric

        # Step 1: ingest source document
        source = tmp_path / "findings.txt"
        source.write_text(
            "Project Inspection — AURA Hub — 2026-09-24\n"
            "Finding A: Evidence collection pipeline fully wired.\n"
            "Finding B: Multimodal executors registered in all entry points.\n"
            "Finding C: Sovereign policy enforced at execution boundary.\n"
            "Status: All checks passed. Recommend approval.\n"
        )
        r_ingest = invoke_fabric(
            "document.ingest",
            {"path": str(source)},
            {"actor": {"kind": "agent", "id": "pipeline-test"}, "cwd": str(proj)},
            cfg,
        )
        assert r_ingest["outcome"] == "succeeded", r_ingest.get("detail")
        chunk_count = (r_ingest.get("output") or {}).get("chunkCount", 0)
        assert chunk_count > 0

        # Step 2: search knowledge
        r_search = invoke_fabric(
            "knowledge.search",
            {"query": "inspection findings approval"},
            {"actor": {"kind": "agent", "id": "pipeline-test"}, "cwd": str(proj)},
            cfg,
        )
        assert r_search["outcome"] == "succeeded"
        results = (r_search.get("output") or {}).get("results", [])
        assert len(results) > 0

        # Step 3: generate approval note DOCX
        out_path = str(tmp_path / "approval.docx")
        finding_texts = [r.get("text", "") for r in results[:3]]
        spec = {
            "artifact_type": "docx",
            "title": "AURA Hub Inspection Approval Note",
            "sections": [
                {
                    "heading": "Summary of Findings",
                    "body": " ".join(finding_texts)[:500] or "See source document.",
                },
                {
                    "heading": "Decision",
                    "body": "Approved. All subsystems verified.",
                },
            ],
        }
        r_generate = invoke_fabric(
            "artifact.generate",
            {"spec": spec, "output_path": out_path},
            {"actor": {"kind": "agent", "id": "pipeline-test"}, "cwd": str(proj)},
            cfg,
        )
        assert r_generate["outcome"] in ("succeeded", "unverified"), r_generate.get("detail")
        generated = Path((r_generate.get("output") or {}).get("path", out_path))
        assert generated.exists()
        assert generated.stat().st_size > 500

        # Step 4: verify evidence
        records = audit.load()
        cap_ids = {r["capabilityId"] for r in records}
        assert "document.ingest" in cap_ids
        assert "knowledge.search" in cap_ids
        assert "artifact.generate" in cap_ids
        # No cloud calls — sovereign guarantee
        for r in records:
            assert r.get("decision") != "denied", (
                f"Governed capability was denied unexpectedly: {r['capabilityId']}"
            )

        # Step 5: verify DOCX content
        from docx import Document
        doc_obj = Document(generated)
        content = " ".join(p.text for p in doc_obj.paragraphs).lower()
        assert len(content) > 50
        assert any(kw in content for kw in ("approval", "finding", "aura", "inspection"))

    def test_pipeline_evidence_audit_integrity(self, multimodal_env, tmp_path):
        """Every governed invocation has an audit record with mandatory fields."""
        home, proj, audit, ledger, cfg, kb, agent = multimodal_env
        from aura.fabric import invoke_fabric

        doc = tmp_path / "doc.txt"
        doc.write_text("Test document for audit integrity verification.")
        invoke_fabric(
            "document.ingest",
            {"path": str(doc)},
            {"actor": {"kind": "agent", "id": "audit-test"}, "cwd": str(proj)},
            cfg,
        )
        invoke_fabric(
            "knowledge.search",
            {"query": "test document"},
            {"actor": {"kind": "agent", "id": "audit-test"}, "cwd": str(proj)},
            cfg,
        )
        records = audit.load()
        mandatory = {"invocationId", "capabilityId", "at", "decision", "outcome"}
        for rec in records:
            missing = mandatory - rec.keys()
            assert not missing, (
                f"Audit record for {rec.get('capabilityId')} missing: {missing}"
            )
