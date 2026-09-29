"""
Unit tests for the milestone-1 orchestration scheduler.
======================================================
Real DAG shapes, real allocation rules, no I/O: cycles are rejected
BEFORE dispatch, independent tasks group into one level, distinct
workers are allocated per concurrently running task, the cap of two is
enforced, and overlap detection demands genuine interval intersection.

Run with: cd backend && python3 -m pytest tests/unit/test_orchestration.py -q
"""
from __future__ import annotations

import pytest

from aura.central_agent.orchestration import (
    MAX_PARALLEL_WORKERS,
    SchedulingError,
    TaskInterval,
    allocate_workers,
    overlapping,
    parallel_eligible,
    plan_levels,
    scheduling_shape,
    validate_dag,
)


def task(tid: str, deps: list[str] | None = None, role: str | None = None):
    """A minimal TaskSpecification with only what the scheduler reads."""
    from aura.central_agent.planner import TaskSpecification

    return TaskSpecification(
        id=tid,
        description=f"task {tid}",
        capabilityId="agent.delegate",
        dependsOn=list(deps or []),
        **({"workerRole": role} if role else {}),
    )


# ── DAG levels and cycle rejection ────────────────────────────────────


class TestPlanLevels:
    def test_independent_tasks_share_one_level(self):
        levels = plan_levels([task("a"), task("b")])
        assert [[t.id for t in lv] for lv in levels] == [["a", "b"]]

    def test_dependencies_force_later_levels(self):
        levels = plan_levels([task("b", ["a"]), task("a")])
        assert [[t.id for t in lv] for lv in levels] == [["a"], ["b"]]

    def test_diamond_shape(self):
        levels = plan_levels([
            task("a"), task("b", ["a"]), task("c", ["a"]),
            task("d", ["b", "c"]),
        ])
        assert [[t.id for t in lv] for lv in levels] == [
            ["a"], ["b", "c"], ["d"]]

    def test_cycle_is_rejected_with_member_names(self):
        with pytest.raises(SchedulingError) as err:
            plan_levels([task("a", ["b"]), task("b", ["a"])])
        assert "cycle" in str(err.value)
        assert "a" in str(err.value) and "b" in str(err.value)

    def test_unknown_dependency_is_rejected_before_dispatch(self):
        with pytest.raises(SchedulingError) as err:
            plan_levels([task("a", ["ghost"])])
        assert "ghost" in str(err.value)

    def test_duplicate_ids_are_rejected(self):
        with pytest.raises(SchedulingError):
            plan_levels([task("a"), task("a")])

    def test_validate_dag_returns_level_shape(self):
        assert validate_dag([task("a"), task("b", ["a"])]) == [["a"], ["b"]]

    def test_scheduling_shape_counts_parallel_candidates(self):
        shape = scheduling_shape([task("a"), task("b"), task("c", ["a"])])
        assert shape == {
            "levels": [["a", "b"], ["c"]],
            "parallelCandidates": 1,
            "tasks": 3,
        }


# ── worker allocation ────────────────────────────────────────────────


NODES = [{"id": "claude-code"}, {"id": "opencode"}]
USABLE = {"agent.delegate": True}
SATISFIES = {
    "claude-code": ["code", "review", "research"],
    "opencode": ["code", "research"],
}


class TestAllocateWorkers:
    def test_distinct_workers_for_independent_tasks(self):
        allocations = allocate_workers(
            [task("a", role="code"), task("b", role="code")],
            NODES, USABLE, SATISFIES)
        got = {a.task_id: a.node_id for a in allocations}
        assert got["a"] != got["b"]
        assert {got["a"], got["b"]} == {"claude-code", "opencode"}

    def test_cap_of_two_defers_the_third(self):
        nodes = [{"id": "w1"}, {"id": "w2"}, {"id": "w3"}]
        sat = {n: ["code"] for n in ("w1", "w2", "w3")}
        allocations = allocate_workers(
            [task("a", role="code"), task("b", role="code"),
             task("c", role="code")],
            nodes, USABLE, sat, cap=MAX_PARALLEL_WORKERS)
        states = {a.task_id: (a.node_id, a.refused) for a in allocations}
        assert states["a"][0] and states["b"][0]
        assert states["c"][0] is None
        assert "deferred" in states["c"][1]

    def test_unsatisfiable_role_is_refused_not_faked(self):
        allocations = allocate_workers(
            [task("a", role="documentation"), task("b", role="code")],
            NODES, USABLE, SATISFIES)
        a = next(x for x in allocations if x.task_id == "a")
        assert not a.ok
        assert "documentation" in a.refused
        # and the other task is unaffected
        b = next(x for x in allocations if x.task_id == "b")
        assert b.ok

    def test_single_worker_degrades_to_sequential_assignment(self):
        allocations = allocate_workers(
            [task("a", role="code"), task("b", role="code")],
            [{"id": "claude-code"}], USABLE,
            {"claude-code": ["code"]})
        states = {a.task_id: a.node_id for a in allocations}
        assert states["a"] == "claude-code"
        assert states["b"] is None  # no second worker: level stays sequential

    def test_parallel_eligible_needs_two_tasks_workers_and_cwd(self):
        level = [task("a"), task("b")]
        ok_allocs = [
            allocate_workers(level, NODES, USABLE, SATISFIES)]
        assert parallel_eligible(level, ok_allocs[0], "/tmp/proj") is True
        assert parallel_eligible(level, ok_allocs[0], None) is False
        assert parallel_eligible([task("a")], ok_allocs[0], "/tmp") is False
        solo = [allocate_workers(level, [{"id": "claude-code"}], USABLE,
                                 {"claude-code": ["code"]})]
        assert parallel_eligible(level, solo[0], "/tmp/proj") is False


# ── overlap evidence ─────────────────────────────────────────────────


class TestOverlapping:
    def test_genuine_overlap_detected(self):
        a = TaskInterval("a", "w1", "2026-01-01T00:00:10Z",
                         "2026-01-01T00:01:10Z")
        b = TaskInterval("b", "w2", "2026-01-01T00:00:40Z",
                         "2026-01-01T00:01:40Z")
        assert overlapping([a, b]) is True

    def test_sequential_execution_is_not_parallel(self):
        a = TaskInterval("a", "w1", "2026-01-01T00:00:00Z",
                         "2026-01-01T00:01:00Z")
        b = TaskInterval("b", "w2", "2026-01-01T00:01:00Z",
                         "2026-01-01T00:02:00Z")
        assert overlapping([a, b]) is False

    def test_unfinished_intervals_never_claim_overlap(self):
        a = TaskInterval("a", "w1", "2026-01-01T00:00:00Z", None)
        b = TaskInterval("b", "w2", "2026-01-01T00:00:00Z", None)
        assert overlapping([a, b]) is False

    def test_three_way_overlap(self):
        ivs = [
            TaskInterval("a", "w1", "00:00:10", "00:02:00"),
            TaskInterval("b", "w2", "00:01:00", "00:03:00"),
            TaskInterval("c", "w3", "00:01:30", "00:04:00"),
        ]
        assert overlapping(ivs) is True
