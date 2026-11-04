"""The autonomous lifecycle: request → plan → execute → verify → report.

AURA Hub Alpha has no human approval gate. These tests drive the real HTTP
API against an isolated AURA_HOME and a scratch git repository, and assert:

- routine read, write, edit and git-inspection tasks run and verify with no
  approval step anywhere in the response or the stored session;
- an operation the policy refuses is rejected at once, creates no pending
  request, and changes nothing on disk;
- a path outside the project is refused, not held;
- reload and retry cannot bring an approval state back.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    proj = tmp_path / "proj"
    proj.mkdir()
    for cmd in (["git", "init", "-q"], ["git", "config", "user.email", "t@t"],
                ["git", "config", "user.name", "t"]):
        subprocess.run(cmd, cwd=proj, check=True)
    (proj / "README.md").write_text("# fixture\n")
    (proj / "main.py").write_text("print('hi')\n")
    subprocess.run(["git", "add", "."], cwd=proj, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=proj, check=True)
    return TestClient(create_app()), proj, home


def run(client, proj, message, timeout=90.0):
    """Submit a request and wait for its terminal result. Returns (submit, result)."""
    body = client.post("/agent/sessions", json={"message": message, "projectPath": str(proj)}).json()
    if body["result"]["status"] != "started":
        return body, body["result"]
    deadline = time.monotonic() + timeout
    while True:
        s = client.get(f"/agent/sessions/{body['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and \
                (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return body, s["lastResult"]
        assert time.monotonic() < deadline, f"never settled: {str(s)[:300]}"
        time.sleep(0.2)


def approval_free(obj) -> None:
    """No approval state, field, or wording anywhere in a response or record."""
    text = json.dumps(obj, default=str).lower()
    for word in ("awaiting-approval", "approvalid", "approvalids", "pendingapproval",
                 "parkedtaskid", "approval.required", "approve"):
        assert word not in text, f"{word!r} leaked into {text[:300]}"


# ── routine work runs and verifies with no approval step ────────────────────

def test_read_runs_and_settles_done_without_approval(tmp_path, monkeypatch):
    """A model-proposed read is planned and executed through the governed
    controller. The heuristic intent path does not propose file reads, so
    this drives the planner and controller directly, as the read-execution
    test does."""
    import tempfile

    from test_fabric_invoke import make_cfg

    from aura.central_agent.execution import ExecutionController
    from aura.central_agent.planner import TaskPlanner
    from aura.contracts import AgentIntent

    home = Path(tempfile.mkdtemp(prefix="auto-read-"))
    monkeypatch.setenv("AURA_HOME", str(home))
    (tmp_path / "main.py").write_text("print('hi')\n")
    cfg = make_cfg(home)
    planner = TaskPlanner(known_capabilities=lambda: {"filesystem.read"},
                          known_nodes=lambda: set())
    intent = AgentIntent(goal="read main.py", expectedOutcome="contents")
    plan = planner.plan_from_model(
        intent, "ses-read", "now",
        {"tasks": [{"id": "t1", "description": "Read main.py",
                    "capabilityId": "filesystem.read", "scopePaths": ["main.py"],
                    "verificationKind": "audit-only", "verification": "content returned"}]})
    out = ExecutionController(cfg).execute(
        plan, None, project_cwd=str(tmp_path),
        correlation={"session_id": "s", "request_id": "r"})
    assert [o.state for o in out.outcomes] == ["done"], out.outcomes[0].detail
    assert out.outcomes[0].performed
    approval_free(out.outcomes[0].model_dump())


def test_write_runs_and_reads_back_without_approval(repo):
    client, proj, _home = repo
    body, result = run(client, proj, "Create report.md containing hello")
    assert result["outcome"] == "completed", result
    assert (proj / "report.md").read_text().strip() == "hello"
    approval_free(body)
    approval_free(result)


def test_edit_of_an_existing_file_runs_and_verifies_without_approval(repo):
    client, proj, _home = repo
    body, result = run(client, proj, "Create main.py containing print('changed')")
    assert result["outcome"] == "completed", result
    assert (proj / "main.py").read_text().strip() == "print('changed')"
    approval_free(body)


def test_git_inspection_runs_and_verifies_without_approval(repo):
    client, proj, _home = repo
    body, result = run(client, proj, "show me git status")
    assert result["outcome"] == "completed", result
    assert result["verified"], result
    approval_free(body)


# ── refusals are immediate and leave nothing waiting ─────────────────────────

def test_unsupported_operation_is_refused_at_once_and_nothing_waits(repo):
    client, proj, _home = repo
    before = sorted(p.name for p in proj.iterdir())
    body, result = run(client, proj, "Push the commits to origin")
    assert result["outcome"] in ("failed", "denied", "unsupported", "needs-clarification"), result
    assert result["outcome"] != "completed"
    assert sorted(p.name for p in proj.iterdir()) == before
    approval_free(result)


def test_out_of_bound_write_is_refused_and_writes_nothing(repo, tmp_path):
    client, proj, _home = repo
    escape = tmp_path / "escape.md"
    body, result = run(client, proj, f"Create {escape} containing x")
    assert result["outcome"] != "completed", result
    assert not escape.exists()
    approval_free(result)


# ── reload and retry cannot resurrect an approval ────────────────────────────

def test_reload_restores_the_settled_result_not_an_approval(repo, monkeypatch):
    client, proj, home = repo
    body, result = run(client, proj, "show me git status")
    assert result["outcome"] == "completed"
    fresh = TestClient(create_app())
    restored = fresh.get(f"/agent/sessions/{body['sessionId']}").json()
    assert restored["lastResult"]["outcome"] == "completed"
    approval_free(restored["lastResult"])


def test_retired_approval_routes_do_not_exist(repo):
    client, _proj, _home = repo
    assert client.get("/fabric/approvals").status_code == 404
    assert client.post("/agent/sessions/agt-000000000000/approve",
                       json={"approvalId": "x", "granted": True}).status_code == 404
    assert client.post("/agent/sessions/agt-000000000000/resume").status_code == 404


def test_retry_after_a_stop_does_not_bring_back_an_approval(repo):
    client, proj, _home = repo
    body, result = run(client, proj, "show me git status")
    sid = body["sessionId"]
    refused = client.post(f"/agent/sessions/{sid}/resume-cancelled")
    # The session was not stopped, so there is nothing to retry.
    assert refused.status_code in (400, 409), refused.text
    approval_free(refused.json())
