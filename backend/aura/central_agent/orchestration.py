"""
orchestration — real multi-worker scheduling over the ONE execution path.
=====================================================================

Milestone 1 of Phase 3. This module adds NO second orchestration engine:
it computes what the existing `ExecutionController.execute()` loop already
did implicitly — the topological order — and adds what it could not
express: dispatching INDEPENDENT tasks CONCURRENTLY, each to a DISTINCT
verified worker, with a hard concurrency cap.

What stays exactly as it was:
  • `_invoke_single` is the only dispatch path — same contracts, same
    governance, same approval parking, same verification.
  • A level with one task, or a level whose tasks cannot each get their
    own worker, runs sequentially exactly as before (the single-worker
    path is the supported fallback, never a degraded imitation).
  • Failure semantics: a failed/denied/timed-out/cancelled task stops the
    run before any dependent is dispatched. A dependent is never marked
    successful because an upstream task failed.

Vocabulary:
  level     — tasks whose dependencies all sit in EARLIER levels. Tasks
              inside one level are mutually independent by construction.
  worker    — a CONNECTED, USABLE node from the existing registry read.
              Busy, disconnected or unverified workers are never
              allocated; allocation is distinct per concurrently
              running task.
  cap       — MAX_PARALLEL_WORKERS. Milestone 1 allows two genuinely
              concurrent workers, no more.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .planner import TaskSpecification, topo_order

#: Milestone 1 concurrency cap. Two real workers, concurrently.
MAX_PARALLEL_WORKERS = 2


class SchedulingError(Exception):
    """The plan cannot be scheduled. Raised before any dispatch."""


def plan_levels(tasks: list[TaskSpecification]) -> list[list[TaskSpecification]]:
    """Group the DAG into dependency levels.

    Level 0 holds tasks with no dependencies; level N holds tasks whose
    every dependency sits in a level < N. Tasks inside one level are
    mutually independent BY CONSTRUCTION (none depends on another), so
    they are the parallel candidates.

    Cycle detection is exact, not a deadlock guess: the members of an
    unresolvable remainder are named, because "no runnable task" tells
    the user nothing about which tasks form the loop.
    """
    by_id: dict[str, TaskSpecification] = {}
    for t in tasks:
        if t.id in by_id:
            raise SchedulingError(f"duplicate task id {t.id!r} in plan")
        by_id[t.id] = t
    for t in tasks:
        for dep in t.dependsOn:
            if dep not in by_id:
                raise SchedulingError(
                    f"task {t.id!r} depends on {dep!r}, which the plan "
                    "does not contain")

    levels: list[list[TaskSpecification]] = []
    placed: set[str] = set()
    remaining = list(tasks)
    while remaining:
        ready = [t for t in remaining
                 if all(d in placed for d in t.dependsOn)]
        if not ready:
            cycle = ", ".join(sorted(t.id for t in remaining))
            raise SchedulingError(
                f"dependency cycle in plan: no runnable task among {cycle}")
        levels.append(ready)
        placed.update(t.id for t in ready)
        remaining = [t for t in remaining if t.id not in placed]
    return levels


def validate_dag(tasks: list[TaskSpecification]) -> list[list[str]]:
    """Validate the plan's dependency graph and return the level shape.

    Same computation as plan_levels, reduced to ids — the shape a caller
    needs for an event frame. Raises SchedulingError on cycles, unknown
    dependencies and duplicate ids, BEFORE anything dispatches.
    """
    return [[t.id for t in level] for level in plan_levels(tasks)]


@dataclass
class WorkerAllocation:
    """One task → one distinct worker decision, with the reason it was
    refused when it was. Never invented: every field is read from the
    registry answer or the exclusion rule that produced it."""

    task_id: str
    node_id: str | None = None
    refused: str = ""

    @property
    def ok(self) -> bool:
        return self.node_id is not None


def allocate_workers(
    level: list[TaskSpecification],
    nodes: list[dict],
    usable_for: dict[str, bool],
    role_satisfies: dict[str, list[str]],
    cap: int = MAX_PARALLEL_WORKERS,
) -> list[WorkerAllocation]:
    """Assign each task in one level its own worker.

    Rules enforced here, deterministically:
      • a worker runs at most ONE task of a concurrently executing level
        (distinctness is the point of isolation);
      • at most `cap` tasks start concurrently — the remainder are
        deferred, not failed: they start when a worker frees up;
      • a task whose role/capability no available worker satisfies is
        refused with the registry's own answer — never silently mapped
        onto a busy or unsuitable worker.

    `role_satisfies` maps node_id → roles it satisfies from the
    registry's own read; `usable_for` maps capability → whether the
    routing executor can drive it (the same usability check dispatch
    would apply).
    """
    taken: set[str] = set()
    slots = max(0, cap)
    out: list[WorkerAllocation] = []
    placed = 0
    for task in level:
        if placed >= slots:
            # Cap reached: the rest wait for a freed worker in the
            # scheduler's work queue. Recorded as deferred, not failed.
            out.append(WorkerAllocation(
                task_id=task.id, refused="deferred: concurrency cap"))
            continue
        candidates: list[str] = []
        role = getattr(task, "workerRole", None)
        if role:
            for node in nodes:
                nid = str(node.get("id") or "")
                if nid and nid not in taken and role in \
                        (role_satisfies.get(nid) or []):
                    candidates.append(nid)
        else:
            for node in nodes:
                nid = str(node.get("id") or "")
                if nid and nid not in taken:
                    candidates.append(nid)
        eligible = [
            nid for nid in candidates
            if usable_for.get(task.capabilityId, True)
        ]
        if not eligible:
            why = (f"no connected worker satisfies role '{role}'"
                   if role else
                   f"no connected worker can run '{task.capabilityId}'")
            if candidates:
                why += " that is not already allocated in this level"
            out.append(WorkerAllocation(task_id=task.id, refused=why))
            continue
        out.append(WorkerAllocation(task_id=task.id, node_id=eligible[0]))
        taken.add(eligible[0])
        placed += 1
    return out


def parallel_eligible(level: list[TaskSpecification],
                      allocations: list[WorkerAllocation],
                      project_cwd: str | None) -> bool:
    """Whether one level may genuinely run concurrently.

    ALL of: more than one task in the level; a working project to isolate;
    and at least two tasks that each secured their OWN worker. Anything
    else keeps the sequential path — which is the existing behaviour, not
    a new one.
    """
    if len(level) < 2 or not project_cwd:
        return False
    placed = [a for a in allocations if a.ok]
    return len(placed) >= 2


@dataclass
class TaskInterval:
    """Wall-clock evidence that two workers actually overlapped.

    Recorded by the scheduler around the real dispatch (clock of the
    process that owns the run), never estimated: startedAt is when the
    worker process was handed the task, endedAt when its outcome
    returned. Emit so the acceptance run can prove concurrency with
    timestamps, not claims."""

    task_id: str
    node_id: str
    started_at: str
    ended_at: str | None = None


def overlapping(intervals: list[TaskInterval]) -> bool:
    """True when any two recorded intervals genuinely overlap."""
    live = [i for i in intervals if i.ended_at is not None]
    if len(live) < 2:
        return False
    ordered = sorted(live, key=lambda i: i.started_at)
    for earlier, later in zip(ordered, ordered[1:]):
        if later.started_at < (earlier.ended_at or ""):
            return True
    return False


def scheduling_shape(tasks: list[TaskSpecification]) -> dict:
    """The one-line summary the service layer can emit with
    `scheduling.planned`: levels, parallel candidates, cycle errors
    already raised by plan_levels."""
    levels = plan_levels(tasks)
    return {
        "levels": [[t.id for t in level] for level in levels],
        "parallelCandidates": sum(1 for level in levels if len(level) > 1),
        "tasks": len(tasks),
    }


__all__ = [
    "MAX_PARALLEL_WORKERS",
    "SchedulingError",
    "TaskInterval",
    "WorkerAllocation",
    "allocate_workers",
    "overlapping",
    "parallel_eligible",
    "plan_levels",
    "scheduling_shape",
    "topo_order",
    "validate_dag",
]
