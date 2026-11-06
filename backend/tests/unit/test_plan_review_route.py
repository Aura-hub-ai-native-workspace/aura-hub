"""GET /agent/sessions/{sid}/plan answered 500 for every session: the route
called CentralAgent.review_plan, which an earlier cleanup removed."""
from types import SimpleNamespace as NS

from aura.central_agent.service import CentralAgent


def _agent(session):
    a = CentralAgent.__new__(CentralAgent)
    a.sessions = NS(load=lambda sid: session if sid == "agt-1" else None)
    a._active_plans = {}
    return a


def test_plan_review_reads_a_stored_plan_dict():
    session = NS(activePlanId=None, activePlan={
        "planId": "pln-1",
        "tasks": [{"id": "implement", "description": "Carry out the change", "capabilityId": "agent.delegate",
                   "risk": "high", "reversible": False,
                   "verification": {"kind": "exit-zero", "description": "worker exits 0"}}],
    })
    review = _agent(session).review_plan("agt-1")
    assert review["planId"] == "pln-1"
    assert review["steps"][0]["id"] == "implement"
    assert review["steps"][0]["verification"] == "worker exits 0"


def test_no_session_or_no_plan_is_none():
    assert _agent(NS(activePlanId=None, activePlan=None)).review_plan("agt-1") is None
    assert _agent(None).review_plan("agt-x") is None
