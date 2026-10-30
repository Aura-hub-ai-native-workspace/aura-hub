"""Observer and guard failures are visible (F-07).

A subscriber that raises must still not break an execution, and now says so in
the log. The live-settings guard answers "is this the live file" and is used to
refuse writes, so a path it cannot resolve counts as live (the safe answer).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from aura.agent_runtime.adapters import claude_code
from aura.central_agent.events import EventBus
from aura.contracts import AgentEvent
from aura.workflow import WorkflowEngine


def test_a_failing_event_subscriber_is_logged_and_others_still_run(caplog):
    bus = EventBus()
    seen = []

    def broken(event):
        raise RuntimeError("observer bug")

    bus.subscribe(broken)
    bus.subscribe(seen.append)
    with caplog.at_level(logging.WARNING, logger="aura.central_agent.events"):
        bus.emit(AgentEvent(type="session.started", at="now", sessionId="s1"))
    assert len(seen) == 1                                  # the execution carried on
    logged = [r for r in caplog.records if "event subscriber" in r.getMessage()]
    assert logged and "observer bug" in str(logged[0].exc_info[1])


def test_a_failing_workflow_listener_is_logged_and_later_listeners_run(caplog):
    engine = WorkflowEngine.__new__(WorkflowEngine)
    seen = []

    def broken(event):
        raise RuntimeError("listener bug")

    engine._listeners = [broken, seen.append]
    with caplog.at_level(logging.WARNING, logger="aura.workflow"):
        engine._emit({"type": "x"})
    assert seen == [{"type": "x"}]
    logged = [r for r in caplog.records if "workflow listener" in r.getMessage()]
    assert logged and "listener bug" in str(logged[0].exc_info[1])


def test_the_live_settings_guard_matches_the_live_file(tmp_path):
    assert claude_code._is_live_path(claude_code._REAL_SETTINGS_PATH) is True
    assert claude_code._is_live_path(tmp_path / "settings.json") is False


def test_a_path_the_guard_cannot_resolve_counts_as_live(monkeypatch):
    def boom(_path):
        raise ValueError("cannot resolve")

    monkeypatch.setattr(os.path, "realpath", boom)
    assert claude_code._is_live_path(Path("/anything")) is True


def test_a_failure_to_record_a_connected_tool_is_logged_and_does_not_fail_the_run(caplog):
    from aura.central_agent.provisioner import Provisioner

    def broken(node_id, version):
        raise RuntimeError("registry write failed")

    provisioner = Provisioner.__new__(Provisioner)
    provisioner._connect = broken
    with caplog.at_level(logging.WARNING, logger="aura.central_agent.provisioner"):
        provisioner._mark_connected("node-x", "1.2")             # must not raise
    logged = [r for r in caplog.records if "could not record node-x 1.2 as connected" in r.getMessage()]
    assert logged and "registry write failed" in str(logged[0].exc_info[1])
