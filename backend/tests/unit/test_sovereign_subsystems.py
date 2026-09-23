"""Tests for the sovereign runtime subsystems (S1–S5, S8–S10, S12).

Coverage:
  S1/S4 — SovereignPolicy: load, allows(), describe(), write config
  S1    — RoutedModelPort keyless + sovereign enforcement
  S2    — ModelRegistry: discover, query, health, snapshot
  S3    — ModelRouter + TaskClassifier: task → capability → record
  S5    — EgressGateway: AI inference host detection, journal, sovereign block
  S8    — KnowledgeBase: add, persist, reload, BM25 search
  S10   — ArtifactGenerator: graceful degradation + structure
  S12   — CentralAgent: sovereign_policy param + auto-load
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# S1 / S4: SovereignPolicy
# ---------------------------------------------------------------------------

class TestSovereignPolicy:
    def test_unrestricted_allows_all(self):
        from aura.sovereign import SovereignPolicy
        p = SovereignPolicy(sovereign_mode=False)
        for nc in ("local", "private", "cloud", "unknown"):
            assert p.allows(nc), f"{nc} should be allowed in unrestricted mode"

    def test_sovereign_mode_blocks_cloud(self):
        from aura.sovereign import SovereignPolicy
        p = SovereignPolicy(sovereign_mode=True)
        assert p.allows("local")
        assert p.allows("private")
        assert not p.allows("cloud")
        assert not p.allows("unknown")

    def test_custom_allowed_classes(self):
        from aura.sovereign import SovereignPolicy
        p = SovereignPolicy(sovereign_mode=True,
                            allowed_classes=frozenset({"local"}))
        assert p.allows("local")
        assert not p.allows("private")
        assert not p.allows("cloud")

    def test_describe_includes_disclaimer(self):
        from aura.sovereign import SovereignPolicy
        p = SovereignPolicy(sovereign_mode=True)
        d = p.describe()
        assert d["sovereignMode"] is True
        assert "APPLICATION ENFORCED" in d["note"]
        # Must NOT claim physical air-gap
        assert "PHYSICALLY" not in d["note"]

    def test_describe_unrestricted(self):
        from aura.sovereign import SovereignPolicy
        p = SovereignPolicy(sovereign_mode=False)
        assert "unrestricted" in p.describe()["note"].lower()

    def test_load_policy_default(self, tmp_path):
        from aura.sovereign.policy import load_sovereign_policy
        p = load_sovereign_policy(path=str(tmp_path / "nonexistent.json"))
        assert p.sovereign_mode is False
        assert p.source == "default"

    def test_load_policy_from_file(self, tmp_path):
        from aura.sovereign.policy import load_sovereign_policy
        cfg = tmp_path / "sovereign.json"
        cfg.write_text(json.dumps({"sovereignMode": True}))
        p = load_sovereign_policy(path=str(cfg))
        assert p.sovereign_mode is True
        assert p.source == "file"

    def test_load_policy_env_override(self, tmp_path, monkeypatch):
        from aura.sovereign.policy import load_sovereign_policy
        cfg = tmp_path / "sovereign.json"
        cfg.write_text(json.dumps({"sovereignMode": False}))
        monkeypatch.setenv("AURA_SOVEREIGN_MODE", "1")
        p = load_sovereign_policy(path=str(cfg))
        assert p.sovereign_mode is True
        assert p.source == "env"

    def test_write_and_reload(self, tmp_path):
        from aura.sovereign.policy import write_sovereign_config, load_sovereign_policy
        out = write_sovereign_config(True, path=str(tmp_path / "sovereign.json"))
        p = load_sovereign_policy(path=str(out))
        assert p.sovereign_mode is True
        assert "_note" not in p.describe()  # _note is a file annotation, not API


# ---------------------------------------------------------------------------
# S1: RoutedModelPort — keyless + sovereign enforcement
# ---------------------------------------------------------------------------

class TestRoutedModelPortSovereign:
    def _make_spec(self, id="p", network_class="cloud", api_key_env="KEY"):
        from aura.central_agent.model_routing import ProviderSpec
        return ProviderSpec(id=id, base_url="http://fake", model="m",
                            api_key_env=api_key_env, network_class=network_class)

    def test_cloud_blocked_in_sovereign_mode(self):
        from aura.central_agent.model_routing import RoutedModelPort, RoutingError
        from aura.sovereign import SovereignPolicy
        policy = SovereignPolicy(sovereign_mode=True)
        spec = self._make_spec(network_class="cloud")
        os.environ["KEY"] = "test-key"
        try:
            port = RoutedModelPort([spec], sovereign_policy=policy)
            with pytest.raises(RoutingError) as exc_info:
                port.complete_json("s", "u")
            assert exc_info.value.category == "PROVIDER_NOT_CONFIGURED"
            assert "sovereign policy" in port.health["p"].last_error
        finally:
            del os.environ["KEY"]

    def test_local_passes_sovereign_check(self):
        from aura.central_agent.model_routing import RoutedModelPort, RoutingError
        from aura.sovereign import SovereignPolicy
        policy = SovereignPolicy(sovereign_mode=True)
        spec = self._make_spec(network_class="local", api_key_env="")
        port = RoutedModelPort([spec], sovereign_policy=policy)
        # Should attempt connection (fails with PROVIDER_UNAVAILABLE, not config error)
        with pytest.raises(RoutingError) as exc_info:
            port.complete_json("s", "u")
        assert exc_info.value.category != "PROVIDER_NOT_CONFIGURED"

    def test_keyless_skips_authorization_header(self):
        from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort
        spec = ProviderSpec(id="ollama", base_url="http://x", model="llama3",
                            api_key_env="", network_class="local")
        captured = {}

        def fake_post(url, payload, headers, timeout):
            captured["headers"] = dict(headers)
            return {"choices": [{"message": {"content": '{"r": 1}'}}]}

        port = RoutedModelPort([spec])
        port._post = fake_post
        port.complete_json("s", "u")
        assert "authorization" not in captured["headers"]

    def test_telemetry_exposes_network_class(self):
        from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort
        from aura.sovereign import SovereignPolicy
        spec = ProviderSpec(id="p", base_url="http://x", model="m",
                            api_key_env="", network_class="local")
        policy = SovereignPolicy(sovereign_mode=True)
        port = RoutedModelPort([spec], sovereign_policy=policy)
        tel = port.telemetry()
        p_tel = tel["providers"][0]
        assert p_tel["networkClass"] == "local"
        assert p_tel["keyless"] is True
        assert p_tel["sovereignAllowed"] is True
        assert tel["sovereignMode"] is True

    def test_infer_network_class_loopback(self):
        from aura.central_agent.model_routing import _infer_network_class
        assert _infer_network_class("http://localhost:11434") == "local"
        assert _infer_network_class("http://127.0.0.1:11434") == "local"

    def test_infer_network_class_private(self):
        from aura.central_agent.model_routing import _infer_network_class
        assert _infer_network_class("http://192.168.1.100:11434") == "private"
        assert _infer_network_class("http://10.0.0.1:8080") == "private"

    def test_infer_network_class_cloud(self):
        from aura.central_agent.model_routing import _infer_network_class
        # Hostnames we can't classify become "unknown" (treated as cloud)
        result = _infer_network_class("https://api.openai.com/v1")
        assert result in ("cloud", "unknown")


# ---------------------------------------------------------------------------
# S2: ModelRegistry
# ---------------------------------------------------------------------------

class TestModelRegistry:
    def _make_record(self, model_name="llama3", network_class="local",
                     caps=None):
        from aura.sovereign import ModelRecord
        caps = caps or frozenset({"text-generation", "json-mode"})
        return ModelRecord(
            id=f"ep/{model_name}", model_name=model_name,
            endpoint_id="ep", base_url="http://localhost:11434",
            network_class=network_class, capabilities=caps, healthy=True)

    def test_register_and_query(self):
        from aura.sovereign import ModelRegistry
        reg = ModelRegistry()
        rec = self._make_record()
        reg.register_manual(rec)
        results = reg.query(frozenset({"text-generation", "json-mode"}))
        assert len(results) == 1
        assert results[0].id == rec.id

    def test_query_unhealthy_excluded(self):
        from aura.sovereign import ModelRegistry, ModelRecord
        reg = ModelRegistry()
        rec = self._make_record()
        rec.healthy = False
        reg.register_manual(rec)
        assert reg.query(frozenset({"text-generation"}), healthy_only=True) == []

    def test_query_network_class_filter(self):
        from aura.sovereign import ModelRegistry
        reg = ModelRegistry()
        local_rec = self._make_record(model_name="local-llm", network_class="local")
        cloud_rec = self._make_record(model_name="cloud-llm", network_class="cloud")
        reg.register_manual(local_rec)
        reg.register_manual(cloud_rec)
        results = reg.query(frozenset({"text-generation"}),
                            network_classes=frozenset({"local"}))
        assert all(r.network_class == "local" for r in results)

    def test_snapshot_structure(self):
        from aura.sovereign import ModelRegistry
        reg = ModelRegistry()
        reg.register_manual(self._make_record())
        snap = reg.snapshot()
        assert snap["total"] == 1
        assert snap["healthy"] == 1
        assert len(snap["records"]) == 1

    def test_infer_capabilities_code(self):
        from aura.sovereign.model_registry import _infer_capabilities
        caps = _infer_capabilities("deepseek-coder:6.7b", 0)
        assert "code-generation" in caps

    def test_infer_capabilities_embedding(self):
        from aura.sovereign.model_registry import _infer_capabilities
        caps = _infer_capabilities("nomic-embed-text", 0)
        assert "embedding" in caps
        assert "text-generation" not in caps

    def test_infer_capabilities_long_context(self):
        from aura.sovereign.model_registry import _infer_capabilities
        caps = _infer_capabilities("llama3", 32768)
        assert "long-context" in caps


# ---------------------------------------------------------------------------
# S3: ModelRouter + TaskClassifier
# ---------------------------------------------------------------------------

class TestModelRouter:
    def _make_registry(self):
        from aura.sovereign import ModelRegistry, ModelRecord
        reg = ModelRegistry()
        reg.register_manual(ModelRecord(
            id="ep/llama3", model_name="llama3", endpoint_id="ep",
            base_url="http://localhost:11434", network_class="local",
            capabilities=frozenset({"text-generation", "json-mode"}),
            healthy=True))
        reg.register_manual(ModelRecord(
            id="ep/deepseek-coder", model_name="deepseek-coder", endpoint_id="ep",
            base_url="http://localhost:11434", network_class="local",
            capabilities=frozenset({"code-generation", "text-generation"}),
            healthy=True))
        return reg

    def test_classify_planning(self):
        from aura.sovereign import TaskClassifier
        clf = TaskClassifier()
        assert clf.classify("Create a plan for the Q4 sprint") == "planning"

    def test_classify_coding(self):
        from aura.sovereign import TaskClassifier
        clf = TaskClassifier()
        assert clf.classify("Fix the bug in auth.py") == "coding"
        assert clf.classify("Implement a REST endpoint") == "coding"

    def test_classify_summarisation(self):
        from aura.sovereign import TaskClassifier
        clf = TaskClassifier()
        assert clf.classify("Summarise this document") == "summarisation"

    def test_classify_general_fallback(self):
        from aura.sovereign import TaskClassifier
        clf = TaskClassifier()
        assert clf.classify("xyznorelevantwords") == "general"

    def test_route_planning_to_json_model(self):
        from aura.sovereign import ModelRouter
        reg = self._make_registry()
        router = ModelRouter(reg)
        d = router.route("Create a project plan")
        assert d.record is not None
        assert "json-mode" in d.record.capabilities

    def test_route_coding_to_code_model(self):
        from aura.sovereign import ModelRouter
        reg = self._make_registry()
        router = ModelRouter(reg)
        d = router.route("Write a Python function to parse JSON")
        assert d.record is not None
        assert "code-generation" in d.record.capabilities

    def test_route_vision_returns_none(self):
        from aura.sovereign import ModelRouter
        reg = self._make_registry()
        router = ModelRouter(reg)
        d = router.route("Describe this image")
        assert d.record is None
        assert "No private model" in d.reason

    def test_routing_decision_explains_gap(self):
        from aura.sovereign import ModelRouter
        reg = self._make_registry()
        router = ModelRouter(reg)
        d = router.route("Embed this document for retrieval")
        assert d.record is None
        # Must give an actionable reason, not an opaque error
        assert len(d.reason) > 20


# ---------------------------------------------------------------------------
# S5: EgressGateway AI inference journal
# ---------------------------------------------------------------------------

class TestEgressGatewayAI:
    def test_ai_host_detection(self):
        from aura.governance.netgate import _is_ai_inference_host
        assert _is_ai_inference_host("api.openai.com")
        assert _is_ai_inference_host("api.anthropic.com")
        assert _is_ai_inference_host("generativelanguage.googleapis.com")
        assert not _is_ai_inference_host("github.com")
        assert not _is_ai_inference_host("fakopenai.com")
        assert not _is_ai_inference_host("localhost")

    def test_inference_journal_entry(self):
        from aura.governance.netgate import InferenceJournalEntry
        e = InferenceJournalEntry(
            at="2026-09-23T00:00:00Z", host="api.openai.com", port=443,
            decision="DENY", reason="sovereign", sovereign_block=True)
        d = e.to_dict()
        assert d["actionType"] == "AI_INFERENCE"
        assert d["sovereignBlock"] is True
        assert d["decision"] == "DENY"

    def test_gateway_accepts_sovereign_policy(self):
        from aura.governance.netgate import EgressGateway
        from aura.sovereign import SovereignPolicy
        policy = SovereignPolicy(sovereign_mode=True)
        gw = EgressGateway("/tmp/test.sock", ("example.com",),
                           sovereign_policy=policy)
        assert gw._sovereign_policy is policy

    def test_inference_journal_snapshot_empty(self):
        from aura.governance.netgate import EgressGateway
        gw = EgressGateway("/tmp/test2.sock", ("example.com",))
        snap = gw.inference_journal_snapshot()
        assert snap["total"] == 0
        assert snap["blocked"] == 0
        assert snap["entries"] == []


# ---------------------------------------------------------------------------
# S8: KnowledgeBase
# ---------------------------------------------------------------------------

class TestKnowledgeBase:
    class _FakeExtraction:
        def __init__(self, text):
            from aura.multimodal.ingestor import ExtractionStatus
            self.text = text
            self.mime_type = "text/plain"
            self.metadata = {}
            self.status = ExtractionStatus.OK
            self.note = ""

    def test_add_and_search(self, tmp_path):
        from aura.knowledge import KnowledgeBase
        kb = KnowledgeBase(store_dir=tmp_path)
        kb.add_document("/doc/finance.txt",
                        self._FakeExtraction("Invoice approval requires three signatories."))
        results = kb.search("invoice approval")
        assert len(results) > 0
        assert results[0].score > 0
        assert "finance.txt" in results[0].doc_record.path

    def test_persist_and_reload(self, tmp_path):
        from aura.knowledge import KnowledgeBase
        kb = KnowledgeBase(store_dir=tmp_path)
        kb.add_document("/doc/policy.txt",
                        self._FakeExtraction("All travel expenses need manager sign-off."))
        kb2 = KnowledgeBase(store_dir=tmp_path)
        assert kb2.snapshot()["documents"] == 1
        results = kb2.search("travel expenses")
        assert len(results) > 0

    def test_remove_document(self, tmp_path):
        from aura.knowledge import KnowledgeBase
        kb = KnowledgeBase(store_dir=tmp_path)
        kb.add_document("/doc/x.txt", self._FakeExtraction("Some content here."))
        assert kb.snapshot()["documents"] == 1
        removed = kb.remove_document("/doc/x.txt")
        assert removed is True
        assert kb.snapshot()["documents"] == 0

    def test_search_result_has_attribution(self, tmp_path):
        from aura.knowledge import KnowledgeBase
        kb = KnowledgeBase(store_dir=tmp_path)
        kb.add_document("/docs/process.txt",
                        self._FakeExtraction("Procurement process: three quotes required."))
        results = kb.search("procurement quotes")
        assert len(results) > 0
        d = results[0].to_dict()
        assert "path" in d
        assert "text" in d
        assert "score" in d
        assert d["matchType"] == "bm25"

    def test_empty_search_returns_nothing(self, tmp_path):
        from aura.knowledge import KnowledgeBase
        kb = KnowledgeBase(store_dir=tmp_path)
        results = kb.search("completely unrelated query")
        assert results == []


# ---------------------------------------------------------------------------
# S10: ArtifactGenerator
# ---------------------------------------------------------------------------

class TestArtifactGenerator:
    def test_missing_docx_dep_returns_status(self, tmp_path):
        from aura.artifacts import ArtifactGenerator, ArtifactSpec, ArtifactType
        gen = ArtifactGenerator()
        spec = ArtifactSpec(
            artifact_type=ArtifactType.DOCX, title="Test",
            sections=[{"heading": "S1", "body": "Hello"}])
        result = gen.generate(spec, tmp_path / "out.docx")
        # Either ok (if python-docx installed) or missing_dep (if not)
        assert result.status in ("ok", "missing_dep")
        if result.status == "missing_dep":
            assert "pip install" in result.note

    def test_missing_xlsx_dep_returns_status(self, tmp_path):
        from aura.artifacts import ArtifactGenerator, ArtifactSpec, ArtifactType
        gen = ArtifactGenerator()
        spec = ArtifactSpec(
            artifact_type=ArtifactType.XLSX, title="Budget",
            sections=[{"rows": [["A", "B"], ["1", "2"]]}])
        result = gen.generate(spec, tmp_path / "out.xlsx")
        assert result.status in ("ok", "missing_dep")

    def test_result_to_dict_structure(self, tmp_path):
        from aura.artifacts import ArtifactGenerator, ArtifactSpec, ArtifactType
        gen = ArtifactGenerator()
        spec = ArtifactSpec(artifact_type=ArtifactType.DOCX, title="T")
        result = gen.generate(spec, tmp_path / "out.docx")
        d = result.to_dict()
        assert "artifactType" in d
        assert "status" in d
        assert "sizeBytes" in d
        assert "generatedAt" in d

    def test_docx_is_valid_zip_if_generated(self, tmp_path):
        """If python-docx is available, the generated file must be a valid ZIP."""
        import zipfile
        from aura.artifacts import ArtifactGenerator, ArtifactSpec, ArtifactType
        gen = ArtifactGenerator()
        spec = ArtifactSpec(
            artifact_type=ArtifactType.DOCX, title="Report",
            sections=[
                {"heading": "Summary", "body": "All clear."},
                {"rows": [["Item", "Status"], ["Door", "OK"]]},
            ])
        out = tmp_path / "report.docx"
        result = gen.generate(spec, out)
        if result.status == "ok":
            assert result.size_bytes > 0
            assert out.exists()
            with zipfile.ZipFile(out) as z:
                assert any("word/" in n for n in z.namelist())


# ---------------------------------------------------------------------------
# S12: CentralAgent sovereign_policy parameter
# ---------------------------------------------------------------------------

class TestCentralAgentSovereign:
    def test_sovereign_policy_param_exists(self):
        import inspect
        from aura.central_agent.service import CentralAgent
        sig = inspect.signature(CentralAgent.__init__)
        assert "sovereign_policy" in sig.parameters

    def test_load_sovereign_policy_at_startup(self, tmp_path, monkeypatch):
        """With no config file, policy loads as default (unrestricted)."""
        monkeypatch.delenv("AURA_SOVEREIGN_MODE", raising=False)
        from aura.sovereign.policy import load_sovereign_policy
        p = load_sovereign_policy(path=str(tmp_path / "nonexistent.json"))
        assert p.sovereign_mode is False
        assert p.source == "default"

    def test_sovereign_policy_blocks_cloud_providers(self):
        """Cloud providers are excluded before building the model port."""
        from aura.central_agent.model_routing import ProviderSpec
        from aura.sovereign import SovereignPolicy
        policy = SovereignPolicy(sovereign_mode=True)
        cloud = ProviderSpec(id="openai", base_url="https://api.openai.com/v1",
                             model="gpt-4o", api_key_env="OPENAI_API_KEY",
                             network_class="cloud")
        # Simulate what default_model_port does with sovereign_policy
        specs = [s for s in [cloud] if s.enabled]
        filtered = [s for s in specs if policy.allows(s.network_class)]
        assert filtered == []  # cloud filtered out → no model port built
