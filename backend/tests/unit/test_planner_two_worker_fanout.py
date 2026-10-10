"""Explicit two-runtime read-only requests fan out into two wired tasks.

A single generic `agent.delegate` of the whole message is the correct
answer for "have an agent do X". When the person instead names TWO
distinct runtimes and orders them to work independently without
modifying anything, one task collapses the split they asked for and
gives verification nothing to compare. The planner must preserve that
distinction.
"""

from __future__ import annotations

from aura.central_agent.intent import heuristic_interpret
from aura.central_agent.planner import (
    _named_distinct_workers,
    _plan_parallel_two_worker,
    plan_delegated_work,
)

TWO_WORKER = (
    "Use two independent AI workers in parallel on this same project. "
    "Have Claude Code inspect the backend architecture and Kilo Code "
    "inspect the frontend architecture. Neither task should modify files."
)


def _two_worker_intent():
    return heuristic_interpret(TWO_WORKER)


class TestParallelTwoWorkerDetection:
    def test_two_named_workers_found(self):
        workers = _named_distinct_workers(TWO_WORKER)
        assert [node for _, _, node in workers] == ["claude-code", "kilo-code"]

    def test_single_worker_request_is_not_matched(self):
        intent = heuristic_interpret(
            "Have Kilo Code inspect the frontend architecture.")
        assert _named_distinct_workers(
            getattr(intent, "delegateTask", "")) is None

    def test_not_matched_without_independence(self):
        intent = heuristic_interpret(
            "Have Claude Code and Kilo Code both contribute to this task."
        )
        assert _plan_parallel_two_worker(intent, "ses", "now") is None


class TestParallelTwoWorkerPlan:
    def test_fans_out_two_tasks(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        assert plan is not None
        assert len(plan.tasks) == 2

    def test_each_task_pinned_to_its_worker(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        by_id = {t.id: t for t in plan.tasks}
        assert by_id["delegate-claude"].nodeId == "claude-code"
        assert by_id["delegate-kilo"].nodeId == "kilo-code"

    def test_each_task_gets_its_own_instruction(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        by_id = {t.id: t for t in plan.tasks}
        assert "backend" in by_id["delegate-claude"].input["task"]
        assert "frontend" in by_id["delegate-kilo"].input["task"]

    def test_no_task_writes(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        for t in plan.tasks:
            assert t.capabilityId in ("agent.delegate", None)
            assert t.workerRole == "research"
            assert t.input.get("expectChange") is not True
            assert t.dependsOn == []

    def test_through_public_planner_front_door(self):
        """The fan-out is on the real path, not a side door."""
        plan = plan_delegated_work(_two_worker_intent(), "ses-1", "now")
        assert len(plan.tasks) == 2
        caps = {t.capabilityId for t in plan.tasks}
        assert caps == {"agent.delegate"}
