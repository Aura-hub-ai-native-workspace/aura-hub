"""Task planner — AgentIntent → bounded TaskPlan.

Template planners keyed by the capabilities the intent names. The planner
NEVER executes and NEVER assumes a capability exists: discovery and
authority checking happen after planning, against the live manifest.
Bounds are hard: at most MAX_TASKS tasks, dependencies must form a DAG.
"""

from __future__ import annotations

import uuid

from ..contracts import (
    AgentIntent,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)

MAX_TASKS = 8


class PlanningError(Exception):
    pass


def _plan_id() -> str:
    return f"pln-{uuid.uuid4().hex[:12]}"


def _task(tid: str, description: str, capability_id: str | None = None,
          input: dict | None = None, input_from: str = "literal",
          verification: VerificationRequirement | None = None) -> TaskSpecification:
    return TaskSpecification(
        id=tid,
        description=description,
        capabilityId=capability_id,
        input=input or {},
        inputFrom=input_from,  # type: ignore[arg-value]
        verification=verification or VerificationRequirement(),
    )


def plan_authoring(intent: AgentIntent, session_id: str, now: str) -> TaskPlan:
    """Intent asks for a workflow → one governed persistence step whose
    arguments are produced by the workflow compiler for this same plan."""
    return TaskPlan(
        planId=_plan_id(),
        sessionId=session_id,
        intent=intent,
        tasks=[
            _task(
                "t1",
                "Compile the requested graph and store it as a workflow definition",
                capability_id="workflow.create",
                input_from="compiled-workflow",
                verification=VerificationRequirement(
                    kind="read-back",
                    description="Stored definition reads back with an identical graph hash.",
                ),
            ),
        ],
        createdAt=now,
    )


def plan_status(intent: AgentIntent, session_id: str, now: str) -> TaskPlan:
    """Read-only inventory question → one low-risk invocation."""
    return TaskPlan(
        planId=_plan_id(),
        sessionId=session_id,
        intent=intent,
        tasks=[
            _task(
                "t1",
                "List stored workflows",
                capability_id="workflow.list",
                verification=VerificationRequirement(
                    kind="audit-only",
                    description="Invocation recorded in the audit trail.",
                ),
            ),
        ],
        createdAt=now,
    )


class TaskPlanner:
    """Deterministic decomposition. A model-driven planner can attach later
    behind the same boundary; its output would face identical validation."""

    def plan(self, intent: AgentIntent, session_id: str, now: str) -> TaskPlan:
        if intent.needsClarification:
            raise PlanningError("intent needs clarification before planning")
        required = [c for c in intent.requiredCapabilities if c]
        if "workflow.create" in required:
            plan = plan_authoring(intent, session_id, now)
        elif "workflow.list" in required:
            plan = plan_status(intent, session_id, now)
        else:
            raise PlanningError(
                "no planned task maps to a capability this installation offers"
            )
        self.validate(plan)
        return plan

    @staticmethod
    def validate(plan: TaskPlan) -> None:
        if not 1 <= len(plan.tasks) <= MAX_TASKS:
            raise PlanningError(f"plan size out of bounds: {len(plan.tasks)}")
        ids = [t.id for t in plan.tasks]
        if len(set(ids)) != len(ids):
            raise PlanningError("duplicate task ids")
        known = set(ids)
        for t in plan.tasks:
            unknown = [d for d in t.dependsOn if d not in known]
            if unknown:
                raise PlanningError(f"task {t.id} depends on unknown {unknown}")
        # cycle check (small n — iterative DFS is plenty)
        state: dict[str, int] = {}

        def visit(tid: str) -> None:
            match state.get(tid):
                case 1:
                    raise PlanningError(f"dependency cycle through {tid}")
                case 2:
                    return
            state[tid] = 1
            for t in plan.tasks:
                if t.id == tid:
                    for dep in t.dependsOn:
                        visit(dep)
            state[tid] = 2

        for tid in ids:
            visit(tid)


def topo_order(tasks: list[TaskSpecification]) -> list[TaskSpecification]:
    """Dependency-resolved order; ties keep declaration order."""
    done: set[str] = set()
    out: list[TaskSpecification] = []
    remaining = list(tasks)
    while remaining:
        runnable = [t for t in remaining if all(d in done for d in t.dependsOn)]
        if not runnable:
            raise PlanningError("no runnable task — dependency deadlock")
        for t in runnable:
            out.append(t)
            done.add(t.id)
        remaining = [t for t in remaining if t.id not in done]
    return out
