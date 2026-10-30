"""One provider story: Settings -> Central Agent, end to end, without secrets.

The ai-service publishes a secret-free view of the provider chosen in Settings
(``agent/providers.settings.json``); the Central Agent merges it with the
operator's own ``agent/providers.json`` (operator wins), follows later changes
without a restart, and reports a model as usable only when it can be reached.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


class _Fake(BaseHTTPRequestHandler):
    mode = "ok"  # ok | slow | broken
    seen_models: list[str] = []

    def log_message(self, *a):  # silence
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "qwen-test"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        req = json.loads(self.rfile.read(n) or b"{}")
        type(self).seen_models.append(str(req.get("model")))
        if type(self).mode == "slow":
            time.sleep(1.6)
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        if type(self).mode == "broken":
            self.wfile.write(b"data: not json\n\ndata: [DONE]\n\n"); return
        for piece in ("Hello ", "there."):
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture()
def fake():
    _Fake.mode = "ok"; _Fake.seen_models = []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    (tmp_path / "home" / "agent").mkdir(parents=True)
    return tmp_path / "home"


def publish(home, **active):
    body = {"schema": 1, "source": "ai-service-settings", "updatedAt": "now",
            "active": active or None}
    (home / "agent" / "providers.settings.json").write_text(json.dumps(body))


def test_nothing_configured_means_no_providers(home):
    from aura.central_agent.model_routing import load_providers

    assert load_providers() == []


def test_settings_choice_becomes_a_keyless_provider_with_the_real_model_and_address(home, fake):
    from aura.central_agent.model_routing import load_providers

    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    [spec] = load_providers()
    assert (spec.id, spec.model, spec.base_url, spec.api_key_env) == ("ollama", "qwen-test", fake, "")
    assert spec.timeout_s >= 60  # a small CPU model is not given a cloud API's 30s
    assert spec.max_context_chars <= 8_000  # fits Ollama's default 4096-token window


def test_operator_file_wins_and_is_never_duplicated(home, fake):
    from aura.central_agent.model_routing import load_providers

    (home / "agent" / "providers.json").write_text(json.dumps({"providers": [
        {"id": "ollama", "baseUrl": "http://127.0.0.1:9/v1", "model": "operator-model"}]}))
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    specs = load_providers()
    assert [(s.id, s.model) for s in specs] == [("ollama", "operator-model")]
    publish(home, providerId="other", model="m", callable=True, baseUrl=fake)
    assert [s.id for s in load_providers()] == ["ollama", "other"]


def test_a_provider_that_needs_a_key_is_not_called_and_says_why(home):
    from aura.central_agent.model_routing import load_providers, settings_provider_status

    publish(home, providerId="openai", model="gpt-x", callable=False,
            reason="needs-api-key: the key is held by the AURA service")
    assert load_providers() == []
    st = settings_provider_status()
    assert st["configured"] and not st["callable"] and "needs-api-key" in st["reason"]


@pytest.mark.parametrize("junk", ["not json", "[]", '{"active": 5}', '{"active": {"callable": true}}',
                                  '{"active": {"callable": true, "providerId": "x"}}'])
def test_a_broken_view_is_ignored_not_trusted(home, junk):
    from aura.central_agent.model_routing import load_providers

    (home / "agent" / "providers.settings.json").write_text(junk)
    assert load_providers() == []


def make_client():
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    return TestClient(create_app())


def status(client):
    return client.get("/agent/models/status").json()


def test_status_follows_settings_changes_without_a_restart_and_reports_reachability(home, fake):
    client = make_client()
    assert status(client)["laya"]["configured"] is False

    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    s = status(client)["laya"]
    assert s["configured"] and s["usable"]
    assert s["providers"][0]["check"]["state"] == "ready"

    publish(home, providerId="ollama", model="not-installed", callable=True, baseUrl=fake)
    s = status(client)["laya"]
    assert s["configured"] and not s["usable"]
    assert s["providers"][0]["check"]["state"] == "model-missing" and "cannot use it" in s["note"]

    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl="http://127.0.0.1:9/v1")
    s = status(client)["laya"]
    assert s["configured"] and not s["usable"] and s["providers"][0]["check"]["state"] == "unreachable"

    publish(home)  # provider deleted in Settings
    assert status(client)["laya"]["configured"] is False


def test_status_never_leaks_a_secret(home, fake):
    (home / "agent" / "providers.settings.json").write_text(json.dumps({
        "active": {"providerId": "ollama", "model": "qwen-test", "callable": True, "baseUrl": fake,
                   "apiKey": "sk-LEAKME-123456789", "encryptedKey": "deadbeef"}}))
    text = json.dumps(status(make_client()))
    assert "LEAKME" not in text and "encryptedKey" not in text and "deadbeef" not in text


def test_chat_uses_the_settings_model_and_attributes_it(home, fake):
    client = make_client()
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    r = client.post("/agent/chat", json={"message": "Explain what a mutex is."}).json()
    assert r["result"]["summary"].startswith("Hello there.")
    assert r["result"]["model"]["model"] == "qwen-test"
    assert _Fake.seen_models == ["qwen-test"]  # the configured identifier, not a guess


def test_a_slow_model_is_a_model_failure_not_a_missing_model(home, fake, monkeypatch):
    import aura.central_agent.model_routing as mr

    monkeypatch.setattr(mr, "SETTINGS_PROVIDER_TIMEOUT_S", 0.5)
    _Fake.mode = "slow"
    client = make_client()
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    r = client.post("/agent/chat", json={"message": "Explain what a mutex is."}).json()["result"]
    assert r["model"] is None                       # nothing is attributed
    assert r["modelFailure"]["category"]
    assert "did not answer" in r["summary"] and "no reasoning model is available" not in r["summary"]
    assert "separate from web search" in r["summary"]


def test_an_unusable_reply_is_a_failure_not_an_attribution(home, fake):
    _Fake.mode = "broken"
    client = make_client()
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    r = client.post("/agent/chat", json={"message": "Explain what a mutex is."}).json()["result"]
    assert r["model"] is None and r["modelFailure"]


def test_with_no_model_the_message_says_none_is_configured(home):
    r = make_client().post("/agent/chat", json={"message": "Explain what a mutex is."}).json()["result"]
    assert "no reasoning model is available" in r["summary"] and not r.get("modelFailure")


def test_status_separates_configured_credentials_reachable_model_and_a_real_request(home, fake):
    """"Ready" is never inferred from configuration alone."""
    client = make_client()
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl=fake)
    st = status(client)["laya"]["providers"][0]["stages"]
    assert st == {"configured": True, "credentials": "not-required", "reachable": True,
                  "modelAvailable": True, "lastRequest": None}          # nothing has really answered yet
    client.post("/agent/chat", json={"message": "Explain what a mutex is."})
    assert status(client)["laya"]["providers"][0]["stages"]["lastRequest"] == "succeeded"
    _Fake.mode = "broken"
    client.post("/agent/chat", json={"message": "And a semaphore?"})
    assert status(client)["laya"]["providers"][0]["stages"]["lastRequest"] == "failed"


def test_an_unreachable_server_is_configured_but_not_reachable_and_never_ready(home):
    client = make_client()
    publish(home, providerId="ollama", model="qwen-test", callable=True, baseUrl="http://127.0.0.1:9/v1")
    laya = status(client)["laya"]
    st = laya["providers"][0]["stages"]
    assert st["configured"] is True and st["reachable"] is False and st["lastRequest"] is None
    assert laya["usable"] is False


def test_a_keyed_provider_reports_a_missing_key_without_its_value(home, monkeypatch):
    monkeypatch.delenv("TEST_PROVIDER_KEY", raising=False)
    (home / "agent" / "providers.json").write_text(json.dumps({"providers": [
        {"id": "cloud", "baseUrl": "https://api.example.test/v1", "model": "m", "apiKeyEnv": "TEST_PROVIDER_KEY"}]}))
    st = status(make_client())["laya"]["providers"][0]["stages"]
    assert st["credentials"] == "missing"
    monkeypatch.setenv("TEST_PROVIDER_KEY", "sk-supersecret-value-1234567890")
    body = json.dumps(status(make_client()))
    assert '"credentials": "available"' in body and "supersecret" not in body
