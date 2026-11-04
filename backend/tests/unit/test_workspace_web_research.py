"""Workspace web research: a real question is searched when the toggle is on, and the answer cites real sources."""
from __future__ import annotations

from types import SimpleNamespace as NS

from aura.contracts import AgentIntent
from aura.central_agent.planner import apply_web_research_preference, wants_web_research
from aura.central_agent.service import CentralAgent


def _intent(**kw):
    return AgentIntent.model_validate({
        "goal": "x", "surface": "project", "expectedOutcome": "an answer", "constraints": [],
        "requiredCapabilities": [], "urgency": "immediate", "complexity": "single", **kw})


class TestTheGate:
    def test_a_real_question_that_would_only_chat_is_researched(self):
        # No keyword from the old list: this used to be answered from memory while the toggle said ON.
        assert wants_web_research("what version of python should I install", would_only_chat=True)
        intent = apply_web_research_preference(_intent(conversational=True), True,
                                               "what version of python should I install")
        assert intent.requiredCapabilities == ["web.research"] and intent.conversational is False

    def test_small_talk_and_short_messages_are_never_researched(self):
        for msg in ("hi", "thanks", "ok cool", "what can you do"):
            assert not wants_web_research(msg, would_only_chat=True)

    def test_work_with_its_own_plan_is_never_turned_into_a_search(self):
        intent = _intent(requiredCapabilities=["agent.delegate"])
        out = apply_web_research_preference(intent, True, "fix the login bug in the auth module")
        assert out.requiredCapabilities == ["agent.delegate"]

    def test_the_toggle_off_never_searches(self):
        out = apply_web_research_preference(_intent(conversational=True), False,
                                            "what is the latest python version")
        assert out.webResearch is False and out.requiredCapabilities == []

    def test_the_old_keyword_shapes_still_work_without_chatting(self):
        assert wants_web_research("latest react release")


class TestSources:
    def _svc(self):
        return CentralAgent.__new__(CentralAgent)

    def test_sources_come_only_from_the_research_output_in_order_without_duplicates(self):
        plan = NS(tasks=[NS(id="t1", capabilityId="web.research"), NS(id="t2", capabilityId="agent.delegate")])
        stdout = ('[source=https://a.example/x title="Alpha"]\nbody\n[/source]\n\n'
                  '[source=https://b.example/y]\nbody\n[/source]\n\n'
                  '[source=https://a.example/x title="Alpha again"]\nbody\n[/source]')
        outcome = NS(verified_outputs={"t1": {"stdout": stdout}, "t2": {"stdout": "[source=https://evil.example/z]"}})
        got = self._svc()._answer_sources(plan, outcome)
        assert got == [{"id": 1, "title": "Alpha", "url": "https://a.example/x"},
                       {"id": 2, "title": "https://b.example/y", "url": "https://b.example/y"}]

    def test_no_research_means_no_sources(self):
        plan = NS(tasks=[NS(id="t1", capabilityId="agent.delegate")])
        assert self._svc()._answer_sources(plan, NS(verified_outputs={"t1": {"stdout": "[source=https://x.example/]"}})) == []
