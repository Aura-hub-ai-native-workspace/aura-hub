"""Live supervisor correction loop — requires a running agent worker.

Separated from the unit suite because these tests spawn real subprocesses
(opencode binary). They are skipped unless AURA_LIVE_WORKERS=1 is set.

Run with::

    AURA_LIVE_WORKERS=1 uv run pytest tests/integration/test_live_supervisor_correction.py -v
"""
from __future__ import annotations

import asyncio
import os
import subprocess

import pytest

from aura.central_agent.supervisor import (
    CorrectionRecord,
    build_correction,
    decide_run,
    decide_task,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("AURA_LIVE_WORKERS") not in {"1", "true", "yes"},
    reason="requires live agent workers — set AURA_LIVE_WORKERS=1 to enable",
)


def _git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, timeout=30)


@pytest.fixture()
def worker_repo(tmp_path):
    root = str(tmp_path / "proj")
    os.makedirs(root)
    _git(root, "init", "-q")
    _git(root, "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init")
    return root


def _delegate(cwd, task, scope, node_id="opencode", name="OpenCode",
              binary="opencode", timeout_ms=180000):
    from aura.executors import agent_delegate_run

    inv = {"input": {"task": task, "scopePaths": scope},
           "context": {"cwd": cwd, "timeoutMs": timeout_ms,
                       "actor": {"kind": "agent", "id": "correction-test"}},
           "node": {"id": node_id, "name": name, "binary": binary}}
    return asyncio.run(agent_delegate_run(inv))


class TestLiveCorrectionLoop:
    def test_full_loop_deviate_then_correct(self, worker_repo):
        out1 = _delegate(
            worker_repo,
            "Create the file offscope.txt containing exactly offscope and nothing else.",
            ["hello.txt"])
        assert out1["ok"] is False, out1
        assert (out1.get("output") or {}).get("scopeDeviation") is True

        v1 = decide_task("done", {
            "taskId": "t1",
            "scopeDeviation": True,
            "scopeCheck": (out1.get("output") or {}).get("scopeCheck") or {},
        }, verified=None)
        assert v1.status == "parked-deviation"
        assert not os.path.exists(os.path.join(worker_repo, "offscope.txt"))
        governed = (out1.get("output") or {}).get("governedActions") or {}
        assert governed.get("governed") is True
        denied = governed.get("denied") or []
        assert denied, "the denied write must be recorded as evidence"
        assert any("offscope.txt" in (d.get("target") or "") for d in denied)

        run1 = decide_run([("t1", "done", {
            "taskId": "t1", "scopeDeviation": True,
            "scopeCheck": (out1.get("output") or {}).get("scopeCheck") or {},
        }, None)], attempts_used=1, task_contract_id="c-live")
        assert run1.status == "parked"

        built = build_correction(
            task_contract_id="c-live", task_id="t1",
            capability_id="agent.delegate",
            base_input={"task": "Create offscope.txt.", "scopePaths": ["hello.txt"]},
            approved_scope=["hello.txt"],
            deviation=v1, attempt=2,
            extra_context="The previous attempt created offscope.txt, which is "
                          "outside the authorized scope. Create hello.txt instead.")
        assert built["input"]["scopePaths"] == ["hello.txt"]

        out2 = _delegate(
            worker_repo,
            built["input"]["task"],
            built["input"]["scopePaths"])
        assert out2["ok"] is True, out2
        assert os.path.exists(os.path.join(worker_repo, "hello.txt"))

        v2 = decide_task("done", {"taskId": "t1"}, verified=True)
        run2 = decide_run([("t1", "done", {"taskId": "t1"}, True)],
                          attempts_used=2, task_contract_id="c-live")
        assert v2.status == "verified"
        assert run2.status == "continue"

        rec = CorrectionRecord(
            task_contract_id="c-live", task_id="t1",
            worker_node_id="opencode", attempt=2, parent_attempt=1,
            verdict="corrected", reasons=["scope deviation on attempt 1"],
            evidence={"outside": ["offscope.txt"]},
            corrective_input=built["input"])
        assert CorrectionRecord.from_dict(rec.to_dict()) == rec
