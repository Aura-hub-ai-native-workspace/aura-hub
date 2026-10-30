"""A damaged sovereign policy file fails closed (F-17).

The operator writes `sovereign.json` to restrict where prompts may go. A
truncated or corrupt file used to load as "no policy" (cloud allowed); a binary
file raised out of the loader and the agent swallowed the error, starting
unrestricted with no trace. A file that exists but cannot be understood now
turns sovereign mode ON, which blocks cloud network classes only; local and
private classes keep working. A missing file is still "never configured", and
an explicit AURA_SOVEREIGN_MODE still decides.
"""

from __future__ import annotations

import json

import pytest

from aura.sovereign.policy import SovereignPolicy, load_sovereign_policy


@pytest.fixture()
def policy_file(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_SOVEREIGN_MODE", raising=False)
    return tmp_path / "sovereign.json"


def test_a_missing_file_is_unrestricted(policy_file):
    policy = load_sovereign_policy()
    assert policy.sovereign_mode is False and policy.source == "default"
    assert policy.allows("cloud")


def test_a_valid_file_is_honoured(policy_file):
    policy_file.write_text(json.dumps({"sovereignMode": True}))
    policy = load_sovereign_policy()
    assert policy.sovereign_mode is True and policy.source == "file"
    assert not policy.allows("cloud")


def test_a_valid_file_that_disables_the_mode_is_honoured(policy_file):
    policy_file.write_text(json.dumps({"sovereignMode": False}))
    assert load_sovereign_policy().allows("cloud")


@pytest.mark.parametrize("content", [
    b'{"sovereignMode": tr',            # truncated by a crash mid-write
    b"",                                  # zero-length after a failed save
    b'["not", "an", "object"]',          # valid JSON of the wrong shape
    b"\xff\xfe\x00 binary garbage",     # not text at all
])
def test_an_unreadable_file_fails_closed_for_cloud_only(policy_file, content, capsys):
    policy_file.write_bytes(content)
    policy = load_sovereign_policy()
    assert policy.sovereign_mode is True
    assert policy.source == "unreadable-file"
    assert not policy.allows("cloud")
    assert policy.allows("local") and policy.allows("private")  # local use keeps working
    assert "sovereign mode ON" in capsys.readouterr().err  # the operator is told


def test_an_explicit_environment_override_still_wins(policy_file, monkeypatch):
    policy_file.write_bytes(b'{"sovereignMode": tr')
    monkeypatch.setenv("AURA_SOVEREIGN_MODE", "0")
    assert load_sovereign_policy().allows("cloud")
    monkeypatch.setenv("AURA_SOVEREIGN_MODE", "1")
    assert not load_sovereign_policy().allows("cloud")


def test_the_agent_does_not_start_unrestricted_when_the_loader_breaks(tmp_path, monkeypatch, caplog):
    from aura.central_agent import service as svc

    monkeypatch.setenv("AURA_HOME", str(tmp_path))

    def broken(*a, **k):
        raise RuntimeError("loader exploded")

    monkeypatch.setattr("aura.sovereign.policy.load_sovereign_policy", broken)
    from aura.central_agent import AgentSessionStore
    from aura.fabric import FabricConfig

    with caplog.at_level("ERROR"):
        agent = svc.CentralAgent(fabric_cfg=FabricConfig(),
                                 session_store=AgentSessionStore(tmp_path))
    assert isinstance(agent.sovereign_policy, SovereignPolicy)
    assert agent.sovereign_policy.sovereign_mode is True
    assert agent.sovereign_policy.source == "load-failed"
    assert any("sovereign policy could not be loaded" in r.getMessage() for r in caplog.records)


def test_the_api_server_does_not_pass_no_policy_to_the_agent_runtime(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    seen = {}

    def broken(*a, **k):
        raise RuntimeError("loader exploded")

    monkeypatch.setattr("aura.sovereign.policy.load_sovereign_policy", broken)
    import aura.agent_runtime.service as runtime_service

    original = runtime_service.AgentRuntimeService.__init__

    def spy(self, *a, **k):
        seen["policy"] = k.get("sovereign_policy")
        return original(self, *a, **k)

    monkeypatch.setattr(runtime_service.AgentRuntimeService, "__init__", spy)
    TestClient(create_app())
    assert seen.get("policy") is not None
    assert seen["policy"].sovereign_mode is True
