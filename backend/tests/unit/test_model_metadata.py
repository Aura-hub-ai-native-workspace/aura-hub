"""Model capability metadata: authoritative when reported, explicitly unknown otherwise.

Missing, malformed or unreachable metadata must never become a guessed value,
and a model name must never be the only evidence for a critical capability.
"""

from __future__ import annotations

import io
import json
import urllib.error
from pathlib import Path

import pytest

from aura.agent_runtime import model_metadata as mm
from aura.agent_runtime.adapters import opencode as opencode_mod
from aura.agent_runtime.model import AuthType, RuntimeConfig
from aura.sovereign.model_registry import _infer_capabilities, reconcile_capabilities


# ── parsing ─────────────────────────────────────────────────────────────


def test_reported_tools_and_context_are_authoritative():
    meta = mm.parse_ollama_show("m", {
        "capabilities": ["completion", "tools"],
        "model_info": {"qwen2.context_length": 32768, "qwen2.block_count": 28},
    })
    assert meta.status == "verified"
    assert meta.tool_calling is True
    assert meta.context_length == 32768


def test_capability_list_without_tools_is_an_authoritative_no():
    meta = mm.parse_ollama_show("nomic", {"capabilities": ["embedding"]})
    assert meta.tool_calling is False
    assert meta.context_length is None  # not reported, so unknown


def test_missing_capability_list_is_unknown_not_false():
    meta = mm.parse_ollama_show("m", {"model_info": {"llama.context_length": 8192}})
    assert meta.tool_calling is None
    assert meta.context_length == 8192


def test_ambiguous_context_fields_are_unknown():
    meta = mm.parse_ollama_show("m", {"model_info": {
        "a.context_length": 4096, "b.context_length": 8192}})
    assert meta.context_length is None
    assert meta.status == "empty"


@pytest.mark.parametrize("value", [True, 0, -1, "32768", 3.5])
def test_implausible_context_values_are_ignored(value):
    meta = mm.parse_ollama_show("m", {"model_info": {"x.context_length": value}})
    assert meta.context_length is None


def test_reply_with_neither_field_is_empty_not_verified():
    meta = mm.parse_ollama_show("m", {"template": "..."})
    assert meta.status == "empty"
    assert meta.tool_calling is None and meta.context_length is None


@pytest.mark.parametrize("payload", [None, [], "tools", 42])
def test_non_object_reply_is_malformed(payload):
    assert mm.parse_ollama_show("m", payload).status == "malformed"


@pytest.mark.parametrize("caps", ["tools", ["tools", 1], {"tools": True}])
def test_malformed_capability_list_is_malformed(caps):
    meta = mm.parse_ollama_show("m", {"capabilities": caps})
    assert meta.status == "malformed"
    assert meta.tool_calling is None


# ── endpoint handling ───────────────────────────────────────────────────


@pytest.mark.parametrize("base,root", [
    ("http://127.0.0.1:11434/v1", "http://127.0.0.1:11434"),
    ("http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434"),
    ("https://gpu.internal:8443", "https://gpu.internal:8443"),
])
def test_server_root_is_derived_from_the_openai_base(base, root):
    assert mm.ollama_server_root(base) == root


@pytest.mark.parametrize("base", ["file:///etc/passwd", "ftp://host/x", "", "not a url"])
def test_unsafe_or_empty_base_urls_are_never_queried(base):
    calls = []
    meta = mm.fetch_ollama_metadata(base, "m", opener=lambda *a, **k: calls.append(a))
    assert meta.status == "not_queried"
    assert calls == []


def _opener_returning(body: bytes, seen_timeouts=None):
    def opener(req, timeout):
        if seen_timeouts is not None:
            seen_timeouts.append(timeout)
        return io.BytesIO(body)
    return opener


def test_fetch_parses_a_valid_reply():
    body = json.dumps({"capabilities": ["tools"],
                       "model_info": {"q.context_length": 4096}}).encode()
    seen: list = []
    meta = mm.fetch_ollama_metadata("http://h:11434/v1", "m", timeout_s=1.5,
                                    opener=_opener_returning(body, seen))
    assert seen == [1.5]  # the caller's bound reaches the request
    assert meta.status == "verified"
    assert meta.tool_calling is True and meta.context_length == 4096


def test_fetch_reports_an_unreachable_endpoint_as_unavailable():
    def down(req, timeout):
        raise urllib.error.URLError("connection refused")

    meta = mm.fetch_ollama_metadata("http://h:11434/v1", "m", opener=down)
    assert meta.status == "unavailable"
    assert meta.tool_calling is None and meta.context_length is None


def test_model_not_found_is_an_http_error_not_an_unreachable_endpoint():
    def not_found(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "not found", {}, io.BytesIO(b""))

    meta = mm.fetch_ollama_metadata("http://h:11434/v1", "missing", opener=not_found)
    assert meta.status == "http_error"
    assert meta.detail == "HTTP 404"


def test_fetch_reports_invalid_json_as_malformed():
    meta = mm.fetch_ollama_metadata("http://h:11434/v1", "m",
                                    opener=_opener_returning(b"<html>proxy error</html>"))
    assert meta.status == "malformed"


# ── misleading names do not decide critical capabilities ────────────────


def test_name_substring_no_longer_implies_json_mode():
    assert "json-mode" not in _infer_capabilities("limit-7b-base", 0)
    assert "json-mode" not in _infer_capabilities("written-tiny", 0)
    assert "json-mode" in _infer_capabilities("some-it-model", 0)


def test_authoritative_list_overrides_a_vision_name_hint():
    hints = _infer_capabilities("llava:7b", 0)
    meta = mm.parse_ollama_show("llava:7b", {"capabilities": ["completion"]})
    tags, sources, _ = reconcile_capabilities(hints, meta)
    assert "vision" not in tags


def test_embedding_model_is_not_text_generation_when_the_server_says_so():
    hints = _infer_capabilities("nomic-embed-text", 0)
    meta = mm.parse_ollama_show("nomic-embed-text", {"capabilities": ["embedding"]})
    tags, sources, _ = reconcile_capabilities(hints, meta)
    assert "embedding" in tags and "text-generation" not in tags
    assert sources["embedding"] == "ollama:/api/show"


def test_tags_without_an_authoritative_source_stay_marked_as_hints():
    hints = _infer_capabilities("qwen2.5-coder:1.5b", 0)
    meta = mm.parse_ollama_show("qwen2.5-coder:1.5b", {"capabilities": ["completion", "tools"]})
    tags, sources, _ = reconcile_capabilities(hints, meta)
    assert "code-generation" in tags
    assert sources["code-generation"] == "name-hint"
    assert sources["tool-calling"] == "ollama:/api/show"


def test_unknown_metadata_keeps_hints_and_reports_no_context():
    hints = _infer_capabilities("llama3.2:3b", 0)
    meta = mm.unknown("llama3.2:3b", "unavailable")
    tags, sources, context = reconcile_capabilities(hints, meta)
    assert tags == hints
    assert set(sources.values()) == {"name-hint"}
    assert context == 0


# ── OpenCode writes only verified values ────────────────────────────────


def _runtime(**overrides) -> RuntimeConfig:
    base = dict(base_url="http://127.0.0.1:11434/v1", model_id="qwen2.5-coder:1.5b",
                auth_type=AuthType.KEYLESS, network_class="local")
    base.update(overrides)
    return RuntimeConfig(**base)


def test_opencode_writes_no_guessed_limits_or_tool_flags():
    entry = opencode_mod.OpenCodeAdapter._model_entry(_runtime())
    assert entry == {"name": "qwen2.5-coder:1.5b"}


def test_opencode_writes_tool_flag_only_when_verified():
    assert opencode_mod.OpenCodeAdapter._model_entry(
        _runtime(tool_calling=True))["tool_call"] is True
    assert opencode_mod.OpenCodeAdapter._model_entry(
        _runtime(tool_calling=False))["tool_call"] is False


def test_opencode_writes_a_limit_block_only_with_both_values():
    context_only = opencode_mod.OpenCodeAdapter._model_entry(_runtime(context_length=32768))
    assert "limit" not in context_only
    both = opencode_mod.OpenCodeAdapter._model_entry(
        _runtime(context_length=32768, max_output_tokens=4096))
    assert both["limit"] == {"context": 32768, "output": 4096}


def test_opencode_no_longer_contains_the_hard_coded_context_window(tmp_path, monkeypatch):
    config = tmp_path / "opencode.json"
    monkeypatch.setattr(opencode_mod, "_CONFIG_PATH", config)
    monkeypatch.setattr(opencode_mod, "_KEY_FILE", tmp_path / "k")
    opencode_mod.OpenCodeAdapter().apply(_runtime())
    text = config.read_text(encoding="utf-8")
    assert "128000" not in text and "8192" not in text
    assert "tool_call" not in text


# ── the service only queries private endpoints, and writes what it verified ──


def test_service_does_not_query_cloud_endpoints(monkeypatch):
    from aura.agent_runtime import service as service_mod

    def must_not_call(*a, **k):
        raise AssertionError("cloud endpoint was queried")

    monkeypatch.setattr(service_mod, "fetch_ollama_metadata", must_not_call)
    rt, meta = service_mod.AgentRuntimeService._with_metadata(
        _runtime(network_class="cloud", base_url="https://api.example.com/v1"))
    assert meta.status == "not_queried"
    assert rt.tool_calling is None and rt.context_length is None


def test_service_fills_unknown_fields_from_verified_metadata(monkeypatch):
    from aura.agent_runtime import service as service_mod

    def verified(base_url, model_id, timeout_s=3.0, opener=None):
        return mm.parse_ollama_show(model_id, {
            "capabilities": ["completion", "tools"],
            "model_info": {"qwen2.context_length": 32768}})

    monkeypatch.setattr(service_mod, "fetch_ollama_metadata", verified)
    rt, meta = service_mod.AgentRuntimeService._with_metadata(_runtime())
    assert rt.tool_calling is True and rt.context_length == 32768
    assert meta.status == "verified"


def test_service_keeps_operator_supplied_values(monkeypatch):
    from aura.agent_runtime import service as service_mod

    monkeypatch.setattr(service_mod, "fetch_ollama_metadata",
                        lambda *a, **k: mm.parse_ollama_show("m", {"capabilities": ["tools"]}))
    rt, _ = service_mod.AgentRuntimeService._with_metadata(
        _runtime(tool_calling=False, context_length=4096))
    assert rt.tool_calling is False and rt.context_length == 4096
