"""A model plan that fails validation gets exactly one correction, with the reason."""
from __future__ import annotations

import pytest

from aura.central_agent.planner import PlanningError
from aura.central_agent.service import CentralAgent


class Port:
    def __init__(self, replies):
        self.replies, self.users = list(replies), []

    def complete_json(self, system, user):
        self.users.append(user)
        return self.replies.pop(0)


class Planner:
    def __init__(self, ok_when):
        self.calls, self.ok_when = [], ok_when

    def known_capability_ids(self):
        return {"filesystem.write"}

    def known_node_ids(self):
        return set()

    def plan_from_model(self, intent, sid, now, raw):
        self.calls.append(raw)
        if raw.get("good"):
            return "PLAN"
        raise PlanningError("task t1 scopePaths must be a non-empty list")


def agent(port, planner):
    a = CentralAgent.__new__(CentralAgent)
    a.intents = type("C", (), {"mode": "model", "model_port": port})()
    a.planner = planner
    a._emit = lambda *x, **k: None
    return a


def session():
    return type("S", (), {"sessionId": "agt-1", "lastRequestId": None})()


INTENT = type("I", (), {"goal": "g", "expectedOutcome": "e", "needsClarification": False})()


def test_a_second_proposal_that_fixes_the_reason_is_accepted_and_told_what_was_wrong():
    port, planner = Port([{"tasks": []}, {"good": True}]), Planner(None)
    out = agent(port, planner)._plan_from_model(INTENT, session(), "make a file", None, PlanningError("x"))
    assert out == "PLAN" and len(port.users) == 2 and len(planner.calls) == 2
    assert "REJECTED: task t1 scopePaths must be a non-empty list" in port.users[1]
    assert "REJECTED" not in port.users[0]


def test_a_first_good_proposal_costs_no_second_call():
    port = Port([{"good": True}])
    assert agent(port, Planner(None))._plan_from_model(INTENT, session(), "m", None, PlanningError("x")) == "PLAN"
    assert len(port.users) == 1


def test_two_bad_proposals_fail_honestly_after_exactly_one_correction():
    port = Port([{"tasks": []}, {"tasks": []}, {"good": True}])
    with pytest.raises(PlanningError, match="after one correction"):
        agent(port, Planner(None))._plan_from_model(INTENT, session(), "m", None, PlanningError("x"))
    assert len(port.users) == 2          # never a third attempt


def test_a_silent_retry_keeps_the_original_reason():
    port = Port([{"tasks": []}, None])
    with pytest.raises(PlanningError, match="scopePaths must be a non-empty list"):
        agent(port, Planner(None))._plan_from_model(INTENT, session(), "m", None, PlanningError("x"))


def test_the_correction_turn_is_actionable_for_a_small_model():
    """A refusal about a dependency cannot be fixed without the legal
    values, so the correction names the ids the model declared and
    restates the two rules that are refused most: what an id is, and
    that dependencies must not form a cycle.

    Without this, a small model re-proposed the same broken shape: the
    live failure was "model proposal contains a dependency cycle".
    """
    raw = {"tasks": [
        {"id": "t1", "title": "One"},
        {"id": "t2", "title": "Two", "dependsOn": ["t1"]},
    ]}
    port = Port([raw, {"good": True}])
    agent(port, Planner(None))._plan_from_model(
        INTENT, session(), "m", None, PlanningError("x"))
    correction = port.users[1]
    # The ids it declared are named back to it.
    assert "TASK IDS YOU DECLARED: t1, t2" in correction
    # The id contract is spelled out.
    assert "letters, digits, underscore or hyphen only, no spaces" in correction
    # dependsOn must be ids, and must not form a cycle.
    assert "the \"id\" of ANOTHER task in this same proposal" in correction
    assert "never form a cycle" in correction


def test_the_correction_event_is_part_of_the_real_event_contract():
    """The stub above hides the bus; the real AgentEvent must accept the type."""
    from aura.contracts.agent import AgentEvent

    ev = AgentEvent(type="plan.correction-requested", at="2026-01-01T00:00:00Z",
                    sessionId="agt-1", payload={"reason": "x"})
    assert ev.type == "plan.correction-requested"
