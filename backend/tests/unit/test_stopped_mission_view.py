"""A stopped run keeps its mission view and names steps the way a person
knows them.

Regression from the real Workspace run (session agt-783c2ab7e0a9): one
required task had finished and verified, the other was stopped mid-flight.
The cancelled result carried no tasks, so the Workspace showed only
"Stopped.", and its summary read "delegate-kilo was stopped mid-flight on
kilo-code. Work already verified is kept: delegate-claude."

Real CentralAgent.submit with invoke_fabric stubbed: no worker is started.
"""

from __future__ import annotations

import threading

import pytest

from test_cancellation import _ok, _stopped

MISSION = ("Claude Code and Kilo Code: work in parallel and independently, "
           "without modifying anything. Claude Code, inspect alpha/a.txt and "
           "report its contents. Kilo Code, inspect alpha/missing.txt and "
           "report its contents.")


def _agent(tmp_path):
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.runcontrol import RunControl
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricConfig
    from aura.fabric.host import WiringHost

    audit = AuditStore(tmp_path / "audit" / "trail.jsonl")
    ledger = None

    class _Nodes:
        def list_nodes(self):
            return [
                {"id": "claude-code", "name": "Claude Code", "binary": "claude",
                 "capabilities": ["coding-agent"]},
                {"id": "kilo-code", "name": "Kilo Code", "binary": "kilo",
                 "capabilities": ["coding-agent"]},
            ]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    cfg = FabricConfig(fabric=fabric, audit_store=audit,
                       permissions={"read": True, "write": True},
                       executors={e.capabilityId: e for e in all_executors(None)})
    agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path))
    agent.controller.engine = None
    agent.runs = RunControl()
    return agent


@pytest.fixture()
def stopped(tmp_path, monkeypatch):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / "a.txt").write_text("alpha A: fixture line.\n")
    agent = _agent(tmp_path)
    claude_done = threading.Event()

    def fake_invoke(cap, payload, context, cfg):
        if context["taskId"] == "delegate-claude":
            out = _ok("inv-claude", "claude-code", stdout="alpha A: fixture line.")
            claude_done.set()
            return out
        # Kilo is still running when the person presses Stop.
        claude_done.wait(5)
        context["cancelToken"].request("cancelled from Execution Chat")
        return _stopped("inv-kilo", "kilo-code")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    return agent.submit(MISSION, project_id="p", project_path=str(tmp_path))


def test_stopped_run_is_terminal_and_not_accepted(stopped):
    assert stopped.outcome == "cancelled"
    assert stopped.status == "cancelled"
    assert stopped.failureReason == "cancelled-by-user"
    assert stopped.objectiveAccepted is False


def test_stopped_run_keeps_the_completed_task_and_its_verification(stopped):
    tasks = {t.taskId: t for t in stopped.tasks}
    assert set(tasks) == {"delegate-claude", "delegate-kilo"}
    assert tasks["delegate-claude"].state == "done"
    assert tasks["delegate-claude"].verified is True
    assert stopped.verified == ["delegate-claude"]


def test_the_interrupted_task_is_marked_stopped_not_failed(stopped):
    tasks = {t.taskId: t for t in stopped.tasks}
    assert tasks["delegate-kilo"].state == "cancelled"
    assert tasks["delegate-kilo"].verified is not True


def test_stopped_summary_names_workers_not_internal_ids(stopped):
    s = stopped.summary
    assert s.startswith("You stopped this run.")
    assert "Kilo Code's step was stopped mid-flight." in s
    assert "Work already verified is kept: Claude Code." in s
    for internal in ("delegate-kilo", "delegate-claude", "kilo-code", "claude-code"):
        assert internal not in s


def test_cancellation_summary_never_falls_back_to_raw_ids():
    from aura.central_agent.service import CentralAgent
    s = CentralAgent._cancellation_summary(
        {"taskId": "delegate-x", "workerNodeId": "some-node"},
        ["delegate-y"], ["delegate-z"], {})
    for internal in ("delegate-x", "delegate-y", "delegate-z", "some-node"):
        assert internal not in s
