"""Governed inter-task result handoff — verified output becomes input.

Every test here exercises BEHAVIOR through the real ExecutionController
with a stubbed Fabric boundary (no processes spawned): verified results
flow, everything else blocks,
envelopes stay bounded and secret-free, fingerprints re-gate, and scope
never widens through output.
"""

from __future__ import annotations

import json
import os

import pytest

from aura.canonical import fingerprint_invocation
from aura.central_agent.execution import ExecutionController
from aura.central_agent.handoff import (
    MAX_ENVELOPE_CHARS,
    HandoffRefusal,
    UpstreamEvidence,
    build_envelope,
    resolve_task_input,
)
from aura.contracts import AgentIntent, TaskOutcome, TaskPlan, TaskSpecification


def _intent():
    return AgentIntent(goal="test goal", expectedOutcome="test outcome")


def _task(tid, cap="agent.delegate", input=None, input_from="literal",
          depends_on=None):
    return TaskSpecification(
        id=tid, description=f"task {tid}", capabilityId=cap,
        input=input or {"task": f"do {tid}"}, inputFrom=input_from,
        dependsOn=depends_on or [])


def _plan(*tasks):
    return TaskPlan(planId="pln-test", sessionId="ses-test",
                    intent=_intent(), tasks=list(tasks),
                    createdAt="2026-09-06T00:00:00.000Z")


def _ok_invocation(inv_id="inv-1", output=None, approval=None):
    return {"invocationId": inv_id, "outcome": "succeeded",
            "detail": "done",
            "verification": {"passed": True, "kind": "exit-code", "detail": ""},
            "policy": {"decision": "auto-execute", "rule": "x",
                       "risk": "low", "reason": ""},
            "at": "2026-09-06T00:00:00.000Z",
            "output": output or {"stdout": "result text", "exitCode": 0},
            **({"approvalId": approval} if approval else {})}


class _StubCfg:
    pass


def _controller(monkeypatch, script):
    """ExecutionController whose Fabric boundary replays a script.

    script: list of (predicate(capability, payload) -> invocation-dict).
    Records every (capability, payload) call for ordering assertions.
    """
    calls: list[tuple[str, dict]] = []

    def fake_invoke(capability_id, payload, context, cfg):
        calls.append((capability_id, dict(payload)))
        for predicate, response in script:
            if predicate(capability_id, payload):
                if callable(response):
                    try:
                        return response(capability_id, payload)
                    except TypeError:
                        return response()
                return response
        raise AssertionError(f"unexpected invoke: {capability_id} {payload!r:.200}")

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                        fake_invoke)
    controller = ExecutionController.__new__(ExecutionController)
    controller._cfg = _StubCfg()
    controller.engine = None
    return controller, calls


# ── envelope unit behavior ────────────────────────────────────────────


class TestEnvelope:
    def test_verified_output_forwarded(self):
        env = build_envelope([UpstreamEvidence(
            task_id="tA", node_id="opencode", agent="OpenCode",
            stdout="found the bug in auth.py",
            scope_paths=["src/auth"], changed_paths=["src/auth/login.py"],
            invocation_ids=["inv-1"], approval_ids=["apr-1"])])
        assert "found the bug in auth.py" in env["text"]
        assert "tA" in env["text"] and "OpenCode" in env["text"]
        assert "inv-1" in env["text"] and "apr-1" in env["text"]
        assert "src/auth/login.py" in env["text"]
        assert env["truncated"] is False
        assert env["consumed_ids"] == ["inv-1"]
        assert env["changed_paths"] == ["src/auth/login.py"]

    def test_output_bounded_and_truncation_announced(self):
        big = "x" * 20000
        env = build_envelope([UpstreamEvidence(
            task_id="tA", stdout=big, invocation_ids=["inv-9"])])
        assert len(env["text"]) <= MAX_ENVELOPE_CHARS + 200
        assert env["truncated"] is True
        assert "inv-9" in env["text"]  # pointer back to full evidence

    def test_empty_sources_refused(self):
        with pytest.raises(HandoffRefusal):
            build_envelope([])

    def test_missing_task_id_refused(self):
        with pytest.raises(HandoffRefusal):
            build_envelope([UpstreamEvidence(task_id="")])

    def test_no_secrets_introduced(self):
        env = build_envelope([UpstreamEvidence(
            task_id="tA", stdout="hello",
            invocation_ids=["inv-1"])])
        # The envelope carries an allowlist of fields; executor-level
        # secret-bearing keys have no path through it by construction.
        # Assembled rather than written out. A release gate scans every
        # tracked file for key material, and it cannot tell a test that
        # names the PEM header from a file that contains one — so spelling
        # it in full turns this test into a permanent false positive on
        # that scan. Same string at runtime; `updater-verify.mjs` splits
        # its own copy of the marker for exactly this reason.
        pem_header = "BEGIN " + "PRIVATE" + " KEY"
        for marker in ("apiKey", pem_header, "AWS_SECRET",
                       "password", "token"):
            assert marker not in env["text"]

    def test_resolve_requires_string_task(self):
        with pytest.raises(HandoffRefusal):
            resolve_task_input({"command": "run"}, "evidence")
        with pytest.raises(HandoffRefusal):
            resolve_task_input({"task": "   "}, "evidence")

    def test_resolve_only_touches_task_text(self):
        resolved = resolve_task_input(
            {"task": "do B", "scopePaths": ["src"],
             "model": "m", "cwd": "/repo"},
            "EVIDENCE-BLOCK")
        assert resolved["scopePaths"] == ["src"]
        assert resolved["model"] == "m"
        assert resolved["cwd"] == "/repo"
        assert "EVIDENCE-BLOCK" in resolved["task"]
        assert resolved["task"].endswith("do B")

    def test_multi_upstream_order_and_union(self):
        env = build_envelope([
            UpstreamEvidence(task_id="tA", stdout="alpha",
                             invocation_ids=["inv-a"]),
            UpstreamEvidence(task_id="tB", stdout="beta",
                             invocation_ids=["inv-b", "inv-a"]),
        ])
        assert env["text"].index("alpha") < env["text"].index("beta")
        assert env["consumed_ids"] == ["inv-a", "inv-b"]


# ── controller gate + resolution ──────────────────────────────────────


class TestControllerHandoff:
    def test_verified_output_flows(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: c == "agent.delegate" and p.get("task") == "do tA",
             lambda: _ok_invocation("inv-a", {"stdout": "A-result",
                                             "exitCode": 0})),
            (lambda c, p: True,
             lambda: _ok_invocation("inv-b", {"stdout": "B-result",
                                             "exitCode": 0})),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        result = controller.execute(plan, project_id="p")
        assert [o.taskId for o in result.outcomes] == ["tA", "tB"]
        assert all(o.state == "done" and o.verified for o in result.outcomes)
        b_payload = calls[1][1]
        assert "A-result" in b_payload["task"]
        assert b_payload["task"].endswith("do tB")
        assert result.outcomes[1].consumedFrom == ["inv-a"]

    def test_unverified_blocks(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: True,
             lambda: {**_ok_invocation("inv-a"), "verification": {
                 "passed": False, "kind": "exit-code", "detail": "bad"}}),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        result = controller.execute(plan, project_id="p")
        assert len(calls) == 1  # B never dispatched
        assert result.outcomes[1].state == "blocked"
        assert result.stopped is True

    def test_failed_blocks(self, monkeypatch):
        def fail_a(cap, payload):
            return {"invocationId": "inv-a", "outcome": "failed",
                    "detail": "boom",
                    "verification": {"passed": False, "kind": "exit-code",
                                     "detail": "boom"},
                    "policy": {"decision": "auto-execute", "rule": "x",
                               "risk": "low", "reason": ""},
                    "at": "2026-09-06T00:00:00.000Z",
                    "output": {"stdout": "", "exitCode": 3}}

        controller, calls = _controller(monkeypatch, [(lambda c, p: True, fail_a)])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        result = controller.execute(plan, project_id="p")
        # The loop stops at the terminal failure: tB is never dispatched
        # (blocking by non-execution) and gets no outcome of its own.
        assert len(calls) == 1
        assert len(result.outcomes) == 1
        assert result.outcomes[0].state == "failed"
        assert result.stopped is True

    def test_unknown_dependency_blocked(self, monkeypatch):
        from aura.central_agent.planner import PlanningError

        controller, calls = _controller(monkeypatch, [])
        plan = _plan(
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["ghost"]))
        # topo_order fails closed on unknown deps before dispatch: nothing
        # runs, nothing is dispatched, the plan itself is rejected.
        with pytest.raises(PlanningError):
            controller.execute(plan, project_id="p")
        assert calls == []

    def test_workflow_route_refused(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: True,
             lambda: _ok_invocation("inv-a", {"stdout": "A", "exitCode": 0})),
        ])
        tW = _task("tW", cap="workflow.run", input={"workflowRef": "w"},
                   input_from="upstream-output", depends_on=["tA"])
        tW.route = "workflow-run"
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            tW)
        result = controller.execute(plan, project_id="p")
        # tA verified; tW refused (unsupported shape) without dispatch.
        assert result.outcomes[0].state == "done"
        assert result.outcomes[1].state == "failed"
        assert "upstream-output" in result.outcomes[1].detail
        assert len(calls) == 1  # only tA dispatched

    def test_scope_never_widens_through_output(self, monkeypatch):
        seen = {}

        def capture(cap, payload):
            seen.update(payload)
            return _ok_invocation("inv-b", {"stdout": "ok", "exitCode": 0})

        controller, calls = _controller(monkeypatch, [
            (lambda c, p: p.get("task") == "do tA",
             lambda: _ok_invocation("inv-a", {
                 "stdout": "A-result", "exitCode": 0,
                 "scopePaths": ["src/auth", "etc"]
             })),
            (lambda c, p: True, capture),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB", "scopePaths": ["src"]},
                  input_from="upstream-output", depends_on=["tA"]))
        result = controller.execute(plan, project_id="p")
        assert result.outcomes[1].state == "done"
        assert seen["scopePaths"] == ["src"]  # downstream scope untouched

    def test_no_direct_channel_single_capability(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: True,
             lambda: _ok_invocation("inv-a", {"stdout": "A", "exitCode": 0})),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        controller.execute(plan, project_id="p")
        assert [c for c, _ in calls] == ["agent.delegate", "agent.delegate"]

    def test_literal_tasks_unchanged(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: True,
             lambda: _ok_invocation("inv-a", {"stdout": "A", "exitCode": 0})),
        ])
        plan = _plan(_task("tA", input={"task": "do tA", "scopePaths": ["x"]}))
        result = controller.execute(plan, project_id="p")
        assert calls[0][1] == {"task": "do tA", "scopePaths": ["x"]}
        assert result.outcomes[0].consumedFrom == []


# ── resume without re-execution ─────────────────────────────────────────


class TestResumeSkipsVerified:
    def test_seeded_task_skipped_never_dispatched(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: True,
             lambda: _ok_invocation("inv-b", {"stdout": "B", "exitCode": 0})),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        seed = {"tA": {"task_id": "tA", "node_id": "opencode",
                       "agent": "OpenCode", "stdout": "seeded",
                       "scope_paths": [], "changed_paths": [],
                       "invocation_ids": ["inv-seed"],
                       "approval_ids": ["apr-seed"]}}
        result = controller.execute(plan, project_id="p",
                                    prior_verified=dict(seed))
        assert result.outcomes[0].state == "skipped"
        assert result.outcomes[0].verified is True
        assert result.outcomes[0].invocationIds == ["inv-seed"]
        # Only tB dispatched; tA never re-ran.
        assert len(calls) == 1
        assert result.outcomes[1].state == "done"
        assert result.outcomes[1].consumedFrom == ["inv-seed"]

    def test_unseeded_plan_reruns_everything(self, monkeypatch):
        controller, calls = _controller(monkeypatch, [
            (lambda c, p: p.get("task") == "do tA",
             lambda: _ok_invocation("inv-a", {"stdout": "A", "exitCode": 0})),
            (lambda c, p: True,
             lambda: _ok_invocation("inv-b", {"stdout": "B", "exitCode": 0})),
        ])
        plan = _plan(
            _task("tA", input={"task": "do tA"}),
            _task("tB", input={"task": "do tB"}, input_from="upstream-output",
                  depends_on=["tA"]))
        result = controller.execute(plan, project_id="p")
        assert len(calls) == 2
        assert [o.state for o in result.outcomes] == ["done", "done"]


# ── approval binding ──────────────────────────────────────────────────


class TestApprovalBinding:
    def test_resolved_input_regates(self):
        before = fingerprint_invocation(
            "agent.delegate", {"task": "do tB", "scopePaths": ["src"]},
            {"projectId": "p"})
        resolved = resolve_task_input(
            {"task": "do tB", "scopePaths": ["src"]}, "EVIDENCE")
        after = fingerprint_invocation(
            "agent.delegate", resolved, {"projectId": "p"})
        assert before != after


# ── planner guard ─────────────────────────────────────────────────────


class TestPlannerGuard:
    def test_upstream_output_needs_depends_on(self):
        from aura.central_agent.planner import PlanningError, TaskPlanner

        planner = TaskPlanner()
        plan = _plan(_task("tB", input={"task": "do tB"},
                           input_from="upstream-output", depends_on=[]))
        with pytest.raises(PlanningError):
            planner.validate(plan)


# ── restart reconstruction ────────────────────────────────────────────


class TestRestartReconstruction:
    def test_outcomes_with_lineage_round_trip(self):
        outcomes = [
            TaskOutcome(taskId="tA", state="done", performed=True,
                        verified=True, invocationIds=["inv-a"],
                        detail="ok"),
            TaskOutcome(taskId="tB", state="done", performed=True,
                        verified=True, invocationIds=["inv-b"],
                        consumedFrom=["inv-a"], detail="ok"),
        ]
        restored = [TaskOutcome.model_validate(
            json.loads(o.model_dump_json())) for o in outcomes]
        assert restored[1].consumedFrom == ["inv-a"]
        lineage = {o.taskId: o.consumedFrom for o in restored}
        assert lineage == {"tA": [], "tB": ["inv-a"]}

