"""Durable task queue — state transitions and persistence.

These tests exercise the queue's state machine and its persistence
contract. They do not touch the filesystem beyond an in-memory dict.
"""
from __future__ import annotations

import pytest

from aura.central_agent.task_queue import TaskQueue, TaskQueueEntry
from aura.contracts.agent import TaskPlan, TaskSpecification, AgentIntent


def _task(tid, depends=(), cap="agent.delegate"):
    return TaskSpecification(
        id=tid, description=f"task {tid}", capabilityId=cap,
        dependsOn=list(depends))


def _plan(tasks):
    return TaskPlan(
        planId="pln-x", sessionId="agt-aaaaaaaaaaaa",
        intent=AgentIntent(goal="g", expectedOutcome="e"),
        tasks=tasks, createdAt="2026-10-20T00:00:00Z")


# ── construction ──────────────────────────────────────────────────────

def test_from_plan_starts_every_task_queued():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2")]))
    assert len(q.entries) == 2
    assert all(e.state == "queued" for e in q.entries)
    assert q.entries[0].task_id == "t1" and q.entries[1].task_id == "t2"
    assert q.entries[1].depends_on == []


def test_from_plan_preserves_dependencies():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2", depends=["t1"])]))
    assert q.entries[1].depends_on == ["t1"]


def test_from_plan_rejects_empty():
    with pytest.raises(ValueError):
        TaskQueue.from_plan(_plan([]))


def test_from_plan_rejects_duplicate_ids():
    with pytest.raises(ValueError):
        TaskQueue.from_plan(_plan([_task("t1"), _task("t1")]))


def test_from_dict_round_trips():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2", depends=["t1"])]))
    q.mark_running("t1", "2026-01-01T00:00:00Z")
    q.mark_done("t1", {"stdout": "ok"}, "2026-01-01T00:01:00Z")
    rebuilt = TaskQueue.from_dict(q.to_dict())
    assert rebuilt.entries[0].state == "succeeded"
    assert rebuilt.entries[0].verified_evidence == {"stdout": "ok"}
    assert rebuilt.entries[1].state == "queued"


def test_empty_queue_loads_empty():
    assert TaskQueue.from_dict(None).entries == []
    assert TaskQueue.from_dict([]).entries == []


# ── ready tasks ────────────────────────────────────────────────────────

def test_get_ready_tasks_respects_dependencies():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2", depends=["t1"])]))
    assert [e.task_id for e in q.get_ready_tasks()] == ["t1"]
    q.mark_running("t1", "now")
    q.mark_done("t1", None, "now")
    assert [e.task_id for e in q.get_ready_tasks()] == ["t2"]


def test_get_ready_tasks_skips_running_and_done():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2")]))
    q.mark_running("t1", "now")
    assert [e.task_id for e in q.get_ready_tasks()] == ["t2"]
    q.mark_done("t1", None, "now")
    assert [e.task_id for e in q.get_ready_tasks()] == ["t2"]


def test_is_complete_only_when_all_succeeded_or_skipped():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2")]))
    assert not q.is_complete()
    q.mark_running("t1", "now"); q.mark_done("t1", None, "now")
    assert not q.is_complete()
    q.mark_running("t2", "now"); q.mark_done("t2", None, "now")
    assert q.is_complete()


# ── state transitions ──────────────────────────────────────────────────

def test_mark_running_increments_attempts():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.mark_running("t1", "now")
    assert q.get_entry("t1").state == "running"
    assert q.get_entry("t1").attempts == 1
    q.mark_failed("t1", "exit 1", "now")
    q.reset_for_retry("t1")
    q.mark_running("t1", "now")
    assert q.get_entry("t1").attempts == 2


def test_mark_done_requires_running():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    with pytest.raises(ValueError):
        q.mark_done("t1", None, "now")


def test_mark_failed_requires_running():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    with pytest.raises(ValueError):
        q.mark_failed("t1", "boom", "now")


def test_mark_timed_out_requires_running():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    with pytest.raises(ValueError):
        q.mark_timed_out("t1", "ran out of time", "now")


def test_mark_cancelled_from_queued_or_running():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.mark_cancelled("t1", "now")
    assert q.get_entry("t1").state == "cancelled"
    q2 = TaskQueue.from_plan(_plan([_task("t1")]))
    q2.mark_running("t1", "now")
    q2.mark_cancelled("t1", "now")
    assert q2.get_entry("t1").state == "cancelled"


def test_mark_blocked_requires_queued():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.mark_running("t1", "now")
    with pytest.raises(ValueError):
        q.mark_blocked("t1", "upstream failed")


def test_mark_skipped_requires_queued():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.mark_running("t1", "now")
    with pytest.raises(ValueError):
        q.mark_skipped("t1", None)


def test_reset_for_retry_only_from_failed_or_timed_out():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.mark_running("t1", "now"); q.mark_failed("t1", "x", "now")
    q.reset_for_retry("t1")
    assert q.get_entry("t1").state == "queued"
    # A succeeded task cannot be retried.
    q2 = TaskQueue.from_plan(_plan([_task("t1")]))
    q2.mark_running("t1", "now"); q2.mark_done("t1", None, "now")
    with pytest.raises(ValueError):
        q2.reset_for_retry("t1")


def test_can_retry_respects_max_attempts():
    q = TaskQueue.from_plan(_plan([_task("t1")]))
    q.get_entry("t1").max_attempts = 1
    q.mark_running("t1", "now"); q.mark_failed("t1", "x", "now")
    assert not q.can_retry("t1")  # attempts (1) >= max (1)


def test_summary_counts_states():
    q = TaskQueue.from_plan(_plan([_task("t1"), _task("t2")]))
    q.mark_running("t1", "now"); q.mark_done("t1", None, "now")
    assert q.summary() == {"queued": 1, "succeeded": 1}