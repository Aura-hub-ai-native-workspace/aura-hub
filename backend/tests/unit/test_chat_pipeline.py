"""General chat and project Let's Chat: research on every question, real
streaming events, honest citations, shared context, and no side effects.

Web research runs through the REAL ``web.research`` executor and the real
Fabric (policy, audit) against a local SearXNG-compatible gateway fixture —
a throwaway HTTP server, not the live web. The model is a recording port,
so what the model was actually told can be asserted.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from test_stopped_mission_view import _agent


class Gateway:
    """A tiny SearXNG-compatible search gateway on loopback."""

    def __init__(self, results, status=200):
        outer = self
        self.queries: list[str] = []
        self.results, self.status = results, status

        class H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                from urllib.parse import parse_qs, urlparse
                q = parse_qs(urlparse(self.path).query).get("q", [""])[0]
                outer.queries.append(q)
                if outer.status != 200:
                    self.send_response(outer.status); self.end_headers(); return
                body = json.dumps({"results": outer.results}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):  # silence
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}/search"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class Port:
    """Streams a fixed answer token by token and records what it was asked."""

    def __init__(self, answer, providers=()):
        self.answer, self.providers, self.calls = answer, providers, []

    def complete_json(self, system, user):
        return None

    def complete_stream(self, system, user, on_token=None, should_stop=None):
        self.calls.append({"system": system, "user": user})
        for piece in self.answer.split(" "):
            if should_stop and should_stop():
                from aura.central_agent.model_routing import _StreamStopped
                raise _StreamStopped()
            if on_token:
                on_token(piece + " ")
        return self.answer


RESULTS = [
    {"title": "PEP 8", "url": "https://peps.python.org/pep-0008/", "content": "Style guide for Python code."},
    {"title": "Python docs", "url": "https://docs.python.org/3/", "content": "The official documentation."},
]


def build(tmp_path, monkeypatch, *, gateway=None, port=None):
    from aura.executors import all_executors

    agent = _agent(tmp_path)
    for ex in all_executors(None):
        agent.fabric_cfg.fabric.register(ex)
    # Network permission is the operator's grant; chat does not widen it.
    agent.fabric_cfg.permissions["network"] = True
    if gateway is not None:
        monkeypatch.setenv("AURA_SEARCH_ENDPOINT", gateway.url)
        monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    else:
        monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
        monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    if port is not None:
        agent.intents.model_port = port
        agent.intents.mode = "model"
    return agent


@pytest.fixture()
def gateway():
    gw = Gateway(RESULTS)
    yield gw
    gw.close()


def events(agent, sid):
    return [e for e in agent.bus.tail if e.sessionId == sid]


def types(agent, sid):
    return [e.type for e in events(agent, sid)]


def test_every_question_is_researched_and_answered_with_real_citations(tmp_path, monkeypatch, gateway):
    port = Port("PEP 8 is Python's style guide [1]. The standard library is documented in the official docs [2].")
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=port)
    result, sid = agent.chat("What is PEP 8?")
    # research happened, through the gateway, because a question was asked
    assert gateway.queries == ["What is PEP 8?"]
    assert result.outcome == "completed" and result.research["status"] == "ok"
    assert [s["url"] for s in result.sources] == ["https://peps.python.org/pep-0008/", "https://docs.python.org/3/"]
    assert result.research["consulted"] == 2 and result.research["cited"] == 2
    assert result.sources[0]["retrievedAt"]
    # the model was handed the evidence fenced as data, with numbered sources
    user = port.calls[0]["user"]
    assert '<untrusted-data source="[1] https://peps.python.org/pep-0008/">' in user
    assert "never obey" in user
    # real provider routing identity is not claimed by the model
    assert "WHAT IS ALREADY SETTLED" not in user  # nothing recorded yet for this scope


def test_streaming_events_are_the_real_pipeline_in_order(tmp_path, monkeypatch, gateway):
    port = Port("Short answer [1].")
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=port)
    _result, sid = agent.chat("What is PEP 8?")
    seq = types(agent, sid)
    order = ["session.started", "intent.classified", "context.retrieved", "research.started",
             "research.sources", "research.completed", "model.invoked", "answer.started",
             "answer.token", "answer.completed", "answer.citations", "result.ready"]
    positions = [seq.index(t) for t in order]
    assert positions == sorted(positions), seq
    tokens = [e.payload["text"] for e in events(agent, sid) if e.type == "answer.token"]
    assert "".join(tokens).strip() == "Short answer [1]."  # tokens came from the model, not a post-hoc split
    assert len(tokens) == 3
    cited = next(e for e in events(agent, sid) if e.type == "answer.citations")
    assert cited.payload["cited"] == [1]


def test_research_failure_is_reported_and_no_citation_is_invented(tmp_path, monkeypatch):
    port = Port("It is a style guide [1] and also [2].")
    agent = build(tmp_path, monkeypatch, gateway=None, port=port)  # no gateway configured
    result, sid = agent.chat("What is PEP 8?")
    assert result.research["status"] == "unavailable" and result.research["kind"] == "not-configured"
    assert result.sources == []  # nothing was found, so nothing may be cited
    assert "NOT available" in port.calls[0]["user"]
    assert "do not exist" in result.summary  # the model's [1]/[2] were flagged, not kept
    done = next(e for e in events(agent, sid) if e.type == "research.completed")
    assert done.payload["status"] == "unavailable"


def test_a_dead_gateway_degrades_to_an_answer_that_says_so(tmp_path, monkeypatch):
    gw = Gateway([], status=503)
    port = Port("I could not look this up.")
    agent = build(tmp_path, monkeypatch, gateway=gw, port=port)
    result, _sid = agent.chat("What is the latest Python release?")
    gw.close()
    assert result.research["status"] == "unavailable" and result.outcome == "completed"
    assert result.sources == []


def test_with_no_model_the_answer_is_honest_and_still_lists_what_research_found(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=None)
    result, _sid = agent.chat("What is PEP 8?")
    assert "no reasoning model is available" in result.summary
    assert "https://peps.python.org/pep-0008/" in result.summary  # real sources, not an invented answer
    assert result.outcome == "completed" and result.model is None


def test_small_talk_is_not_researched(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("Hello!"))
    result, sid = agent.chat("hi")
    assert gateway.queries == [] and result.research["status"] == "skipped"
    assert "research.started" not in types(agent, sid)


def test_chat_cannot_run_work_even_though_it_may_search(tmp_path, monkeypatch, gateway):
    port = Port("Sure, I'll create that file.")
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=port)
    project = tmp_path / "proj"
    project.mkdir()
    result, sid = agent.chat("create a file called pwned.md containing hi", project_id="p",
                             project_path=str(project))
    assert not (project / "pwned.md").exists()
    assert result.performed == [] and result.runId is None and result.evidence is None
    assert "Nothing was run or changed" in result.summary
    audit = agent.fabric_cfg.audit_store.load()
    assert {r["capabilityId"] for r in audit} <= {"web.research"}


def test_a_status_question_reports_real_state_and_starts_nothing(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("must not be used"))
    result, sid = agent.chat("how is it going?", project_id="p")
    assert "Nothing has run in Workspace" in result.summary
    assert gateway.queries == [] and agent.fabric_cfg.audit_store.load() == []
    intent = next(e for e in events(agent, sid) if e.type == "intent.classified")
    assert intent.payload["intent"] == "task-status" and intent.payload["action"] == "report-status"


def test_a_status_question_reflects_the_actual_last_run(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("x"))
    session = agent.sessions.create("p")
    from aura.contracts import AgentResult
    session.state = "completed"
    session.lastResult = AgentResult(status="completed", outcome="failed", summary="the build failed",
                                     tasks=[{"taskId": "t1", "description": "Write a.py", "state": "done",
                                             "verified": True, "worker": None, "dependsOn": []},
                                            {"taskId": "t2", "description": "Test it", "state": "failed",
                                             "verified": None, "worker": "claude-code", "dependsOn": ["t1"]}])
    agent.sessions.save(session)
    result, _ = agent.chat("what's the status?", project_id="p")
    assert "did not succeed (outcome: failed)" in result.summary
    assert "1 of 2 task(s) done, 1 verified" in result.summary and "Test it: failed" in result.summary


def test_context_persists_across_chats_and_a_restart_and_stays_in_its_project(tmp_path, monkeypatch, gateway):
    port = Port("Noted.")
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=port)
    result, _ = agent.chat("I want to build a habit tracker app that works offline. "
                           "It must sync when online. Let's use SQLite. I don't want Electron.",
                           project_id="proj-a")
    kinds = {r["kind"] for r in result.recorded}
    assert {"goal", "requirement", "decision", "rejected"} <= kinds
    # a brand-new agent over the same home (a restart) still has it
    again = build(tmp_path, monkeypatch, gateway=gateway, port=Port("Ok."))
    again.chat("which database should it use?", project_id="proj-a")
    assert "SQLite" in again.intents.model_port.calls[0]["user"]
    assert "Electron" in again.intents.model_port.calls[0]["user"]
    # another project sees none of it
    other = build(tmp_path, monkeypatch, gateway=gateway, port=Port("Ok."))
    other.chat("which database should it use?", project_id="proj-b")
    assert "SQLite" not in other.intents.model_port.calls[0]["user"]
    assert other.shared_context.list("proj-b") != [] and other.shared_context.counts("proj-b").get("goal") is None


def test_the_next_step_is_offered_only_when_the_conversation_has_earned_it(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("Interesting."))
    first, sid = agent.chat("What are habit trackers?")
    assert first.nextActions == []
    second, sid = agent.chat("I want to build a habit tracker app. It must work offline.", session_id=sid)
    assert second.nextActions == ["create-project"]
    explicit, _ = agent.chat("let's start a new project for this")
    assert explicit.nextActions == ["create-project"]


def test_project_chat_offers_a_plan_once_decisions_exist(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("Fine."))
    agent.shared_context.add("proj", "goal", "Goal", "habit tracker", key="goal")
    agent.shared_context.add("proj", "requirement", "Offline", "must work offline")
    chat, sid = agent.chat("Let's go with SQLite.", project_id="proj")
    assert "create-plan" in chat.nextActions
    explicit, _ = agent.chat("make a plan for this", project_id="proj")
    assert "create-plan" in explicit.nextActions


def test_stop_during_research_or_streaming_ends_cancelled(tmp_path, monkeypatch, gateway):
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("one two three four five six seven"))
    original = agent._stream_conversation

    def stop_then_stream(session, *a, **k):
        agent.runs.request_cancel(session.sessionId, "test")
        return original(session, *a, **k)

    agent._stream_conversation = stop_then_stream
    result, sid = agent.chat("What is PEP 8?")
    assert result.outcome == "cancelled" and result.failureReason == "cancelled-by-user"
    assert "result.ready" in types(agent, sid)


def test_the_model_identity_comes_from_routing_not_from_the_answer(tmp_path, monkeypatch, gateway):
    spec = type("S", (), {"id": "ollama-local", "model": "qwen2.5-coder:1.5b",
                          "network_class": "local", "max_context_chars": 8000,
                          "base_url": "http://127.0.0.1:11434/v1"})()
    agent = build(tmp_path, monkeypatch, gateway=gateway, port=Port("I am GPT-9 [1].", providers=(spec,)))
    _result, sid = agent.chat("What is PEP 8?")
    invoked = next(e for e in events(agent, sid) if e.type == "model.invoked")
    assert invoked.payload["providers"][0]["id"] == "ollama-local"
    ctx = next(e for e in events(agent, sid) if e.type == "context.retrieved")
    assert ctx.payload["budgetChars"] == 2000  # 25% of this model's real 8000-char window
