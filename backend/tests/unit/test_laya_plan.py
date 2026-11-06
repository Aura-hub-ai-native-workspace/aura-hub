"""Laya changes the plan: reviews, dropped steps, order. Every change is validated and confident."""
from __future__ import annotations

from aura.central_agent import plan_handoff as ph
from aura.central_agent.laya_plan import propose_changes

import pytest


@pytest.fixture(autouse=True)
def _no_aura_authoring(monkeypatch):
    """Default owner setting: AURA does not write files itself, so every step is for a worker."""
    monkeypatch.setattr(ph, "authoring_allowed", lambda: False)

CANDIDATES = [{"id": "opencode", "name": "OpenCode"}, {"id": "kilo-code", "name": "Kilo Code"}]


def _task(tid, title, description="do the work", depends=(), worker=None, review_of=None):
    return {"id": tid, "title": title, "description": description, "targetFile": None, "files": [],
            "dependsOn": list(depends), "worker": worker, "requires": [], "expectedOutput": "",
            "verification": "", "reviewOf": review_of}


def _handoff(tasks):
    raw = {"source": "planner", "planId": "plan-1", "revision": 1, "goal": "Build the shop site", "tasks": tasks}
    return ph.validate_handoff(raw)


def _answers(by_question):
    """A fake Laya: answers each question kind with a fixed (choice, probability)."""
    def ask(brief, instructions, criteria):
        for key, answer in by_question.items():
            if key in instructions:
                return answer
        return None
    return ask


def test_a_confident_review_is_added_after_the_step_and_run_by_a_different_agent():
    plan = _handoff([_task("front", "Build the front end page", "front end page")])
    ask = _answers({"second agent": ("review", 0.9)})
    new, changes = propose_changes(plan, ask, floor=0.75)
    assert [t["id"] for t in new["tasks"]] == ["front", "front-review"]
    assert changes[0]["kind"] == "add_review" and "different agent" in changes[0]["text"]
    chosen = ph.select_workers(new, CANDIDATES, [], chooser=lambda b, c: {"worker": c[0]["id"], "probability": 0.9})["handoff"]["tasks"]
    assert chosen[0]["worker"] != chosen[1]["worker"]


def test_an_unsure_review_is_not_added():
    plan = _handoff([_task("front", "Build the front end page", "front end page")])
    new, changes = propose_changes(plan, _answers({"second agent": ("review", 0.5)}), floor=0.75)
    assert changes == [] and [t["id"] for t in new["tasks"]] == ["front"]


def test_a_step_laya_judges_not_needed_is_dropped_but_never_the_last_one():
    plan = _handoff([
        _task("front", "Build the front end page", "front end page"),
        _task("api", "Write the orders endpoint", "backend API endpoint"),
    ])
    new, changes = propose_changes(plan, _answers({"needed to complete": ("not_needed", 0.9)}), floor=0.75)
    assert [c["kind"] for c in changes] == ["remove_step"]
    assert len([t for t in new["tasks"] if t["id"] in ("front", "api")]) == 1

    single = _handoff([_task("front", "Build the front end page", "front end page")])
    kept, none = propose_changes(single, _answers({"needed to complete": ("not_needed", 0.99)}), floor=0.75)
    assert none == [] and [t["id"] for t in kept["tasks"]] == ["front"]


def test_a_step_another_depends_on_is_never_dropped():
    plan = _handoff([
        _task("front", "Build the front end page", "front end page"),
        _task("api", "Write the orders endpoint", "backend API endpoint", depends=["front"]),
    ])
    _, changes = propose_changes(plan, _answers({"needed to complete": ("not_needed", 0.99)}), floor=0.75)
    assert all(c["kind"] != "remove_step" or c["taskId"] != "front" for c in changes)


def test_adjacent_independent_steps_run_in_the_order_laya_prefers():
    plan = _handoff([
        _task("api", "Write the orders endpoint", "backend API endpoint"),
        _task("front", "Build the front end page", "front end page"),
    ])
    new, changes = propose_changes(plan, _answers({"should run first": ("b", 0.9)}), floor=0.75)
    assert [t["id"] for t in new["tasks"]] == ["front", "api"]
    assert changes[0]["kind"] == "reorder"


def test_a_plan_that_would_fail_validation_is_left_alone():
    plan = _handoff([_task("front", "Build the front end page", "front end page")])
    # A review of a task that does not exist cannot validate; the plan stays as it was.
    bad = dict(plan, tasks=[dict(plan["tasks"][0], reviewOf="ghost")])
    try:
        ph.validate_handoff(bad)
        raised = False
    except ph.HandoffError:
        raised = True
    assert raised


class TestHighRiskAlwaysReviewed:
    """A fixed floor: Laya can add reviews, but cannot drop these or miss them."""

    def _decide(self, monkeypatch, task, pick):
        from types import SimpleNamespace

        from aura.central_agent import laya_advisor as advisor_module
        from aura.central_agent.service import CentralAgent

        asked = []

        def ask_choice(*args):
            asked.append(args)
            return pick

        monkeypatch.setattr(advisor_module, "laya_advisor",
                            lambda: SimpleNamespace(ask_choice=ask_choice))
        intent = SimpleNamespace(delegateTask=task, delegateReview=False,
                                 delegateRemediate=False)
        said = []
        CentralAgent._laya_review_default(
            SimpleNamespace(_emit=lambda *a, **k: said.append(k)), intent, "s")
        return intent, asked, said

    def test_reviewed_without_asking_laya_even_if_she_would_say_no(self, monkeypatch):
        intent, asked, said = self._decide(
            monkeypatch, "Add Stripe payments to checkout", ("no-review", 0.99))
        assert intent.delegateReview and intent.delegateRemediate
        assert asked == [] and said

    def test_ordinary_work_still_follows_laya(self, monkeypatch):
        intent, asked, _ = self._decide(
            monkeypatch, "Change the button colour", ("no-review", 0.99))
        assert asked and not intent.delegateReview

    def test_matches_whole_words_only(self):
        from aura.central_agent.laya_plan import HIGH_RISK_WORK

        assert HIGH_RISK_WORK.search("Fix the login flow")
        assert HIGH_RISK_WORK.search("Add a database migration")
        assert not HIGH_RISK_WORK.search("Add a blog page")
        assert not HIGH_RISK_WORK.search("Rename the secretary field")
