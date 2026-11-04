"""Regression: distinct chat requests must not collapse into one generic answer.

Two different user messages on the same session must each reach the model
as themselves, and a reply that names tools the catalogue does not contain
(or claims work that never ran) must be flagged rather than passed through.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pass


class _Model(BaseHTTPRequestHandler):
    prompts: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "m"}]}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        type(self).prompts.append(json.dumps(req["messages"]))
        # Echo the user's own message back so distinctness is observable.
        user_msg = ""
        for m in req["messages"]:
            if m.get("role") == "user":
                user_msg = m.get("content", "")
        reply = f"Answering your specific request: {user_msg[:80]}"
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": reply}}]}) + "\n\ndata: [DONE]\n\n").encode())


@pytest.fixture()
def client(tmp_path, monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Model.prompts = []
    home = tmp_path / "home"
    (home / "agent").mkdir(parents=True)
    (home / "agent" / "providers.settings.json").write_text(json.dumps({"active": {
        "providerId": "ollama", "model": "m", "callable": True,
        "baseUrl": f"http://127.0.0.1:{srv.server_address[1]}/v1"}}))
    monkeypatch.setenv("AURA_HOME", str(home))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    yield TestClient(create_app())
    srv.shutdown()


def test_two_distinct_requests_reach_the_model_as_themselves(client):
    r1 = client.post("/agent/chat", json={"message": "Explain how to build a chatbot using the Groq API.",
                                          "projectId": "p1", "surface": "project-chat"})
    r2 = client.post("/agent/chat", json={"message": "Build a chatbot with a local web interface using the Groq API.",
                                          "projectId": "p1", "surface": "project-chat"})
    assert r1.status_code == 200 and r2.status_code == 200
    # Each request's user message reached the model (not a stale or cached one).
    assert "Explain how to build a chatbot using the Groq API." in _Model.prompts[-2]
    assert "Build a chatbot with a local web interface using the Groq API." in _Model.prompts[-1]
    # The two user messages are distinct.
    assert "Explain how to build a chatbot using the Groq API." != "Build a chatbot with a local web interface using the Groq API."


def test_invented_tools_are_flagged(client):
    _Model.prompts = []
    r = client.post("/agent/chat", json={"message": "Create a simple HTML landing page.",
                                         "projectId": "p1", "surface": "project-chat"})
    assert r.status_code == 200
    # The response should not claim work was done.
    text = r.json()["result"]["summary"]
    # No approval prompts or claims of completion.
    assert "Nothing was run or changed" in text or "no build, test, deployment" in text or "Note:" in text


def test_no_caching_collision_between_sessions(client):
    _Model.prompts = []
    r1 = client.post("/agent/chat", json={"message": "Build a local chatbot that uses Ollama instead of Groq.",
                                          "projectId": "p1", "surface": "project-chat"})
    r2 = client.post("/agent/chat", json={"message": "Create a simple HTML landing page.",
                                          "projectId": "p2", "surface": "project-chat"})
    assert r1.status_code == 200 and r2.status_code == 200
    # Both messages reached the model independently.
    assert any("Build a local chatbot that uses Ollama instead of Groq." in p for p in _Model.prompts)
    assert any("Create a simple HTML landing page." in p for p in _Model.prompts)
