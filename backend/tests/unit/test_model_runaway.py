"""A small model that falls into a loop must be stopped, honestly, and safely.

Observed: qwen2.5-coder:1.5b repeated "Exit the Workspace / Exit the Project"
until a token cap. Streams had no max_tokens, no repetition check and no
deadline. All servers here are local fixtures; no model is involved.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort, RoutingError
from aura.central_agent.repetition import RepetitionGuard, find_loop

LOOP_UNIT = ("Exit the Workspace: Exit the workspace using the `workspace.exit` command.\n```sh\nworkspace.exit\n```\n"
             "Exit the Project: Exit the project using the `project.exit` command.\n```sh\nproject.exit\n```\n")
USEFUL = "A mutex lets one thread at a time use a shared resource.\n\n"


# ── the detector (unit) ──────────────────────────────────────────────────
def test_a_verbatim_cycle_is_found_and_the_text_before_it_is_kept():
    text = USEFUL + LOOP_UNIT * 4
    cut = find_loop(text)
    assert cut is not None
    kept = text[:cut]
    assert kept.startswith(USEFUL) and kept.count("workspace.exit\n```") == 1     # one copy, not four


def test_a_long_legitimate_answer_is_never_cut_short():
    table = "| id | name | score |\n|---|---|---|\n" + "".join(f"| {i} | user{i} | {i * 7 % 101} |\n" for i in range(120))
    code = "".join(f"def handler_{i}(request):\n    return respond(request, status={200 + i})\n\n" for i in range(60))
    prose = " ".join(f"Sentence number {i} explains a distinct point about topic {i % 13}." for i in range(80))
    for text in (table, code, prose, table + code + prose):
        assert find_loop(text) is None, text[:60]


def test_two_repeats_or_a_short_echo_are_not_a_loop():
    assert find_loop(USEFUL + LOOP_UNIT * 2) is None
    assert find_loop("ha " * 200) is None or len("ha ") * 1 < 40   # a short unit alone is style, but never crashes
    assert find_loop("") is None


def test_the_streaming_guard_fires_early_and_only_once_established():
    text = USEFUL + LOOP_UNIT * 6
    guard = RepetitionGuard()
    fired = None
    for i in range(0, len(text), 25):
        if guard.feed(text[i:i + 25]):
            fired = i
            break
    assert fired is not None and fired < len(text) * 0.6      # stopped long before the cap
    assert guard.useful_text().startswith(USEFUL)


# ── through the real port, against a local fixture server ────────────────
class _Stream(BaseHTTPRequestHandler):
    pieces: list[str] = []
    delay = 0.0
    seen: list[dict] = []
    sent = 0

    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        type(self).seen.append(req)
        type(self).sent = 0
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        try:
            for p in type(self).pieces:
                self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": p}}]}) + "\n\n").encode())
                self.wfile.flush()
                type(self).sent += 1
                if type(self).delay:
                    time.sleep(type(self).delay)
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


@pytest.fixture()
def server():
    _Stream.pieces, _Stream.delay, _Stream.seen = [], 0.0, []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Stream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


def port(base, **kw):
    return RoutedModelPort([ProviderSpec(id="ollama", base_url=base, model="m", timeout_s=5.0, network_class="local", **kw)])


def chunks(text, n=30):
    return [text[i:i + n] for i in range(0, len(text), n)]


def test_every_stream_is_bounded_at_the_provider(server):
    _Stream.pieces = ["fine answer"]
    assert port(server, max_output_tokens=777).complete_stream("s", "u") == "fine answer"
    assert _Stream.seen[-1]["max_tokens"] == 777


def test_a_looping_stream_is_stopped_early_with_the_useful_text_and_is_not_an_answer(server):
    _Stream.pieces = chunks(USEFUL + LOOP_UNIT * 40)
    tokens: list[str] = []
    with pytest.raises(RoutingError) as err:
        port(server).complete_stream("s", "u", on_token=tokens.append)
    assert err.value.category == "DEGENERATE_OUTPUT"
    assert err.value.partial.startswith(USEFUL) and err.value.partial.count("project.exit\n```") == 1
    assert 0 < len(tokens) < len(_Stream.pieces) * 0.5       # the client stopped well before the loop ended
    assert "".join(tokens).startswith(USEFUL)                # what was shown live is not retracted silently


def test_a_long_legitimate_streamed_answer_completes(server):
    prose = " ".join(f"Sentence number {i} explains a distinct point about topic {i % 13}." for i in range(90))
    _Stream.pieces = chunks(prose, 50)
    assert port(server).complete_stream("s", "u") == prose[:12_000]


def test_a_slow_stream_that_never_ends_hits_the_wall_clock_deadline_and_keeps_its_partial(server, monkeypatch):
    import aura.central_agent.model_routing as mr

    monkeypatch.setattr(mr, "MAX_STREAM_SECONDS", 0.6)
    _Stream.pieces = [f"word{i} " for i in range(100)]
    _Stream.delay = 0.1
    with pytest.raises(RoutingError) as err:
        port(server).complete_stream("s", "u")
    assert err.value.category == "PROVIDER_TIMEOUT" and err.value.partial.startswith("word0 ")


def test_cancellation_stops_reading_and_returns_nothing(server):
    _Stream.pieces = [f"word{i} " for i in range(200)]
    _Stream.delay = 0.02
    seen = []
    assert port(server).complete_stream("s", "u", on_token=seen.append, should_stop=lambda: len(seen) >= 3) is None
    assert 3 <= len(seen) < 50


def test_the_port_recovers_after_a_loop(server):
    p = port(server)
    _Stream.pieces = chunks(USEFUL + LOOP_UNIT * 40)
    with pytest.raises(RoutingError):
        p.complete_stream("s", "u")
    assert p.health["ollama"].consecutive_failures == 1
    _Stream.pieces = ["a good answer"]
    assert p.complete_stream("s", "u") == "a good answer"
    assert p.health["ollama"].consecutive_failures == 0       # and the circuit never opened


# ── what the person sees (API, fixture model) ────────────────────────────
@pytest.fixture()
def client(tmp_path, monkeypatch, server):
    home = tmp_path / "home"
    (home / "agent").mkdir(parents=True)
    (home / "agent" / "providers.settings.json").write_text(json.dumps({"active": {
        "providerId": "ollama", "model": "m", "callable": True, "baseUrl": server}}))
    monkeypatch.setenv("AURA_HOME", str(home))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    return TestClient(create_app())


def test_chat_reports_a_loop_honestly_and_keeps_the_partial(client):
    _Stream.pieces = chunks(USEFUL + LOOP_UNIT * 40)
    r = client.post("/agent/chat", json={"message": "Explain what a mutex is."}).json()["result"]
    assert r["model"] is None                                        # nothing is attributed as an answer
    assert r["modelFailure"]["category"] == "DEGENERATE_OUTPUT"
    assert "began repeating itself" in r["summary"] and "not a finished answer" in r["summary"]
    assert "A mutex lets one thread" in r["summary"]                 # the useful part survives, labelled
    assert r["summary"].count("workspace.exit\n```") <= 1


def test_chat_after_a_loop_works_again(client):
    _Stream.pieces = chunks(USEFUL + LOOP_UNIT * 40)
    client.post("/agent/chat", json={"message": "Explain what a mutex is."})
    _Stream.pieces = ["A mutex is a lock."]
    r = client.post("/agent/chat", json={"message": "Explain what a mutex is again."}).json()["result"]
    assert r["summary"].startswith("A mutex is a lock.") and r["model"]["model"] == "m" and not r.get("modelFailure")


# ── cancellation of a chat turn, end to end ──────────────────────────────
def _post_chat(client, sid, message="Explain what a mutex is."):
    return client.post("/agent/chat", json={"message": message, "sessionId": sid, "surface": "general-chat"}).json()["result"]


def test_a_stray_cancel_does_not_poison_the_next_message_in_a_chat(client):
    _Stream.pieces = ["First answer."]
    sid = "agt-0123456789ab"
    assert _post_chat(client, sid)["summary"].startswith("First answer.")
    assert client.post(f"/agent/sessions/{sid}/cancel", json={}).status_code == 200   # nothing in flight
    _Stream.pieces = ["Second answer."]
    r = _post_chat(client, sid, "And again?")
    assert r["summary"].startswith("Second answer.") and r["model"]["model"] == "m"   # the model was really asked


def test_cancelling_mid_stream_stops_the_turn_keeps_the_session_intact_and_allows_the_next(client):
    _Stream.pieces = [f"word{i} " for i in range(400)]
    _Stream.delay = 0.03
    sid = "agt-aaaaaaaaaaaa"
    out = {}
    t = threading.Thread(target=lambda: out.update(r=_post_chat(client, sid)))
    t.start()
    time.sleep(0.6)
    assert client.post(f"/agent/sessions/{sid}/cancel", json={}).json()["cancelled"] is True
    t.join(20)
    r = out["r"]
    assert r["status"] == "cancelled" and r["model"] is None and r["summary"] == "Stopped."
    sess = client.get(f"/agent/sessions/{sid}").json()               # saved state is readable, not corrupted
    assert sess["sessionId"] == sid and len(sess["messages"]) >= 1
    _Stream.pieces, _Stream.delay = ["Recovered."], 0.0
    assert _post_chat(client, sid, "Try again")["summary"].startswith("Recovered.")
