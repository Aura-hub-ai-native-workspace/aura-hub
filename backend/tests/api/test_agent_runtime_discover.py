"""AI Runtime contract — /agent-runtime/discover and /agent-runtime/summary
must emit the AgentRuntimeSummary / AgentRecord shape the desktop renderer
actually consumes.

The desktop component reads id/name/status/currentConfig/drift per agent
and the top-level counts. Previously the route returned a snake_case
discovery record with no counts, and AgentCard dereferenced fields that
were never there — the screen fell into its ErrorBoundary.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from aura.agent_runtime.model import AgentRecord, ConfigStatus
from aura.agent_runtime.service import AgentRuntimeService
from aura.api.server import create_app

API_RECORD_KEYS = {
    "id", "name", "detected", "configPath", "status",
    "statusNote", "currentConfig", "drift", "driftFields", "error",
}
VALID_STATUS = {"ok", "partial", "incompatible", "not_installed", "error"}
VALID_DRIFT = {"in_sync", "drifted", "unknown"}


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    app = create_app()
    return TestClient(app), tmp_path


# ── API-level: the route must conform to AgentRuntimeSummary ─────────────────

def test_discover_response_has_summary_shape(svc):
    c, _ = svc
    r = c.get("/agent-runtime/discover")
    assert r.status_code == 200
    body = r.json()
    # 1. response contains the AgentRuntimeSummary shape
    assert isinstance(body.get("agents"), list)
    for key in ("installedCount", "configuredCount", "driftedCount"):
        assert isinstance(body.get(key), int), f"missing/invalid {key}"


def test_every_discovered_agent_conforms_to_agent_record(svc):
    c, _ = svc
    body = c.get("/agent-runtime/discover").json()
    for agent in body["agents"]:
        # 2. each agent conforms to AgentRecord
        assert set(agent.keys()) == API_RECORD_KEYS, set(agent.keys())
        assert isinstance(agent["id"], str) and agent["id"]
        assert isinstance(agent["name"], str) and agent["name"]
        assert isinstance(agent["detected"], bool)
        assert agent["status"] in VALID_STATUS
        assert isinstance(agent["statusNote"], str)
        assert isinstance(agent["currentConfig"], dict)
        assert agent["drift"] in VALID_DRIFT
        assert isinstance(agent["driftFields"], list)
        assert agent["error"] is None or isinstance(agent["error"], str)
        # 4. contract's empty-state representation: no fabricated error/drift
        assert agent["drift"] == "unknown"
        assert agent["driftFields"] == []
        assert agent["error"] is None


def test_counts_are_internally_consistent(svc):
    c, _ = svc
    body = c.get("/agent-runtime/discover").json()
    agents = body["agents"]
    installed = [a for a in agents if a["detected"]]
    configured = [a for a in agents
                  if a["detected"] and a["status"] in ("ok", "partial")]
    # 3. internally consistent — and never fabricated out of thin air
    assert body["installedCount"] == len(installed)
    assert body["configuredCount"] == len(configured)
    assert body["configuredCount"] <= body["installedCount"]
    assert body["driftedCount"] == 0
    assert body["installedCount"] <= len(agents)


def test_discover_carries_no_fabricated_agents(svc):
    c, _ = svc
    body = c.get("/agent-runtime/discover").json()
    # 6. no invented agents: every listed agent is a real detected record
    for a in body["agents"]:
        assert isinstance(a["name"], str) and a["name"]
        assert a["currentConfig"].keys() <= {"baseUrl", "modelId", "version", "binaryPath"}


# ── service-level: field mapping is honest, existence preserves information ──

def _rec(agent_id, **over):
    base = dict(
        agent_id=agent_id, display_name=agent_id, version=None,
        binary_path=None, config_path=None, detected=False,
        adapter_class="a.b.C", current_base_url=None, current_model=None,
        config_status=ConfigStatus.NOT_INSTALLED, notes=[],
    )
    base.update(over)
    return AgentRecord(**base)


def test_full_record_maps_all_fields(tmp_path):
    svc = AgentRuntimeService(store_dir=tmp_path)
    rec = svc.to_api_record(_rec(
        "claude-code", display_name="Claude Code", version="2.1.152",
        binary_path="/usr/bin/claude", config_path="/home/x/.claude",
        detected=True, current_base_url="https://api.anthropic.com",
        current_model="claude-opus", config_status=ConfigStatus.OK,
        notes=["apiKeyConfigured: True", "baseUrlSet"],
    ))
    # 5. existing discovery info is preserved, not dropped
    assert rec["id"] == "claude-code"
    assert rec["name"] == "Claude Code"
    assert rec["detected"] is True
    assert rec["configPath"] == "/home/x/.claude"
    assert rec["status"] == "ok"
    assert rec["statusNote"] == "apiKeyConfigured: True; baseUrlSet"
    assert rec["currentConfig"] == {
        "baseUrl": "https://api.anthropic.com",
        "modelId": "claude-opus",
        "version": "2.1.152",
        "binaryPath": "/usr/bin/claude",
    }


def test_minimal_record_stays_empty_not_faked(tmp_path):
    svc = AgentRuntimeService(store_dir=tmp_path)
    rec = svc.to_api_record(_rec("opencode", display_name="OpenCode"))
    # 4. missing optional values use the contract's empty/null representation
    assert rec["configPath"] is None
    assert rec["status"] == "not_installed"
    assert rec["statusNote"] == ""
    assert rec["currentConfig"] == {}
    assert rec["drift"] == "unknown"
    assert rec["driftFields"] == []
    assert rec["error"] is None


def test_summary_counts_derive_from_records(tmp_path):
    svc = AgentRuntimeService(store_dir=tmp_path)
    records = [
        _rec("a", display_name="A", detected=True,
             current_base_url="http://x", current_model="m",
             config_status=ConfigStatus.OK),
        _rec("b", display_name="B", detected=True,
             config_status=ConfigStatus.NOT_INSTALLED),
        _rec("c", display_name="C", detected=False),
    ]
    summary = svc.summary_from_records(records)
    agents = [a["id"] for a in summary["agents"]]
    assert agents == ["a", "b", "c"]
    # 3. counts consistent with what discovery actually knows
    assert summary["installedCount"] == 2
    assert summary["configuredCount"] == 1
    assert summary["driftedCount"] == 0
