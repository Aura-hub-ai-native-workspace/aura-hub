"""Tool provisioning: only approved, non-privileged, catalogue-named tools —
and an honest report of everything else.

No real installation happens here: the guard is pure, and the provisioner
runs against a fake invoker and a fake probe.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from aura.central_agent.provisioner import MAX_ATTEMPTS, Need, Provisioner
from aura.environment.catalog import catalog_entry
from aura.environment.install import InstallPlan
from aura.environment.provisioning import (
    DEFAULT_ALLOWLIST, allowed_ids, decide, operator_allowlist, tool_provision_run,
)

PNPM = catalog_entry("pnpm")


def plan_for(privilege="user", bin_="npm", command="npm install -g pnpm"):
    return lambda entry: InstallPlan(executable=privilege == "user", privilege=privilege, bin=bin_,
                                     args=["install", "-g", "pnpm"], command=command, why="because")


# ── the guard ────────────────────────────────────────────────────────────

def test_an_allowlisted_user_space_tool_is_allowed():
    d = decide("pnpm", allow=frozenset({"pnpm"}), plan_fn=plan_for())
    assert d.allowed and d.code == "ok" and d.command == "npm install -g pnpm"


@pytest.mark.parametrize("node", ["pnpm; rm -rf /", "$(curl evil)", "../pnpm", "PNPM", "", None, 7, "a" * 90,
                                  "pnpm && echo hi", "pnpm\nrm", "`id`"])
def test_a_caller_can_never_smuggle_a_command_through_the_id(node):
    d = decide(node, allow=frozenset({"pnpm"}), plan_fn=plan_for())
    assert not d.allowed and d.code in ("invalid-id", "not-in-catalog")


def test_a_catalogue_entry_is_not_an_authorisation():
    # opencode IS in the catalogue and installable in user space; it is a paid-account AI worker, so it
    # is not on the default allowlist and is refused unless the owner adds it.
    assert catalog_entry("opencode") is not None
    d = decide("opencode", allow=DEFAULT_ALLOWLIST)
    assert not d.allowed and d.code == "not-allowlisted"
    assert "vercel" not in DEFAULT_ALLOWLIST  # nor are deploy CLIs


def test_a_privileged_install_is_never_run_and_gives_the_command_back():
    d = decide("pnpm", allow=frozenset({"pnpm"}), plan_fn=plan_for(privilege="root", command="sudo apt install pnpm"))
    assert not d.allowed and d.code == "needs-privilege" and d.command == "sudo apt install pnpm"
    assert "administrator" in d.reason


def test_an_installer_that_is_not_allowlisted_is_refused():
    d = decide("pnpm", allow=frozenset({"pnpm"}), plan_fn=plan_for(bin_="bash"))
    assert not d.allowed and d.code == "installer-not-allowed"


def test_no_install_plan_means_no_install():
    from aura.environment.install import NoInstallPlan
    d = decide("pnpm", allow=frozenset({"pnpm"}), plan_fn=lambda e: NoInstallPlan(reason="no package manager"))
    assert not d.allowed and d.code == "no-install-plan"


def test_the_owner_can_extend_the_allowlist_but_only_with_plain_ids(tmp_path):
    (tmp_path / "provisioning.json").write_text(json.dumps({"allow": ["opencode", "pnpm; rm -rf /", 7, "Bad Id"]}))
    assert operator_allowlist(tmp_path) == frozenset({"opencode"})
    assert allowed_ids(tmp_path) == DEFAULT_ALLOWLIST | {"opencode"}
    (tmp_path / "provisioning.json").write_text("not json")
    assert operator_allowlist(tmp_path) == frozenset()


def test_the_executor_refuses_before_touching_the_runner(monkeypatch):
    called = []

    async def runner(inv):
        called.append(inv)
        return {"ok": True}

    monkeypatch.setattr("aura.environment.executor.system_install_executor", runner)
    for bad in ({"nodeId": "opencode"}, {"nodeId": "pnpm; echo hi"}, {"nodeId": "nope-not-real"}, {}, "x"):
        out = asyncio.run(tool_provision_run({"input": bad}))
        assert out["ok"] is False
    assert called == []


def test_only_the_validated_id_reaches_the_runner(monkeypatch):
    seen = []

    async def runner(inv):
        seen.append(inv)
        return {"ok": True, "detail": "x", "output": {"installOutcome": "installed"}}

    monkeypatch.setattr("aura.environment.executor.system_install_executor", runner)
    monkeypatch.setattr("aura.environment.provisioning.decide",
                        lambda node_id, **k: SimpleNamespace(allowed=True, code="ok", reason="", command="npm i"))
    out = asyncio.run(tool_provision_run({"input": {"nodeId": "pnpm", "reason": "$(rm -rf /)", "command": "evil"},
                                          "context": {"timeoutMs": 5}}))
    assert out["ok"] and seen[0]["input"] == {"nodeId": "pnpm"}  # the reason and any "command" were dropped


# ── the provisioner ──────────────────────────────────────────────────────

class Bus:
    def __init__(self):
        self.events = []

    def __call__(self, type_, **payload):
        self.events.append((type_, payload))

    def stages(self):
        return [p["stage"] for t, p in self.events if t == "tool.provisioning"]


def probe_sequence(*answers):
    seq = list(answers)

    def probe(node_id):
        value = seq.pop(0) if len(seq) > 1 else seq[0]
        return SimpleNamespace(present=value, version="9.1.0" if value else "", detail="not found")
    return probe


def invoke_returning(*results):
    seq = list(results)
    calls = []

    def invoke(cap, payload, ctx):
        calls.append((cap, payload, ctx))
        return seq.pop(0) if len(seq) > 1 else seq[0]
    invoke.calls = calls
    return invoke


OK = {"outcome": "succeeded", "detail": "installed", "verification": {"passed": True},
      "output": {"exitCode": 0, "stdout": "added 1 package"}}
ALLOW = SimpleNamespace(allowed=True, code="ok", reason="", command="npm install -g pnpm")


def need():
    return [Need("pnpm", ["t1"], ["needed by task t1"])]


def run(invoke, probe, bus, decide_fn=lambda n: ALLOW, **kw):
    return Provisioner(invoke, probe, bus, decide_fn=decide_fn, sleep=lambda s: None).ensure(
        need(), session_id="agt-1", request_id=None, project_id="p", **kw)


def test_a_tool_that_is_already_there_is_reused_and_nothing_is_run():
    bus, invoke = Bus(), invoke_returning(OK)
    out = run(invoke, probe_sequence(True), bus)
    assert out["ok"] and out["tools"][0]["outcome"] == "reused" and invoke.calls == []
    assert bus.stages() == ["checking", "present"]


def test_a_missing_tool_is_installed_then_confirmed_by_a_fresh_probe():
    bus, invoke = Bus(), invoke_returning(OK)
    out = run(invoke, probe_sequence(False, True), bus)
    tool = out["tools"][0]
    assert out["ok"] and tool["outcome"] == "installed" and tool["version"] == "9.1.0" and tool["exitCode"] == 0
    assert bus.stages() == ["checking", "installing", "installed"]
    cap, payload, ctx = invoke.calls[0]
    assert cap == "tool.provision" and payload["nodeId"] == "pnpm" and ctx["actor"]["id"] == "central-agent:provisioner"
    done = [p for t, p in bus.events if p.get("stage") == "installed"][0]
    assert done["durationMs"] >= 0 and done["outputTail"] == "added 1 package"


def test_an_installer_that_exits_0_but_leaves_no_tool_is_a_failure_not_an_install():
    bus = Bus()
    out = run(invoke_returning(OK), probe_sequence(False, False), bus)
    assert not out["ok"] and out["tools"][0]["outcome"] == "failed" and "still cannot find" in out["tools"][0]["detail"]
    assert bus.stages()[-1] == "failed" and out["blocked"] == {"t1": out["blocked"]["t1"]}
    assert "not available" in out["blocked"]["t1"]


def test_a_failed_install_is_reported_with_its_exit_code_and_never_as_installed():
    fail = {"outcome": "failed", "detail": "The installer exited 1.", "output": {"exitCode": 1, "stdout": "EACCES"}}
    out = run(invoke_returning(fail), probe_sequence(False), Bus())
    t = out["tools"][0]
    assert t["outcome"] == "failed" and t["exitCode"] == 1 and "EACCES" in t["outputTail"] and not out["ok"]


def test_a_transient_failure_is_retried_once_and_then_stops():
    net = {"outcome": "failed", "detail": "network error: connection refused ECONNREFUSED",
           "output": {"exitCode": 1, "stdout": ""}}
    bus, invoke = Bus(), invoke_returning(net)
    out = run(invoke, probe_sequence(False), bus)
    assert len(invoke.calls) == MAX_ATTEMPTS == 2 and "retrying" in bus.stages() and not out["ok"]
    # an ordinary failure is not retried
    bus2, invoke2 = Bus(), invoke_returning({"outcome": "failed", "detail": "tests broke", "output": {"exitCode": 1}})
    run(invoke2, probe_sequence(False), bus2)
    assert len(invoke2.calls) == 1 and "retrying" not in bus2.stages()


def test_a_retry_can_succeed():
    net = {"outcome": "failed", "detail": "network error ETIMEDOUT", "output": {"exitCode": 1}}
    out = run(invoke_returning(net, OK), probe_sequence(False, True), Bus())
    assert out["ok"] and out["tools"][0]["attempt"] == 2


def test_a_refused_tool_blocks_its_tasks_with_the_exact_reason_and_never_installs():
    refused = SimpleNamespace(allowed=False, code="needs-privilege", reason="needs administrator rights ...",
                              command="sudo apt install pnpm")
    bus, invoke = Bus(), invoke_returning(OK)
    out = run(invoke, probe_sequence(False), bus, decide_fn=lambda n: refused)
    assert invoke.calls == [] and out["tools"][0]["outcome"] == "blocked" and out["tools"][0]["command"] == "sudo apt install pnpm"
    assert "administrator" in out["blocked"]["t1"] and bus.stages() == ["checking", "blocked"]


def test_stopping_before_the_install_does_not_install():
    invoke = invoke_returning(OK)
    out = run(invoke, probe_sequence(False), Bus(), should_stop=lambda: True)
    assert invoke.calls == [] and out["tools"][0]["outcome"] == "cancelled" and not out["ok"]


def test_an_unreadable_probe_is_not_treated_as_installed():
    def boom(_):
        raise RuntimeError("probe broke")
    out = run(invoke_returning(OK), boom, Bus())
    assert out["tools"][0]["outcome"] in ("installed", "failed")  # decided by the install + a probe, not assumed
    assert out["tools"][0]["outcome"] == "failed"  # the post-install probe also broke: nothing is confirmed


def test_output_in_events_is_sanitized():
    leaky = {"outcome": "failed", "detail": "x", "output": {"exitCode": 1,
             "stdout": "token sk-abcdefghijklmnopqrstuv \x1b[31mred\x1b[0m"}}
    bus = Bus()
    run(invoke_returning(leaky), probe_sequence(False), bus)
    tail = [p for t, p in bus.events if p.get("stage") == "failed"][0]["outputTail"]
    assert "sk-abcdef" not in tail and "\x1b" not in tail


# ── through the real agent ───────────────────────────────────────────────

class WritingPort:
    providers = ()

    def complete_json(self, system, user):
        return None

    def complete_stream(self, system, user, on_token=None, should_stop=None):
        path = user.rsplit("Write the full contents of ", 1)[1].split(" now.")[0]
        return f"# {path}\n"


def handoff_plan():
    def t(tid, path, deps=(), requires=()):
        return {"id": tid, "title": f"Write {path}", "description": "", "targetFile": path, "files": [],
                "dependsOn": list(deps), "worker": None, "requires": list(requires)}
    return {"source": "planner", "planId": "plan-tools", "revision": 1, "goal": "Build three files",
            "tasks": [t("needs", "needs.md", requires=["pnpm"]), t("free", "free.md"),
                      t("after", "after.md", deps=["needs"])]}


@pytest.fixture()
def agent_and_project(tmp_path, monkeypatch):
    from aura.executors import all_executors
    from test_stopped_mission_view import _agent

    agent = _agent(tmp_path)
    for ex in all_executors(None):
        agent.fabric_cfg.fabric.register(ex)
    agent.intents.model_port = WritingPort()
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr("aura.environment.probe.probe_node",
                        lambda node_id, refresh=False: SimpleNamespace(present=False, version="", detail="not found"))
    return agent, project


def test_a_tool_that_cannot_be_provided_blocks_only_the_tasks_that_need_it(agent_and_project, monkeypatch):
    agent, project = agent_and_project
    monkeypatch.setattr("aura.environment.provisioning.decide",
                        lambda node_id, **k: SimpleNamespace(allowed=False, code="needs-privilege", command="sudo apt install pnpm",
                                                             reason="pnpm needs administrator rights, so AURA did not run anything."))
    result, sid = agent.execute_handoff(handoff_plan(), project_id="p", project_path=str(project))
    assert (project / "free.md").exists()  # independent work carried on
    assert not (project / "needs.md").exists() and not (project / "after.md").exists()
    assert result.outcome != "completed"  # a plan with blocked tasks is never reported complete
    rep = result.report
    # AURA issues its own task ids; the Planner's ids are kept as sourceId.
    states = {u["sourceId"]: u["state"] for u in rep["unfinished"]}
    assert states == {"needs": "blocked", "after": "blocked"}
    assert {w["sourceId"] for w in rep["workCompleted"]} == {"free"}
    blocked = next(u for u in rep["unfinished"] if u["sourceId"] == "needs")
    assert "administrator" in blocked["detail"]
    dep = next(u for u in rep["unfinished"] if u["sourceId"] == "after")
    needs_id = blocked["taskId"]
    assert f"depends on {needs_id}" in dep["detail"]
    ev = [e for e in agent.bus.tail if e.sessionId == sid and e.type == "tool.provisioning"]
    assert [e.payload["stage"] for e in ev] == ["checking", "blocked"] and ev[1].payload["command"] == "sudo apt install pnpm"
    assert rep["toolsInstalled"] == [] and rep["toolsReused"] == []


def test_a_provisioned_tool_runs_its_task_and_is_reported_as_installed(agent_and_project, monkeypatch):
    agent, project = agent_and_project
    present = {"now": False}
    monkeypatch.setattr("aura.environment.probe.probe_node",
                        lambda node_id, refresh=False: SimpleNamespace(present=present["now"], version="9.1.0", detail=""))
    monkeypatch.setattr("aura.environment.provisioning.decide",
                        lambda node_id, **k: SimpleNamespace(allowed=True, code="ok", reason="", command="npm install -g pnpm"))
    real = __import__("aura.fabric", fromlist=["invoke_fabric"]).invoke_fabric

    def fake(cap, payload, ctx, cfg):
        if cap == "tool.provision":
            present["now"] = True  # the (fake) install made the tool appear
            return {"outcome": "succeeded", "detail": "ok", "verification": {"passed": True},
                    "output": {"exitCode": 0, "stdout": "added 1 package"}}
        return real(cap, payload, ctx, cfg)

    monkeypatch.setattr("aura.fabric.invoke_fabric", fake)
    result, sid = agent.execute_handoff(handoff_plan(), project_id="p", project_path=str(project))
    assert result.outcome == "completed", result.summary
    assert all((project / f).exists() for f in ("needs.md", "free.md", "after.md"))
    assert [t["nodeId"] for t in result.report["toolsInstalled"]] == ["pnpm"]
    stages = [e.payload["stage"] for e in agent.bus.tail if e.sessionId == sid and e.type == "tool.provisioning"]
    assert stages == ["checking", "installing", "installed"]


def test_a_tool_already_on_the_machine_is_reused_not_reinstalled(agent_and_project, monkeypatch):
    agent, project = agent_and_project
    monkeypatch.setattr("aura.environment.probe.probe_node",
                        lambda node_id, refresh=False: SimpleNamespace(present=True, version="8.0.0", detail=""))
    result, sid = agent.execute_handoff(handoff_plan(), project_id="p", project_path=str(project))
    assert result.outcome == "completed"
    assert [t["nodeId"] for t in result.report["toolsReused"]] == ["pnpm"] and result.report["toolsInstalled"] == []
    assert "installing" not in [e.payload["stage"] for e in agent.bus.tail if e.sessionId == sid and e.type == "tool.provisioning"]
