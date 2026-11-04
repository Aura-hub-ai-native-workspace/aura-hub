"""A follow-up must be answered, not echoed; and "X instead of Y" must record Y as rejected.

Observed in the real UI with a 1.5B model: asked to "build a local chatbot using Ollama
instead of Groq", it repeated its previous answer (still "use the AsyncGroq client"), and
AURA recorded the whole request as the rejected thing. Scripted fake model; no real model.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aura.central_agent.context_capture import capture

# ── what gets remembered ─────────────────────────────────────────────────


def kinds(message):
    return [(r["kind"], r["title"]) for r in capture(message, counts={"goal": 1}, intent="general-question")]


def test_instead_of_records_the_rejected_thing_and_the_chosen_one():
    recs = kinds("Now build a local chatbot using Ollama instead of Groq.")
    assert ("rejected", "Not using Groq") in recs
    assert ("decision", "build a local chatbot using Ollama") in recs
    assert not any(t.startswith("Now build") for _, t in recs)       # the whole request is not "the rejection"


def test_instead_of_at_the_start_of_a_sentence_works_too():
    recs = kinds("Instead of Firebase, use SQLite for storage.")
    assert ("rejected", "Not using Firebase") in recs and ("decision", "use SQLite for storage") in recs


def test_rather_than_is_the_same_switch():
    assert ("rejected", "Not using Electron") in kinds("Use Tauri rather than Electron please.")


def test_plain_rejections_are_unchanged():
    assert ("rejected", "I don't want Electron.") in kinds("I don't want Electron. It is too heavy for this.")


# ── the answer to a follow-up ────────────────────────────────────────────
FIRST = ("To build a chatbot with Groq, install the SDK, set GROQ_API_KEY, create a client, and send the user's message "
         "to the chat completions endpoint, then print the reply. Keep the conversation history in a list so that each "
         "request includes the earlier turns, and handle errors and rate limits. " * 2)
OTHER = ("With Ollama nothing leaves your machine: install Ollama, run `ollama pull` for a small model, then call the local "
         "endpoint on port 11434 with the same message-list format and print the reply. No API key is needed. "
         "Everything else, such as keeping the history list, stays the same. " * 2)


class _Scripted(BaseHTTPRequestHandler):
    replies: list[str] = []
    prompts: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "m"}]}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        type(self).prompts.append(json.dumps(req["messages"]))
        text = type(self).replies.pop(0) if type(self).replies else "(no more scripted replies)"
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}) + "\n\ndata: [DONE]\n\n").encode())


@pytest.fixture()
def client(tmp_path, monkeypatch):
    _Scripted.replies, _Scripted.prompts = [], []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Scripted)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    home = tmp_path / "home"
    (home / "agent").mkdir(parents=True)
    (home / "agent" / "providers.settings.json").write_text(json.dumps({"active": {
        "providerId": "ollama", "model": "m", "callable": True, "baseUrl": f"http://127.0.0.1:{srv.server_address[1]}/v1"}}))
    monkeypatch.setenv("AURA_HOME", str(home))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    yield TestClient(create_app())
    srv.shutdown()


def ask(client, sid, message):
    return client.post("/agent/chat", json={"message": message, "sessionId": sid, "surface": "general-chat"}).json()["result"]


SID = "agt-0123456789ab"


def test_a_follow_up_that_repeats_the_last_answer_is_asked_again_once_and_the_new_answer_is_shown(client):
    _Scripted.replies = [FIRST, FIRST, OTHER]            # turn 1; turn 2 repeats it; the retry answers properly
    ask(client, SID, "Explain how to build a chatbot using Groq.")
    r = ask(client, SID, "Now build a local chatbot using Ollama instead of Groq.")
    assert r["summary"].startswith("With Ollama nothing leaves your machine")      # what the person reads
    assert r["model"]["model"] == "m" and not r.get("modelFailure")
    assert "IDENTICAL" not in r["summary"] and FIRST[:60] not in r["summary"]
    assert "REPEATED YOUR PREVIOUS ANSWER" in _Scripted.prompts[-1]                # the retry said what was wrong
    assert len(_Scripted.prompts) == 3                                              # exactly one retry


def test_if_the_retry_repeats_too_it_is_reported_not_presented_as_an_answer(client):
    _Scripted.replies = [FIRST, FIRST, FIRST]
    ask(client, SID, "Explain how to build a chatbot using Groq.")
    r = ask(client, SID, "Now build a local chatbot using Ollama instead of Groq.")
    assert r["model"] is None and r["modelFailure"]["category"] == "REPEATED_ANSWER"
    assert "repeated its previous answer instead of answering this request" in r["summary"]
    assert "separate from web search" in r["summary"]
    assert FIRST[:60] not in r["summary"]                                           # the copy is not shown as the answer
    assert len(_Scripted.prompts) == 3                                              # never a third attempt


def test_a_genuinely_different_follow_up_costs_no_retry(client):
    _Scripted.replies = [FIRST, OTHER]
    ask(client, SID, "Explain how to build a chatbot using Groq.")
    r = ask(client, SID, "Now build a local chatbot using Ollama instead of Groq.")
    assert r["summary"].startswith("With Ollama") and len(_Scripted.prompts) == 2


def test_short_replies_are_never_treated_as_repeats(client):
    _Scripted.replies = ["OK, noted.", "OK, noted."]
    ask(client, SID, "Remember that my cat is called Zebra.")
    r = ask(client, SID, "And remember my dog is called Rex.")
    assert r["summary"].startswith("OK, noted.") and len(_Scripted.prompts) == 2


def test_the_first_turn_is_never_compared_with_anything(client):
    _Scripted.replies = [FIRST]
    r = ask(client, SID, "Explain how to build a chatbot using Groq.")
    assert r["summary"].startswith("To build a chatbot with Groq") and len(_Scripted.prompts) == 1
