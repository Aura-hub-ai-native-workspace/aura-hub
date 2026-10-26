"""Planner → Workspace handoff: the plan arrives whole and runs now.

A plan handed over from the Planner becomes the same validated TaskPlan a
typed Workspace request would, and runs through the same dispatch:
discovery, authority, the coordinator, verification. These tests pin:

  * the actual tasks, dependencies, files and workers arrive intact;
  * AURA-written files are authored inside the run and really written
    (real Fabric, read-back verified) — no coding agent is involved;
  * a chosen worker is delegated to, scoped to the task's files;
  * the same plan revision cannot start twice;
  * a plan Workspace cannot carry out is refused before anything starts.
"""

from __future__ import annotations

import pytest

from aura.central_agent.plan_handoff import HandoffError, validate_handoff
from test_cancellation import _ok
from test_stopped_mission_view import _agent


class _Port:
    """A model port that writes deterministic file contents."""

    providers = ()

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def complete_stream(self, system, user, on_token=None, should_stop=None):
        self.prompts.append(user)
        path = user.rsplit("Write the full contents of ", 1)[1].split(" now.")[0]
        return f"```\n# {path}\nwritten for the plan\n```"


def _plan(**over):
    plan = {
        "source": "planner", "planId": "mission-abc", "revision": 1,
        "goal": "Add a short NOTES.md file",
        "tasks": [{"id": "t1", "title": "Create NOTES.md",
                   "description": "A short notes file for the project.",
                   "targetFile": "NOTES.md", "files": [], "dependsOn": [],
                   "worker": None}],
    }
    plan.update(over)
    return plan


@pytest.fixture()
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "README.md").write_text("# proj\n")
    return root


@pytest.fixture()
def agent(tmp_path):
    from aura.executors import all_executors

    agent = _agent(tmp_path)
    # The real executors, so an AURA-written file is truly written and read
    # back by the Fabric (the shared helper leaves the Fabric bare).
    for executor in all_executors(None):
        agent.fabric_cfg.fabric.register(executor)
    agent.intents.model_port = _Port()
    return agent


def test_an_aura_written_task_is_authored_and_really_written(agent, project):
    result, sid = agent.execute_handoff(_plan(), project_id="p",
                                        project_path=str(project))
    assert result.outcome == "completed", result.summary
    assert (project / "NOTES.md").read_text() == "# NOTES.md\nwritten for the plan\n"
    session = agent.sessions.load(sid)
    assert session.mode == "work"
    assert session.origin == {"source": "planner", "planId": "mission-abc", "revision": 1}
    types = [e.type for e in agent.bus.tail if e.sessionId == sid]
    assert types.index("plan.received") < types.index("task.authored") \
        < types.index("execution.started")
    assert not any(t.startswith("plan.awaiting") or t == "approval.required" for t in types)


def test_the_whole_plan_arrives_and_runs_in_dependency_order(agent, project, monkeypatch):
    calls: list[tuple[str, dict]] = []

    def fake_invoke(cap, payload, context, cfg):
        calls.append((cap, dict(payload)))
        return _ok(f"inv-{context['taskId']}", "claude-code")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    plan = _plan(goal="Add a parser and its tests", tasks=[
        # Listed out of order on purpose: dependencies decide execution order.
        {"id": "tests", "title": "Write parser tests", "description": "Cover edge cases.",
         "targetFile": None, "files": ["tests/test_parser.py"], "dependsOn": ["impl"],
         "worker": "claude-code"},
        {"id": "impl", "title": "Implement the parser", "description": "Tokenise, then parse.",
         "targetFile": None, "files": ["src/parser.py"], "dependsOn": [],
         "worker": "kilo-code"},
    ])
    result, sid = agent.execute_handoff(plan, project_id="p", project_path=str(project))
    assert result.outcome == "completed", result.summary
    assert [c[0] for c in calls] == ["agent.delegate", "agent.delegate"]
    first, second = calls[0][1], calls[1][1]
    assert first["task"].startswith("Implement the parser\n\nTokenise, then parse.")
    assert "src/parser.py" in first["task"]
    assert second["task"].startswith("Write parser tests")
    plan_event = next(e for e in agent.bus.tail
                      if e.sessionId == sid and e.type == "plan.received")
    assert [t["id"] for t in plan_event.payload["tasks"]] == ["impl", "tests"]
    assert plan_event.payload["tasks"][1]["dependsOn"] == ["impl"]
    active = agent.sessions.load(sid).activePlan
    workers = [t.get("nodeId") for t in active["tasks"]]
    assert workers == ["kilo-code", "claude-code"]


def test_the_same_plan_revision_cannot_start_twice(agent, project):
    agent.execute_handoff(_plan(), project_id="p", project_path=str(project))
    with pytest.raises(HandoffError) as err:
        agent.execute_handoff(_plan(), project_id="p", project_path=str(project))
    assert err.value.code == "duplicate"
    assert err.value.extra["sessionId"].startswith("agt-")
    # An edited plan is a new revision, and may run.
    (project / "NOTES.md").unlink()
    result, _ = agent.execute_handoff(_plan(revision=2), project_id="p",
                                      project_path=str(project))
    assert result.outcome == "completed"


def test_a_reused_session_id_is_refused(agent, project):
    _r, sid = agent.chat("hello", project_id="p")
    with pytest.raises(HandoffError) as err:
        agent.execute_handoff(_plan(), session_id=sid, project_id="p",
                              project_path=str(project))
    assert err.value.code == "duplicate"
    assert agent.sessions.load(sid).mode == "chat"


def test_without_a_model_aura_cannot_author_and_nothing_starts(agent, project):
    agent.intents.model_port = None
    before = set((project.parent / "agent").rglob("*.json")) if (project.parent / "agent").exists() else set()
    with pytest.raises(HandoffError) as err:
        agent.execute_handoff(_plan(), project_id="p", project_path=str(project))
    assert err.value.code == "unavailable"
    assert not (project / "NOTES.md").exists()
    after = set((project.parent / "agent").rglob("*.json")) if (project.parent / "agent").exists() else set()
    assert after == before  # no session was created


@pytest.mark.parametrize("tasks, message", [
    ([], "no tasks"),
    ([{"id": "t1", "title": "Think about it", "targetFile": None, "worker": None}],
     "no target file and no worker"),
    ([{"id": "a", "title": "A", "targetFile": "a.md", "dependsOn": ["b"]},
      {"id": "b", "title": "B", "targetFile": "b.md", "dependsOn": ["a"]}], "cycle"),
    ([{"id": "a", "title": "A", "targetFile": "a.md", "dependsOn": ["zz"]}], "unknown task"),
    ([{"id": "a", "title": "A", "targetFile": "../outside.md"}], "inside the project"),
    ([{"id": "a", "title": "A", "targetFile": "/etc/passwd"}], "relative to the project"),
    ([{"id": "a", "title": "A", "targetFile": "x.md"},
      {"id": "b", "title": "B", "targetFile": "x.md"}], "more than one"),
])
def test_unactionable_plans_are_refused_before_anything_runs(tasks, message):
    with pytest.raises(HandoffError) as err:
        validate_handoff(_plan(tasks=tasks))
    assert err.value.code == "invalid"
    assert message in str(err.value)


def test_http_route_refuses_bad_plans_and_duplicates(agent, project, monkeypatch, tmp_path):
    from starlette.applications import Starlette
    from starlette.testclient import TestClient

    import aura.api.server as server

    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    app = server.create_api_server()
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/agent/plans/execute" in paths
    assert isinstance(app, Starlette)
    client = TestClient(app)
    r = client.post("/agent/plans/execute", json={"plan": _plan(), "projectPath": ""})
    assert r.status_code == 400 and "projectPath" in r.json()["error"]
    r = client.post("/agent/plans/execute",
                    json={"plan": _plan(tasks=[]), "projectPath": str(project)})
    assert r.status_code == 400 and r.json()["code"] == "invalid"


# ── acceptance, context and per-task expectations ─────────────────────────

def rich_plan():
    return _plan(
        planId="plan-rich", goal="Add a parser with tests",
        acceptance=["parser.py parses the sample input", "tests pass"],
        context={"text": "Decision: use recursive descent. Rejected: regex-only.", "scope": "p",
                 "sources": [{"title": "Parsing 101", "url": "https://example.test/parsing"},
                             {"title": "bad", "url": "javascript:alert(1)"}]},
        tasks=[{"id": "impl", "title": "Implement the parser", "description": "Tokenise then parse.",
                "targetFile": None, "files": ["src/parser.py"], "dependsOn": [], "worker": "claude-code",
                "expectedOutput": "src/parser.py exposes parse(text)", "verification": "pytest tests/test_parser.py exits 0",
                "requires": []}])


def test_workers_receive_expected_output_verification_acceptance_and_fenced_context(agent, project, monkeypatch):
    calls = []

    def fake(cap, payload, context, cfg):
        calls.append(dict(payload))
        return _ok("inv-1", "claude-code")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake)
    result, sid = agent.execute_handoff(rich_plan(), project_id="p", project_path=str(project))
    assert result.outcome == "completed", result.summary
    task = calls[0]["task"]
    assert "Expected output: src/parser.py exposes parse(text)" in task
    assert "How it will be checked: pytest tests/test_parser.py exits 0" in task
    assert "parser.py parses the sample input; tests pass" in task
    assert calls[0]["context"].startswith('<untrusted-data kind="plan-context">')
    assert "recursive descent" in calls[0]["context"]
    # the plan's own acceptance is reported as stated, never as verified
    assert result.report["acceptanceStated"] == ["parser.py parses the sample input", "tests pass"]
    assert any("not each sentence" in l for l in result.report["limitations"])


def test_the_plan_and_its_research_are_remembered_for_later_work(agent, project):
    agent.execute_handoff(_plan(planId="plan-mem", context={
        "text": "x", "scope": "p", "sources": [{"title": "T", "url": "https://example.test/a"}]}),
        project_id="p", project_path=str(project))
    plan = agent.shared_context.get("p", "plan:plan-mem")
    assert plan["kind"] == "plan" and plan["planId"] == "plan-mem" and "NOTES.md" in plan["body"]
    research = agent.shared_context.get("p", "plan-research:plan-mem")
    assert [r["url"] for r in research["refs"]] == ["https://example.test/a"]
    # a later turn retrieves it
    got = agent.shared_context.retrieve("p", "NOTES.md plan", plan_id="plan-mem")
    assert any(r["kind"] == "plan" for r in got)


@pytest.mark.parametrize("patch, message", [
    ({"acceptance": ["x"] * 13}, "at most 12"),
    ({"acceptance": "not a list"}, "at most 12"),
    ({"context": "nope"}, "must be an object"),
    ({"tasks": [{"id": "t", "title": "T", "targetFile": "a.md", "expectedOutput": "x" * 700}]}, "longer than 600"),
])
def test_the_extended_fields_are_validated(patch, message):
    with pytest.raises(HandoffError) as err:
        validate_handoff(_plan(**patch))
    assert message in str(err.value)


def test_unsafe_source_urls_are_dropped_not_trusted():
    out = validate_handoff(rich_plan())
    assert [s["url"] for s in out["context"]["sources"]] == ["https://example.test/parsing"]


def test_the_planning_prompt_states_the_id_contract_the_validator_enforces():
    """The prompt and the validator must agree on what a task id is.

    The prompt used to offer "id: short-label (optional)" and
    "dependsOn: labels of prerequisite tasks", while the validator has
    always required an id matching [A-Za-z0-9_-]+ and checked every
    dependsOn entry against the ids of the SAME proposal. A small model
    read "labels" and wrote a description ("README.md exists") into
    dependsOn; the plan was refused twice and the turn failed. The
    prompt now states the rule the validator enforces.
    """
    from aura.central_agent.service import _PLAN_PROPOSAL_SYSTEM

    assert "REQUIRED unique task id" in _PLAN_PROPOSAL_SYSTEM
    assert "no spaces" in _PLAN_PROPOSAL_SYSTEM
    assert "labels of prerequisite tasks" not in _PLAN_PROPOSAL_SYSTEM
    # dependsOn must be described as ids, and the rule spelled out.
    assert '"dependsOn": ["the id of another task in THIS proposal"]' in _PLAN_PROPOSAL_SYSTEM
    assert "take TASK IDS" in _PLAN_PROPOSAL_SYSTEM
    assert "is NOT a task id" in _PLAN_PROPOSAL_SYSTEM


def test_a_depends_on_entry_that_is_not_a_task_id_is_refused_by_name():
    """The refusal names the offending entry, so a correction turn can
    fix exactly that."""
    plan = _plan(tasks=[
        {"id": "t1", "title": "One", "targetFile": "a.md"},
        {"id": "t2", "title": "Two", "targetFile": "b.md",
         "dependsOn": ["README.md exists"]},
    ])
    with pytest.raises(HandoffError) as err:
        validate_handoff(plan)
    assert "depends on unknown task 'README.md exists'" in str(err.value)


class _SameFilePort(_Port):
    """A weak model that hands the file back unchanged."""

    def complete_stream(self, system, user, on_token=None, should_stop=None):
        self.prompts.append(user)
        return "```\n" + (self.original or "") + "```"


def test_an_edit_the_model_did_not_make_fails_instead_of_reading_back_verified(agent, project):
    (project / "index.html").write_text("<html>\n<body>hi</body>\n</html>\n")
    port = _SameFilePort()
    port.original = "<html>\n<body>hi</body>\n</html>\n"
    agent.intents.model_port = port
    plan = _plan(goal="Add an audio element to index.html", tasks=[
        {"id": "t1", "title": "Update index.html", "description": "Add an audio element with id audio.",
         "targetFile": "index.html", "files": [], "dependsOn": [], "worker": None}])
    result, sid = agent.execute_handoff(plan, project_id="p", project_path=str(project))
    assert result.outcome != "completed"
    assert "did not change index.html" in result.summary and "requested change was not made" in result.summary
    assert (project / "index.html").read_text() == port.original            # untouched


def test_the_change_observer_does_not_call_an_identical_rewrite_a_modification(tmp_path):
    import os
    import time

    from aura.central_agent import change_observer as co

    (tmp_path / "a.txt").write_text("same")
    (tmp_path / "b.txt").write_text("old")
    before = co.snapshot(tmp_path)
    time.sleep(0.01)
    (tmp_path / "a.txt").write_text("same")          # new mtime, identical content
    (tmp_path / "b.txt").write_text("new")           # really changed
    os.utime(tmp_path / "a.txt")
    changes, complete = co.diff(before, co.snapshot(tmp_path))
    assert complete and changes == [{"path": "b.txt", "op": "modified"}]


class _CorrectedPort(_Port):
    """Unchanged first, then a real edit when told the first reply was identical."""

    def complete_stream(self, system, user, on_token=None, should_stop=None):
        self.prompts.append(user)
        if "IDENTICAL to the current file" in user:
            return "```\n<html>\n<body>hi<audio id=\"audio\"></audio></body>\n</html>\n```"
        return "```\n<html>\n<body>hi</body>\n</html>\n```"


def test_one_correction_turns_an_unchanged_reply_into_the_real_edit(agent, project):
    (project / "index.html").write_text("<html>\n<body>hi</body>\n</html>\n")
    port = _CorrectedPort()
    agent.intents.model_port = port
    plan = _plan(goal="Add an audio element to index.html", tasks=[
        {"id": "t1", "title": "Update index.html", "description": "Add an audio element with id audio.",
         "targetFile": "index.html", "files": [], "dependsOn": [], "worker": None}])
    result, _ = agent.execute_handoff(plan, project_id="p", project_path=str(project))
    assert result.outcome == "completed", result.summary
    assert 'id="audio"' in (project / "index.html").read_text()
    assert len(port.prompts) == 2


def test_a_file_too_large_to_show_whole_is_not_rewritten_from_a_truncated_view(agent, project):
    big = "line of code\n" * 600                                   # > 5,000 characters
    (project / "big.js").write_text(big)
    plan = _plan(goal="Fix big.js", tasks=[
        {"id": "t1", "title": "Update big.js", "description": "Fix it.",
         "targetFile": "big.js", "files": [], "dependsOn": [], "worker": None}])
    result, _ = agent.execute_handoff(plan, project_id="p", project_path=str(project))
    assert result.outcome != "completed" and "would lose the rest" in result.summary
    assert (project / "big.js").read_text() == big
    assert agent.intents.model_port.prompts == []                    # the model was never asked
