"""Stopping a run stops its terminal command (H-02).

`terminal.execute` runs an allow-listed binary (node, npm, git, ...). The
worker path already killed its whole process group when the run was stopped;
the terminal executor never passed the stop signal on, so a command already
running kept going until its own timeout, and its side effects landed after
the person had pressed stop. These tests run a real slow script through the
real fabric and stop it part way.
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

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

#: Writes a marker only if it is allowed to run to its end (6 s).
SLOW = """
const fs = require('fs');
setTimeout(() => { fs.writeFileSync('finished.marker', 'ran to the end'); }, 6000);
"""


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
    proj.mkdir()
    (proj / "slow.js").write_text(SLOW)
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
    return cfg, proj


def _survivors(proj, script="slow.js"):
    """Live processes running `script` from this project directory."""
    found = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        if script.encode() in argv and cwd == str(proj):
            found.append(int(pid))
    return found


def _run(cfg, proj, token, command="node slow.js"):
    return invoke_fabric("terminal.execute", {"command": command},
                         {"cwd": str(proj), "actor": {"kind": "agent", "id": "t"},
                          "cancelToken": token, "taskId": "t1"}, cfg)


def test_stopping_a_run_stops_the_running_command(env):
    cfg, proj = env
    token = RunControl().begin("ses-1")
    threading.Timer(1.0, token.request, args=("user pressed stop",)).start()
    started = time.monotonic()
    result = _run(cfg, proj, token)
    elapsed = time.monotonic() - started

    assert elapsed < 4.0, f"the command ran on after stop ({elapsed:.1f}s)"
    assert result["output"].get("cancelled") is True
    assert result["outcome"] != "succeeded"
    deadline = time.monotonic() + 2.0   # the group is gone, not merely detached
    while _survivors(proj) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _survivors(proj) == [], "the stopped command's process is still alive"
    assert not (proj / "finished.marker").exists()


def test_a_run_stopped_before_the_command_starts_never_launches_it(env):
    cfg, proj = env
    token = RunControl().begin("ses-2")
    token.request("stopped first")
    result = _run(cfg, proj, token)
    assert result["output"].get("cancelled") is True
    assert _survivors(proj) == []                      # nothing was launched


def test_a_command_with_no_stop_signal_still_runs_normally(env):
    cfg, proj = env
    (proj / "quick.js").write_text("console.log('done')")
    result = _run(cfg, proj, RunControl().begin("ses-3"), "node quick.js")
    assert result["outcome"] == "succeeded"
    assert result["output"]["stdout"].strip() == "done"
    assert result["output"].get("cancelled") in (None, False)
