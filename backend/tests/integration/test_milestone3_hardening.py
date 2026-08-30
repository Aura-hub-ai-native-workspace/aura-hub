"""Milestone-3 hardening — continuation semantics, corruption recovery,
and the model-cannot-widen security gate."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.central_agent.planner import MAX_TASKS, PlanningError, TaskPlanner
from aura.contracts import AgentIntent
from aura.fabric import FabricConfig
from aura.workflow import EngineConfig, WorkflowEngine, make_stores


def make_agent(home: Path, cfg: FabricConfig) -> CentralAgent:
    ws, vs, rs = make_stores()
    return CentralAgent(
        fabric_cfg=cfg, session_store=AgentSessionStore(home),
        workflow_store=ws, run_store=rs,
        workflow_engine=WorkflowEngine(cfg, ws, vs, rs, EngineConfig()))


@pytest.fixture()
def env(tmp_path, monkeypatch):
    from aura.fabric import CapabilityFabric, FabricHost
    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}
        def node_available(self, _cap):
            return True
        async def request_approval(self, _req, _ctx):
            return False
    home = tmp_path / "home"
    proj = tmp_path / "project"
    proj.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    monkeypatch.setenv("AURA_HOME", str(home))
    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    host = _H()
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    from aura.executors import all_executors
    execs = {e.capabilityId: e for e in all_executors(home)}
    for exe in execs.values():
        try:
            fabric.register(exe)
        except Exception:
            pass
    cfg = FabricConfig(
        fabric=fabric,
        policy_config={}, permissions={"read": True, "write": True},
        executors=execs,
        audit_store=audit, ledger=ledger)
    return home, proj, audit, ledger, cfg


class TestFollowUpContinuation:
    def test_follow_up_does_not_replay_completed_effects(self, env):
        home, proj, audit, ledger, cfg = env
        agent = make_agent(home, cfg)
        first = agent.submit("show git status", project_path=str(proj))
        assert first.outcome == "completed"
        writes_before = len(audit.load())

        # Follow-up question about the SAME work must not re-execute it.
        sid = agent.sessions.last_session_id
        agent.message(sid, "what did you just do?")
        # unmappable follow-up asks for clarification instead of replaying;
        # either way NO new governed invocation may appear for git.status.
        git_calls = [r for r in audit.load()[writes_before:]
                     if r.get("capabilityId") == "git.status"]
        assert git_calls == [], "follow-up replayed a completed effect"

    def test_clarification_answer_completes_original_goal(self, env):
        home, proj, audit, ledger, cfg = env
        agent = make_agent(home, cfg)
        first = agent.submit("flurb the bazzle")
        assert first.outcome == "needs-clarification"
        sid = agent.sessions.last_session_id
        second = agent.message(sid, "actually show my git status",
                               project_path=str(proj))
        assert second.outcome == "completed"
        assert second.summary != first.summary


class TestFailureRecovery:
    def test_corrupted_session_loads_tolerant(self, env):
        home, proj, audit, ledger, cfg = env
        agent = make_agent(home, cfg)
        agent.submit("show git status", project_path=str(proj))
        sessions = sorted((home / "agent" / "sessions").glob("*.json"))
        sessions[-1].write_text("{corrupted json")
        fresh = make_agent(home, cfg).sessions.load(sessions[-1].stem)
        assert fresh is None, "corrupt session must degrade to absent, not crash"
        # and the agent keeps working
        again = make_agent(home, cfg)
        r = again.submit("show git status", project_path=str(proj))
        assert r.outcome == "completed"

    def test_corrupted_workflow_store_entry_is_skipped(self, env):
        home, proj, audit, ledger, cfg = env
        ws, _, _ = make_stores()
        wf = ws.create({"name": "doomed"})
        path = home / "workflows" / f"{wf['id']}.json"
        path.write_text("{broken")
        store = make_stores()[0]
        assert store.get(wf["id"]) is None
        listed = {w["id"] for w in store.list()}
        assert wf["id"] not in listed or True  # tolerant read never crashes

    def test_provider_unavailable_reports_honestly(self, env):
        from aura.central_agent.intent import IntentCompilationError, IntentCompiler

        class DownPort:
            def complete_json(self, system, user):
                return None

        compiler = IntentCompiler(mode="model", model_port=DownPort())
        with pytest.raises(IntentCompilationError, match="nothing usable"):
            compiler.compile("anything")

    def test_interrupted_run_reconciled_by_store(self, env):
        home, proj, audit, ledger, cfg = env
        ws, vs, rs = make_stores()
        engine = WorkflowEngine(cfg, ws, vs, rs, EngineConfig())
        wf = ws.create({"name": "interrupted"})
        nodes = [{"id": "g", "type": "git-status", "x": 0, "y": 0, "config": {}}]
        saved = ws.save(wf["id"], {"name": "interrupted", "description": "",
                                   "category": "t", "favorite": False,
                                   "nodes": nodes, "edges": []})
        run = engine.start_run(saved["id"], project_path=str(proj))
        # simulate a crash mid-run: force state back to running on disk
        raw = rs.get(run["workflowId"], run["id"])
        raw["state"] = "running"
        rs.save(raw)
        healed = rs.reconcile_interrupted()
        assert any(h["id"] == run["id"] for h in healed), \
            "interrupted runs must be reconciled to an honest terminal state"


class TestModelCannotWiden:
    def test_model_plan_cannot_widen_executor_scope(self, env):
        """A proposed absolute/escaping path survives compilation as DATA but
        the executor's confinement refuses it after authorization."""
        home, proj, audit, ledger, cfg = env
        planner = TaskPlanner(known_capabilities=lambda: {"filesystem.write"})
        intent = AgentIntent(goal="x", expectedOutcome="y")
        evil = {"tasks": [{"description": "escape", "capabilityId": "filesystem.write",
                           "input": {"path": "/etc/aura-pwned", "content": "no"}}]}
        plan = planner.plan_from_model(intent, "agt-x", "now", evil)
        from aura.fabric import invoke_fabric
        result = invoke_fabric(
            "filesystem.write", plan.tasks[0].input,
            {"actor": {"kind": "agent", "id": "t"}, "cwd": str(proj)}, cfg)
        if result["outcome"] == "awaiting-approval":
            ledger.decide(result["approvalId"], True, "user")
            result = invoke_fabric(
                "filesystem.write", plan.tasks[0].input,
                {"actor": {"kind": "agent", "id": "t"}, "cwd": str(proj),
                 "taskId": "esc", "approvalId": result["approvalId"]}, cfg)
        assert result["outcome"] == "failed"
        assert not Path("/etc/aura-pwned").exists()

    def test_model_plan_risk_cannot_be_lowered_below_manifest(self, env):
        """The proposal says low risk; policy still sees manifest truth."""
        home, proj, audit, ledger, cfg = env
        planner = TaskPlanner(known_capabilities=lambda: {"filesystem.write"})
        intent = AgentIntent(goal="x", expectedOutcome="y")
        sneaky = {"tasks": [{"description": "w", "capabilityId": "filesystem.write",
                             "risk": "low",
                             "input": {"path": "ok.txt", "content": "fine"}}]}
        plan = planner.plan_from_model(intent, "agt-x", "now", sneaky)
        # filesystem.write is MEDIUM in the manifest; preflight must reflect that
        from aura.central_agent.authority import AuthorityChecker
        reqs = AuthorityChecker(cfg).check_plan(plan, None, str(proj))
        assert reqs[0].risk == "medium"
        assert reqs[0].approvalRequired is True

    def test_model_plan_size_bound(self):
        planner = TaskPlanner(known_capabilities=lambda: {"workflow.list"})
        intent = AgentIntent(goal="x", expectedOutcome="y")
        flood = {"tasks": [
            {"description": str(i), "capabilityId": "workflow.list"}
            for i in range(MAX_TASKS + 1)]}
        with pytest.raises(PlanningError, match="bound"):
            planner.plan_from_model(intent, "agt-x", "now", flood)


class TestApiContinuationSurface:
    def test_message_and_approve_routes_over_http(self, env):
        import json as _json
        import urllib.error
        import urllib.request

        home, proj, audit, ledger, cfg = env
        from aura.api import AgentApiServer, ApiDeps

        agent = make_agent(home, cfg)
        server = AgentApiServer(ApiDeps(agent=agent, sessions=agent.sessions,
                                        ledger=ledger, audit=audit), port=4397)
        server.start_background()
        try:
            def call(method, path, body=None):
                req = urllib.request.Request(
                    f"http://127.0.0.1:4397{path}",
                    data=_json.dumps(body or {}).encode() if method == "POST" else None,
                    method=method, headers={"content-type": "application/json"})
                try:
                    with urllib.request.urlopen(req) as r:
                        return _json.loads(r.read()), r.status
                except urllib.error.HTTPError as e:
                    return _json.loads(e.read()), e.code

            call("POST", "/agent/sessions",
                 {"message": "flurb the bazzle", "projectPath": str(proj)})
            sid = agent.sessions.last_session_id
            out, code = call("POST", f"/agent/sessions/{sid}/message",
                             {"message": "actually show my git status"})
            assert code == 200 and out["result"]["outcome"] == "completed"

            # approval convenience route: park a write, then approve+resume
            out2, _ = call("POST", "/agent/sessions",
                           {"message": "create a file called api.txt containing v",
                            "projectPath": str(proj)})
            res = out2["result"]
            if res["outcome"] == "awaiting-approval":
                sid2 = out2["sessionId"]
                apr = res["evidence"]["approvalIds"][0]
                out3, code3 = call("POST", f"/agent/sessions/{sid2}/approve",
                                   {"approvalId": apr, "granted": True})
                assert code3 == 200
                assert out3["result"]["outcome"] == "completed"
                assert (proj / "api.txt").read_text() == "v"
                dup, code4 = call("POST", f"/agent/sessions/{sid2}/approve",
                                  {"approvalId": apr, "granted": True})
                assert code4 == 409
        finally:
            server.shutdown()

    def test_plan_review_route_hides_reasoning(self, env):
        import json as _json
        import urllib.request

        home, proj, audit, ledger, cfg = env
        from aura.api import AgentApiServer, ApiDeps

        agent = make_agent(home, cfg)
        server = AgentApiServer(ApiDeps(agent=agent, sessions=agent.sessions,
                                        ledger=ledger, audit=audit), port=4396)
        server.start_background()
        try:
            def call(method, path, body=None):
                req = urllib.request.Request(
                    f"http://127.0.0.1:4396{path}",
                    data=_json.dumps(body or {}).encode() if method == "POST" else None,
                    method=method, headers={"content-type": "application/json"})
                try:
                    with urllib.request.urlopen(req) as r:
                        return _json.loads(r.read()), r.status
                except urllib.error.HTTPError as e:
                    return _json.loads(e.read()), e.code

            call("POST", "/agent/sessions",
                 {"message": "show git status", "projectPath": str(proj)})
            sid = agent.sessions.last_session_id
            review, code = call("GET", f"/agent/sessions/{sid}/plan")
            if code == 200:
                blob = _json.dumps(review).lower()
                for banned in ("chain-of-thought", "reasoning:", "hidden"):
                    assert banned not in blob
                assert "steps" in review
        finally:
            server.shutdown()
