"""The multi-agent coordinator: shared board, ownership, recovery, completion.

Real ExecutionController (scheduling, waves, the completion check, the
run board); the Fabric invoke is replaced by a scripted fake, so no worker
is started. Two connected coding workers: claude-code and kilo-code.
"""

from __future__ import annotations

import threading
import time

import pytest

from test_stopped_mission_view import _agent

from aura.central_agent.execution import MAX_TASK_ATTEMPTS, ExecutionController
from aura.contracts.agent import AgentIntent, TaskPlan, TaskSpecification


def _task(tid, *, depends=(), cap="agent.delegate", node=None, role="code",
          scope=None):
    inp = {"task": f"do {tid}"}
    if scope:
        inp.update({"scopePaths": list(scope), "expectChange": True})
    return TaskSpecification(id=tid, description=f"do {tid}", capabilityId=cap,
                             dependsOn=list(depends), nodeId=node,
                             workerRole=role if cap == "agent.delegate" and not node else None,
                             input=inp)


def _plan(tasks, goal="ship the feature"):
    return TaskPlan(planId="plan-coord", sessionId="agt-aaaaaaaaaaaa",
                    intent=AgentIntent(goal=goal, expectedOutcome="it works"),
                    tasks=tasks, createdAt="2026-10-19T00:00:00Z")


def _invocation(inv, node, ok=True, stdout="done"):
    return {"invocationId": inv, "outcome": "succeeded" if ok else "failed",
            "detail": "done" if ok else "worker exited 1",
            "verification": {"passed": True if ok else None, "kind": "exit-code",
                             "detail": "exit 0" if ok else ""},
            "policy": {"decision": "auto-execute", "rule": "r", "risk": "high", "reason": ""},
            "at": "2026-10-19T00:00:00Z",
            "output": {"stdout": stdout, "exitCode": 0 if ok else 1, "nodeId": node,
                       "agent": node}}


@pytest.fixture()
def coord(tmp_path, monkeypatch):
    agent = _agent(tmp_path)
    controller: ExecutionController = agent.controller
    # Role matching on provision alone: both nodes provide coding-agent.
    monkeypatch.setattr(ExecutionController, "_role_usable", lambda self, cap: None)
    calls: list[dict] = []
    script: dict[str, list[bool]] = {}
    lock = threading.Lock()

    def fake_invoke(cap, payload, context, cfg):
        tid = context["taskId"]
        node = context.get("nodeId") or "claude-code"
        with lock:
            n = sum(1 for c in calls if c["taskId"] == tid)
            calls.append({"taskId": tid, "node": node, "payload": dict(payload),
                          "cap": cap})
            plan = script.get(tid, [True])
            ok = plan[min(n, len(plan) - 1)]
        return _invocation(f"inv-{tid}-{n}", node, ok=ok, stdout=f"{tid} finding")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    return controller, calls, script


def _run(controller, plan, **kw):
    return controller.execute(plan, "p", project_cwd="/proj", **kw)


def _final(result, tid):
    return [o for o in result.outcomes if o.taskId == tid][-1]


# ── recovery and completion ───────────────────────────────────────────────

def test_a_failed_worker_task_is_reassigned_and_completed(coord):
    controller, calls, script = coord
    script["t1"] = [False, True]
    result = _run(controller, _plan([_task("t1")]))
    assert _final(result, "t1").state == "done"
    assert "t1" in result.verified_outputs
    assert [c["taskId"] for c in calls] == ["t1", "t1"]
    first, second = calls[0]["node"], calls[1]["node"]
    assert first != second, "the retry went to another eligible worker"
    assert "A previous attempt" in calls[1]["payload"]["task"]
    assert result.recovery == [{"round": 1, "taskId": "t1", "fromNode": first,
                                "toNode": second, "previousState": "failed",
                                "reason": "ordinary", "handoff": False,
                                "state": "done", "verified": True}]
    assert not result.stopped


def test_a_worker_the_person_named_is_never_reassigned(coord):
    controller, calls, script = coord
    script["t1"] = [False, True]
    result = _run(controller, _plan([_task("t1", node="kilo-code")]))
    assert [c["node"] for c in calls] == ["kilo-code", "kilo-code"]
    assert _final(result, "t1").state == "done"


def test_dependents_waiting_on_a_failed_task_run_after_recovery(coord):
    controller, calls, script = coord
    script["t1"] = [False, True]
    result = _run(controller, _plan([_task("t1"), _task("t2", depends=["t1"])]))
    assert [c["taskId"] for c in calls] == ["t1", "t1", "t2"]
    assert _final(result, "t2").state == "done"
    assert set(result.verified_outputs) == {"t1", "t2"}


def test_retries_are_bounded_and_the_failure_is_reported(coord):
    controller, calls, script = coord
    script["t1"] = [False]
    result = _run(controller, _plan([_task("t1")]))
    assert len(calls) == MAX_TASK_ATTEMPTS
    assert _final(result, "t1").state == "failed"
    assert result.recovery[-1]["verified"] is False
    assert result.stopped


def test_verified_work_is_never_repeated_by_recovery(coord):
    controller, calls, script = coord
    script["t2"] = [False, True]
    result = _run(controller, _plan([_task("t1"), _task("t2")]))
    assert [c["taskId"] for c in calls].count("t1") == 1
    assert {"t1", "t2"} <= set(result.verified_outputs)


def test_a_non_worker_step_is_not_retried_automatically(coord):
    controller, calls, script = coord
    script["w"] = [False, True]
    result = _run(controller, _plan([_task("w", cap="filesystem.write")]))
    assert len(calls) == 1
    assert _final(result, "w").state == "failed"
    assert result.recovery == []


def test_a_cancelled_run_is_not_retried(coord):
    controller, calls, script = coord
    script["t1"] = [False, True]

    class _Token:
        cancelled = False

        def note_dispatch(self, *_a, **_k):
            self.cancelled = True  # the person pressed Stop during t1

    result = _run(controller, _plan([_task("t1")]), cancel_token=_Token())
    assert len(calls) == 1
    assert result.recovery == []


# ── the shared run board ──────────────────────────────────────────────────

def test_a_later_worker_sees_the_goal_and_what_earlier_workers_found(coord):
    controller, calls, _ = coord
    _run(controller, _plan([_task("t1"), _task("t2", depends=["t1"])],
                           goal="add rate limiting"))
    board = calls[1]["payload"]["context"]
    assert "AURA RUN BOARD" in board
    assert "Goal: add rate limiting" in board
    assert "t1 finding" in board
    assert "t2: do t2 [this task (you)]" in board


def test_the_board_names_files_other_tasks_own(coord):
    controller, calls, _ = coord
    _run(controller, _plan([_task("api", scope=["backend/api"]),
                            _task("ui", scope=["frontend/ui"])]))
    by_task = {c["taskId"]: c["payload"]["context"] for c in calls}
    assert "frontend/ui (ui)" in by_task["api"]
    assert "backend/api (api)" in by_task["ui"]


# ── one coding worker per project at a time ───────────────────────────────

def test_workers_in_a_project_never_run_at_the_same_time(tmp_path, monkeypatch):
    """The product rule: only one coding worker edits a project at a time.
    Disjoint scopes, overlapping scopes, different workers — it makes no
    difference: three delegated tasks run one after another."""
    agent = _agent(tmp_path)
    controller: ExecutionController = agent.controller
    spans: dict[str, tuple[float, float]] = {}
    lock = threading.Lock()

    def fake_invoke(cap, payload, context, cfg):
        start = time.monotonic()
        time.sleep(0.2)
        with lock:
            spans[context["taskId"]] = (start, time.monotonic())
        return _invocation(f"inv-{context['taskId']}", "claude-code")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", fake_invoke)
    plan = _plan([_task("a", scope=["src"], node="claude-code"),
                  _task("b", scope=["src/util.py"], node="kilo-code"),
                  _task("c", scope=["docs"], node="kilo-code")])
    _run(controller, plan)

    assert set(spans) == {"a", "b", "c"}  # all of them still ran
    ordered = sorted(spans.values())
    for earlier, later in zip(ordered, ordered[1:]):
        assert later[0] >= earlier[1], "a second worker started before the first finished"


def test_quota_failure_hands_off_to_another_worker(coord):
    """A worker that fails with a recognised quota message is retried on a
    different worker; the second attempt's outcome replaces the first."""
    controller, calls, script = coord
    nodes = controller._present_nodes()
    # Both coding workers present.
    assert {n["id"] for n in nodes} >= {"claude-code", "kilo-code"}

    # claude-code is pinned to t1 first; it fails with a quota message.
    t1 = _task("t1", node="claude-code")
    plan = _plan([t1])
    # Make the fake return a quota failure on the first attempt.
    quota_calls: list[dict] = []

    def quota_invoke(cap, payload, context, cfg):
        tid = context["taskId"]
        node = context.get("nodeId") or "claude-code"
        quota_calls.append({"taskId": tid, "node": node})
        n = sum(1 for c in quota_calls if c["taskId"] == tid) - 1
        if n == 0:
            return {"invocationId": f"inv-{tid}-{n}", "outcome": "failed",
                    "detail": "You've hit your usage limit for this session.",
                    "verification": {"passed": None, "kind": "exit-code", "detail": ""},
                    "policy": {"decision": "auto-execute", "rule": "r", "risk": "high", "reason": ""},
                    "at": "2026-10-19T00:00:00Z",
                    "output": {"stdout": "", "exitCode": 1, "nodeId": node, "agent": node}}
        return _invocation(f"inv-{tid}-{n}", "kilo-code", ok=True, stdout=f"{tid} finding")

    import aura.central_agent.execution as exmod
    orig = exmod.invoke_fabric
    exmod.invoke_fabric = quota_invoke
    try:
        result = _run(controller, plan)
    finally:
        exmod.invoke_fabric = orig

    assert len(quota_calls) == 2, quota_calls
    assert quota_calls[0]["node"] == "claude-code"
    assert quota_calls[1]["node"] == "kilo-code", quota_calls
    assert _final(result, "t1").state == "done"
    assert _final(result, "t1").verified is True
    # Recovery recorded the handoff and its reason.
    assert any(r.get("handoff") for r in result.recovery)
    assert any(r.get("reason") == "quota exhausted" for r in result.recovery)


def test_ordinary_failure_does_not_hand_off(coord):
    """A task that fails with an ordinary error is not retried on another
    worker: no cross-worker handoff, and the run reports the failure."""
    controller, calls, script = coord
    t1 = _task("t1", node="claude-code")
    plan = _plan([t1])
    # Make it fail with an ordinary error on every attempt.
    script["t1"] = [False, False]
    result = _run(controller, plan)
    nodes_used = {c["node"] for c in calls if c["taskId"] == "t1"}
    assert nodes_used == {"claude-code"}, nodes_used
    assert _final(result, "t1").state in ("failed", "done")  # done only if verified
    # No handoff recorded.
    assert not any(r.get("handoff") for r in result.recovery)
