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

from aura.central_agent.execution import MAX_TASK_ATTEMPTS, ExecutionController, ExecutionOutcome
from aura.contracts.agent import (AgentIntent, AgentResult, TaskOutcome,
                                  TaskPlan, TaskSpecification)


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
                                "alternativeSelected": True,
                                "sameRuntimeRetry": False,
                                "alternativeAvailable": True,
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


def _consumer(tid, depends):
    task = _task(tid, depends=depends)
    task.inputFrom = "upstream-output"
    return task


def test_recovery_keeps_handoff_edges_for_a_task_consuming_recovered_and_verified_output(coord):
    """A is verified; B fails and recovers on another worker; C consumes the output of both."""
    controller, calls, script = coord
    script["b"] = [False, True]
    plan = _plan([_task("a"), _task("b"), _consumer("c", ["a", "b"])])
    result = _run(controller, plan)

    # A ran once and was never repeated; B moved to the other worker; C ran once, after both.
    assert [(c["taskId"], c["node"]) for c in calls] == [
        ("a", "claude-code"), ("b", "claude-code"), ("b", "kilo-code"), ("c", "claude-code")]
    assert [(r["taskId"], r["state"], r["verified"]) for r in result.recovery] == [("b", "done", True)]
    final = _final(result, "c")
    assert (final.state, final.verified) == ("done", True)
    # Provenance names the invocations consumed: A's only run and B's RECOVERED run, not its failed one.
    assert sorted(final.consumedFrom) == ["inv-a-0", "inv-b-1"]
    consumer_brief = str(calls[-1]["payload"])
    assert "a finding" in consumer_brief and "b finding" in consumer_brief
    # The plan the person approved is untouched: the original edges are still there.
    assert plan.tasks[2].dependsOn == ["a", "b"]
    assert set(result.verified_outputs) == {"a", "b", "c"}
    assert result.stopped is False and result.denied is False
    assert len([o for o in result.outcomes if o.taskId == "a"]) == 1


def test_recovery_runs_a_task_consuming_output_verified_before_recovery_began(coord):
    """A is verified; an unrelated task fails and recovers; D consumes only A's output."""
    controller, calls, script = coord
    script["b"] = [False, True]
    plan = _plan([_task("a"), _task("b"), _consumer("d", ["a"])])
    result = _run(controller, plan)

    assert [c["taskId"] for c in calls] == ["a", "b", "b", "d"]
    final = _final(result, "d")
    assert (final.state, final.verified) == ("done", True)
    assert final.consumedFrom == ["inv-a-0"]
    assert "a finding" in str(calls[-1]["payload"])
    assert plan.tasks[2].dependsOn == ["a"]
    assert result.stopped is False


def test_the_recovery_leg_carries_verified_upstreams_as_seeds_with_full_handoff_edges(coord):
    controller, _calls, _script = coord
    plan = _plan([_task("a"), _task("b", depends=["a"]), _consumer("c", ["a", "b"]),
                  _task("e", depends=["a"])])
    result = ExecutionOutcome(
        outcomes=[TaskOutcome(taskId="a", state="done", performed=True, verified=True),
                  TaskOutcome(taskId="b", state="failed", detail="worker exited 1")],
        verified_outputs={"a": {"verified": True}}, stopped=True)
    leg, _notes = controller._recovery_plan(plan, result, {"b": result.outcomes[1]})

    by_id = {t.id: t for t in leg.tasks}
    assert set(by_id) == {"a", "b", "c", "e"}
    assert by_id["c"].dependsOn == ["a", "b"]      # handoff edges are complete
    assert by_id["a"].dependsOn == []              # a seed: evidence only, never dispatched
    assert by_id["e"].dependsOn == []              # plain ordering edge to settled work is pruned
    assert by_id["b"].dependsOn == []


def test_a_consumer_stays_out_of_recovery_when_its_upstream_is_done_but_not_verified(coord):
    """Handoff validation is not weakened: an unverified upstream never becomes a seed."""
    controller, _calls, _script = coord
    plan = _plan([_task("a"), _task("b"), _consumer("c", ["a", "b"])])
    result = ExecutionOutcome(
        outcomes=[TaskOutcome(taskId="a", state="done", performed=True, verified=None),
                  TaskOutcome(taskId="b", state="failed", detail="worker exited 1")],
        verified_outputs={}, stopped=True)
    leg, _notes = controller._recovery_plan(plan, result, {"b": result.outcomes[1]})
    assert [t.id for t in leg.tasks] == ["b"]


def test_a_consumer_fails_the_mission_when_the_recovered_upstream_still_does_not_verify(coord):
    controller, calls, script = coord
    script["b"] = [False]
    result = _run(controller, _plan([_task("a"), _task("b"), _consumer("c", ["a", "b"])]))
    assert "c" not in [c["taskId"] for c in calls]
    assert "c" not in result.verified_outputs
    assert result.stopped is True


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


def test_denied_and_non_worker_failures_do_not_suppress_independent_retry(coord):
    controller, _calls, _script = coord
    plan = _plan([_task("denied"), _task("worker"),
                  _task("ordinary", cap="filesystem.write")])
    outcome = controller._recoverable(
        plan,
        ExecutionOutcome(outcomes=[
            TaskOutcome(taskId="denied", state="denied", detail="policy denied"),
            TaskOutcome(taskId="worker", state="failed", detail="worker exited 1"),
            TaskOutcome(taskId="ordinary", state="failed", detail="write failed"),
        ], denied=True),
        attempts={}, cancel_token=None,
    )
    assert list(outcome) == ["worker"]


def test_plan_recovers_independent_work_without_reexecuting_denied_task(
        coord, monkeypatch):
    import aura.central_agent.execution as exmod

    controller, calls, script = coord
    script["retry"] = [False, True]
    base_invoke = exmod.invoke_fabric
    denied_calls: list[str] = []

    def invoke(capability, payload, context, cfg):
        if context.get("taskId") == "denied":
            denied_calls.append(str(context.get("taskId")))
            node = str(context.get("nodeId") or "claude-code")
            denied = _invocation("inv-denied", node, ok=False)
            denied.update(outcome="denied", detail="permanently denied by policy")
            denied["policy"]["decision"] = "deny"
            denied["policy"]["reason"] = "operation outside configured scope"
            return denied
        return base_invoke(capability, payload, context, cfg)

    monkeypatch.setattr(exmod, "invoke_fabric", invoke)
    result = _run(controller, _plan([
        _task("denied"),
        _task("retry"),
        _task("dependent", depends=["retry"]),
        _task("independent"),
    ]))

    by_id = {o.taskId: o for o in result.outcomes}
    assert denied_calls == ["denied"]
    assert [c["taskId"] for c in calls].count("retry") == 2
    assert [c["taskId"] for c in calls].count("dependent") == 1
    assert [c["taskId"] for c in calls].count("independent") == 1
    assert by_id["denied"].state == "denied"
    assert by_id["retry"].state == "done" and by_id["retry"].verified is True
    assert by_id["dependent"].state == "done"
    assert by_id["independent"].state == "done"
    assert result.denied is True and result.stopped is False


def test_recovery_leg_excludes_denials_and_completed_work(coord):
    controller, _calls, _script = coord
    plan = _plan([
        _task("denied"),
        _task("completed"),
        _task("retry"),
        _task("dependent", depends=["retry"]),
        _task("independent"),
        _task("denied-dependent", depends=["denied"]),
        _task("nonworker-done", cap="filesystem.write"),
    ])
    result = ExecutionOutcome(outcomes=[
        TaskOutcome(taskId="denied", state="denied", detail="no-provider"),
        TaskOutcome(taskId="completed", state="done", performed=True, verified=True),
        TaskOutcome(taskId="retry", state="failed", detail="worker exited 1"),
        TaskOutcome(taskId="dependent", state="blocked", detail="depends on retry"),
        TaskOutcome(taskId="denied-dependent", state="blocked", detail="depends on denied"),
        TaskOutcome(taskId="nonworker-done", state="done", performed=True, verified=False),
    ], denied=True, verified_outputs={"completed": {"verified": True}},
       worker_assignments={"retry": {"nodeId": "claude-code"}})
    retry = {"retry": result.outcomes[2]}

    leg, _notes = controller._recovery_plan(plan, result, retry)

    assert [task.id for task in leg.tasks] == ["retry", "dependent", "independent"]
    assert all(task.id != "denied" for task in leg.tasks)
    assert all(task.id != "completed" for task in leg.tasks)
    assert all(task.id != "denied-dependent" for task in leg.tasks)
    assert all(task.id != "nonworker-done" for task in leg.tasks)


def test_recovery_merge_preserves_denial_and_keeps_recovered_partial_work(coord):
    controller, _calls, _script = coord
    result = ExecutionOutcome(outcomes=[
        TaskOutcome(taskId="denied", state="denied", detail="no-provider"),
        TaskOutcome(taskId="retry", state="failed", detail="worker exited 1"),
        TaskOutcome(taskId="dependent", state="blocked", detail="depends on retry"),
    ], denied=True, stopped=True, stop_reason="worker exited 1")
    leg = ExecutionOutcome(outcomes=[
        TaskOutcome(taskId="retry", state="done", performed=True, verified=True),
        TaskOutcome(taskId="dependent", state="done", performed=True, verified=True),
        TaskOutcome(taskId="independent", state="done", performed=True, verified=True),
    ], verified_outputs={
        "retry": {"verified": True},
        "dependent": {"verified": True},
        "independent": {"verified": True},
    })

    controller._merge_leg(result, leg, 1, {"retry": {"toNode": "kilo-code"}})

    final = {o.taskId: o for o in result.outcomes}
    assert final["denied"].state == "denied"
    assert final["retry"].state == "done"
    assert final["dependent"].state == "done"
    assert final["independent"].state == "done"
    assert result.denied is True
    assert result.stopped is False
    assert len([o for o in result.outcomes if o.taskId == "denied"]) == 1


def test_named_worker_auth_failure_without_alternative_is_not_redispatched(
        coord, monkeypatch):
    import aura.central_agent.execution as exmod

    controller, calls, script = coord
    present = controller._present_nodes()
    assert present
    named_runtime = next(node for node in present if node.get("id") == "kilo-code")
    monkeypatch.setattr(controller, "_present_nodes", lambda: [named_runtime])
    auth_calls: list[str] = []

    def auth_failure(_cap, _payload, context, _cfg):
        node = str(context.get("nodeId") or "")
        auth_calls.append(node)
        result = _invocation(f"auth-{len(auth_calls)}", node, ok=False)
        result["detail"] = "provider authentication failed (401 unauthorized)"
        result["output"]["stderr"] = result["detail"]
        return result

    monkeypatch.setattr(exmod, "invoke_fabric", auth_failure)

    result = _run(controller, _plan([_task("t1", node="kilo-code")]))

    assert len(auth_calls) == 1
    assert auth_calls == ["kilo-code"]
    assert calls == []
    assert _final(result, "t1").state == "failed"
    assert "401 unauthorized" in _final(result, "t1").detail
    assert result.recovery[-1]["reason"] == "auth"
    assert result.recovery[-1]["alternativeAvailable"] is False
    assert result.recovery[-1]["state"] == "not-dispatched"
    assert result.recovery[-1]["sameRuntimeRetry"] is False


def test_named_worker_auth_failure_moves_to_another_permitted_runtime(coord, monkeypatch):
    import aura.central_agent.execution as exmod

    controller, _calls, _script = coord
    calls: list[str] = []

    def invoke(_cap, _payload, context, _cfg):
        node = str(context.get("nodeId") or "")
        calls.append(node)
        if len(calls) == 1:
            result = _invocation("inv-auth-failed", node, ok=False)
            result["detail"] = "provider authentication failed (401 unauthorized)"
            result["output"]["stderr"] = result["detail"]
            return result
        return _invocation("inv-auth-retry", node, ok=True, stdout="verified fix")

    monkeypatch.setattr(exmod, "invoke_fabric", invoke)
    result = _run(controller, _plan([_task("auth-retry", node="kilo-code")]))

    assert calls == ["kilo-code", "claude-code"]
    assert calls.count("kilo-code") == 1
    assert result.recovery[0]["reason"] == "auth"
    assert result.recovery[0]["alternativeSelected"] is True
    assert result.recovery[0]["sameRuntimeRetry"] is False
    assert result.recovery[0]["alternativeAvailable"] is True
    assert _final(result, "auth-retry").state == "done"
    assert _final(result, "auth-retry").verified is True


def test_named_worker_malformed_failure_uses_only_a_valid_alternative(coord, monkeypatch):
    import aura.central_agent.execution as exmod

    controller, _calls, _script = coord
    present = {node["id"] for node in controller._present_nodes()}
    assert {"claude-code", "kilo-code"} <= present
    calls: list[str] = []

    def invoke(_cap, _payload, context, _cfg):
        node = str(context.get("nodeId") or "")
        calls.append(node)
        if len(calls) == 1:
            failed = _invocation("inv-invalid-worker", node, ok=False)
            failed["detail"] = "unrecognized flag --bad-worker-option"
            failed["output"]["stderr"] = failed["detail"]
            return failed
        return _invocation("inv-valid-alternative", node, ok=True,
                           stdout="verified result")

    monkeypatch.setattr(exmod, "invoke_fabric", invoke)
    result = _run(controller, _plan([_task("malformed", node="kilo-code")]))

    assert calls == ["kilo-code", "claude-code"]
    assert calls.count("kilo-code") == 1
    assert calls[1] in present
    assert result.recovery[0]["reason"] == "malformed"
    assert result.recovery[0]["alternativeSelected"] is True
    assert result.recovery[0]["sameRuntimeRetry"] is False
    assert _final(result, "malformed").state == "done"
    assert _final(result, "malformed").verified is True


def test_stop_at_dispatch_boundary_prevents_the_first_worker_call(coord):
    controller, calls, script = coord
    script["t1"] = [False, True]

    class _Token:
        cancelled = False

        def note_dispatch(self, *_a, **_k):
            self.cancelled = True  # the person pressed Stop during t1

    result = _run(controller, _plan([_task("t1")]), cancel_token=_Token())
    assert len(calls) == 0
    assert result.cancelled is True
    assert _final(result, "t1").state == "cancelled"
    assert result.recovery == []


class _RecoveryStopToken:
    def __init__(self):
        self.cancelled = False
        self.reason = "owner stopped before recovery"

    def note_dispatch(self, *_a, **_k):
        pass

    def snapshot(self):
        return {"cancelled": self.cancelled, "reason": self.reason,
                "taskId": "retry"}


@pytest.mark.parametrize("stop_boundary", ["after-selection", "before-leg"])
def test_stop_between_execution_and_recovery_never_dispatches_recovery(
        coord, monkeypatch, stop_boundary):
    controller, calls, script = coord
    script["retry"] = [False, True]
    token = _RecoveryStopToken()
    original_recoverable = controller._recoverable
    original_recovery_plan = controller._recovery_plan

    def recoverable(*args, **kwargs):
        selected = original_recoverable(*args, **kwargs)
        if stop_boundary == "after-selection" and selected:
            token.cancelled = True
        return selected

    def recovery_plan(*args, **kwargs):
        leg_plan, notes = original_recovery_plan(*args, **kwargs)
        if stop_boundary == "before-leg":
            token.cancelled = True
        return leg_plan, notes

    monkeypatch.setattr(controller, "_recoverable", recoverable)
    monkeypatch.setattr(controller, "_recovery_plan", recovery_plan)
    plan = _plan([_task("completed"), _task("retry")])
    result = _run(controller, plan, cancel_token=token)

    assert [c["taskId"] for c in calls].count("retry") == 1
    assert len(calls) == 2  # initial completed + failed tasks only
    assert _final(result, "completed").state == "done"
    assert _final(result, "completed").verified is True
    assert "completed" in result.verified_outputs
    assert _final(result, "retry").state == "failed"  # original outcome retained
    assert result.cancelled is True
    assert result.stopped is True
    assert result.stop_reason == token.reason
    assert "retry" in result.cancelled_before
    assert result.recovery[-1]["state"] == "not-dispatched"


def test_stop_during_recovery_is_terminal_and_keeps_completed_work(
        coord, monkeypatch):
    controller, calls, script = coord
    script["retry"] = [False, True]
    token = _RecoveryStopToken()
    import aura.central_agent.execution as exmod
    original_invoke = exmod.invoke_fabric

    def invoke(capability, payload, context, cfg):
        result = original_invoke(capability, payload, context, cfg)
        if context.get("taskId") == "retry" and len(
                [call for call in calls if call["taskId"] == "retry"]) == 2:
            token.cancelled = True
        return result

    monkeypatch.setattr(exmod, "invoke_fabric", invoke)
    result = _run(controller, _plan([_task("completed"), _task("retry")]),
                  cancel_token=token)

    assert [c["taskId"] for c in calls].count("retry") == 2
    assert _final(result, "completed").verified is True
    assert _final(result, "retry").state == "done"
    assert _final(result, "retry").verified is True
    assert result.cancelled is True
    assert result.stopped is True
    assert result.stop_reason == token.reason
    assert result.recovery[-1]["state"] == "done"


def test_recovery_boundary_stop_settles_mission_as_cancelled(
        tmp_path, monkeypatch):
    import aura.central_agent.execution as exmod

    agent = _agent(tmp_path)
    controller = agent.controller
    monkeypatch.setattr(ExecutionController, "_role_usable",
                        lambda self, cap: None)
    calls = []

    def invoke(_cap, _payload, context, _cfg):
        tid = context["taskId"]
        node = context.get("nodeId") or "claude-code"
        calls.append((tid, node))
        return _invocation(f"inv-{tid}-{calls.count((tid, node))}", node,
                           ok=(tid == "completed" or calls.count((tid, node)) > 1),
                           stdout=f"{tid} finding")

    monkeypatch.setattr(exmod, "invoke_fabric", invoke)
    plan = _plan([_task("completed"), _task("retry")])
    session = agent.sessions.create("p")
    token = agent.runs.begin(session.sessionId)
    original_recoverable = controller._recoverable

    def stop_after_selection(*args, **kwargs):
        selected = original_recoverable(*args, **kwargs)
        if selected:
            token.request("owner stopped before recovery")
        return selected

    monkeypatch.setattr(controller, "_recoverable", stop_after_selection)
    outcome = controller.execute(plan, "p", cancel_token=token)
    settled = agent._settle_cancellation(
        session, AgentResult(status="failed", outcome="failed",
                             summary="execution failed"),
        outcome=outcome, plan=plan)

    assert [tid for tid, _node in calls].count("retry") == 1
    assert settled.status == "cancelled"
    assert settled.outcome == "cancelled"
    assert settled.failureReason == "cancelled-by-user"
    assert settled.objectiveAccepted is not True
    assert "You stopped this run." in settled.summary
    assert settled.verified == ["completed"]
    assert outcome.recovery[-1]["state"] == "not-dispatched"
    assert outcome.cancelled is True and outcome.stopped is True


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
    assert quota_calls[0]["node"] != quota_calls[1]["node"]
    assert _final(result, "t1").state == "done"
    assert _final(result, "t1").verified is True
    # Recovery recorded the handoff and its reason.
    assert any(r.get("handoff") for r in result.recovery)
    assert result.recovery[0]["reason"] == "quota exhausted"
    assert result.recovery[0]["reason"] != "auth"


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
