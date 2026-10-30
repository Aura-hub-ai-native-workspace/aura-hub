"""Durable task queue — the per-task state that survives a process death.

A task is not "done" because the plan says so: it is done because a
worker ran, its check passed, and the evidence is recorded here. This
module is the single source of truth for that, and it is deliberately
small: it knows about TASKS and DEPENDENCIES, never about workers,
models, or policy.

The queue is persisted on the session (``session.taskQueue``) as a list of
dicts, so it survives a restart and is readable without importing this
module. Every method returns a new entry or mutates in place; callers
persist with ``session_store.save(session)`` after each transition.

State machine (per task):

    queued -> running -> succeeded
                   -> failed (retryable if capability is a worker step)
                   -> failed (final, attempts exhausted)
                   -> timed-out -> queued (retry)
                   -> cancelled -> cancelled
                   -> blocked (dependency unmet)
                   -> skipped (already verified in a prior leg)

A "skipped" task is one whose evidence was already proven in an earlier
leg of the same run; it is never dispatched, so it never re-executes
settled side effects.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class TaskQueueEntry:
    task_id: str
    state: str  # queued, running, succeeded, failed, timed-out, cancelled, blocked, skipped
    attempts: int = 0
    max_attempts: int = 2
    depends_on: list[str] = field(default_factory=list)
    capability_id: str | None = None
    verified_evidence: dict | None = None
    started_at: str | None = None
    finished_at: str | None = None
    outcome: dict | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskQueueEntry":
        if not isinstance(data, dict):
            raise ValueError("task queue entry must be a dict")
        return cls(
            task_id=str(data.get("task_id") or ""),
            state=str(data.get("state") or "queued"),
            attempts=int(data.get("attempts") or 0),
            max_attempts=int(data.get("max_attempts") or 2),
            depends_on=list(data.get("depends_on") or []),
            capability_id=data.get("capability_id"),
            verified_evidence=data.get("verified_evidence"),
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            outcome=data.get("outcome"),
            error=data.get("error"),
        )


class TaskQueue:
    """A durable, dependency-aware task queue.

    The queue holds the authoritative state of every task in one plan.
    It is persisted as ``session.taskQueue`` and reloaded verbatim on
    restart. No task is ever removed; transitions are recorded so a
    restart can resume from the last transition without guessing.
    """

    def __init__(self, entries: list[TaskQueueEntry] | None = None) -> None:
        self.entries: list[TaskQueueEntry] = list(entries or [])

    # ── construction ─────────────────────────────────────────────────

    @classmethod
    def from_plan(cls, plan: Any) -> "TaskQueue":
        """Build a queue from a validated TaskPlan (or handoff dict).

        Every task starts in ``queued`` state with zero attempts. The
        dependencies come from the plan; the capability id comes from the
        task specification. A plan with no tasks is an error.
        """
        tasks = getattr(plan, "tasks", None)
        if tasks is None and isinstance(plan, dict):
            tasks = plan.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise ValueError("a task queue needs at least one task")
        entries: list[TaskQueueEntry] = []
        seen: set[str] = set()
        for t in tasks:
            tid = getattr(t, "id", None)
            if tid is None and isinstance(t, dict):
                tid = t.get("id")
            tid = str(tid or "")
            if not tid:
                raise ValueError("a task queue entry needs a task id")
            if tid in seen:
                raise ValueError(f"duplicate task id '{tid}' in the queue")
            seen.add(tid)
            deps = getattr(t, "dependsOn", None)
            if deps is None and isinstance(t, dict):
                deps = t.get("dependsOn") or t.get("depends_on")
            capability_id = getattr(t, "capabilityId", None)
            if capability_id is None and isinstance(t, dict):
                capability_id = t.get("capabilityId")
            max_attempts = 2
            entries.append(TaskQueueEntry(
                task_id=tid,
                state="queued",
                depends_on=list(deps or []),
                capability_id=capability_id,
                max_attempts=max_attempts,
            ))
        return cls(entries)

    @classmethod
    def from_dict(cls, data: list[dict] | None) -> "TaskQueue":
        if not data:
            return cls([])
        if not isinstance(data, list):
            raise ValueError("task queue must be a list")
        return cls([TaskQueueEntry.from_dict(e) for e in data])

    def to_dict(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self.entries]

    # ── queries ──────────────────────────────────────────────────────

    def get_entry(self, task_id: str) -> TaskQueueEntry | None:
        for e in self.entries:
            if e.task_id == task_id:
                return e
        return None

    def get_ready_tasks(self) -> list[TaskQueueEntry]:
        """Tasks that are queued and whose dependencies have all
        succeeded or been skipped. These are the candidates for the next
        dispatch."""
        settled = {e.task_id for e in self.entries
                    if e.state in ("succeeded", "skipped")}
        return [e for e in self.entries
                if e.state == "queued"
                and set(e.depends_on) <= settled]

    def is_complete(self) -> bool:
        """Every task is in a terminal success state."""
        return all(e.state in ("succeeded", "skipped") for e in self.entries)

    def has_failed(self) -> bool:
        """At least one task is in a terminal failure state and cannot be
        retried (attempts exhausted or not retryable)."""
        for e in self.entries:
            if e.state in ("failed", "timed-out", "cancelled", "blocked"):
                if e.attempts >= e.max_attempts:
                    return True
                # A task that has not exhausted its retries is not yet
                # "failed" from the queue's point of view.
                if e.state in ("cancelled", "blocked"):
                    return True
        return False

    def can_retry(self, task_id: str) -> bool:
        e = self.get_entry(task_id)
        if e is None:
            return False
        if e.state not in ("failed", "timed-out"):
            return False
        return e.attempts < e.max_attempts

    # ── transitions ──────────────────────────────────────────────────

    def mark_running(self, task_id: str, started_at: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "queued":
            raise ValueError(
                f"task '{task_id}' cannot start from state '{e.state}'")
        e.state = "running"
        e.started_at = started_at
        e.attempts += 1

    def mark_done(self, task_id: str, evidence: dict | None, finished_at: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "running":
            raise ValueError(
                f"task '{task_id}' cannot succeed from state '{e.state}'")
        e.state = "succeeded"
        e.verified_evidence = evidence
        e.finished_at = finished_at
        e.outcome = {"state": "done", "verified": True}

    def mark_failed(self, task_id: str, error: str, finished_at: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "running":
            raise ValueError(
                f"task '{task_id}' cannot fail from state '{e.state}'")
        e.state = "failed"
        e.error = error
        e.finished_at = finished_at
        e.outcome = {"state": "failed", "verified": False}

    def mark_timed_out(self, task_id: str, error: str, finished_at: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "running":
            raise ValueError(
                f"task '{task_id}' cannot time out from state '{e.state}'")
        e.state = "timed-out"
        e.error = error
        e.finished_at = finished_at
        e.outcome = {"state": "timed-out", "verified": False}

    def mark_cancelled(self, task_id: str, finished_at: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state not in ("queued", "running"):
            raise ValueError(
                f"task '{task_id}' cannot cancel from state '{e.state}'")
        e.state = "cancelled"
        e.finished_at = finished_at
        e.outcome = {"state": "cancelled", "verified": None}

    def mark_blocked(self, task_id: str, reason: str) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "queued":
            raise ValueError(
                f"task '{task_id}' cannot block from state '{e.state}'")
        e.state = "blocked"
        e.error = reason
        e.outcome = {"state": "blocked", "verified": False}

    def mark_skipped(self, task_id: str, evidence: dict | None) -> None:
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state != "queued":
            raise ValueError(
                f"task '{task_id}' cannot skip from state '{e.state}'")
        e.state = "skipped"
        e.verified_evidence = evidence
        e.outcome = {"state": "skipped", "verified": True}

    def reset_for_retry(self, task_id: str) -> None:
        """Return a failed/timed-out task to the queue for another attempt."""
        e = self.get_entry(task_id)
        if e is None:
            raise ValueError(f"unknown task '{task_id}'")
        if e.state not in ("failed", "timed-out"):
            raise ValueError(
                f"task '{task_id}' cannot retry from state '{e.state}'")
        e.state = "queued"
        e.started_at = None
        e.finished_at = None
        e.error = None
        e.outcome = None

    def summary(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in self.entries:
            out[e.state] = out.get(e.state, 0) + 1
        return out
