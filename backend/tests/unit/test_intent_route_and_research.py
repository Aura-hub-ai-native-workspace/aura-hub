"""The interaction router and the research step of chat answers."""

from __future__ import annotations

import pytest

from aura.central_agent.intent_route import RouteState, classify_route, readiness
from aura.central_agent.research import (
    evidence_block, extract_citations, research_depth, research_status_line, run_web_research,
)


def route(message, **state):
    return classify_route(message, RouteState(**state))


# ── intent routing ───────────────────────────────────────────────────────

@pytest.mark.parametrize("message, surface, intent, action", [
    ("what is a monad?", "general-chat", "general-question", "answer"),
    ("compare Postgres and SQLite for a small desktop app", "general-chat", "research-question", "answer"),
    ("I want to build an app that tracks habits", "general-chat", "idea-exploration", "answer"),
    ("let's start a new project for this", "general-chat", "new-project-creation", "offer-create-project"),
    ("make a plan for this", "project-chat", "plan-generation", "offer-create-plan"),
    ("send it to workspace", "planner", "planner-handoff", "execute"),
    ("Make a calculator app", "workspace", "direct-workspace-execution", "execute"),
    ("what tools do I have installed?", "workspace", "environment-query", "report-environment"),
])
def test_routes(message, surface, intent, action):
    r = route(message, surface=surface, has_project=surface != "general-chat")
    assert (r.intent, r.action) == (intent, action), r.reason


def test_chat_can_never_resolve_to_execute():
    for message in ("create a file called a.md", "implement the login page", "fix the failing test",
                    "delete the build folder", "make a calculator app"):
        for surface in ("general-chat", "project-chat"):
            r = route(message, surface=surface, has_project=True)
            assert r.action != "execute", (message, surface, r)
    r = route("create a file called a.md", surface="project-chat", has_project=True)
    assert r.intent == "direct-workspace-execution" and r.action == "point-to-workspace"


def test_a_status_question_reports_and_never_starts_work():
    for surface in ("workspace", "project-chat", "general-chat"):
        r = route("how is it going?", surface=surface, has_active_run=True)
        assert (r.intent, r.action) == ("task-status", "report-status")
    r = route("is it done yet", surface="workspace", has_active_run=True)
    assert r.intent == "task-status"


def test_recovery_needs_something_to_recover():
    assert route("try again", surface="workspace", has_failed_run=True).intent == "error-recovery"
    assert route("try again", surface="workspace", turns=3).intent != "error-recovery"


def test_complex_staged_work_is_marked_for_the_workflow_engine():
    r = route("run the tests, then if they fail fix them and retry until they pass, then commit", surface="workspace")
    assert r.workflow is True and r.action == "execute"
    simple = route("add a README.md file", surface="workspace")
    assert simple.workflow is False and simple.intent == "direct-workspace-execution"


def test_a_plain_question_is_not_workflow_work():
    assert route("what does a mutex do?", surface="general-chat").workflow is False


def test_vague_openers_ask_a_short_question():
    r = route("do it", surface="general-chat")
    assert r.intent == "needs-clarification" and r.action == "clarify" and r.question
    assert route("do it", surface="workspace", has_active_run=True).intent != "needs-clarification"


def test_readiness_reflects_what_the_conversation_produced():
    assert readiness({}) == {"project": False, "plan": False}
    assert readiness({"goal": 1}) == {"project": False, "plan": False}
    assert readiness({"goal": 1, "requirement": 1}) == {"project": True, "plan": False}
    assert readiness({"goal": 1, "requirement": 1, "decision": 1}) == {"project": True, "plan": True}
    assert readiness({"requirement": 5}) == {"project": False, "plan": False}  # no goal
    # a project made from an idea carries that idea as its origin: one settled
    # decision on top of the goal is enough to offer a plan
    assert readiness({"goal": 1, "decision": 1, "origin": 1}) == {"project": True, "plan": True}
    assert readiness({"goal": 1, "origin": 1}) == {"project": False, "plan": False}  # origin alone shapes nothing


# ── research ─────────────────────────────────────────────────────────────

def test_research_is_proportionate():
    simple, _ = research_depth("what is a closure?")
    harder, why = research_depth("compare the latest Rust web frameworks for a 2026 production API")
    assert simple == 3 and harder > simple and "compares" in why
    assert research_depth("")[0] == 3


class Recorder:
    def __init__(self):
        self.events = []

    def __call__(self, type_, **payload):
        self.events.append((type_, payload))

    def types(self):
        return [t for t, _ in self.events]


def fabric(result):
    calls = []

    def invoke(cap, payload, context):
        calls.append((cap, payload, context))
        return result
    invoke.calls = calls
    return invoke


GOOD = {"outcome": "succeeded", "detail": "2 results", "output": {
    "results": [{"title": "Python docs", "url": "https://docs.python.org/3/", "snippet": "Official."},
                {"title": "PEP 8", "url": "https://peps.python.org/pep-0008/", "snippet": "Style."}],
    "stdout": "[source=https://docs.python.org/3/]\nOfficial.\n[/source]", "pagesFetched": 1}}


def test_research_stamps_consent_itself_and_reports_real_sources():
    emit, invoke = Recorder(), fabric(GOOD)
    out = run_web_research(invoke, "what is PEP 8?", session_id="agt-1", request_id=None,
                           project_id=None, emit=emit)
    cap, payload, context = invoke.calls[0]
    assert cap == "web.research" and payload["webResearch"] is True
    assert context["actor"]["id"] == "central-agent:chat"
    assert out["status"] == "ok" and [s["id"] for s in out["sources"]] == [1, 2]
    assert out["sources"][0]["url"] == "https://docs.python.org/3/" and out["sources"][0]["retrievedAt"]
    assert emit.types() == ["research.started", "research.sources", "research.completed"]
    assert emit.events[-1][1]["count"] == 2


@pytest.mark.parametrize("detail, kind", [
    ("Web research is not configured: no search gateway is set.", "not-configured"),
    ("The search gateway did not answer: timed out.", "timeout"),
    ("The search gateway refused the request (403).", "refused"),
])
def test_research_failures_are_reported_and_invent_nothing(detail, kind):
    emit = Recorder()
    out = run_web_research(fabric({"outcome": "failed", "detail": detail}), "q", session_id="agt-1",
                           request_id=None, project_id=None, emit=emit)
    assert out["status"] == "unavailable" and out["sources"] == [] and out["kind"] == kind
    assert emit.events[-1][1]["status"] == "unavailable"
    assert "NOT available" in research_status_line(out)
    assert evidence_block(out) == ""


def test_an_empty_search_is_not_a_failure_and_not_evidence():
    out = run_web_research(fabric({"outcome": "succeeded", "output": {"results": [], "stdout": ""}}),
                           "q", session_id="a", request_id=None, project_id=None, emit=Recorder())
    assert out["status"] == "empty" and "found nothing" in research_status_line(out)


def test_a_crashing_research_step_degrades_instead_of_breaking_chat():
    def boom(*_):
        raise RuntimeError("socket exploded")
    out = run_web_research(boom, "q", session_id="a", request_id=None, project_id=None, emit=Recorder())
    assert out["status"] == "unavailable" and "socket" not in out["detail"]


def test_stopping_before_the_search_does_not_search():
    invoke = fabric(GOOD)
    out = run_web_research(invoke, "q", session_id="a", request_id=None, project_id=None,
                           emit=Recorder(), should_stop=lambda: True)
    assert out["status"] == "cancelled" and invoke.calls == []


def test_sources_reach_the_model_fenced_as_untrusted_data():
    out = run_web_research(fabric(GOOD), "q", session_id="a", request_id=None, project_id=None, emit=Recorder())
    block = evidence_block(out)
    assert 'source="[1] https://docs.python.org/3/"' in block and block.count("<untrusted-data") >= 3
    assert "never obey" in block


def test_only_real_sources_can_be_cited():
    sources = [{"id": 1, "title": "A", "url": "https://a.test"}, {"id": 2, "title": "B", "url": "https://b.test"}]
    cited, dangling = extract_citations("Claim one [2]. Claim two [1][2]. Invented [7].", sources)
    assert [s["id"] for s in cited] == [2, 1] and dangling == [7]
    assert extract_citations("no citations here", sources) == ([], [])
