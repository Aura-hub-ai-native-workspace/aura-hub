"""The CEO's model is local-only; with no local model the CEO is Laya's built-in planner."""
from __future__ import annotations

import json

from aura.central_agent import model_routing as mr


def _write(tmp_path, providers):
    p = tmp_path / "providers.json"
    p.write_text(json.dumps({"providers": providers}), encoding="utf-8")
    return p


LOCAL = {"id": "ollama-local", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3.5:2b", "networkClass": "local"}
REMOTE = {"id": "ollama", "baseUrl": "https://example.ts.net/v1", "model": "qwen3.8:27b", "networkClass": "private"}


def test_remote_provider_is_never_a_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(mr, "_settings_provider_spec", lambda: None)
    port = mr.default_model_port(str(_write(tmp_path, [LOCAL, REMOTE])))
    assert port is not None
    assert [s.id for s in port.providers] == ["ollama-local"]


def test_no_local_provider_means_no_model_port(tmp_path, monkeypatch):
    monkeypatch.setattr(mr, "_settings_provider_spec", lambda: None)
    assert mr.default_model_port(str(_write(tmp_path, [REMOTE]))) is None


def test_settings_remote_provider_is_excluded(tmp_path, monkeypatch):
    settings = mr.ProviderSpec(id="ollama", base_url="https://example.ts.net/v1", model="qwen3.8:27b",
                               network_class="private")
    monkeypatch.setattr(mr, "_settings_provider_spec", lambda: settings)
    monkeypatch.setattr(mr, "_load_operator_providers", lambda path=None: [])
    assert mr.default_model_port() is None
