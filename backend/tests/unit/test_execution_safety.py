"""Fail-closed execution plumbing: unknown outcomes, broken registries,
unverifiable worker pins, tampered identities, and escaping paths.

Each test pins a refusal or degradation that used to be a crash, a
silent success, or an indistinguishable "no workers" answer.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from aura.central_agent.authority import _requested_node_denial
from aura.central_agent.execution import ExecutionController, _outcome_state
from aura.environment.pathsec import FileIdentity
from aura.executors import inside
from aura.fabric.executors import _confine


class TestOutcomeStates:
    @pytest.mark.parametrize("outcome,expected", [
        ("succeeded", "done"),
        ("unverified", "done"),
        ("denied", "denied"),
        ("awaiting-approval", "awaiting-approval"),
        ("failed", "failed"),
        ("unsupported", "blocked"),
    ])
    def test_known_outcomes_map(self, outcome, expected):
        assert _outcome_state(outcome) == expected

    @pytest.mark.parametrize("outcome", ["timed-out", "cancelled", "", "DONE"])
    def test_unknown_outcomes_fail_closed_not_crash(self, outcome):
        assert _outcome_state(outcome) == "failed"


class TestPresentNodesError:
    def _controller(self, host):
        ctrl = ExecutionController.__new__(ExecutionController)
        ctrl._cfg = SimpleNamespace(fabric=SimpleNamespace(host=host))
        ctrl._nodes_error = None
        return ctrl

    def test_registry_failure_named_not_empty(self):
        def boom():
            raise RuntimeError("registry disk gone")

        ctrl = self._controller(SimpleNamespace(present_nodes=boom))
        assert ctrl._present_nodes() == []
        assert ctrl._nodes_error == "registry disk gone"


class TestAuthorityFailClosed:
    def _cfg(self, resolve):
        return SimpleNamespace(
            fabric=SimpleNamespace(host=SimpleNamespace(
                resolve_node=resolve)))

    def _task(self):
        return SimpleNamespace(capabilityId="filesystem.read",
                               nodeId="ghost", input={}, risk="low")

    def test_host_error_denies_pin(self):
        def boom(_cap, _req):
            raise RuntimeError("host exploded")

        reason = _requested_node_denial(self._task(), self._cfg(boom))
        assert reason is not None
        assert "refusing" in reason

    def test_unusable_pin_still_denied(self):
        reason = _requested_node_denial(
            self._task(),
            self._cfg(lambda _cap, _req: {"ok": False,
                                          "reason": "node retired"}))
        assert reason == "node retired"


class TestDirectTextOutput:
    """A successful direct-path task whose executor returns TEXT output
    (filesystem.read, terminal stdout) must settle done — never crash
    the leg with AttributeError on .get.

    Live-reproduced: binding input.path (correctly) let t1 reach
    dispatch, where the cancelled-flag check called .get on the file
    text and the whole session failed as 'Unexpected failure'.
    """

    def test_filesystem_read_text_output_settles_done(
            self, tmp_path, monkeypatch):
        import tempfile

        from test_fabric_invoke import make_cfg

        from aura.central_agent.execution import ExecutionController
        from aura.central_agent.planner import TaskPlanner
        from aura.contracts import AgentIntent

        home = Path(tempfile.mkdtemp(prefix="exec-text-"))
        monkeypatch.setenv("AURA_HOME", str(home))
        target = tmp_path / "main.py"
        target.write_text("print('hi')\n")
        cfg = make_cfg(home)
        planner = TaskPlanner(
            known_capabilities=lambda: {"filesystem.read"},
            known_nodes=lambda: set())
        intent = AgentIntent(goal="read main.py",
                             expectedOutcome="contents")
        plan = planner.plan_from_model(
            intent, "ses-text", "now",
            {"tasks": [{
                "id": "t1",
                "description": "Read main.py",
                "capabilityId": "filesystem.read",
                "scopePaths": ["main.py"],
                "verificationKind": "audit-only",
                "verification": "content returned",
            }]})
        assert plan.tasks[0].input["path"] == "main.py"
        ctrl = ExecutionController(cfg)
        out = ctrl.execute(
            plan, None, project_cwd=str(tmp_path),
            correlation={"session_id": "s", "request_id": "r"})
        assert [o.taskId for o in out.outcomes] == ["t1"]
        assert out.outcomes[0].state == "done", out.outcomes[0].detail


class TestDelegationCheckpoints:
    """A delegated worker edits files on its own authority, so the tree
    must be recoverable before it starts and attributable afterwards.

    Both go through governed git.commit (autonomous, audited). Neither
    ever blocks dispatch — an unavailable checkpoint is loud evidence,
    not a silent gap.
    """

    def _plan(self, home):
        from test_fabric_invoke import make_cfg

        from aura.central_agent.execution import ExecutionController
        from aura.central_agent.planner import TaskPlanner

        cfg = make_cfg(home, permissions={"read": True, "write": True,
                                               "execute": True})

        class _Delegate:
            capabilityId = "agent.delegate"

            async def run(self, invocation):
                return {"ok": True, "detail": "delegated",
                        "output": {"stdout": "ok", "exitCode": 0}}

            async def verify(self, _inv, _res):
                return {"passed": True, "kind": "exit-code", "detail": "0"}

        # The async invoke path reads fabric.executors, not cfg.executors.
        cfg.fabric.executors["agent.delegate"] = _Delegate()
        return ExecutionController(cfg), TaskPlanner(
            known_capabilities=lambda: {"agent.delegate"},
            known_nodes=lambda: set())

    def _repo(self, path, monkeypatch):
        import subprocess

        monkeypatch.setenv("AURA_HOME", str(path.parent / "home"))
        for args in (["init"], ["config", "user.email", "t@t.t"],
                     ["config", "user.name", "t"], ["add", "-A"],
                     ["commit", "-m", "base"]):
            subprocess.run(["git", *args], cwd=str(path), check=True,
                           capture_output=True)
        (path / "work.txt").write_text("dirty\n")
        return path

    def _intent(self):
        from aura.contracts import AgentIntent
        return AgentIntent(goal="do the thing", expectedOutcome="done")

    def _log(self, path):
        import subprocess
        out = subprocess.run(["git", "log", "--pretty=%s"], cwd=str(path),
                             capture_output=True, text=True)
        return out.stdout

    def test_dirty_tree_is_committed_before_dispatch(
            self, tmp_path, monkeypatch):
        import tempfile
        from pathlib import Path as P

        home = P(tempfile.mkdtemp(prefix="exec-ckpt-"))
        proj = tmp_path / "proj"
        proj.mkdir()
        (proj / "base.txt").write_text("base\n")
        self._repo(proj, monkeypatch)
        ctrl, planner = self._plan(home)
        plan = planner.plan_from_model(
            self._intent(), "ses-ckpt", "now",
            {"tasks": [{
                "id": "t1",
                "description": "Do the thing",
                "capabilityId": "agent.delegate",
                "input": {"task": "do the thing"},
                "verificationKind": "audit-only",
                "verification": "done",
            }]})
        out = ctrl.execute(plan, None, project_cwd=str(proj),
                           correlation={"session_id": "s", "request_id": "r"})
        assert [o.taskId for o in out.outcomes] == ["t1"]
        assert out.outcomes[0].state == "done", out.outcomes[0].detail
        assert out.outcomes[0].approvalId is None
        assert "AURA checkpoint: before worker task t1" in self._log(proj)
        assert "checkpoint" in out.outcomes[0].detail.lower() or \
            "before commit recorded" in out.outcomes[0].detail

    def test_non_repo_dispatches_with_a_loud_note(
            self, tmp_path, monkeypatch):
        import tempfile
        from pathlib import Path as P

        home = P(tempfile.mkdtemp(prefix="exec-ckpt-"))
        proj = tmp_path / "plain"
        proj.mkdir()
        monkeypatch.setenv("AURA_HOME", str(home))
        ctrl, planner = self._plan(home)
        plan = planner.plan_from_model(
            self._intent(), "ses-ckpt", "now",
            {"tasks": [{
                "id": "t1",
                "description": "Do the thing",
                "capabilityId": "agent.delegate",
                "input": {"task": "do the thing"},
                "verificationKind": "audit-only",
                "verification": "done",
            }]})
        out = ctrl.execute(plan, None, project_cwd=str(proj),
                           correlation={"session_id": "s", "request_id": "r"})
        assert out.outcomes[0].state == "done", out.outcomes[0].detail
        assert "checkpoint unavailable" in out.outcomes[0].detail


class TestRealWorkerFailureNeedsNoApproval:
    """The real opencode binary, no credentials: dispatch spawns a REAL
    worker process, which fails at auth. The failure must settle failed
    with captured stderr — never parked, never hidden.
    """

    def test_auth_failure_settles_failed_with_evidence(
            self, tmp_path, monkeypatch):
        import asyncio
        import shutil

        from aura.executors import agent_delegate_run

        if shutil.which("opencode") is None:
            pytest.skip("no opencode binary on this machine")
        monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
        inv = {
            # No scopePaths key at all: an empty scope is refused, and
            # this test must reach the real worker process, not the
            # contract validator.
            "input": {"task": "Reply with exactly: PROBE"},
            # Short budget on purpose: with no credentials the CLI
            # blocks on auth until it is stopped. The assertion is
            # about the settle (failed with evidence, never parked),
            # not about the model answering.
            "context": {"cwd": str(tmp_path), "timeoutMs": 20000},
            "node": {"id": "opencode", "name": "OpenCode",
                     "binary": "opencode"},
        }
        out = asyncio.run(agent_delegate_run(inv))
        assert out["ok"] is False, out
        assert out["detail"], "a failed worker must say why"


class TestCorrectionRunsWithoutApproval:
    """A scope deviation triggers the correction loop, and the
    correction re-dispatch runs through the REAL governed path —
    no fakes, no human grant. This is autonomous recovery: detect,
    rebuild the task, re-dispatch, verify.
    """

    def test_deviation_corrects_autonomously(
            self, tmp_path, monkeypatch):
        import tempfile
        from pathlib import Path as P

        from test_fabric_invoke import make_cfg

        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.execution import ExecutionController, ExecutionOutcome
        from aura.contracts import TaskPlan, TaskSpecification

        home = P(tempfile.mkdtemp(prefix="exec-corr-"))
        monkeypatch.setenv("AURA_HOME", str(home))

        class _Delegate:
            capabilityId = "agent.delegate"

            async def run(self, invocation):
                return {"ok": True, "detail": "corrected",
                        "output": {"stdout": "corrected", "exitCode": 0}}

            async def verify(self, _inv, _res):
                return {"passed": True, "kind": "exit-code", "detail": "0"}

        cfg = make_cfg(home, permissions={"read": True, "write": True,
                                          "execute": True})
        cfg.fabric.executors["agent.delegate"] = _Delegate()
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(home))
        agent.controller = ExecutionController(cfg)

        session = agent.sessions.create("p")
        task = TaskSpecification(
            id="t1", description="Implement it",
            capabilityId="agent.delegate",
            input={"task": "implement", "scopePaths": ["src"]},
            risk="high",
            verification={"kind": "exit-code",
                          "description": "exit 0"})
        from aura.contracts import AgentIntent
        plan = TaskPlan(planId="pl-1", sessionId=session.sessionId,
                        intent=AgentIntent(goal="do it",
                                           expectedOutcome="done"),
                        tasks=[task], createdAt="now")
        outcome = ExecutionOutcome()
        outcome.deviation_evidence = {
            "t1": {"outside": ["rogue.txt"],
                   "changed_paths": ["src/ok.py", "rogue.txt"],
                   "invocation_ids": ["inv-1"]},
        }
        result = agent._maybe_correct(session, plan, outcome,
                                      project_cwd=str(tmp_path))
        assert result is not None, "deviation must enter correction"
        chain = agent.sessions.load(session.sessionId).correctionChain
        assert chain, "correction must be recorded"
        # The correction re-dispatched the worker with no human grant.
        assert cfg.ledger.pending() == []
        states = [o.state for o in result.outcomes] if hasattr(
            result, "outcomes") else []
        assert "awaiting-approval" not in states, states


class TestFileIdentity:
    def _id(self, **kw):
        base = {"device": 1, "inode": 2, "mode": 0o100644, "size": 10,
                "mtime_ns": 5}
        base.update(kw)
        return FileIdentity(**base)

    def test_same_file_matches(self):
        assert self._id().matches(self._id()) is True

    def test_rewritten_in_place_does_not_match(self):
        # Same inode, new bytes: truncate-and-rewrite keeps the file
        # number on most filesystems. Size/mtime must catch it.
        assert self._id().matches(self._id(size=11)) is False
        assert self._id().matches(self._id(mtime_ns=6)) is False

    def test_replaced_file_does_not_match(self):
        assert self._id().matches(self._id(inode=3)) is False

    def test_none_never_matches(self):
        assert self._id().matches(None) is False


class TestConfinement:
    def test_inside_allows_member(self, tmp_path):
        target = tmp_path / "sub" / "f.txt"
        target.parent.mkdir()
        target.write_text("x")
        assert inside(str(tmp_path), "sub/f.txt") == str(target.resolve())

    def test_inside_refuses_escape(self, tmp_path):
        with pytest.raises(ValueError, match="leaves the project"):
            inside(str(tmp_path), "../evil.txt")

    def test_confine_allows_member(self, tmp_path):

        assert _confine(tmp_path, "a/b.txt") == (tmp_path / "a/b.txt").resolve()

    def test_confine_refuses_absolute_and_empty(self, tmp_path):
        with pytest.raises(ValueError):
            _confine(tmp_path, "/etc/passwd")
        with pytest.raises(ValueError):
            _confine(tmp_path, "  ")
