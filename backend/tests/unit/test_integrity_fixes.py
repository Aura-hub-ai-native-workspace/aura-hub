"""Integrity: a corrupt registry is preserved, and an unreadable session is reported.

Corrupt connected-nodes.json used to load as an empty registry, and the next
registration overwrote the file, destroying the connections it held. An
unreadable session used to return None with no trace.
"""
from __future__ import annotations

import logging

import pytest


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("AURA_HOME", str(h))
    return h


def test_corrupt_registry_is_moved_aside_not_overwritten(home):
    from aura.persistence.nodes import ConnectedNodeStore

    registry = home / "connected-nodes.json"
    garbage = '{"nodes": [{"id": "git", "capabilities": ["source-control"]'  # truncated
    registry.write_text(garbage, encoding="utf-8")

    store = ConnectedNodeStore()
    assert store.list_nodes() == []
    store.register("claude-code", "Claude Code", ["coding-agent"])

    kept = list(home.glob("connected-nodes.json.corrupt-*"))
    assert len(kept) == 1, "the unreadable registry must be preserved beside the new one"
    assert kept[0].read_text(encoding="utf-8") == garbage
    assert [n["id"] for n in ConnectedNodeStore().list_nodes()] == ["claude-code"]


def test_registry_that_cannot_be_moved_aside_is_never_overwritten(home, monkeypatch):
    import os

    from aura.persistence.nodes import ConnectedNodeStore

    registry = home / "connected-nodes.json"
    garbage = "not json at all"
    registry.write_text(garbage, encoding="utf-8")

    real_replace = os.replace

    def refuse(src, dst):
        if str(src).endswith("connected-nodes.json"):
            raise OSError("simulated: cannot move")
        return real_replace(src, dst)

    monkeypatch.setattr("aura.persistence.nodes.os.replace", refuse)
    store = ConnectedNodeStore()
    with pytest.raises(OSError, match="refusing to overwrite"):
        store.register("git", "Git", ["source-control"])
    assert registry.read_text(encoding="utf-8") == garbage


def test_unreadable_session_is_logged_not_silently_none(home, caplog):
    from aura.central_agent.session import AgentSessionStore

    sessions_dir = home / "agent" / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "agt-bad0000000.json").write_text(
        '{"sessionId": "agt-bad0000000", "orchestrationState": "parked-somewhere"}',
        encoding="utf-8")
    store = AgentSessionStore(home)
    with caplog.at_level(logging.ERROR):
        assert store.load("agt-bad0000000") is None
    assert any("agt-bad0000000" in r.getMessage() and "cannot be loaded" in r.getMessage()
               for r in caplog.records), caplog.text


def test_a_missing_session_is_quiet(home, caplog):
    from aura.central_agent.session import AgentSessionStore

    store = AgentSessionStore(home)
    with caplog.at_level(logging.ERROR):
        assert store.load("agt-000000000000") is None
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
