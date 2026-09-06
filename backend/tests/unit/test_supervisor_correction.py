"""Supervisor correction loop — deterministic verdicts over worker evidence.

Every test here exercises BEHAVIOR: verdicts derive from outcome states
plus executor-level evidence, corrections rebuild through the governed
input shape, and the budget/restart/attribution guarantees hold on real
(thowaway) repositories. Nothing here consults a model.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess

import pytest

from aura.central_agent.supervisor import (
    MAX_CORRECTION_ATTEMPTS,
    CorrectionRecord,
    build_correction,
    decide_run,
    decide_task,
    validate_correction_scope,
)


def _ev(**kw):
    base = {"taskId": "t1"}
    base.update(kw)
    return base


# ── per-task verdicts ─────────────────────────────────────────────────


class TestDecideTask:
    def test_clean_completion_continues(self):
        v = decide_task("done", _ev(), verified=True)
        assert v.status == "verified"
        assert v.correctable is False

    def test_exit_nonzero_fails_correctably(self):
        v = decide_task("failed", _ev(exitCode=3), verified=False)
        assert v.status == "failed"
        assert v.correctable is True

    def test_timeout_parks_correctably(self):
        v = decide_task("timed-out", _ev(), verified=None)
        assert v.status == "parked-timeout"
        assert v.correctable is True

    def test_cancelled_parks_without_auto_retry(self):
        v = decide_task("cancelled", _ev(), verified=None)
        assert v.status == "parked-cancelled"
        assert v.correctable is False

    def test_denied_is_terminal(self):
        v = decide_task("denied", _ev(), verified=None)
        assert v.status == "denied"
        assert v.correctable is False

    def test_scope_deviation_parks_with_evidence(self):
        v = decide_task(
            "done",
            _ev(scopeDeviation=True,
                scopeCheck={"outside": ["rogue.py"], "changed": ["rogue.py"]}),
            verified=None,
        )
        assert v.status == "parked-deviation"
        assert v.correctable is True
        assert any("rogue.py" in r for r in v.reasons)

    def test_done_unverified_parks(self):
        v = decide_task("done", _ev(), verified=False)
        assert v.status == "parked-unverified"
        assert v.correctable is True

    def test_unknown_state_fails_closed(self):
        v = decide_task("exploded", _ev(), verified=None)
        assert v.status == "failed"
        assert v.correctable is False


# ── run verdicts, budget, DAG blocking ────────────────────────────────


class TestDecideRun:
    def test_all_verified_continues(self):
        r = decide_run([("t1", "done", _ev(), True)], task_contract_id="c1")
        assert r.status == "continue"
        assert r.budget_remaining == MAX_CORRECTION_ATTEMPTS

    def test_denied_is_terminal_failure(self):
        r = decide_run([("t1", "denied", _ev(), None)])
        assert r.status == "failed"

    def test_budget_exhaustion_parks_for_review(self):
        r = decide_run(
            [("t1", "failed", _ev(exitCode=1), False)],
            attempts_used=1 + MAX_CORRECTION_ATTEMPTS)
        assert r.status == "failed-for-review"
        assert r.budget_remaining == 0

    def test_parked_within_budget(self):
        r = decide_run(
            [("t1", "failed", _ev(exitCode=1), False)], attempts_used=1)
        assert r.status == "parked"
        assert r.budget_remaining == MAX_CORRECTION_ATTEMPTS

    def test_parked_upstream_blocks_downstream(self):
        r = decide_run(
            [("tA", "done",
              _ev(taskId="tA", scopeDeviation=True,
                  scopeCheck={"outside": ["rogue.py"]}), None),
             ("tB", "done", _ev(taskId="tB"), True)],
            depends_on={"tB": ["tA"]},
            task_contract_id="c1")
        by_id = {v.task_id: v for v in r.tasks}
        assert by_id["tA"].status == "parked-deviation"
        # tB verified on its own, but its dependency did not: blocked.
        assert by_id["tB"].status == "blocked"
        assert r.status == "parked"

    def test_verified_upstream_does_not_block(self):
        r = decide_run(
            [("tA", "done", _ev(taskId="tA"), True),
             ("tB", "done", _ev(taskId="tB"), True)],
            depends_on={"tB": ["tA"]})
        assert r.status == "continue"


# ── correction assembly ───────────────────────────────────────────────


def _deviation():
    return decide_task(
        "done",
        _ev(taskId="t1", scopeDeviation=True,
            scopeCheck={"outside": ["rogue.py"], "changed": ["rogue.py"]}),
        verified=None)


class TestBuildCorrection:
    def test_correction_keeps_scope_and_links_parent(self):
        d = _deviation()
        built = build_correction(
            task_contract_id="c1", task_id="t1",
            capability_id="agent.delegate",
            base_input={"task": "Write hello.", "scopePaths": ["src/auth"]},
            approved_scope=["src/auth", "tests/auth"],
            deviation=d, attempt=2)
        assert built["input"]["scopePaths"] == ["src/auth", "tests/auth"]
        assert built["input"]["correctionOf"] == "t1"
        assert built["input"]["attempt"] == 2
        assert built["parentAttempt"] == 1
        assert "rogue.py" in built["input"]["task"]
        # Original objective preserved inside the corrective instruction.
        assert "Write hello." in built["input"]["task"]

    def test_narrower_scope_allowed(self):
        d = _deviation()
        built = build_correction(
            task_contract_id="c1", task_id="t1",
            capability_id="agent.delegate",
            base_input={"task": "Write hello."},
            approved_scope=["src/auth", "tests/auth"],
            deviation=d, attempt=2, narrower_scope=["src/auth"])
        assert built["input"]["scopePaths"] == ["src/auth"]

    def test_wider_scope_refused(self):
        d = _deviation()
        with pytest.raises(ValueError, match="[Ww]ider scope"):
            build_correction(
                task_contract_id="c1", task_id="t1",
                capability_id="agent.delegate",
                base_input={"task": "Write hello."},
                approved_scope=["src/auth"],
                deviation=d, attempt=2, narrower_scope=["src"])

    def test_budget_refused(self):
        d = _deviation()
        with pytest.raises(ValueError, match="[Bb]udget"):
            build_correction(
                task_contract_id="c1", task_id="t1",
                capability_id="agent.delegate",
                base_input={"task": "Write hello."},
                approved_scope=["src/auth"],
                deviation=d, attempt=1 + MAX_CORRECTION_ATTEMPTS + 1)

    def test_cancelled_has_no_correction(self):
        v = decide_task("cancelled", _ev(taskId="t1"), verified=None)
        with pytest.raises(ValueError):
            build_correction(
                task_contract_id="c1", task_id="t1",
                capability_id="agent.delegate",
                base_input={"task": "Write hello."},
                approved_scope=["src/auth"],
                deviation=v, attempt=2)

    def test_correction_is_regated_by_fingerprint(self):
        # The corrective input differs from the original (correctionOf,
        # attempt, instruction text), so its approval fingerprint differs:
        # every correction requires a FRESH approval.
        from aura.canonical import fingerprint_invocation

        d = _deviation()
        built = build_correction(
            task_contract_id="c1", task_id="t1",
            capability_id="agent.delegate",
            base_input={"task": "Write hello.", "scopePaths": ["src/auth"]},
            approved_scope=["src/auth"],
            deviation=d, attempt=2)
        before = fingerprint_invocation(
            "agent.delegate",
            {"task": "Write hello.", "scopePaths": ["src/auth"]},
            {"projectId": "p"})
        after = fingerprint_invocation(
            "agent.delegate", built["input"], {"projectId": "p"})
        assert before != after

    def test_validate_correction_scope(self):
        ok, _ = validate_correction_scope(["src/auth/x.py"], ["src/auth"])
        assert ok is True
        ok, reason = validate_correction_scope(["etc/passwd"], ["src/auth"])
        assert ok is False
        assert reason


# ── records: attribution + restart reconstruction ─────────────────────


class TestCorrectionRecords:
    def test_record_round_trip(self):
        rec = CorrectionRecord(
            task_contract_id="c1", task_id="t1", worker_node_id="opencode",
            attempt=2, parent_attempt=1, verdict="parked-deviation",
            reasons=["rogue.py outside scope"],
            evidence={"invocationIds": ["inv-1"], "approvalIds": ["apr-1"],
                      "outside": ["rogue.py"]},
            corrective_input={"task": "retry", "scopePaths": ["src"]})
        restored = CorrectionRecord.from_dict(json.loads(json.dumps(rec.to_dict())))
        assert restored == rec
        assert restored.worker_node_id == "opencode"
        assert restored.parent_attempt == 1

    def test_approval_ledger_survives_restart(self, tmp_path):
        from aura.approvals import ApprovalLedger

        store = tmp_path / "approvals.json"

        def load():
            try:
                return json.loads(store.read_text())
            except OSError:
                return []

        def save(items):
            store.write_text(json.dumps(items))

        first = ApprovalLedger()
        first.attach_store(load, save)
        req = {"id": "apr-1", "state": "pending", "items": [
            {"invocationId": "inv-1", "capabilityId": "agent.delegate",
             "fingerprint": "fp-1"}]}
        first.register("k1", req)
        # Simulate restart: a fresh ledger over the same store file.
        second = ApprovalLedger()
        second.attach_store(load, save)
        pending = second.pending()
        assert any(r["id"] == "apr-1" for r in pending)
        decided = second.decide("apr-1", True, decided_by="human")
        assert decided and decided["state"] == "granted"
        spent = second.consume("apr-1")
        assert spent is not None
        # Single-use: replay finds nothing.
        assert second.consume("apr-1") is None


# ── live correction loop (throwaway repo, real worker) ────────────────


def _git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, timeout=30)


@pytest.fixture()
def worker_repo(tmp_path):
    root = str(tmp_path / "proj")
    import os

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
        # Attempt 1: worker asked for file A, constrained to scope B.
        # (The worker complies with the ASKED file; the scope contract is
        # what makes it a deviation.)
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
        # Nothing reverted by the parking decision.
        assert os.path.exists(os.path.join(worker_repo, "offscope.txt"))

        run1 = decide_run([("t1", "done", {
            "taskId": "t1", "scopeDeviation": True,
            "scopeCheck": (out1.get("output") or {}).get("scopeCheck") or {},
        }, None)], attempts_used=1, task_contract_id="c-live")
        assert run1.status == "parked"

        # Central Agent's correction: same scope, corrective instruction.
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
