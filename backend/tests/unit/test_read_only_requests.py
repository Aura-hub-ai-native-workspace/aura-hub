"""Read-only requests run their real tool and show its real result (F-02).

Before this fix, in a disposable repository:
- "show me the git diff", "what branch am I on", "list the files", "read
  README.md" asked for clarification in deterministic mode, and a model that
  labelled them as conversation executed nothing;
- git.diff was refused by policy in the real app: no node was declared to
  provide it, although the git tool runs `git diff`;
- a read-only tool that did run (git.diff, filesystem.list, filesystem.read,
  project.list, workflow.list) had its result dropped: the
  executor returns text or a list, and the verified record kept only a
  `stdout` field it never filled, so the answer was "1 task(s) executed";
- a model-planned filesystem.list with a path was rerouted to an agent;
- a correct read of the requested file failed verification because the
  task's input path did not count as addressing the file.
"""

from __future__ import annotations

import json
import subprocess
import time

import pytest

from aura.central_agent.intent import IntentCompiler, ScriptedModelPort, heuristic_interpret
from aura.central_agent.verification import VerificationEngine


def read_only_request(message):
    from aura.central_agent.requested import read_only_request as classify

    return classify(message)
from aura.contracts import (
    AgentIntent,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)

ROUTED = [
    ("Show me the git diff.", "git.diff", {}),
    ("What changed in the working tree?", "git.diff", {}),
    ("What branch am I on?", "git.status", {}),  # git status names the branch
    ("List the files in this repository.", "filesystem.list", {"path": "."}),
    ("Read README.md", "filesystem.read", {"path": "README.md"}),
    ("Show me the contents of src/app.py", "filesystem.read", {"path": "src/app.py"}),
]

NOT_ROUTED = [
    "Fix the diff in app.py",
    "Delete the files in src",
    "Create a branch called feature-x",
    "Switch to branch main",
    "Read README.md and update it",
    "List my projects",
    "Show me the git status",
]


# ── classification ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("message, capability, payload", ROUTED)
def test_read_only_requests_are_recognised(message, capability, payload):
    assert read_only_request(message) == (capability, payload)


@pytest.mark.parametrize("message", NOT_ROUTED)
def test_changes_and_other_handled_requests_are_not_routed_here(message):
    assert read_only_request(message) is None


@pytest.mark.parametrize("message, capability, payload", ROUTED)
def test_deterministic_mode_routes_to_the_tool(message, capability, payload):
    intent = heuristic_interpret(message)
    assert intent.requiredCapabilities == [capability]
    assert intent.needsClarification is False
    assert intent.goal == message


@pytest.mark.parametrize("message, capability, payload", ROUTED)
def test_a_model_calling_it_conversation_still_runs_the_tool(message, capability, payload):
    port = ScriptedModelPort([(message, {
        "goal": message, "expectedOutcome": "a reply",
        "requiredCapabilities": [], "conversational": True,
    })])
    intent = IntentCompiler(mode="model", model_port=port).compile(message)
    assert intent.conversational is False
    assert intent.requiredCapabilities == [capability]


def test_a_model_choosing_an_unrelated_tool_is_overridden():
    message = "Show me the git diff."
    port = ScriptedModelPort([(message, {
        "goal": "list projects", "expectedOutcome": "projects",
        "requiredCapabilities": ["project.list"],
    })])
    intent = IntentCompiler(mode="model", model_port=port).compile(message)
    assert intent.requiredCapabilities == ["git.diff"]


# ── the real path: API → plan → tool → record → answer ─────────────────────

@pytest.fixture()
def api(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    (proj / "src").mkdir(parents=True)
    run = lambda *a: subprocess.run(["git", *a], cwd=proj, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "t@t")
    run("config", "user.name", "t")
    (proj / "README.md").write_text("# probe fixture\nline two\n")
    (proj / "src" / "app.py").write_text("print('hi')\n")
    run("add", ".")
    run("commit", "-qm", "init")
    (proj / "README.md").write_text("# probe fixture\nline two\nchanged line\n")
    (tmp_path / "secret.txt").write_text("TOP-SECRET-OUTSIDE\n")
    return TestClient(create_app()), proj, home


def _ask(client, proj, message):
    body = client.post("/agent/sessions",
                       json={"message": message, "projectPath": str(proj)}).json()
    if (body.get("result") or {}).get("status") != "started":
        return body["result"]
    deadline = time.monotonic() + 90
    while True:
        s = client.get(f"/agent/sessions/{body['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and \
                (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return s["lastResult"]
        assert time.monotonic() < deadline, str(s)[:300]
        time.sleep(0.1)


def _audit(home):
    trail = home / "audit" / "trail.jsonl"
    if not trail.exists():
        return []
    return [json.loads(line) for line in trail.read_text().splitlines() if line.strip()]


def _repo_state(proj):
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=proj, capture_output=True, text=True).stdout
    tree = subprocess.run(["git", "status", "--porcelain"], cwd=proj, capture_output=True, text=True).stdout
    return head, tree


@pytest.mark.parametrize("message, capability, shown", [
    ("Show me the git diff.", "git.diff", "+changed line"),
    ("What branch am I on?", "git.status", "The current branch is main."),
    ("List the files in this repository.", "filesystem.list", "README.md"),
    ("Read README.md", "filesystem.read", "# probe fixture"),
])
def test_the_tool_runs_and_its_real_output_is_the_answer(api, message, capability, shown):
    client, proj, home = api
    before = _repo_state(proj)
    result = _ask(client, proj, message)
    assert result["outcome"] == "completed", result
    assert result["verified"] == ["t1"]
    records = _audit(home)
    assert [r["capabilityId"] for r in records] == [capability]
    assert records[0]["outcome"] == "succeeded"
    assert shown in result["summary"]
    assert "task(s) executed" not in result["summary"]
    assert _repo_state(proj) == before  # read-only: nothing changed


def test_listing_shows_directories_and_files(api):
    client, proj, _home = api
    result = _ask(client, proj, "List the files in this repository.")
    assert "src/" in result["summary"]
    assert "README.md" in result["summary"]


def test_a_path_outside_the_project_is_refused_and_not_shown(api):
    client, proj, home = api
    result = _ask(client, proj, "Read ../secret.txt")
    assert result["outcome"] != "completed"
    assert "TOP-SECRET-OUTSIDE" not in json.dumps(result)
    assert all(r["outcome"] != "succeeded" for r in _audit(home))


def test_project_listing_shows_the_registered_projects(api):
    client, proj, home = api
    registered = client.post("/projects", json={"path": str(proj), "name": "probe-proj"})
    assert registered.status_code == 200, registered.text
    result = _ask(client, proj, "List my projects")
    assert result["outcome"] == "completed", result
    assert "probe-proj" in result["summary"]
    assert str(proj) in result["summary"]
    assert [r["capabilityId"] for r in _audit(home)] == ["project.list"]


def test_workflow_listing_reaches_the_answer(api):
    client, proj, _home = api
    result = _ask(client, proj, "List my workflows")
    assert result["outcome"] == "completed", result
    assert "task(s) executed" not in result["summary"]


# ── result propagation and planning guards ─────────────────────────────────

def test_text_and_list_outputs_are_recorded_as_verified_text():
    from aura.central_agent.execution import ExecutionController, ExecutionOutcome

    for capability, output, expected in (
            ("filesystem.read", "file text\n", "file text\n"),
            ("filesystem.list", ["a.py", "src/"], "a.py\nsrc/"),
            ("git.diff", "diff --git a/x b/x\n+new\n", "+new"),
            ("workflow.list", {"workflows": [{"id": "w1", "name": "Build"}]}, "Build")):
        result = ExecutionOutcome()
        result.outcomes.append(TaskOutcome(taskId="t1", state="done", performed=True,
                                           verified=True, invocationIds=["inv-1"]))
        task = TaskSpecification(id="t1", description="d", capabilityId=capability, input={},
                                 verification=VerificationRequirement(kind="audit-only", description="a"))
        ExecutionController._note_task_closed(ExecutionController.__new__(ExecutionController),
                                              task, result, output, [])
        assert expected in result.verified_outputs["t1"]["stdout"], capability


def test_a_model_planned_listing_with_a_path_is_not_sent_to_an_agent():
    from aura.central_agent.planner import TaskPlanner

    intent = AgentIntent(goal="List the files in src", expectedOutcome="files",
                         requiredCapabilities=["filesystem.list"])
    planner = TaskPlanner(known_capabilities=lambda: {"filesystem.list", "agent.delegate"})
    plan = planner.plan_from_model(intent, "ses", "now", {"tasks": [
        {"id": "t1", "description": "List files in src", "capabilityId": "filesystem.list",
         "input": {"path": "src"}, "risk": "low", "verificationKind": "audit-only"}]})
    assert [t.capabilityId for t in plan.tasks] == ["filesystem.list"]


def _plan(request, capability, task_input):
    intent = AgentIntent(goal=request, expectedOutcome="shown")
    task = TaskSpecification(id="t1", description="step", capabilityId=capability, input=task_input,
                             verification=VerificationRequirement(kind="audit-only", description="a"))
    return TaskPlan(planId="p", sessionId="s", intent=intent, tasks=[task], createdAt="now",
                    acceptance=[VerificationRequirement(kind="audit-only", description="ran",
                                                        expect={"tasks": ["t1"]})])


def _done():
    return TaskOutcome(taskId="t1", state="done", performed=True, verified=True, invocationIds=["inv-1"])


def test_reading_the_requested_file_satisfies_the_request():
    report = VerificationEngine().verify(_plan("Read README.md", "filesystem.read", {"path": "README.md"}), [_done()])
    assert report.objectiveAccepted is True
    assert report.passed is True


def test_an_unrelated_tool_cannot_satisfy_a_diff_request():
    report = VerificationEngine().verify(_plan("Show me the git diff.", "project.list", {}), [_done()])
    assert report.passed is False
    assert any("git diff" in u for u in report.unmetAcceptance)
