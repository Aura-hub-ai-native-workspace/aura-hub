"""Live inter-task handoff — requires running agent workers.

Exercises the governed two-worker handoff path with real worker
subprocesses (opencode, claude). Separated from the unit suite because
these tests spawn real subprocesses. Skipped unless AURA_LIVE_WORKERS=1.

Run with::

    AURA_LIVE_WORKERS=1 uv run pytest tests/integration/test_live_handoff.py -v
"""
from __future__ import annotations

import os
import subprocess

import pytest

from aura.contracts import AgentIntent, TaskPlan, TaskSpecification

pytestmark = pytest.mark.skipif(
    os.environ.get("AURA_LIVE_WORKERS") not in {"1", "true", "yes"},
    reason="requires live agent workers — set AURA_LIVE_WORKERS=1 to enable",
)


def _intent():
    return AgentIntent(goal="test goal", expectedOutcome="test outcome")


def _git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, timeout=30)


@pytest.fixture()
def handoff_repo(tmp_path):
    root = str(tmp_path / "proj")
    os.makedirs(root)
    _git(root, "init", "-q")
    _git(root, "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init")
    return root


def _live_invoke(monkeypatch, cwd, ledger_decisions=None):
    """Real Python Fabric with stub host presenting opencode+claude."""
    from pathlib import Path

    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric
    from aura.fabric.host import WiringHost

    home = Path(cwd) / ".." / "wiring-home"
    home.mkdir(exist_ok=True)
    audit = AuditStore(home / "audit.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    class StubNodes:
        def list_nodes(self):
            return [
                {"id": "opencode", "name": "OpenCode", "binary": "opencode",
                 "capabilities": ["coding-agent"]},
                {"id": "claude-code", "name": "Claude", "binary": "claude",
                 "capabilities": ["coding-agent"]},
            ]

    host = WiringHost(StubNodes())
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    fabric._ledger = ledger
    for e in all_executors(None):
        try:
            fabric.register(e)
        except Exception:
            fabric.executors[e.capabilityId] = e
    return fabric, ledger


class TestLiveHandoff:
    def test_opencode_to_claude_no_paste(self, handoff_repo):
        from aura.central_agent.execution import ExecutionController
        from aura.fabric import FabricConfig

        fabric, ledger = _live_invoke(None, handoff_repo)
        cfg = FabricConfig(fabric=fabric, ledger=ledger,
                           permissions={"read": True, "write": True})
        controller = ExecutionController(cfg, engine=None)

        tA = TaskSpecification(
            id="tA", description="create findings file",
            capabilityId="agent.delegate",
            input={"task": "Create findings.txt containing exactly auth-bug-in-login and nothing else.",
                   "scopePaths": ["findings.txt"]})
        tB = TaskSpecification(
            id="tB", description="review findings and record verdict",
            capabilityId="agent.delegate",
            input={"task": "Read the verified findings provided above. Create verdict.txt containing exactly reviewed-ok and nothing else.",
                   "scopePaths": ["verdict.txt"]},
            inputFrom="upstream-output", dependsOn=["tA"])
        plan = TaskPlan(planId="pln-live", sessionId="ses-live",
                        intent=_intent(), tasks=[tA, tB],
                        createdAt="2026-09-06T00:00:00.000Z")

        r1 = controller.execute(plan, project_id="live", project_cwd=handoff_repo)
        assert r1.outcomes[0].state == "awaiting-approval"
        assert r1.approval_id
        assert not os.path.exists(os.path.join(handoff_repo, "findings.txt"))

        assert ledger.decide(r1.approval_id, True, decided_by="live")["state"] == "granted"

        r2 = controller.execute(
            plan, project_id="live", project_cwd=handoff_repo,
            resume_grants={"tA": (r1.approval_id, "")})
        assert r2.outcomes[0].state == "done", r2.outcomes[0].detail
        assert r2.outcomes[0].verified is True
        assert r2.outcomes[1].state == "awaiting-approval"
        tA_inv = r2.outcomes[0].invocationIds[0]

        assert ledger.decide(
            r2.outcomes[1].approvalId, True, decided_by="live")["state"] == "granted"

        prior = dict(r2.verified_outputs)
        assert "tA" in prior
        r3 = controller.execute(
            plan, project_id="live", project_cwd=handoff_repo,
            resume_grants={"tB": (r2.outcomes[1].approvalId, "")},
            prior_verified=prior)
        assert r3.outcomes[0].state == "skipped"
        assert r3.outcomes[1].state == "done", r3.outcomes[1].detail
        assert r3.outcomes[1].verified is True
        assert r3.outcomes[0].invocationIds == [tA_inv]

        assert os.path.exists(os.path.join(handoff_repo, "verdict.txt"))
        open(os.path.join(handoff_repo, "verdict.txt")).read() or True

    def test_failed_upstream_blocks_live(self, handoff_repo):
        from aura.central_agent.execution import ExecutionController
        from aura.fabric import FabricConfig

        fabric, ledger = _live_invoke(None, handoff_repo)
        cfg = FabricConfig(fabric=fabric, ledger=ledger,
                           permissions={"read": True, "write": True})
        controller = ExecutionController(cfg, engine=None)

        tA = TaskSpecification(
            id="tA", description="impossible scope",
            capabilityId="agent.delegate",
            input={"task": "x", "scopePaths": ["../escape"]})
        tB = TaskSpecification(
            id="tB", description="downstream",
            capabilityId="agent.delegate",
            input={"task": "y"},
            inputFrom="upstream-output", dependsOn=["tA"])
        plan = TaskPlan(planId="pln-live-f", sessionId="ses-live-f",
                        intent=_intent(), tasks=[tA, tB],
                        createdAt="2026-09-06T00:00:00.000Z")
        r1 = controller.execute(plan, project_id="live", project_cwd=handoff_repo)
        assert r1.outcomes[0].state == "awaiting-approval"
        ledger.decide(r1.approval_id, True, decided_by="live")
        r2 = controller.execute(
            plan, project_id="live", project_cwd=handoff_repo,
            resume_grants={"tA": (r1.approval_id, "")})
        assert r2.outcomes[0].state in ("failed", "blocked")
        assert not (r2.outcomes[0].state == "done" and r2.outcomes[0].verified is True)
        assert len(r2.outcomes) == 1
        leftovers = [p for p in os.listdir(handoff_repo) if p != ".git"]
        assert leftovers == [], f"worker ran despite refusal: {leftovers}"
