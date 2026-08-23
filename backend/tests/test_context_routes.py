"""The context HTTP surface, and the one place context enters execution.

Two properties are worth pinning at the transport boundary:

* a GET must stay a GET — reading context mounts nothing, scans nothing
  and executes nothing;
* `agent.delegate` receives AURA's context by default, and a caller can
  opt out, but no caller can inject a context for a project it did not
  name.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from aura_backend.api.app import create_app
from aura_backend.config import load_settings


@pytest.fixture
def client(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    os.environ["AURA_PY_HOME"] = str(home)
    os.environ["AURA_PY_PORT"] = "4398"
    app = create_app(load_settings())
    with TestClient(app) as c:
        c.app_state = app.state  # type: ignore[attr-defined]
        yield c


@pytest.fixture
def project(client, tmp_path: Path) -> str:
    root = tmp_path / "subject"
    root.mkdir()
    (root / "package.json").write_text('{"name":"subject"}')
    return client.post("/projects", json={"path": str(root), "name": "Subject"}).json()[
        "project"
    ]["id"]


def test_the_view_is_served_and_carries_its_own_provenance(client, project) -> None:
    body = client.get(f"/projects/{project}/context?git=false").json()
    assert body["contractVersion"] == 1
    assert body["surface"] == "general"
    assert set(body) >= {"project", "repository", "changes", "git", "environment",
                         "capabilities", "missions", "activity", "constraints"}
    for section in ("repository", "changes", "git", "environment"):
        assert "freshness" in body[section]
        assert "generatedAt" in body[section], "an explicit null, not an absent key"


def test_an_unknown_project_is_404_on_both_routes(client) -> None:
    view = client.get("/projects/no-such-project/context")
    assert view.status_code == 404
    assert view.json()["status"] == "unavailable"
    assert client.get("/projects/no-such-project/context/contract").status_code == 404


def test_the_surface_selects_the_budget_and_is_echoed(client, project) -> None:
    body = client.get(f"/projects/{project}/context/contract?surface=planning").json()
    assert body["surface"] == "planning"
    assert body["projectId"] == project
    assert body["contract"].startswith("<PROJECT_CONTEXT>")


def test_only_the_literal_false_turns_git_off(client, project) -> None:
    off = client.get(f"/projects/{project}/context?git=false").json()
    assert off["git"]["reason"] == "git was not read for this request"
    for value in ("0", "no", "False", ""):
        on = client.get(f"/projects/{project}/context?git={value}").json()
        assert on["git"]["reason"] != "git was not read for this request", value


def test_reading_context_does_not_mount_the_project(client, project) -> None:
    for _ in range(3):
        client.get(f"/projects/{project}/context?git=false")
        client.get(f"/projects/{project}/context/contract?git=false")
    assert client.get(f"/projects/{project}/context?git=false").json()["project"][
        "mounted"
    ] is False
    # And the workspace still has nothing open.
    assert client.app_state.workspace.current_project_id is None


def test_reading_context_records_nothing_in_the_audit_trail(client, project) -> None:
    before = len(client.get("/fabric/audit").json()["audit"])
    for _ in range(5):
        client.get(f"/projects/{project}/context")
    assert len(client.get("/fabric/audit").json()["audit"]) == before


def test_reading_context_does_not_scan_the_environment(client, project) -> None:
    """A GET must not spawn probes on the user's machine."""
    assert client.app_state.node_projection.snapshot() is None
    client.get(f"/projects/{project}/context")
    assert client.app_state.node_projection.snapshot() is None
    body = client.get(f"/projects/{project}/context").json()
    assert body["environment"]["freshness"] == "unknown"


# ── the agent context seam ───────────────────────────────────────────

def _capture(client) -> list[dict[str, Any]]:
    """Intercept what actually reaches the Fabric."""
    seen: list[dict[str, Any]] = []
    fabric = client.app_state.fabric
    original = fabric.invoke

    async def spy(capability_id: str, payload: dict, context):
        seen.append({"capabilityId": capability_id, "input": dict(payload)})
        return await original(capability_id, payload, context)

    fabric.invoke = spy  # type: ignore[method-assign]
    return seen


def test_delegating_within_a_project_receives_the_context_contract(client, project) -> None:
    seen = _capture(client)
    client.post("/fabric/invoke", json={
        "capabilityId": "agent.delegate",
        "input": {"task": "do the thing"},
        "context": {"projectId": project, "actorKind": "human", "actorId": "u"},
    })
    assert seen and "context" in seen[0]["input"]
    assert seen[0]["input"]["context"].startswith("<PROJECT_CONTEXT>")
    assert "Do not read or modify files outside this root" in seen[0]["input"]["context"]


def test_an_explicit_empty_context_opts_out(client, project) -> None:
    seen = _capture(client)
    client.post("/fabric/invoke", json={
        "capabilityId": "agent.delegate",
        "input": {"task": "do the thing", "context": ""},
        "context": {"projectId": project, "actorKind": "human", "actorId": "u"},
    })
    assert seen[0]["input"]["context"] == ""


def test_a_supplied_context_is_never_overwritten(client, project) -> None:
    seen = _capture(client)
    client.post("/fabric/invoke", json={
        "capabilityId": "agent.delegate",
        "input": {"task": "t", "context": "caller's own briefing"},
        "context": {"projectId": project, "actorKind": "human", "actorId": "u"},
    })
    assert seen[0]["input"]["context"] == "caller's own briefing"


def test_no_project_means_no_context(client) -> None:
    seen = _capture(client)
    client.post("/fabric/invoke", json={
        "capabilityId": "agent.delegate",
        "input": {"task": "t"},
        "context": {"actorKind": "human", "actorId": "u"},
    })
    assert "context" not in seen[0]["input"]


def test_an_unresolvable_project_delegates_without_a_context(client) -> None:
    """Context is an enrichment, not a gate. A project that cannot be
    composed must not turn a delegation into a failure."""
    seen = _capture(client)
    client.post("/fabric/invoke", json={
        "capabilityId": "agent.delegate",
        "input": {"task": "t"},
        "context": {"projectId": "not-registered", "actorKind": "human", "actorId": "u"},
    })
    assert "context" not in seen[0]["input"]


def test_only_agent_delegate_gets_the_seam(client, project) -> None:
    seen = _capture(client)
    for capability in ("filesystem.list", "terminal.execute", "git.status"):
        client.post("/fabric/invoke", json={
            "capabilityId": capability,
            "input": {"path": ".", "command": "true"},
            "context": {"projectId": project, "actorKind": "human", "actorId": "u"},
        })
    assert all("context" not in call["input"] for call in seen)
