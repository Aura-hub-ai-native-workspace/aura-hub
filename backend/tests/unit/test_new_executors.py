"""Unit tests for the Phase-0 multimodal executors.

Covers:
  - knowledge.search  — KnowledgeSearchExecutor
  - document.ingest   — DocumentIngestExecutor (no document text in audit)
  - artifact.generate — ArtifactGenerateExecutor
  - sandbox.execute   — SandboxExecutor (timeout, exit-code, cwd)
  - CANONICAL_INTERNAL_CAPABILITIES membership check
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _inv(params: dict, cwd: str | None = None) -> dict:
    return {"input": params, "context": {"cwd": cwd or ""}}


def _make_kb(tmp_path: Path):
    from aura.knowledge.store import KnowledgeBase
    return KnowledgeBase(store_dir=tmp_path / "knowledge")


def _make_executors(tmp_path: Path):
    from aura.executors import multimodal_executors
    kb = _make_kb(tmp_path)
    return multimodal_executors(kb, tmp_path / "artifacts"), kb


def _get_executor(adapters, cap_id: str):
    for a in adapters:
        if a.capabilityId == cap_id:
            return a
    raise KeyError(cap_id)


# ---------------------------------------------------------------------------
# CANONICAL_INTERNAL_CAPABILITIES membership
# ---------------------------------------------------------------------------

class TestCapabilityRegistration:
    def test_all_four_caps_present(self):
        from aura.executors import CANONICAL_INTERNAL_CAPABILITIES
        ids = {c["id"] for c in CANONICAL_INTERNAL_CAPABILITIES}
        assert "knowledge.search" in ids
        assert "document.ingest" in ids
        assert "artifact.generate" in ids
        assert "sandbox.execute" in ids

    def test_caps_have_required_fields(self):
        from aura.executors import CANONICAL_INTERNAL_CAPABILITIES
        required = {"id", "name", "category", "surface", "risk", "input", "output"}
        for cap in CANONICAL_INTERNAL_CAPABILITIES:
            missing = required - cap.keys()
            assert not missing, f"{cap['id']} missing fields: {missing}"

    def test_no_duplicate_ids(self):
        from aura.executors import CANONICAL_INTERNAL_CAPABILITIES
        ids = [c["id"] for c in CANONICAL_INTERNAL_CAPABILITIES]
        assert len(ids) == len(set(ids)), "duplicate capability IDs"

    def test_all_four_discoverable_via_fab(self):
        import aura.fabric as fab
        from aura.executors import register_canonical_internal_capabilities
        register_canonical_internal_capabilities(None)
        for cap_id in ("knowledge.search", "document.ingest",
                       "artifact.generate", "sandbox.execute"):
            assert cap_id in fab._BY_ID, f"{cap_id} not in fab._BY_ID"

    def test_multimodal_executors_returns_four_adapters(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ids = {a.capabilityId for a in adapters}
        assert ids == {"knowledge.search", "document.ingest",
                       "artifact.generate", "sandbox.execute"}


# ---------------------------------------------------------------------------
# knowledge.search
# ---------------------------------------------------------------------------

class TestKnowledgeSearch:
    async def test_empty_kb_returns_empty_results(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "knowledge.search")
        result = await ex.run(_inv({"query": "anything"}))
        assert result["ok"]
        assert result["output"]["results"] == []

    async def test_indexed_text_is_found(self, tmp_path):
        from aura.knowledge.store import KnowledgeBase
        from aura.executors import multimodal_executors
        from aura.multimodal.ingestor import DocumentIngestor

        kb = KnowledgeBase(store_dir=tmp_path / "knowledge")
        doc = tmp_path / "doc.txt"
        doc.write_text("The sovereign AI system uses a policy engine for governance.")
        result = DocumentIngestor().ingest(str(doc))
        kb.add_document(str(doc), result)

        adapters = multimodal_executors(kb, tmp_path / "artifacts")
        ex = _get_executor(adapters, "knowledge.search")
        r = await ex.run(_inv({"query": "sovereign policy"}))
        assert r["ok"]
        assert len(r["output"]["results"]) > 0
        assert any("sovereign" in res["text"].lower()
                   for res in r["output"]["results"])

    async def test_missing_query_returns_error(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "knowledge.search")
        r = await ex.run(_inv({"query": ""}))
        assert not r["ok"]
        assert "query" in r["detail"]

    async def test_top_k_respected(self, tmp_path):
        from aura.knowledge.store import KnowledgeBase
        from aura.multimodal.ingestor import DocumentIngestor
        from aura.executors import multimodal_executors

        kb = KnowledgeBase(store_dir=tmp_path / "knowledge")
        for i in range(5):
            doc = tmp_path / f"doc{i}.txt"
            doc.write_text(f"Document {i} about governance and policy frameworks.")
            res = DocumentIngestor().ingest(str(doc))
            kb.add_document(str(doc), res)

        adapters = multimodal_executors(kb, tmp_path / "artifacts")
        ex = _get_executor(adapters, "knowledge.search")
        r = await ex.run(_inv({"query": "governance policy", "top_k": 2}))
        assert r["ok"]
        assert len(r["output"]["results"]) <= 2


# ---------------------------------------------------------------------------
# document.ingest
# ---------------------------------------------------------------------------

class TestDocumentIngest:
    async def test_plain_text_file_is_indexed(self, tmp_path):
        adapters, kb = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        doc = tmp_path / "report.txt"
        doc.write_text("Safety findings: item A is critical.")
        r = await ex.run(_inv({"path": str(doc)}))
        assert r["ok"], r
        out = r["output"]
        assert out["chunkCount"] > 0
        assert out["status"] == "ok"

    async def test_document_text_not_in_audit_output(self, tmp_path):
        """CRITICAL: document text must never appear in the result dict."""
        adapters, kb = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        secret_content = "CONFIDENTIAL: password=s3cr3t, api_key=abc123"
        doc = tmp_path / "secret.txt"
        doc.write_text(secret_content)
        r = await ex.run(_inv({"path": str(doc)}))
        result_str = json.dumps(r)
        assert "s3cr3t" not in result_str
        assert "abc123" not in result_str
        assert "CONFIDENTIAL" not in result_str

    async def test_missing_path_returns_error(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        r = await ex.run(_inv({"path": ""}))
        assert not r["ok"]
        assert "path" in r["detail"]

    async def test_nonexistent_file_handled_gracefully(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        r = await ex.run(_inv({"path": str(tmp_path / "does_not_exist.pdf")}))
        assert isinstance(r, dict)

    async def test_verify_passes_when_chunks_indexed(self, tmp_path):
        adapters, kb = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        doc = tmp_path / "v.txt"
        doc.write_text("Content for verification test.")
        run_result = await ex.run(_inv({"path": str(doc)}))
        verify_result = await ex.verify(_inv({"path": str(doc)}), run_result)
        assert verify_result["passed"]
        assert verify_result["kind"] == "read-back"

    async def test_verify_fails_when_result_not_ok(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "document.ingest")
        verify_result = await ex.verify(
            _inv({"path": ""}), {"ok": False, "detail": "path is required"})
        assert not verify_result["passed"]


# ---------------------------------------------------------------------------
# artifact.generate
# ---------------------------------------------------------------------------

class TestArtifactGenerate:
    @pytest.fixture
    def docx_available(self):
        try:
            import docx  # noqa: F401
            return True
        except ImportError:
            return False

    async def test_missing_spec_returns_error(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        r = await ex.run(_inv({}))
        assert not r["ok"]
        assert "spec" in r["detail"]

    async def test_invalid_spec_returns_error(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        r = await ex.run(_inv({"spec": {"artifact_type": "invalid_type", "title": "X"}}))
        assert not r["ok"]

    async def test_spec_as_json_string_is_parsed(self, tmp_path, docx_available):
        if not docx_available:
            pytest.skip("python-docx not installed")
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        spec_str = json.dumps({
            "artifact_type": "docx",
            "title": "Test Report",
            "sections": [{"heading": "Summary", "body": "All clear."}],
        })
        r = await ex.run(_inv({"spec": spec_str,
                               "output_path": str(tmp_path / "out.docx")}))
        assert r["ok"], r.get("detail")
        assert Path(r["output"]["path"]).exists()

    async def test_docx_generation_with_explicit_output_path(self, tmp_path, docx_available):
        if not docx_available:
            pytest.skip("python-docx not installed")
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        out = tmp_path / "approval_note.docx"
        spec = {
            "artifact_type": "docx",
            "title": "Approval Note",
            "sections": [
                {"heading": "Findings", "body": "No issues found."},
                {"heading": "Decision", "body": "Approved."},
            ],
        }
        r = await ex.run(_inv({"spec": spec, "output_path": str(out)}))
        assert r["ok"], r.get("detail")
        assert out.exists()
        assert out.stat().st_size > 100

    async def test_auto_output_path_used_when_omitted(self, tmp_path, docx_available):
        if not docx_available:
            pytest.skip("python-docx not installed")
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        r = await ex.run(_inv({"spec": {"artifact_type": "docx", "title": "Auto"}}))
        assert r["ok"], r.get("detail")
        generated = Path(r["output"]["path"])
        assert generated.exists()
        assert generated.suffix == ".docx"

    async def test_verify_passes_when_file_exists(self, tmp_path, docx_available):
        if not docx_available:
            pytest.skip("python-docx not installed")
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "artifact.generate")
        out = str(tmp_path / "v.docx")
        spec = {"artifact_type": "docx", "title": "V"}
        run_result = await ex.run(_inv({"spec": spec, "output_path": out}))
        verify_result = await ex.verify(_inv({"spec": spec, "output_path": out}), run_result)
        assert verify_result["passed"]
        assert verify_result["kind"] == "read-back"


# ---------------------------------------------------------------------------
# sandbox.execute
# ---------------------------------------------------------------------------

class TestSandboxExecute:
    async def test_simple_echo_succeeds(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        r = await ex.run(_inv({"command": "echo hello", "cwd": str(tmp_path)}))
        assert r["ok"], r
        assert r["output"]["exitCode"] == 0
        assert "hello" in r["output"]["stdout"]

    async def test_nonzero_exit_is_failure(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        r = await ex.run(_inv({"command": "false", "cwd": str(tmp_path)}))
        assert not r["ok"]
        assert r["output"]["exitCode"] != 0

    async def test_missing_command_returns_error(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        r = await ex.run(_inv({"command": ""}))
        assert not r["ok"]
        assert "command" in r["detail"]

    async def test_timeout_enforced(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        r = await ex.run(_inv({
            "command": "sleep 10",
            "cwd": str(tmp_path),
            "timeout_ms": 300,
        }))
        assert not r["ok"]
        assert r["output"]["timedOut"] is True

    async def test_stdout_captured(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        r = await ex.run(_inv({
            "command": f"{sys.executable} -c \"print('AURA_OUTPUT')\"",
            "cwd": str(tmp_path),
        }))
        assert r["ok"], r
        assert "AURA_OUTPUT" in r["output"]["stdout"]

    async def test_verify_passes_on_zero_exit(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        run_result = await ex.run(_inv({"command": "echo ok", "cwd": str(tmp_path)}))
        verify_result = await ex.verify(_inv({"command": "echo ok"}), run_result)
        assert verify_result["passed"]
        assert verify_result["kind"] == "exit-code"

    async def test_verify_fails_on_nonzero_exit(self, tmp_path):
        adapters, _ = _make_executors(tmp_path)
        ex = _get_executor(adapters, "sandbox.execute")
        run_result = await ex.run(_inv({"command": "false", "cwd": str(tmp_path)}))
        verify_result = await ex.verify(_inv({"command": "false"}), run_result)
        assert not verify_result["passed"]
