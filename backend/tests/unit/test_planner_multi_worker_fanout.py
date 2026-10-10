"""Explicit 3- or 4-runtime read-only requests fan out into N wired tasks.

The two-worker path handles the common "two runtimes in parallel" case.
When three or four distinct runtimes are named with an explicit independence
and read-only signal, the multi-worker path must create one task per worker,
each pinned to its own node, with no file modifications permitted.
"""

from __future__ import annotations

from aura.central_agent.intent import heuristic_interpret
from aura.central_agent.planner import (
    _named_multi_workers,
    _plan_parallel_multi_worker,
    plan_delegated_work,
)

THREE_WORKER = (
    "Use three independent AI workers in parallel on this same project. "
    "Have Claude Code inspect the backend architecture, Kilo Code inspect "
    "the frontend architecture, and OpenCode audit the test coverage. "
    "No worker should modify any files."
)

FOUR_WORKER = (
    "Run four independent agents simultaneously without modifying files. "
    "Have Claude Code review the API layer, Kilo Code review the UI layer, "
    "OpenCode review the database layer, and Codex review the CI pipeline."
)


def _three_worker_intent():
    return heuristic_interpret(THREE_WORKER)


def _four_worker_intent():
    return heuristic_interpret(FOUR_WORKER)


class TestNamedMultiWorkerDetection:
    def test_three_named_workers_found(self):
        workers = _named_multi_workers(THREE_WORKER)
        assert workers is not None
        nodes = [node for _, _, node in workers]
        assert "claude-code" in nodes
        assert "kilo-code" in nodes
        assert "opencode" in nodes
        assert len(nodes) == 3

    def test_four_named_workers_found(self):
        workers = _named_multi_workers(FOUR_WORKER)
        assert workers is not None
        nodes = [node for _, _, node in workers]
        assert len(nodes) == 4
        assert "claude-code" in nodes
        assert "kilo-code" in nodes
        assert "opencode" in nodes
        assert "codex" in nodes

    def test_single_worker_returns_none(self):
        result = _named_multi_workers(
            "Have Kilo Code inspect the frontend architecture."
        )
        assert result is None

    def test_workers_returned_in_textual_order(self):
        workers = _named_multi_workers(THREE_WORKER)
        assert workers is not None
        positions = [pos for pos, _, _ in workers]
        assert positions == sorted(positions)

    def test_new_aliases_matched(self):
        text = (
            "Run independently and read-only: have Gemini CLI do security audit, "
            "Codex CLI do dependency check, and Qwen Code check the docs."
        )
        workers = _named_multi_workers(text)
        assert workers is not None
        nodes = [node for _, _, node in workers]
        assert "gemini" in nodes
        assert "codex" in nodes
        assert "qwen-code" in nodes


class TestParallelMultiWorkerPlan:
    def test_fans_out_three_tasks(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        assert len(plan.tasks) == 3

    def test_fans_out_four_tasks(self):
        plan = _plan_parallel_multi_worker(_four_worker_intent(), "ses-2", "now")
        assert plan is not None
        assert len(plan.tasks) == 4

    def test_each_task_pinned_to_its_worker(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        node_ids = {t.nodeId for t in plan.tasks}
        assert "claude-code" in node_ids
        assert "kilo-code" in node_ids
        assert "opencode" in node_ids

    def test_all_tasks_are_delegate_capability(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        for t in plan.tasks:
            assert t.capabilityId == "agent.delegate"

    def test_no_task_writes(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        for t in plan.tasks:
            assert t.workerRole == "research"
            assert t.input.get("expectChange") is not True
            assert t.dependsOn == []

    def test_task_ids_are_unique(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        ids = [t.id for t in plan.tasks]
        assert len(ids) == len(set(ids))

    def test_not_matched_without_parallel_signal(self):
        intent = heuristic_interpret(
            "Have Claude Code, Kilo Code, and OpenCode all look at this. "
            "None should modify files."
        )
        assert _plan_parallel_multi_worker(intent, "ses", "now") is None

    def test_not_matched_without_readonly_signal(self):
        intent = heuristic_interpret(
            "Use three independent AI workers in parallel. "
            "Have Claude Code, Kilo Code, and OpenCode each implement a feature."
        )
        assert _plan_parallel_multi_worker(intent, "ses", "now") is None

    def test_acceptance_covers_all_tasks(self):
        plan = _plan_parallel_multi_worker(_three_worker_intent(), "ses-1", "now")
        assert plan is not None
        covered = {tid for a in plan.acceptance
                   for tid in (a.expect.get("tasks") or [])}
        task_ids = {t.id for t in plan.tasks}
        assert task_ids <= covered


class TestMultiWorkerThroughPublicPlanner:
    def test_three_workers_through_front_door(self):
        """The three-worker fan-out is on the real plan_delegated_work path."""
        plan = plan_delegated_work(_three_worker_intent(), "ses-1", "now")
        assert len(plan.tasks) == 3
        caps = {t.capabilityId for t in plan.tasks}
        assert caps == {"agent.delegate"}

    def test_four_workers_through_front_door(self):
        plan = plan_delegated_work(_four_worker_intent(), "ses-2", "now")
        assert len(plan.tasks) == 4
        caps = {t.capabilityId for t in plan.tasks}
        assert caps == {"agent.delegate"}

    def test_multi_worker_fires_before_two_worker(self):
        """Three named workers should go through multi path, not two-worker path."""
        plan = plan_delegated_work(_three_worker_intent(), "ses-1", "now")
        # Multi path creates 3 tasks; two-worker path would have created 2
        assert len(plan.tasks) == 3
