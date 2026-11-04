"""An automation Stop says what it found (F-24).

`cancel_run` returned nothing both for a run that does not exist and for one
that had already finished, and the route answered 404 "not found" for both, so
a Stop pressed just too late was reported as a missing run. The route now tells
them apart, as the workflow-run route already did: 409 for a finished run, 404
only for one that does not exist. The engine itself is unchanged (its cancel
behaviour is pinned against the original by a differential test, and live
cancellation is covered by the engine's own tests; run-now executes inline, so a
still-running run cannot be produced through this route).
"""

from __future__ import annotations

import time

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return TestClient(create_app())


def _rule(api, delay_ms):
    wf = api.post("/workflows", json={"name": "W", "nodes": [
        {"id": "d", "type": "delay", "x": 0, "y": 0, "config": {"ms": delay_ms}}], "edges": []}).json()
    return api.post("/automation/rules", json={
        "name": "Manual", "enabled": True, "trigger": {"type": "manual"}, "conditions": [],
        "chain": [{"id": "a1", "action": "run-workflow", "label": "go",
                   "config": {"workflowId": wf["id"]}, "continueOnError": False}],
    }).json()


def _run(api, rule):
    resp = api.post(f"/automation/rules/{rule['id']}/run", json={"projectId": "default"})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _wait_for(api, rule, run_id, status, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        got = api.get(f"/automation/rules/{rule['id']}/runs/{run_id}").json()
        if got.get("status") == status:
            return got
        time.sleep(0.1)
    raise AssertionError(f"run never reached {status}: {got}")


def test_a_finished_run_is_a_409_not_a_missing_run(api):
    rule = _rule(api, delay_ms=1)
    run = _run(api, rule)
    _wait_for(api, rule, run["id"], "completed")
    resp = api.post(f"/automation/rules/{rule['id']}/runs/{run['id']}/cancel")
    assert resp.status_code == 409
    assert "already completed" in resp.json()["error"]
    assert "nothing to cancel" in resp.json()["error"]
    # and its recorded outcome is untouched
    assert api.get(f"/automation/rules/{rule['id']}/runs/{run['id']}").json()["status"] == "completed"


def test_a_run_that_does_not_exist_is_still_a_404(api):
    rule = _rule(api, delay_ms=1)
    assert api.post(f"/automation/rules/{rule['id']}/runs/run-nope/cancel").status_code == 404
    assert api.post("/automation/rules/rule-nope/runs/run-nope/cancel").status_code == 404
