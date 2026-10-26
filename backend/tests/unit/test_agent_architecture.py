"""Laya plans, selects and triggers; the connected coding agents write the code.

Mocks only: no real agent is started. These run under the product's real defaults
(AURA's own model writes nothing; unknown-billing workers are denied).
"""
from __future__ import annotations

import json

import pytest

from aura.central_agent import plan_handoff as ph
from test_cancellation import _ok
from test_stopped_mission_view import _agent

pytestmark = [pytest.mark.real_agent_architecture, pytest.mark.real_billing_policy]

NODES = [
    {"id": "opencode", "name": "OpenCode", "binary": "opencode", "capabilities": ["coding-agent"]},
    {"id": "kilo-code", "name": "Kilo Code", "binary": "kilo", "capabilities": ["coding-agent"]},
    {"id": "claude-code", "name": "Claude Code", "binary": "claude", "capabilities": ["coding-agent"]},
]


def task(tid, title, target=None, deps=(), worker=None, desc=""):
    return {"id": tid, "title": title, "description": desc, "targetFile": target, "files": [target] if target else [],
            "dependsOn": list(deps), "worker": worker, "requires": [], "expectedOutput": "", "verification": ""}


def handoff(*tasks):
    return {"source": "planner", "planId": "p1", "revision": 1, "goal": "music player", "tasks": list(tasks),
            "acceptance": [], "context": None}


OC = {"id": "opencode", "name": "OpenCode"}
KC = {"id": "kilo-code", "name": "Kilo Code"}


# ── selection (pure) ─────────────────────────────────────────────────────
def test_frontend_work_goes_to_kilo_and_backend_work_to_opencode_with_reasons():
    h = handoff(task("a", "Audio engine and library state", "player.js", desc="queue, storage, playback logic"),
                task("b", "Build the interface", "index.html", desc="page markup and styling"))
    out = ph.select_workers(h, [OC, KC], [])
    assert [t["worker"] for t in out["handoff"]["tasks"]] == ["opencode", "kilo-code"]
    assert all(s["reason"] and s["candidates"] == ["opencode", "kilo-code"] for s in out["selections"])


def test_with_one_agent_available_the_two_agent_or_one_agent_workflow_is_used():
    h = handoff(task("a", "Engine", "player.js"), task("b", "Interface", "index.html"))
    out = ph.select_workers(h, [OC], [])
    assert {t["worker"] for t in out["handoff"]["tasks"]} == {"opencode"}


def test_tasks_run_one_at_a_time_in_plan_order():
    out = ph.select_workers(handoff(task("a", "Engine", "a.py"), task("b", "UI", "b.html"), task("c", "Tests", "c.py")), [OC, KC], [])
    deps = {t["id"]: t["dependsOn"] for t in out["handoff"]["tasks"]}
    assert deps == {"a": [], "b": ["a"], "c": ["b"]}


def test_a_named_worker_is_respected_and_not_reassigned():
    out = ph.select_workers(handoff(task("a", "Engine", "a.py", worker="kilo-code")), [OC, KC], [])
    assert out["handoff"]["tasks"][0]["worker"] == "kilo-code" and out["selections"] == []


def test_no_available_agent_is_a_blocker_that_names_every_denied_agent_not_a_silent_fallback():
    blocked = [{"id": "claude-code", "reason": "not allowed by the owner's worker policy (billable)"},
               {"id": "opencode", "reason": "not allowed by the owner's worker policy (unknown)"}]
    with pytest.raises(ph.HandoffError) as e:
        ph.select_workers(handoff(task("a", "Engine", "a.py")), [], blocked)
    assert e.value.code == "unavailable"
    msg = str(e.value)
    assert "claude-code" in msg and "opencode" in msg and "does not write the application itself" in msg


def test_the_planning_model_does_not_author_files_by_default():
    assert ph.authoring_allowed() is False
    assert ph.aura_authored(task("a", "x", "a.py")) is False and ph.needs_selection(task("a", "x", "a.py")) is True


def test_authoring_is_an_explicit_owner_opt_in_only(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    (tmp_path / "worker-policy.json").write_text(json.dumps({"allowAuraAuthoring": True}))
    assert ph.authoring_allowed() is True
    (tmp_path / "worker-policy.json").write_text(json.dumps({"allowAuraAuthoring": "yes"}))
    assert ph.authoring_allowed() is False                    # only the literal true


# ── through the real Central Agent ───────────────────────────────────────
@pytest.fixture()
def agent(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    from aura.executors import all_executors

    a = _agent(tmp_path)
    for ex in all_executors(None):
        a.fabric_cfg.fabric.register(ex)
    return a


@pytest.fixture()
def project(tmp_path):
    p = tmp_path / "proj"
    p.mkdir()
    return p


def plan():
    return {"source": "planner", "planId": "m1", "revision": 1, "goal": "Build a music player",
            "tasks": [{"id": "t1", "title": "Audio engine", "description": "", "targetFile": "player.js", "files": [], "dependsOn": [], "worker": None},
                      {"id": "t2", "title": "Interface", "description": "", "targetFile": "index.html", "files": [], "dependsOn": [], "worker": None}]}


def test_a_plan_no_agent_may_run_is_refused_before_anything_starts_and_nothing_is_written(agent, project, monkeypatch):
    monkeypatch.setattr(type(agent.controller), "_present_nodes", lambda self: NODES)
    from aura.central_agent.plan_handoff import HandoffError

    with pytest.raises(HandoffError) as e:
        agent.execute_handoff(plan(), project_id="p", project_path=str(project))
    assert e.value.code == "unavailable" and "worker-policy.json" in str(e.value)
    assert list(project.iterdir()) == []                      # the planning model wrote nothing


def test_laya_selects_allowed_agents_triggers_them_in_order_and_each_runs_only_after_the_previous(agent, project, monkeypatch, tmp_path):
    (tmp_path / "home").mkdir(exist_ok=True)
    # The harness's fabric knows kilo-code and claude-code; the owner allows exactly those two.
    (tmp_path / "home" / "worker-policy.json").write_text(json.dumps({"authorized": ["claude-code", "kilo-code"]}))
    monkeypatch.setattr(type(agent.controller), "_present_nodes", lambda self: NODES)
    monkeypatch.setattr(type(agent.controller), "_role_usable", lambda self, cap: (lambda n: True))
    calls: list[tuple[str, str]] = []

    def fake_invoke(cap, payload, context, cfg):
        calls.append((context["taskId"], payload.get("nodeId") or context.get("nodeId") or ""))
        return _ok(f"inv-{context['taskId']}", context.get("nodeId") or "opencode")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    agent.planner._known_nodes = lambda: {n["id"] for n in NODES}      # the nodes the fabric would report
    result, sid = agent.execute_handoff(plan(), project_id="p", project_path=str(project))
    assert result.outcome == "completed", (result.outcome, result.summary, [(e.type, str(e.payload)[:120]) for e in agent.bus.tail if e.sessionId == sid][-6:])
    events = [e for e in agent.bus.tail if e.sessionId == sid]
    picks = [e.payload for e in events if e.type == "worker.selected"]
    assert [(p["taskId"], p["worker"]) for p in picks] == [("t1", "kilo-code"), ("t2", "kilo-code")]   # opencode is not connected here; claude-code is a worse fit and never preferred
    assert all(p["reason"] for p in picks)
    assert [c[0] for c in calls] == ["t1", "t2"]                # strictly ordered
    assert not any(e.type == "task.authored" for e in events)    # Laya wrote no file
    assert list(project.iterdir()) == []                         # (the mocked agents wrote nothing either)


def test_claude_code_is_never_selected_without_owner_authorization(agent, project, monkeypatch, tmp_path):
    (tmp_path / "home").mkdir(exist_ok=True)
    (tmp_path / "home" / "worker-policy.json").write_text(json.dumps({"authorized": ["opencode"]}))
    monkeypatch.setattr(type(agent.controller), "_present_nodes", lambda self: NODES)
    monkeypatch.setattr(type(agent.controller), "_role_usable", lambda self, cap: (lambda n: True))
    cands, denied = agent._agent_candidates()
    assert [c["id"] for c in cands] == ["opencode"]
    assert {d["id"] for d in denied} == {"kilo-code", "claude-code"}


def test_selection_follows_the_preference_order_not_catalogue_order():
    h = handoff(task("a", "Audio engine and library state", "src/player.js"))
    out = ph.select_workers(h, [KC, OC], [])            # kilo listed first in the catalogue
    assert out["handoff"]["tasks"][0]["worker"] == "opencode"   # backend work prefers opencode


def test_the_kind_comes_from_the_title_and_files_not_from_the_long_brief():
    long_brief = "index.html styles.css ui page layout frontend " * 20       # names every part of the project
    t = task("a", "Audio engine, library, queue and playlists", "src/player.js", desc=long_brief)
    assert ph.classify_task(t) == "backend"


def test_a_laya_selected_agent_is_not_a_pin_the_retry_moves_to_another_agent():
    from aura.central_agent.planner import TaskPlanner  # noqa: F401  (import check)

    h = ph.select_workers(handoff(task("a", "Audio engine", "src/player.js")), [OC, KC], [])["handoff"]
    entry = ph.build_proposal(h, {})["tasks"][0]
    assert entry["workerChoice"] == "selected" and entry["nodeId"] == "opencode"
    named = ph.build_proposal(handoff(task("a", "Audio engine", "src/player.js", worker="kilo-code")), {})["tasks"][0]
    assert named["workerChoice"] == "named"
