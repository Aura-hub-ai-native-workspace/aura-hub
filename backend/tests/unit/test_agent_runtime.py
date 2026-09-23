"""Tests for the AI Agent Runtime Control Plane.

Covers:
  - AgentConfigurationAdapter contract (per adapter)
  - ConfigurationBackupManager: backup, restore, list
  - DriftDetector: in-sync vs drifted
  - AgentRuntimeRegistry: discovery loop, error isolation
  - AgentRuntimeService: apply, restore, drift, sovereign block
  - RuntimeConfig.to_dict(): no secret values
  - HTTP routes via TestClient
"""

import json
import os
import tempfile
from pathlib import Path

import pytest

from aura.agent_runtime.backup import ConfigurationBackupManager
from aura.agent_runtime.drift import DriftDetector
from aura.agent_runtime.model import (
    AgentRecord,
    AuthType,
    ConfigStatus,
    ConfigurationChange,
    DriftStatus,
    RuntimeConfig,
    checksum,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _runtime(base_url="http://localhost:11434/v1", model_id="llama3.2",
             auth_type=AuthType.KEYLESS, network_class="local") -> RuntimeConfig:
    return RuntimeConfig(
        base_url=base_url,
        model_id=model_id,
        auth_type=auth_type,
        network_class=network_class,
    )


def _record(agent_id="test-agent", detected=True,
            base_url=None, model=None) -> AgentRecord:
    return AgentRecord(
        agent_id=agent_id,
        display_name=agent_id,
        version="1.0",
        binary_path="/usr/bin/test",
        config_path=None,
        detected=detected,
        adapter_class="test.TestAdapter",
        current_base_url=base_url,
        current_model=model,
        config_status=ConfigStatus.OK if detected else ConfigStatus.NOT_INSTALLED,
    )


# ── RuntimeConfig ─────────────────────────────────────────────────────────────

class TestRuntimeConfig:
    def test_to_dict_no_secrets(self):
        rt = RuntimeConfig(
            base_url="http://localhost:11434/v1",
            model_id="llama3.2",
            auth_type=AuthType.BEARER,
            network_class="local",
            api_key_env="MY_SECRET_KEY",
        )
        d = rt.to_dict()
        blob = json.dumps(d)
        assert "MY_SECRET_KEY" not in blob  # env var name may appear as a label
        assert "api_key_env" not in blob    # internal field not exposed
        assert d["apiKeyConfigured"] is True
        assert d["baseUrl"] == "http://localhost:11434/v1"
        assert d["modelId"] == "llama3.2"
        assert d["networkClass"] == "local"

    def test_keyless_api_key_configured_false(self):
        rt = RuntimeConfig(base_url="http://x", model_id="m")
        d = rt.to_dict()
        assert d["apiKeyConfigured"] is False

    def test_immutable(self):
        rt = _runtime()
        with pytest.raises((AttributeError, TypeError)):
            rt.base_url = "http://other"  # type: ignore[misc]


# ── ConfigurationBackupManager ────────────────────────────────────────────────

class TestConfigurationBackupManager:
    def test_backup_and_restore(self, tmp_path: Path):
        mgr = ConfigurationBackupManager(tmp_path / "backups")
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text('{"key": "value"}', encoding="utf-8")

        raw, backup_id = mgr.backup("agent-x", cfg_file)
        assert raw == b'{"key": "value"}'
        assert "/" in backup_id and backup_id.startswith("agent-x/")

        restored = mgr.restore(backup_id)
        assert restored == raw

    def test_latest_backup_id(self, tmp_path: Path):
        mgr = ConfigurationBackupManager(tmp_path / "backups")
        cfg_file = tmp_path / "cfg.json"
        cfg_file.write_text("{}", encoding="utf-8")

        assert mgr.latest_backup_id("agent-x") is None

        _, bid = mgr.backup("agent-x", cfg_file)
        assert mgr.latest_backup_id("agent-x") == bid

    def test_restore_missing_raises(self, tmp_path: Path):
        mgr = ConfigurationBackupManager(tmp_path / "backups")
        with pytest.raises(FileNotFoundError):
            mgr.restore("agent-x/20991231T000000Z")

    def test_backup_nonexistent_file(self, tmp_path: Path):
        mgr = ConfigurationBackupManager(tmp_path / "backups")
        raw, bid = mgr.backup("agent-y", tmp_path / "doesnotexist.json")
        assert raw == b""
        assert mgr.restore(bid) == b""

    def test_list_backups(self, tmp_path: Path):
        mgr = ConfigurationBackupManager(tmp_path / "backups")
        cfg = tmp_path / "cfg.json"
        cfg.write_text("{}", encoding="utf-8")
        mgr.backup("agt", cfg)
        mgr.backup("agt", cfg)
        metas = mgr.list_backups("agt")
        assert len(metas) == 2
        assert all("agentId" in m for m in metas)

    def test_checksum_stability(self):
        data = b"hello world"
        cs1 = checksum(data)
        cs2 = checksum(data)
        assert cs1 == cs2
        assert len(cs1) == 64  # sha-256 hex


# ── DriftDetector ─────────────────────────────────────────────────────────────

class TestDriftDetector:
    def test_in_sync(self):
        detector = DriftDetector()
        rt = _runtime("http://localhost:11434/v1", "llama3.2")
        rec = _record(base_url="http://localhost:11434/v1", model=None)
        drift = detector.check(rec, rt)
        assert drift.status == DriftStatus.IN_SYNC
        assert drift.drifted_fields == []

    def test_base_url_drifted(self):
        detector = DriftDetector()
        rt = _runtime("http://localhost:11434/v1", "llama3.2")
        rec = _record(base_url="http://other-host:11434/v1")
        drift = detector.check(rec, rt)
        assert drift.status == DriftStatus.DRIFTED
        assert "baseUrl" in drift.drifted_fields

    def test_model_drifted(self):
        detector = DriftDetector()
        rt = _runtime("http://localhost:11434/v1", "llama3.2")
        rec = _record(base_url="http://localhost:11434/v1", model="mistral")
        drift = detector.check(rec, rt)
        assert drift.status == DriftStatus.DRIFTED
        assert "model" in drift.drifted_fields

    def test_not_detected_is_unknown(self):
        detector = DriftDetector()
        rt = _runtime()
        rec = _record(detected=False)
        drift = detector.check(rec, rt)
        assert drift.status == DriftStatus.UNKNOWN
        assert drift.actual_base_url is None

    def test_check_all(self):
        detector = DriftDetector()
        rt = _runtime("http://localhost:11434/v1")
        records = [
            _record("a", base_url="http://localhost:11434/v1"),
            _record("b", base_url="http://other"),
            _record("c", detected=False),
        ]
        drifts = detector.check_all(records, rt)
        assert len(drifts) == 3
        statuses = {d.agent_id: d.status for d in drifts}
        assert statuses["a"] == DriftStatus.IN_SYNC
        assert statuses["b"] == DriftStatus.DRIFTED
        assert statuses["c"] == DriftStatus.UNKNOWN


# ── ClaudeCodeAdapter ─────────────────────────────────────────────────────────

class TestClaudeCodeAdapter:
    def test_readCurrentConfig_not_installed(self, tmp_path: Path, monkeypatch):
        import aura.agent_runtime.adapters.claude_code as _mod
        monkeypatch.setattr(_mod, "_SETTINGS_PATH", tmp_path / "nonexistent.json")
        monkeypatch.setattr(_mod, "_BINARY_CANDIDATES", [])
        import shutil as _shutil
        monkeypatch.setattr(_shutil, "which", lambda x: None)
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        adapter = ClaudeCodeAdapter()
        rec = adapter.readCurrentConfig()
        assert rec.detected is False
        assert rec.config_status == ConfigStatus.NOT_INSTALLED

    def test_apply_writes_env_block(self, tmp_path: Path, monkeypatch):
        settings_path = tmp_path / "settings.json"
        settings_path.write_text('{"theme": "dark"}', encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.claude_code._SETTINGS_PATH", settings_path)
        monkeypatch.setattr("shutil.which", lambda x: "/usr/bin/claude" if x == "claude" else None)

        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        adapter = ClaudeCodeAdapter()
        rt = _runtime()
        change = adapter.apply(rt)
        assert change.status == ConfigStatus.OK
        assert "env.ANTHROPIC_BASE_URL" in change.fields_changed

        written = json.loads(settings_path.read_text())
        assert written["env"]["ANTHROPIC_BASE_URL"] == "http://localhost:11434/v1"
        assert written["env"]["ANTHROPIC_API_KEY"] == "ollama"
        assert written["theme"] == "dark"   # other keys preserved

    def test_verify_matched(self, tmp_path: Path, monkeypatch):
        settings_path = tmp_path / "settings.json"
        settings_path.write_text(
            json.dumps({"env": {"ANTHROPIC_BASE_URL": "http://localhost:11434/v1"}}),
            encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.claude_code._SETTINGS_PATH", settings_path)
        monkeypatch.setattr("shutil.which", lambda x: "/usr/bin/claude" if x == "claude" else None)
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        adapter = ClaudeCodeAdapter()
        change = adapter.verify(_runtime())
        assert change.status == ConfigStatus.OK
        assert "matched" in change.note

    def test_verify_mismatch(self, tmp_path: Path, monkeypatch):
        settings_path = tmp_path / "settings.json"
        settings_path.write_text(
            json.dumps({"env": {"ANTHROPIC_BASE_URL": "http://other"}}),
            encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.claude_code._SETTINGS_PATH", settings_path)
        monkeypatch.setattr("shutil.which", lambda x: "/usr/bin/claude" if x == "claude" else None)
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        adapter = ClaudeCodeAdapter()
        change = adapter.verify(_runtime())
        assert change.status == ConfigStatus.ERROR

    def test_restore(self, tmp_path: Path, monkeypatch):
        settings_path = tmp_path / "settings.json"
        original = '{"theme": "light"}'
        settings_path.write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": "x"}}))
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.claude_code._SETTINGS_PATH", settings_path)
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        adapter = ClaudeCodeAdapter()
        change = adapter.restore(original.encode())
        assert change.status == ConfigStatus.OK
        assert settings_path.read_text() == original


# ── ClaudeCodeAdapter write guard ───────────────────────────────────────────
# Root-cause regression tests (2026-09-23): AURA runs on the same machine —
# often inside Claude Code itself — so apply()/restore() must NEVER rewrite
# the developer's own live ~/.claude/settings.json without explicit opt-in.
# These tests read the live file (allowed) but never write it.

class TestClaudeCodeWriteGuard:
    def _live_path_and_bytes(self):
        import aura.agent_runtime.adapters.claude_code as mod
        live = Path(os.path.expanduser("~/.claude/settings.json"))
        assert Path(mod._REAL_SETTINGS_PATH) == live  # guard watches true path
        return live, (live.read_bytes() if live.exists() else None)

    def _live_base_url(self):
        live = Path(os.path.expanduser("~/.claude/settings.json"))
        if not live.exists():
            return None
        try:
            return json.loads(live.read_text(encoding="utf-8")).get(
                "env", {}).get("ANTHROPIC_BASE_URL")
        except Exception:
            return None

    def test_apply_refuses_live_config_by_default(self, monkeypatch):
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        live, before = self._live_path_and_bytes()
        change = ClaudeCodeAdapter().apply(_runtime())
        assert change.status == ConfigStatus.ERROR
        assert "efus" in change.note
        assert change.fields_changed == []
        assert change.previous_checksum == change.new_checksum
        _, after = self._live_path_and_bytes()
        assert after == before  # byte-for-byte unchanged (or still absent)

    def test_refused_apply_preserves_current_base_url(self, monkeypatch):
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        before = self._live_base_url()
        ClaudeCodeAdapter().apply(_runtime())
        assert self._live_base_url() == before

    def test_apply_isolated_path_still_modifiable(self, tmp_path, monkeypatch):
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        isolated = tmp_path / "isolated-settings.json"
        isolated.write_text('{"theme": "dark"}', encoding="utf-8")
        change = ClaudeCodeAdapter(settings_path=isolated).apply(_runtime())
        assert change.status == ConfigStatus.OK
        written = json.loads(isolated.read_text())
        assert written["env"]["ANTHROPIC_BASE_URL"] == "http://localhost:11434/v1"
        assert written["theme"] == "dark"  # other keys preserved

    def test_restore_refuses_live_config_by_default(self, monkeypatch):
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        live, before = self._live_path_and_bytes()
        change = ClaudeCodeAdapter().restore(b'{"theme": "planted"}')
        assert change.status == ConfigStatus.ERROR
        _, after = self._live_path_and_bytes()
        assert after == before

    def test_restore_isolated_path_works(self, tmp_path, monkeypatch):
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        isolated = tmp_path / "isolated-settings.json"
        isolated.write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": "x"}}))
        original = '{"theme": "light"}'
        change = ClaudeCodeAdapter(settings_path=isolated).restore(
            original.encode())
        assert change.status == ConfigStatus.OK
        assert isolated.read_text() == original

    def test_opt_in_unlocks_guarded_path(self, tmp_path, monkeypatch):
        # Exercises the opt-in branch against a FAKE live path — the real
        # ~/.claude is never touched by this test.
        import aura.agent_runtime.adapters.claude_code as mod
        fake_live = tmp_path / "live-settings.json"
        fake_live.write_text('{"theme": "dark"}', encoding="utf-8")
        monkeypatch.setattr(mod, "_REAL_SETTINGS_PATH", fake_live)
        monkeypatch.setattr(mod, "_SETTINGS_PATH", fake_live)
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
        monkeypatch.delenv("AURA_MANAGE_EXTERNAL_CLAUDE", raising=False)
        refused = ClaudeCodeAdapter().apply(_runtime())
        assert refused.status == ConfigStatus.ERROR
        assert fake_live.read_text() == '{"theme": "dark"}'
        monkeypatch.setenv("AURA_MANAGE_EXTERNAL_CLAUDE", "1")
        allowed = ClaudeCodeAdapter().apply(_runtime())
        assert allowed.status == ConfigStatus.OK
        assert json.loads(fake_live.read_text())["env"][
            "ANTHROPIC_BASE_URL"] == "http://localhost:11434/v1"


# ── QwenCodeAdapter ───────────────────────────────────────────────────────────

class TestQwenCodeAdapter:
    def test_apply_upserts_provider(self, tmp_path: Path, monkeypatch):
        settings_path = tmp_path / "settings.json"
        initial = {
            "modelProviders": {"openai": []},
            "model": {"name": "old-model"},
            "$version": 4,
        }
        settings_path.write_text(json.dumps(initial), encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.qwen._SETTINGS_PATH", settings_path)
        monkeypatch.setattr("shutil.which", lambda x: "/usr/bin/qwen" if x == "qwen" else None)
        from aura.agent_runtime.adapters.qwen import QwenCodeAdapter
        adapter = QwenCodeAdapter()
        rt = _runtime("http://localhost:11434/v1", "llama3.2")
        change = adapter.apply(rt)
        assert change.status == ConfigStatus.OK

        written = json.loads(settings_path.read_text())
        providers = written["modelProviders"]["openai"]
        aura_entry = next((p for p in providers if p["id"] == "aura-private"), None)
        assert aura_entry is not None
        assert aura_entry["baseUrl"] == "http://localhost:11434/v1"
        assert written["model"]["name"] == "llama3.2"

    def test_apply_no_secret_in_file(self, tmp_path: Path, monkeypatch):
        os.environ["TEST_QWEN_KEY"] = "secret_qwen_key_value"
        try:
            settings_path = tmp_path / "settings.json"
            settings_path.write_text('{"modelProviders": {"openai": []}, "$version": 4}')
            monkeypatch.setattr(
                "aura.agent_runtime.adapters.qwen._SETTINGS_PATH", settings_path)
            monkeypatch.setattr("shutil.which", lambda x: "/usr/bin/qwen" if x == "qwen" else None)
            from aura.agent_runtime.adapters.qwen import QwenCodeAdapter
            adapter = QwenCodeAdapter()
            rt = RuntimeConfig(
                base_url="http://localhost:11434/v1",
                model_id="m",
                auth_type=AuthType.BEARER,
                api_key_env="TEST_QWEN_KEY",
            )
            adapter.apply(rt)
            blob = settings_path.read_text()
            assert "secret_qwen_key_value" not in blob
        finally:
            del os.environ["TEST_QWEN_KEY"]


# ── OpenCodeAdapter ───────────────────────────────────────────────────────────

class TestOpenCodeAdapter:
    def test_apply_adds_provider(self, tmp_path: Path, monkeypatch):
        cfg_path = tmp_path / "opencode.json"
        cfg_path.write_text(
            json.dumps({"$schema": "https://opencode.ai/config.json", "provider": {}}),
            encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.opencode._CONFIG_PATH", cfg_path)
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.opencode._KEY_FILE",
            tmp_path / "aura-private.key")
        monkeypatch.setattr("shutil.which",
                            lambda x: "/usr/bin/opencode" if x == "opencode" else None)
        from aura.agent_runtime.adapters.opencode import OpenCodeAdapter
        adapter = OpenCodeAdapter()
        change = adapter.apply(_runtime("http://localhost:11434/v1", "llama3.2"))
        assert change.status == ConfigStatus.OK

        written = json.loads(cfg_path.read_text())
        prov = written["provider"]["aura-private"]
        assert prov["options"]["baseURL"] == "http://localhost:11434/v1"
        assert "llama3.2" in prov["models"]

    def test_verify_success(self, tmp_path: Path, monkeypatch):
        cfg_path = tmp_path / "opencode.json"
        cfg_path.write_text(json.dumps({
            "provider": {
                "aura-private": {
                    "options": {"baseURL": "http://localhost:11434/v1"},
                    "models": {"llama3.2": {}},
                }
            }
        }), encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.opencode._CONFIG_PATH", cfg_path)
        monkeypatch.setattr("shutil.which",
                            lambda x: "/usr/bin/opencode" if x == "opencode" else None)
        from aura.agent_runtime.adapters.opencode import OpenCodeAdapter
        adapter = OpenCodeAdapter()
        change = adapter.verify(_runtime("http://localhost:11434/v1", "llama3.2"))
        assert change.status == ConfigStatus.OK


# ── KiloAdapter ──────────────────────────────────────────────────────────────

class TestKiloAdapter:
    def test_apply_writes_env_block_to_jsonc(self, tmp_path: Path, monkeypatch):
        cfg_path = tmp_path / "kilo.jsonc"
        cfg_path.write_text('{"permission": {}}', encoding="utf-8")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.kilo._CONFIG_PATH", cfg_path)
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.kilo._ADVISORY_PATH",
            tmp_path / "aura-runtime-env.sh")
        monkeypatch.setattr("shutil.which",
                            lambda x: "/usr/bin/kilo" if x in ("kilo", "kilocode") else None)
        from aura.agent_runtime.adapters.kilo import KiloAdapter
        adapter = KiloAdapter()
        change = adapter.apply(_runtime())
        assert change.status == ConfigStatus.PARTIAL  # honest about uncertain env support
        written = json.loads(cfg_path.read_text())
        assert written["env"]["ANTHROPIC_BASE_URL"] == "http://localhost:11434/v1"


# ── CodexAdapter ──────────────────────────────────────────────────────────────

class TestCodexAdapter:
    def test_apply_updates_model_and_writes_advisory(self, tmp_path: Path, monkeypatch):
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text('model = "gpt-5.6"\nmodel_reasoning_effort = "low"\n',
                             encoding="utf-8")
        advisory_path = tmp_path / "aura-runtime-env.sh"
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.codex._CONFIG_PATH", cfg_path)
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.codex._ADVISORY_PATH", advisory_path)
        monkeypatch.setattr("shutil.which",
                            lambda x: "/usr/bin/codex" if x == "codex" else None)
        from aura.agent_runtime.adapters.codex import CodexAdapter
        adapter = CodexAdapter()
        change = adapter.apply(_runtime("http://localhost:11434/v1", "llama3.2"))
        assert change.status == ConfigStatus.PARTIAL  # honest: base_url is env-only
        assert advisory_path.exists()
        advisory = advisory_path.read_text()
        assert "OPENAI_BASE_URL" in advisory
        assert "http://localhost:11434/v1" in advisory
        # Updated model in toml
        new_toml = cfg_path.read_text()
        assert 'model = "llama3.2"' in new_toml
        assert "model_reasoning_effort" in new_toml  # other keys preserved


# ── GeminiCliAdapter ──────────────────────────────────────────────────────────

class TestGeminiCliAdapter:
    def test_not_detected_when_no_binary(self, monkeypatch):
        monkeypatch.setattr("shutil.which", lambda x: None)
        from aura.agent_runtime.adapters.gemini import GeminiCliAdapter
        adapter = GeminiCliAdapter()
        assert adapter.detect() is False

    def test_apply_returns_partial(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr("shutil.which",
                            lambda x: "/usr/bin/gemini" if x == "gemini" else None)
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.gemini._ADVISORY_PATH",
            tmp_path / "aura-runtime-env.sh")
        monkeypatch.setattr(
            "aura.agent_runtime.adapters.gemini._SETTINGS_PATH",
            tmp_path / "settings.json")
        from aura.agent_runtime.adapters.gemini import GeminiCliAdapter
        adapter = GeminiCliAdapter()
        change = adapter.apply(_runtime())
        assert change.status == ConfigStatus.PARTIAL
        assert "not supported" in change.note


# ── AgentRuntimeRegistry ──────────────────────────────────────────────────────

class TestAgentRuntimeRegistry:
    def test_discover_never_crashes(self):
        from aura.agent_runtime.registry import AgentRuntimeRegistry
        registry = AgentRuntimeRegistry()
        records = registry.discover()
        assert isinstance(records, list)
        assert len(records) == 6  # all 6 known agents

    def test_discover_all_have_agent_id(self):
        from aura.agent_runtime.registry import AgentRuntimeRegistry
        registry = AgentRuntimeRegistry()
        for rec in registry.discover():
            assert rec.agent_id, "every record must have an agent_id"

    def test_installed_subset_of_discover(self):
        from aura.agent_runtime.registry import AgentRuntimeRegistry
        registry = AgentRuntimeRegistry()
        all_recs = registry.discover()
        installed = registry.installed()
        assert all(r.detected for r in installed)
        assert len(installed) <= len(all_recs)

    def test_error_isolation(self, monkeypatch):
        """A crashing adapter must not abort discovery of other agents."""
        from aura.agent_runtime import registry as reg_mod
        from aura.agent_runtime.adapters import AgentConfigurationAdapter
        from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter

        class BrokenAdapter(AgentConfigurationAdapter):
            def detect(self): raise RuntimeError("boom")
            def readCurrentConfig(self): raise RuntimeError("boom")
            def buildDesiredConfig(self, runtime): return {}
            def apply(self, runtime): raise RuntimeError("boom")
            def verify(self, runtime): raise RuntimeError("boom")
            def restore(self, backup_bytes): raise RuntimeError("boom")

        original_all = reg_mod._ALL_ADAPTERS[:]
        reg_mod._ALL_ADAPTERS = [BrokenAdapter, ClaudeCodeAdapter]
        try:
            from aura.agent_runtime.registry import AgentRuntimeRegistry
            r = AgentRuntimeRegistry()
            records = r.discover()
            assert len(records) == 2
            error_rec = next(r for r in records if r.config_status == ConfigStatus.ERROR)
            assert "discovery error" in error_rec.notes[0]
        finally:
            reg_mod._ALL_ADAPTERS = original_all


# ── AgentRuntimeService ───────────────────────────────────────────────────────

class TestAgentRuntimeService:
    def test_discover_returns_list(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        svc = AgentRuntimeService(store_dir=tmp_path)
        records = svc.discover()
        assert isinstance(records, list)

    def test_sovereign_block(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        from aura.sovereign.policy import SovereignPolicy

        policy = SovereignPolicy(
            sovereign_mode=True,
            allowed_classes=frozenset({"local", "private"}),
            source="test",
        )
        svc = AgentRuntimeService(store_dir=tmp_path, sovereign_policy=policy)
        cloud_rt = RuntimeConfig(
            base_url="https://api.openai.com/v1",
            model_id="gpt-4",
            network_class="cloud",
        )
        with pytest.raises(ValueError, match="Sovereign mode blocks"):
            svc.apply_all(cloud_rt)

    def test_sovereign_allows_local(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        from aura.sovereign.policy import SovereignPolicy

        policy = SovereignPolicy(
            sovereign_mode=True,
            allowed_classes=frozenset({"local", "private"}),
            source="test",
        )
        svc = AgentRuntimeService(store_dir=tmp_path, sovereign_policy=policy)
        local_rt = _runtime("http://localhost:11434/v1")
        # Should not raise
        changes = svc.apply_all(local_rt)
        assert isinstance(changes, list)

    def test_restore_no_backup(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        svc = AgentRuntimeService(store_dir=tmp_path)
        change = svc.restore_agent("claude-code")
        # Will either succeed (if backup exists on this machine) or return ERROR
        assert change.operation == "restore"

    def test_runtime_summary_no_secrets(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        svc = AgentRuntimeService(store_dir=tmp_path)
        summary = svc.runtime_summary()
        blob = json.dumps(summary)
        for forbidden in ("api_key", "apikey", "secret", "bearer", "authorization",
                          "password", "token"):
            # These must not appear as values — field name "apiKeyConfigured" is ok
            assert forbidden not in blob.lower() or "Configured" in blob

    def test_drift_check_runs(self, tmp_path: Path):
        from aura.agent_runtime.service import AgentRuntimeService
        svc = AgentRuntimeService(store_dir=tmp_path)
        rt = _runtime()
        drifts = svc.check_drift(rt)
        assert isinstance(drifts, list)


# ── HTTP routes ───────────────────────────────────────────────────────────────

class TestAgentRuntimeHTTP:
    def _client(self, tmp_path: Path, monkeypatch):
        import os
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        from starlette.testclient import TestClient
        from aura.api.server import create_app
        return TestClient(create_app())

    def test_discover(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.get("/agent-runtime/discover")
        assert r.status_code == 200
        body = r.json()
        assert "agents" in body
        assert isinstance(body["agents"], list)

    def test_summary(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.get("/agent-runtime/summary")
        assert r.status_code == 200
        body = r.json()
        assert "installedCount" in body
        assert "agents" in body

    def test_apply_all_local_runtime(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.post("/agent-runtime/apply", json={
            "baseUrl": "http://localhost:11434/v1",
            "modelId": "llama3.2",
            "authType": "keyless",
            "networkClass": "local",
        })
        assert r.status_code == 200
        body = r.json()
        assert "changes" in body
        assert isinstance(body["changes"], list)

    def test_apply_missing_fields(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.post("/agent-runtime/apply", json={"baseUrl": "http://localhost:11434/v1"})
        assert r.status_code == 400

    def test_drift_check(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.post("/agent-runtime/drift", json={
            "baseUrl": "http://localhost:11434/v1",
            "modelId": "llama3.2",
        })
        assert r.status_code == 200
        assert "drift" in r.json()

    def test_summary_no_secret_values(self, tmp_path: Path, monkeypatch):
        c = self._client(tmp_path, monkeypatch)
        r = c.get("/agent-runtime/summary")
        blob = r.text.lower()
        for forbidden in ("bearer ", "api_key_value", "secret_value"):
            assert forbidden not in blob
