"""A git status request is answered by git status, and only by it.

The exact failure: "Show me the git status" was planned as project.list, the
listing ran and succeeded, and the mission was reported as verified. These
tests pin the fix at each layer: the intent that is compiled, the executor that
runs, the verifier that judges, and the synthesis that words the outcome.
"""

from __future__ import annotations

import asyncio
import subprocess

import pytest

from aura.central_agent.intent import IntentCompiler, ScriptedModelPort
from aura.central_agent.requested import asks_for_git_status
from aura.central_agent.verification import VerificationEngine
from aura.contracts import (
    AgentIntent,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)
from aura.executors import git_status

REQUEST = "Show me the git status"


def _plan(capability: str, request: str = REQUEST, task_id: str = "t1") -> TaskPlan:
    intent = AgentIntent(goal=request, expectedOutcome="status reported")
    task = TaskSpecification(
        id=task_id, description="step", capabilityId=capability, input={},
        verification=VerificationRequirement(kind="audit-only", description="audit"))
    criterion = VerificationRequirement(
        kind="audit-only", description="the task ran", expect={"tasks": [task_id]})
    return TaskPlan(planId="pln-g", sessionId="ses-g", intent=intent,
                    tasks=[task], acceptance=[criterion], createdAt="now")


def _outcome(task_id: str, *, performed: bool = True, evidence: bool = True) -> TaskOutcome:
    return TaskOutcome(taskId=task_id, state="done", performed=performed,
                       verified=performed,
                       invocationIds=[f"inv-{task_id}"] if evidence else [])


# 1. The request maps to the git status capability.

def test_model_proposed_project_list_is_replaced_by_git_status():
    """The real run: the model proposed project.list for this request."""
    port = ScriptedModelPort([(REQUEST, {
        "goal": "List registered projects", "expectedOutcome": "projects listed",
        "requiredCapabilities": ["project.list"], "surface": "aura-internal",
    })])
    intent = IntentCompiler(mode="model", model_port=port).compile(REQUEST)
    assert intent.requiredCapabilities == ["git.status"]
    assert intent.goal == REQUEST
    assert intent.surface == "project"
    assert "Read-only" in intent.constraints


def test_a_model_calling_the_request_conversation_still_runs_git_status():
    """A real run: the model marked this request conversational with no
    capabilities, and the reply told the person to run git status themselves."""
    port = ScriptedModelPort([(REQUEST, {
        "goal": REQUEST, "expectedOutcome": "a reply",
        "requiredCapabilities": [], "conversational": True,
    })])
    intent = IntentCompiler(mode="model", model_port=port).compile(REQUEST + ".")
    assert intent.conversational is False
    assert intent.requiredCapabilities == ["git.status"]


def test_git_status_request_is_recognised_and_writes_are_not():
    assert asks_for_git_status(REQUEST)
    assert asks_for_git_status("git status")
    assert not asks_for_git_status("fix the git status bug and commit")
    assert not asks_for_git_status("list my projects")


# 2. The capability runs against the intended repository.

def test_git_status_reports_branch_and_changes_from_the_selected_repo(tmp_path):
    repo = tmp_path / "scratch"
    repo.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init")
    (repo / "changed.txt").write_text("edit\n")

    result = asyncio.run(git_status({"context": {"cwd": str(repo)}, "input": {}}))
    assert result["ok"] is True
    assert "On branch main" in result["detail"]
    assert "1 changed path" in result["detail"]
    assert "changed.txt" in result["output"]["stdout"]
    assert result["output"]["branch"] == "main"
    assert result["output"]["changes"] == ["?? changed.txt"]


def test_a_clean_repo_is_reported_clean_not_changed(tmp_path):
    """Regression: the branch line alone made a clean tree read as changed."""
    repo = tmp_path / "clean"
    repo.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init")

    result = asyncio.run(git_status({"context": {"cwd": str(repo)}, "input": {}}))
    assert result["detail"] == "On branch main. Working tree is clean."
    assert result["output"]["changes"] == []
    assert result["output"]["stdout"].startswith("## main")


def test_git_status_refuses_a_directory_that_is_not_a_repo(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    result = asyncio.run(git_status({"context": {"cwd": str(plain)}, "input": {}}))
    assert result["ok"] is False


# 3–5. Verification is grounded in the request and in real evidence.

def test_project_list_cannot_satisfy_a_git_status_request():
    """The exact original failure: the listing ran, performed, and passed."""
    report = VerificationEngine().verify(_plan("project.list"), [_outcome("t1")])
    assert report.passed is False
    assert report.objectiveAccepted is False
    assert any("git status" in u for u in report.unmetAcceptance)


def test_a_successful_unrelated_result_is_not_verified():
    report = VerificationEngine().verify(_plan("filesystem.list"), [_outcome("t1")])
    assert report.passed is False
    assert report.objectiveAccepted is False


def test_missing_git_status_evidence_is_not_verified():
    """A git.status task that did not actually run leaves the objective unmet."""
    report = VerificationEngine().verify(
        _plan("git.status"), [_outcome("t1", performed=False, evidence=False)])
    assert report.passed is False
    assert report.objectiveAccepted is False


def test_real_git_status_evidence_is_verified():
    report = VerificationEngine().verify(_plan("git.status"), [_outcome("t1")])
    assert report.passed is True
    assert report.objectiveAccepted is True


# 6. The completion message and the record agree with what ran.

def test_completion_wording_follows_the_grounded_verdict(tmp_path):
    from aura.central_agent.events import EventBus
    from aura.central_agent.evidence import EvidenceCollector
    from aura.central_agent.execution import ExecutionOutcome
    from aura.central_agent.service import CentralAgent
    from aura.central_agent.session import AgentSessionStore

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    svc.verifier = VerificationEngine()
    svc.evidence = EvidenceCollector(lambda: [])
    session = AgentSessionStore(tmp_path).create(None)

    outcome = ExecutionOutcome()
    outcome.outcomes.append(_outcome("t1"))
    result = svc._synthesize(session, _plan("project.list"), outcome)
    assert result.outcome == "failed"
    assert "Mission not verified" in result.summary
    assert "Mission verified" not in result.summary
    assert "Objective NOT verified" not in result.summary
    assert result.verified == ["t1"]  # the record keeps what was actually verified


# 7. Result to answer, through the real API path (the failing path).

def _api_repo(tmp_path, monkeypatch, branch="main", dirty=None):
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=proj, check=True, capture_output=True)
    run("init", "-q", "-b", branch)
    run("config", "user.email", "t@t")
    run("config", "user.name", "t")
    (proj / "README.md").write_text("x\n")
    run("add", ".")
    run("commit", "-qm", "init")
    if dirty:
        (proj / dirty).write_text("new\n")
    return TestClient(create_app()), proj, home


def _ask(client, proj, message="Show me the git status."):
    import time

    body = client.post("/agent/sessions",
                       json={"message": message, "projectPath": str(proj)}).json()
    deadline = time.monotonic() + 90
    while True:
        s = client.get(f"/agent/sessions/{body['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and \
                (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return s["lastResult"]
        assert time.monotonic() < deadline, str(s)[:300]
        time.sleep(0.1)


def _audit_capabilities(home):
    import json

    trail = home / "audit" / "trail.jsonl"
    return [json.loads(line)["capabilityId"] for line in trail.read_text().splitlines() if line.strip()]


def test_answer_reports_branch_and_clean_tree_from_git_output(tmp_path, monkeypatch):
    """The exact failing case: the answer must carry git's real result."""
    client, proj, home = _api_repo(tmp_path, monkeypatch)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=proj, capture_output=True, text=True).stdout
    result = _ask(client, proj)
    assert result["outcome"] == "completed", result
    assert result["verified"] == ["t1"]
    assert result["summary"] == "The repository is on branch main. The working tree is clean."
    assert _audit_capabilities(home) == ["git.status"]
    # A read-only request leaves the repository exactly as it was.
    assert subprocess.run(["git", "rev-parse", "HEAD"], cwd=proj, capture_output=True, text=True).stdout == head
    assert subprocess.run(["git", "status", "--porcelain"], cwd=proj, capture_output=True, text=True).stdout == ""


def test_answer_follows_the_observed_branch_and_changes(tmp_path, monkeypatch):
    """Nothing is assumed: another branch and a changed file are reported as observed."""
    client, proj, _home = _api_repo(tmp_path, monkeypatch, branch="feature", dirty="notes.txt")
    result = _ask(client, proj)
    assert result["outcome"] == "completed", result
    assert "on branch feature" in result["summary"]
    assert "1 changed path" in result["summary"]
    assert "?? notes.txt" in result["summary"]
    assert "clean" not in result["summary"]


def test_missing_git_output_is_reported_not_answered(tmp_path):
    """A verified git task with no recorded output yields no status claim."""
    from aura.central_agent.events import EventBus
    from aura.central_agent.evidence import EvidenceCollector
    from aura.central_agent.execution import ExecutionOutcome
    from aura.central_agent.git_answer import NO_OUTPUT
    from aura.central_agent.service import CentralAgent
    from aura.central_agent.session import AgentSessionStore

    svc = CentralAgent.__new__(CentralAgent)
    svc.bus = EventBus()
    svc.verifier = VerificationEngine()
    svc.evidence = EvidenceCollector(lambda: [])
    session = AgentSessionStore(tmp_path).create(None)
    outcome = ExecutionOutcome()
    outcome.outcomes.append(_outcome("t1"))
    outcome.verified_outputs["t1"] = {"task_id": "t1", "stdout": "", "invocation_ids": ["inv-t1"]}
    result = svc._synthesize(session, _plan("git.status"), outcome)
    assert result.summary == NO_OUTPUT
    assert result.outcome == "failed"
    assert "branch" not in result.summary.split(",")[0]


@pytest.mark.parametrize("output, expected", [
    ("## main", "The repository is on branch main. The working tree is clean."),
    ("## main...origin/main [ahead 1]\n M a.py",
     "The repository is on branch main, tracking origin/main (ahead 1). "
     "The working tree has 1 changed path:\n   M a.py"),
    ("## No commits yet on main", "The repository is on branch main, which has no commits yet. "
                                  "The working tree is clean."),
    ("## HEAD (no branch)", "The repository is on a detached HEAD. The working tree is clean."),
])
def test_git_output_is_described_as_observed(output, expected):
    from aura.central_agent.git_answer import describe_git_status

    assert describe_git_status(output) == expected


@pytest.mark.parametrize("output", ["", "   ", "fatal: not a git repository"])
def test_unrecognised_git_output_makes_no_claim(output):
    from aura.central_agent.git_answer import describe_git_status

    assert describe_git_status(output) is None
