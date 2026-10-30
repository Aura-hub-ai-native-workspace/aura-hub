"""What Workspace shows is measured, not narrated.

A fake worker really writes files into a temporary project, so the change
observer measures them; task state events, handoffs and the completion
report are checked against what actually happened — including the cases
where the honest report is "not done".
"""

from __future__ import annotations

import pytest

from aura.central_agent.change_observer import diff, snapshot
from test_cancellation import _ok
from test_stopped_mission_view import MISSION, _agent


@pytest.fixture()
def project(tmp_path):
    root = tmp_path / "proj"
    (root / "alpha").mkdir(parents=True)
    (root / "alpha" / "a.txt").write_text("alpha A.\n")
    (root / "keep.md").write_text("keep\n")
    return root


def events(agent, sid):
    return [e for e in agent.bus.tail if e.sessionId == sid]


def last_sid(agent):
    return next(e.sessionId for e in reversed(agent.bus.tail))


def worker(root, writes_by_node, fail_nodes=(), tests=None):
    calls = []

    def invoke(cap, payload, context, cfg):
        node = context.get("nodeId") or "claude-code"
        calls.append(node)
        if node in fail_nodes:
            return {"invocationId": f"inv-{len(calls)}", "outcome": "failed",
                    "detail": "You've hit your usage limit for this session.",
                    "verification": {"passed": None, "kind": "exit-code", "detail": ""},
                    "policy": {"decision": "auto-execute", "rule": "r", "risk": "high", "reason": ""},
                    "at": "2026-10-20T00:00:00Z",
                    "output": {"stdout": "", "exitCode": 1, "nodeId": node, "agent": node}}
        for rel, text in writes_by_node.get(node, {}).items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        res = _ok(f"inv-{len(calls)}", node, stdout="done")
        if tests:
            res["output"]["governedActions"] = {"events": tests}
        return res
    invoke.calls = calls
    return invoke


# ── the observer itself ──────────────────────────────────────────────────

def test_observer_reports_created_modified_and_deleted(tmp_path):
    (tmp_path / "a.txt").write_text("1")
    (tmp_path / "gone.txt").write_text("x")
    (tmp_path / "node_modules").mkdir()
    before = snapshot(tmp_path)
    (tmp_path / "a.txt").write_text("22")
    (tmp_path / "new.txt").write_text("n")
    (tmp_path / "gone.txt").unlink()
    (tmp_path / "node_modules" / "junk.js").write_text("ignored")
    (tmp_path / ".aura").mkdir()
    (tmp_path / ".aura" / "note.md").write_text("ignored")
    changes, complete = diff(before, snapshot(tmp_path))
    assert changes == [{"path": "a.txt", "op": "modified"}, {"path": "gone.txt", "op": "deleted"},
                       {"path": "new.txt", "op": "created"}]
    assert complete is True


def test_observer_does_not_follow_symlinks_out_of_the_project(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    root = tmp_path / "proj"
    root.mkdir()
    try:
        (root / "link").symlink_to(outside)
    except (OSError, NotImplementedError) as exc:   # a privilege, not a platform: Windows needs Developer Mode or admin
        pytest.skip(f"this account cannot create symlinks ({exc})")
    assert "link/secret.txt" not in snapshot(root).files and snapshot(root).files == {}


def test_a_missing_folder_is_not_observed():
    assert snapshot("/definitely/not/here") is None
    assert diff(None, None) == ([], False)


# ── through the real agent ───────────────────────────────────────────────

def test_changes_are_measured_task_states_are_real_and_the_report_matches(tmp_path, monkeypatch, project):
    import aura.central_agent.execution as ex
    agent = _agent(tmp_path)
    invoke = worker(project, {"claude-code": {"out/claude.txt": "from claude"},
                              "kilo-code": {"out/kilo.txt": "from kilo", "keep.md": "changed\n"}},
                    tests=[{"taskId": "delegate-claude", "workerNodeId": "claude-code",
                            "command": "pytest -q tests", "decision": "ALLOW"}])
    monkeypatch.setattr(ex, "invoke_fabric", invoke)
    result = agent.submit(MISSION, project_id="p", project_path=str(project))
    sid = last_sid(agent)
    assert result.outcome == "completed", result.summary
    rep = result.report
    paths = {(c["path"], c["op"]) for c in rep["filesChanged"]}
    assert ("out/claude.txt", "created") in paths and ("out/kilo.txt", "created") in paths
    assert ("keep.md", "modified") in paths
    assert all(c["verified"] and c["worker"] for c in rep["filesChanged"])  # attributed and verified
    assert (project / "out" / "claude.txt").read_text() == "from claude"  # it really is on disk
    assert {w["taskId"] for w in rep["workCompleted"]} == {"delegate-claude", "delegate-kilo"}
    assert rep["unfinished"] == [] and rep["errors"] == []
    # test commands are reported as the worker's own record, not as AURA-verified results
    assert rep["testsObserved"] and rep["testsObserved"][0]["command"] == "pytest -q tests"
    assert any("not their results" in l for l in rep["limitations"])
    # per-task states arrive as running → verified, in order, for each task
    states = [(e.payload["taskId"], e.payload["state"]) for e in events(agent, sid) if e.type == "task.state"]
    for tid in ("delegate-claude", "delegate-kilo"):
        mine = [s for t, s in states if t == tid]
        assert mine[0] == "running" and mine[-1] == "verified"
    changed = [e for e in events(agent, sid) if e.type == "files.changed"]
    assert {e.payload["worker"] for e in changed} == {"claude-code", "kilo-code"}
    assert "verification.started" in [e.type for e in events(agent, sid)]


def test_a_quota_handoff_is_announced_and_keeps_what_was_done(tmp_path, monkeypatch, project):
    import aura.central_agent.execution as ex
    agent = _agent(tmp_path)
    invoke = worker(project, {"kilo-code": {"out/kilo.txt": "k"}}, fail_nodes={"claude-code"})
    monkeypatch.setattr(ex, "invoke_fabric", invoke)
    result = agent.submit(MISSION, project_id="p", project_path=str(project))
    sid = last_sid(agent)
    assert result.outcome == "completed", result.summary
    handoffs = [e for e in events(agent, sid) if e.type == "worker.handoff"]
    assert handoffs and handoffs[0].payload["fromWorker"] == "claude-code"
    assert handoffs[0].payload["toWorker"] == "kilo-code" and "quota" in handoffs[0].payload["reason"]
    assert result.report["handoffs"][0]["toNode"] == "kilo-code"
    assert result.report["errors"] and result.report["errors"][0]["status"] == "resolved"


def test_a_run_that_did_not_finish_says_so_and_claims_nothing_done(tmp_path, monkeypatch, project):
    import aura.central_agent.execution as ex
    agent = _agent(tmp_path)
    monkeypatch.setattr(ex, "invoke_fabric", worker(project, {}, fail_nodes={"claude-code", "kilo-code"}))
    result = agent.submit(MISSION, project_id="p", project_path=str(project))
    assert result.outcome != "completed"
    rep = result.report
    assert rep["workCompleted"] == [] and rep["unfinished"]
    assert any("not verified complete" in l for l in rep["limitations"])
    assert rep["filesChanged"] == []  # nothing changed, so none is claimed
    assert all(e["status"] != "resolved" for e in rep["errors"])


def test_chat_results_carry_no_work_report(tmp_path, project):
    agent = _agent(tmp_path)
    result, _ = agent.chat("hello", project_id="p", project_path=str(project))
    assert result.report is None
