"""Phase 1: startup discovery reads the provider file through the planner's reader.

Both documented shapes (a wrapper object and a bare list) must work. Missing, malformed and
unreadable files must be reported as such, never as an empty healthy registry. Discovery must
contact only endpoints the operator explicitly configured for a sovereign class, and its
diagnostics must carry no address, header, key name or provider error text.

These tests run the real discovery function against a local fake Ollama server, so the
registry is populated through the same HTTP path production uses.
"""

from __future__ import annotations

import http.server
import json
import threading
from pathlib import Path

import pytest

from aura.central_agent.model_routing import (
    PROVIDER_FILE_MALFORMED,
    PROVIDER_FILE_MISSING,
    PROVIDER_FILE_OK,
    PROVIDER_FILE_UNREADABLE,
    load_providers,
    read_provider_document,
)
from aura.sovereign.discovery_config import discover_configured_endpoints
from aura.sovereign.model_registry import ModelRegistry

SECRET = "sk-SUPERSECRET-DO-NOT-LEAK"
SECRET_ENV = "AURA_TEST_PRIVATE_KEY_NAME"


class _FakeOllama:
    """A minimal /api/tags and /api/show server that counts every request."""

    def __init__(self, models=("qwen2.5-coder:1.5b",), answer=True):
        self.hits: list[str] = []
        self.models = list(models)
        self.answer = answer
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _send(self, payload):
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                outer.hits.append("GET " + self.path)
                if self.path.startswith("/api/tags"):
                    self._send({"models": [{"name": m} for m in outer.models]
                                if outer.answer else []})
                else:
                    self.send_error(404)

            def do_POST(self):  # noqa: N802
                outer.hits.append("POST " + self.path)
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                if self.path.startswith("/api/show"):
                    self._send({"capabilities": ["completion", "tools"],
                                "model_info": {"qwen2.context_length": 32768}})
                else:
                    self.send_error(404)

            def log_message(self, *_a):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def ollama():
    server = _FakeOllama()
    yield server
    server.close()


@pytest.fixture
def cloud_ollama():
    server = _FakeOllama()
    yield server
    server.close()


def _write(tmp_path: Path, document) -> Path:
    path = tmp_path / "agent" / "providers.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document) if not isinstance(document, str) else document,
                    encoding="utf-8")
    return path


def _entry(eid, url, **extra):
    return {"id": eid, "baseUrl": url, "model": "qwen2.5-coder:1.5b", **extra}


# ── both documented shapes ───────────────────────────────────────────────


def test_wrapped_configuration_discovers_its_configured_endpoint(tmp_path, ollama):
    path = _write(tmp_path, {"providers": [_entry("gpu-lan", ollama.url,
                                                  networkClass="private")]})
    registry = ModelRegistry()
    report = discover_configured_endpoints(registry, path=path)
    assert report.file_status == PROVIDER_FILE_OK
    assert report.discovered == ["gpu-lan"]
    assert {r.endpoint_id for r in registry._records.values()} == {"gpu-lan"}


def test_bare_list_configuration_discovers_the_same_endpoint(tmp_path, ollama):
    path = _write(tmp_path, [_entry("gpu-lan", ollama.url, networkClass="private")])
    registry = ModelRegistry()
    report = discover_configured_endpoints(registry, path=path)
    assert report.file_status == PROVIDER_FILE_OK
    assert report.discovered == ["gpu-lan"]


def test_the_planner_and_discovery_read_the_same_entries(tmp_path, ollama):
    path = _write(tmp_path, {"providers": [_entry("gpu-lan", ollama.url, networkClass="private")]})
    planner_view = [p.id for p in load_providers(str(path))]
    discovery_view = discover_configured_endpoints(ModelRegistry(), path=path).discovered
    assert planner_view == discovery_view == ["gpu-lan"]


# ── missing, malformed and unreadable files are explicit ─────────────────


def test_a_missing_file_is_reported_as_missing_and_not_as_a_failure(tmp_path):
    registry = ModelRegistry()
    report = discover_configured_endpoints(registry, path=tmp_path / "absent.json")
    assert report.file_status == PROVIDER_FILE_MISSING
    assert report.endpoints == []
    assert registry._records == {}


@pytest.mark.parametrize("content", ['{"providers": [', "not json at all", "42"])
def test_a_malformed_file_is_reported_as_malformed(tmp_path, content):
    path = _write(tmp_path, content)
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    assert report.file_status == PROVIDER_FILE_MALFORMED
    assert report.file_detail
    assert report.endpoints == []


def test_a_wrapper_whose_providers_field_is_not_a_list_is_malformed(tmp_path):
    path = _write(tmp_path, {"providers": {"gpu-lan": {}}})
    assert read_provider_document(path).status == PROVIDER_FILE_MALFORMED


def test_an_unreadable_file_is_reported_as_unreadable(tmp_path):
    directory = tmp_path / "agent" / "providers.json"
    directory.mkdir(parents=True)       # a directory where the file should be
    assert read_provider_document(directory).status == PROVIDER_FILE_UNREADABLE


def test_a_malformed_file_never_yields_an_empty_healthy_registry_silently(tmp_path):
    registry = ModelRegistry()
    registry.configuration_status = discover_configured_endpoints(
        registry, path=_write(tmp_path, "{broken"))
    assert registry.configuration_status.file_status == PROVIDER_FILE_MALFORMED
    assert registry._records == {}


def test_a_malformed_file_is_not_treated_as_zero_endpoints_by_the_planner(tmp_path):
    assert load_providers(str(_write(tmp_path, "{broken"))) == []
    assert read_provider_document(_write(tmp_path, "{broken")).status == PROVIDER_FILE_MALFORMED


# ── authorisation is unchanged: only configured sovereign endpoints are contacted ──


def test_an_undeclared_network_class_is_not_contacted_even_on_loopback(tmp_path, ollama):
    path = _write(tmp_path, {"providers": [_entry("loopback-undeclared", ollama.url)]})
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    assert report.endpoints[0].reason == "network-class-not-declared"
    assert ollama.hits == []


def test_a_cloud_endpoint_is_never_contacted(tmp_path, ollama, cloud_ollama):
    path = _write(tmp_path, {"providers": [
        _entry("gpu-lan", ollama.url, networkClass="private"),
        _entry("api-cloud", cloud_ollama.url, networkClass="cloud"),
    ]})
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    assert report.discovered == ["gpu-lan"]
    assert cloud_ollama.hits == []
    assert any(e.endpoint_id == "api-cloud" and e.reason == "network-class-not-sovereign"
               for e in report.endpoints)


def test_a_disabled_endpoint_is_not_contacted(tmp_path, ollama):
    path = _write(tmp_path, {"providers": [_entry("gpu-off", ollama.url,
                                                  networkClass="private", enabled=False)]})
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    assert report.endpoints[0].reason == "disabled"
    assert ollama.hits == []


@pytest.mark.parametrize("extra,reason", [
    ({"networkClass": "moon"}, "network-class-invalid"),
    ({"networkClass": "  "}, "network-class-not-declared"),
    ({"networkClass": "private", "baseUrl": "file:///etc/passwd"}, "base-url-unsupported"),
])
def test_malformed_entries_are_skipped_with_a_reason(tmp_path, extra, reason):
    entry = {"id": "bad", "baseUrl": "http://127.0.0.1:9", **extra}
    report = discover_configured_endpoints(ModelRegistry(),
                                           path=_write(tmp_path, {"providers": [entry]}))
    assert report.endpoints[0].outcome == "skipped"
    assert report.endpoints[0].reason == reason


def test_a_missing_id_and_a_duplicate_id_are_skipped(tmp_path, ollama):
    path = _write(tmp_path, {"providers": [
        {"baseUrl": ollama.url, "networkClass": "private"},
        _entry("dup", ollama.url, networkClass="private"),
        _entry("dup", ollama.url, networkClass="private"),
    ]})
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    reasons = [e.reason for e in report.endpoints]
    assert "missing-id" in reasons and "duplicate-id" in reasons
    assert report.discovered == ["dup"]


def test_a_configured_endpoint_with_no_models_is_reported_not_faked(tmp_path):
    server = _FakeOllama(answer=False)
    try:
        path = _write(tmp_path, {"providers": [_entry("empty", server.url, networkClass="private")]})
        registry = ModelRegistry()
        report = discover_configured_endpoints(registry, path=path)
        assert report.endpoints[0].outcome == "no-models-reported"
        assert registry._records == {}
    finally:
        server.close()


def test_an_unreachable_configured_endpoint_is_reported_without_its_address(tmp_path):
    address = "http://127.0.0.1:1"          # nothing listens here
    path = _write(tmp_path, {"providers": [_entry("down", address, networkClass="private")]})
    report = discover_configured_endpoints(ModelRegistry(), path=path, timeout_s=1.0)
    assert report.endpoints[0].outcome == "no-models-reported"
    assert "127.0.0.1" not in json.dumps(report.to_dict())


# ── diagnostics carry no secrets ─────────────────────────────────────────


def test_diagnostics_never_carry_addresses_headers_key_names_or_secrets(tmp_path, ollama):
    token_url = ollama.url + "/?token=" + SECRET
    path = _write(tmp_path, {"providers": [
        _entry("gpu-lan", ollama.url, networkClass="private",
               apiKeyEnv=SECRET_ENV, headers={"x-api-key": SECRET}),
        {"id": "broken", "baseUrl": token_url, "networkClass": "moon",
         "apiKeyEnv": SECRET_ENV, "headers": {"authorization": SECRET}},
    ]})
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    dumped = json.dumps(report.to_dict()) + repr(report)
    for forbidden in (SECRET, SECRET_ENV, ollama.url, str(ollama.port), "authorization",
                      "x-api-key", "token="):
        assert forbidden not in dumped, forbidden


def test_a_malformed_file_diagnostic_never_echoes_its_content(tmp_path):
    path = _write(tmp_path, '{"providers": [{"apiKeyEnv": "%s", ' % SECRET)
    report = discover_configured_endpoints(ModelRegistry(), path=path)
    assert SECRET not in json.dumps(report.to_dict())
    assert SECRET not in report.file_detail


# ── compatibility of the existing planner and startup paths ──────────────


def test_the_planner_loader_keeps_its_behaviour_for_both_shapes(tmp_path, ollama):
    wrapped = load_providers(str(_write(tmp_path / "w", {"providers": [
        _entry("gpu-lan", ollama.url, networkClass="private")]})))
    bare = load_providers(str(_write(tmp_path / "b", [
        _entry("gpu-lan", ollama.url, networkClass="private")])))
    assert [p.id for p in wrapped] == [p.id for p in bare] == ["gpu-lan"]
    assert wrapped[0].network_class == bare[0].network_class == "private"


def test_the_planner_still_infers_a_class_the_discovery_refuses_to_infer(tmp_path, ollama):
    """The planner's documented inference is unchanged. Discovery is stricter on purpose."""
    path = _write(tmp_path, {"providers": [_entry("loopback", ollama.url)]})
    assert load_providers(str(path))[0].network_class == "local"
    assert discover_configured_endpoints(ModelRegistry(), path=path).discovered == []


def test_the_registry_defaults_to_no_configuration_status():
    assert ModelRegistry().configuration_status is None


def test_the_server_startup_calls_the_shared_discovery_function():
    """The startup block in api/server.py must use this function, not its own parser."""
    server_source = (Path(__file__).resolve().parents[2] / "aura" / "api" / "server.py").read_text(
        encoding="utf-8")
    assert "discover_configured_endpoints(" in server_source
    assert '.get("network_class")' not in server_source
    assert '.get("base_url")' not in server_source
