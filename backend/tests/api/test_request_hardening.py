"""Request hardening — malformed client input is a 400, never a 500.

Regression: bare `await request.json()` plus unvalidated query/body shapes
turned client mistakes (malformed JSON, arrays, `?limit=abc`, non-dict
`input`/`context`) into unhandled 500s. Every route now parses through
`_json_body` and validates shapes before touching them.
"""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return TestClient(create_app())


class TestMalformedBodies:
    def test_malformed_json_is_400_not_500(self, client):
        r = client.post("/workflows", content="{bad json",
                        headers={"content-type": "application/json"})
        assert r.status_code < 500

    def test_array_body_is_400_not_500(self, client):
        r = client.post("/workflows", json=[1, 2, 3])
        assert r.status_code < 500

    def test_agent_submit_array_body(self, client):
        r = client.post("/agent/sessions", json=["hello"])
        assert r.status_code < 500

    def test_fabric_policy_array_body(self, client):
        r = client.post("/fabric/policy", json=["byRisk"])
        assert r.status_code < 500


class TestRunsPagination:
    def test_non_numeric_pagination_falls_back(self, client):
        r = client.get("/workflow-runs?offset=abc&limit=abc")
        assert r.status_code == 200
        body = r.json()
        assert body["offset"] == 0
        assert body["limit"] == 50

    def test_negative_pagination_clamped(self, client):
        r = client.get("/workflow-runs?offset=-5&limit=-5")
        assert r.status_code == 200
        assert r.json()["offset"] == 0


class TestFabricInvokeShapes:
    def test_list_input_rejected(self, client):
        r = client.post("/fabric/invoke",
                        json={"capabilityId": "workflow.list",
                              "input": [1, 2]})
        assert r.status_code == 400
        assert "object" in r.json()["error"]

    def test_string_context_rejected(self, client):
        r = client.post("/fabric/invoke",
                        json={"capabilityId": "workflow.list",
                              "context": "nope"})
        assert r.status_code == 400
        assert "object" in r.json()["error"]

    def test_valid_invoke_still_works(self, client):
        r = client.post("/fabric/invoke",
                        json={"capabilityId": "workflow.list", "input": {}})
        assert r.status_code == 200
