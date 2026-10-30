"""A plan task that omits the required `projectId` gets the session's project (reported from the Workspace)."""
from aura.central_agent.execution import _fill_session_inputs


def test_missing_project_id_is_filled_for_a_capability_that_requires_it():
    p = {}
    _fill_session_inputs("diagnosis.run", p, "proj-1")
    assert p == {"projectId": "proj-1"}


def test_empty_value_is_filled_but_an_explicit_one_is_kept():
    p = {"projectId": "  "}
    _fill_session_inputs("diagnosis.run", p, "proj-1")
    assert p["projectId"] == "proj-1"
    q = {"projectId": "other"}
    _fill_session_inputs("diagnosis.run", q, "proj-1")
    assert q["projectId"] == "other"


def test_nothing_is_invented_without_a_session_project_or_for_capabilities_that_do_not_need_it():
    p = {}
    _fill_session_inputs("diagnosis.run", p, None)
    assert p == {}
    r = {}
    _fill_session_inputs("git.status", r, "proj-1")
    assert "projectId" not in r                      # git.status does not require it
