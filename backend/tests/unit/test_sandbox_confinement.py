"""sandbox.execute stays inside the project and inside the allow-list (F-18).

Its manifest promises a bounded subprocess "inside the project root". The
executor took the working directory from its own input and ran any program,
so a plan could write outside the project (reproduced through the agent's
planner and dispatch). With the human approval step gone, a medium-risk
capability must be safe at its own boundary. These tests drive the real
fabric and the real agent path with harmless commands in temporary
directories.
"""

from __future__ import annotations

import os
import shutil
import threading
import time

import pytest

from aura.audit import AuditStore
from aura.central_agent.runcontrol import RunControl
from aura.fabric import CapabilityFabric, FabricConfig, FabricHost, builtin_executors, invoke_fabric

NEEDS_NODE = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    class Host(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

    home = tmp_path / "home"
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    (proj / "sub").mkdir(parents=True)
    (proj / "sub" / "inner.txt").write_text("inner")
    outside = tmp_path / "outside"
    outside.mkdir()
    audit = AuditStore(home / "audit" / "trail.jsonl")
    fab = CapabilityFabric(Host())
    fab.attach_audit_store(audit.load, audit.append)
    execs = builtin_executors(home)
    for exe in execs.values():
        try:
            fab.register(exe)
        except Exception:
            pass
    cfg = FabricConfig(fabric=fab, policy_config={}, permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit)
    return cfg, proj, outside


def _sandbox(cfg, proj, params, **context):
    ctx = {"cwd": str(proj), "actor": {"kind": "agent", "id": "t"}, **context}
    return invoke_fabric("sandbox.execute", params, ctx, cfg)


def test_a_command_runs_in_a_directory_inside_the_project(env):
    cfg, proj, _ = env
    result = _sandbox(cfg, proj, {"command": "ls", "cwd": "sub"})
    assert result["outcome"] == "succeeded"
    assert "inner.txt" in result["output"]["stdout"]


def test_the_default_directory_is_the_project_root(env):
    cfg, proj, _ = env
    result = _sandbox(cfg, proj, {"command": "ls"})
    assert result["outcome"] == "succeeded"
    assert "sub" in result["output"]["stdout"]


@pytest.mark.parametrize("where", ["absolute-outside", "parent", "deep-escape", "tilde"])
def test_a_directory_outside_the_project_is_refused(env, where):
    cfg, proj, outside = env
    cwd = {"absolute-outside": str(outside), "parent": "..", "deep-escape": "sub/../../outside",
           "tilde": "~"}[where]
    result = _sandbox(cfg, proj, {"command": "ls", "cwd": cwd})
    assert result["outcome"] == "failed"
    assert "leaves the project directory" in result["detail"]


def test_a_symlink_out_of_the_project_is_refused(env):
    cfg, proj, outside = env
    os.symlink(outside, proj / "escape")
    result = _sandbox(cfg, proj, {"command": "ls", "cwd": "escape"})
    assert result["outcome"] == "failed"
    assert "leaves the project directory" in result["detail"]


@pytest.mark.parametrize("command", [
    "id",                              # not on the allow-list
    "bash -c touch-nothing",           # a shell
    "touch created.txt",               # not on the allow-list
    "ls; touch created.txt",           # shell operator
    "ls | wc",                         # shell operator
    "npm install left-pad",            # installing software
])
def test_commands_outside_the_terminal_rule_are_refused(env, command):
    cfg, proj, _ = env
    result = _sandbox(cfg, proj, {"command": command})
    assert result["outcome"] == "failed"
    assert not (proj / "created.txt").exists()


def test_no_project_directory_means_nothing_runs(env):
    cfg, _, outside = env
    result = invoke_fabric("sandbox.execute", {"command": "ls", "cwd": str(outside)},
                           {"actor": {"kind": "agent", "id": "t"}}, cfg)
    assert result["outcome"] == "failed"
    assert "Open a project first" in result["detail"]


def test_an_agent_plan_cannot_run_a_command_outside_the_project(env, tmp_path):
    """The reproduction: a model-proposed plan naming a directory elsewhere."""
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.contracts import AgentIntent
    from aura.fabric.manifest import all_capabilities
    from aura.workflow import EngineConfig, WorkflowEngine, make_stores

    cfg, proj, outside = env
    ws, vs, rs = make_stores()
    agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path / "home"),
                         workflow_store=ws, run_store=rs,
                         workflow_engine=WorkflowEngine(cfg, ws, vs, rs, EngineConfig()))
    agent.planner = type(agent.planner)(known_capabilities=lambda: {c.id for c in all_capabilities()})
    session = agent.sessions.create(None)
    session.projectPath = str(proj)
    agent.sessions.save(session)
    intent = AgentIntent(goal="run a build step", expectedOutcome="ran",
                         requiredCapabilities=["sandbox.execute"])
    plan = agent.planner.plan_from_model(intent, session.sessionId, "now", {"tasks": [
        {"id": "t1", "description": "Run a build step", "capabilityId": "sandbox.execute",
         "input": {"command": "ls", "cwd": str(outside)}, "risk": "medium",
         "verificationKind": "audit-only"}]})
    (outside / "written-by-agent.txt").write_text("")  # a file a listing there would show
    result = agent._dispatch_plan(session, plan, intent, "run a build step")
    assert result.outcome != "completed"
    assert "written-by-agent" not in str(result.summary)


# ── stopping a run stops its sandboxed command (H-02, second executor) ─────

SLOW = "setTimeout(function(){ require('fs').writeFileSync('finished.marker','x'); }, 6000);"


def _survivors(proj):
    found = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        if b"slow.js" in argv and cwd == str(proj):
            found.append(int(pid))
    return found


@NEEDS_NODE
def test_stopping_a_run_stops_the_sandboxed_command(env):
    cfg, proj, _ = env
    (proj / "slow.js").write_text(SLOW)
    token = RunControl().begin("ses-s1")
    threading.Timer(1.0, token.request, args=("user pressed stop",)).start()
    started = time.monotonic()
    result = _sandbox(cfg, proj, {"command": "node slow.js", "timeout_ms": 20000}, cancelToken=token,
                      taskId="t1")
    assert time.monotonic() - started < 4.0
    assert result["output"].get("cancelled") is True
    deadline = time.monotonic() + 2.0
    while _survivors(proj) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _survivors(proj) == []
    assert not (proj / "finished.marker").exists()


@NEEDS_NODE
def test_a_run_stopped_before_the_sandboxed_command_starts_never_launches_it(env):
    cfg, proj, _ = env
    (proj / "slow.js").write_text(SLOW)
    token = RunControl().begin("ses-s2")
    token.request("stopped first")
    result = _sandbox(cfg, proj, {"command": "node slow.js"}, cancelToken=token, taskId="t1")
    assert result["output"].get("cancelled") is True
    assert _survivors(proj) == []
