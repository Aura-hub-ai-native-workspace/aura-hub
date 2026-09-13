"""Phase K — the worker surface over HTTP, and its authority boundary.

The frontend can ask AURA to prove a worker. It can never assert that a
worker is proved, and it can never make one dispatchable by describing
it convincingly.
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.api.server import create_app

    return TestClient(create_app()), tmp_path


class TestWorkerRoutes:
    def test_workers_are_listed_with_honest_defaults(self, client):
        c, _ = client
        body = c.get("/workers").json()
        assert body["total"] >= 6
        assert body["connected"] == 0
        names = {w["id"] for w in body["workers"]}
        assert {"opencode", "claude-code", "kilo-code", "codex-cli",
                "gemini-cli", "qwen-cli"} <= names
        for worker in body["workers"]:
            assert worker["connected"] is False
            assert worker["governance"] == "NOT_CONNECTED"

    def test_the_matrix_has_no_fabricated_cells(self, client):
        c, _ = client
        for row in c.get("/workers").json()["matrix"]:
            assert row["realResponse"] is False
            assert row["connected"] is False

    def test_an_unknown_worker_is_refused(self, client):
        c, _ = client
        res = c.post("/workers/connect", json={"id": "definitely-not-real"})
        assert res.status_code == 400
        assert "error" in res.json()

    def test_connect_requires_an_id(self, client):
        c, _ = client
        assert c.post("/workers/connect", json={}).status_code == 400


class TestEnvironmentConnectCannotFakeAWorker:
    def test_a_worker_cannot_be_connected_by_the_tool_route(self, client):
        """The exact shortcut this phase closes: /environment/connect
        marks a node connected on a version probe alone. For a worker
        that is not evidence of anything, so the route refuses and says
        where the real handshake lives."""
        c, _ = client
        res = c.post("/environment/connect", json={"id": "opencode"})
        assert res.status_code == 409
        body = res.json()
        assert body["connected"] is False
        assert body["worker"] is True
        assert "/workers/connect" in body["detail"]

    def test_a_real_tool_still_connects_the_old_way(self, client):
        """Tools are unaffected: git is a capability the Fabric drives
        itself, and presence is the right evidence for it."""
        c, _ = client
        res = c.post("/environment/connect", json={"id": "git"})
        assert res.status_code == 200


class TestFrontendIsNeverTheAuthority:
    def test_registering_a_node_cannot_make_it_dispatchable(self, client):
        """A client may register a node — that has always been the local
        configuration seam. It must not be able to state the runtime
        binding or a readiness proof, because those are what let AURA
        actually spawn a worker."""
        c, home = client
        res = c.post("/fabric/nodes", json={
            "id": "opencode", "name": "OpenCode",
            "capabilities": ["coding-agent", "terminal"],
            # everything below is the client trying to promote itself
            "binary": "opencode",
            "worker": True,
            "readiness": {"proved": True, "governance": "FULLY_GOVERNED"},
        })
        assert res.status_code == 200
        record = res.json()
        assert "binary" not in record
        assert "readiness" not in record

        from aura.executors import agent_delegate_supports_node

        assert agent_delegate_supports_node(record) is False

        # and the worker surface still reports the truth
        worker = next(w for w in c.get("/workers").json()["workers"]
                      if w["id"] == "opencode")
        assert worker["connected"] is False
