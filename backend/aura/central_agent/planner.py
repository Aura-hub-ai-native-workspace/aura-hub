"""Task planner — AgentIntent → bounded TaskPlan.

Template planners keyed by the capabilities the intent names. The planner
NEVER executes and NEVER assumes a capability exists: discovery and
authority checking happen after planning, against the live manifest.
Bounds are hard: at most MAX_TASKS tasks, dependencies must form a DAG.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable

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


def _write_inputs(intent: AgentIntent) -> dict:
    """Write arguments from heuristic extras OR structured entities.
    Entities are DATA describing the request; the executor still confines
    the path and policy still gates the effect."""
    wire = intent.wire()
    path = wire.get("writePath")
    content = wire.get("writeContent")
    if not path:
        for e in intent.entities:
            if e.type == "path" and e.value:
                path = e.value
                break
    if not content:
        for e in intent.entities:
            if e.type == "text" and e.value:
                content = e.value
                break
    return {"path": path, "content": content}


def _run_workflow_ref(intent: AgentIntent) -> str | None:
    """Detect 'run workflow <ref>' intents. Ref may be an id or a name."""
    match = re.search(r"\brun (?:the )?workflow (?:named |called )?(.+)",
                      intent.goal, re.IGNORECASE)
    if not match:
        return None
    # Trailing qualifiers ("with project X", "for Y") are not part of the ref.
    ref = re.split(r"\s+with\s|\s+for\s|\s+on\s", match.group(1).strip(),
                   maxsplit=1, flags=re.IGNORECASE)[0].strip().strip("'\"")
    return ref or None


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


def plan_run_workflow(intent: AgentIntent, session_id: str, now: str,
                      workflow_ref: str) -> TaskPlan:
    """Intent asks to RUN a stored workflow → one workflow-run task. The
    engine loads the definition, versions it and drives it through the
    Fabric; the agent never executes nodes itself."""
    return TaskPlan(
        planId=_plan_id(),
        sessionId=session_id,
        intent=intent,
        tasks=[
            _task(
                "t1",
                f"Run workflow {workflow_ref} through the Python engine",
                capability_id=None,
                input={"workflowRef": workflow_ref},
            ).model_copy(update={
                "route": "workflow-run",
                "inputFrom": "literal",
                "verification": VerificationRequirement(
                    kind="audit-only",
                    description="Run reaches a terminal state; evidence from node records.",
                ),
            })
        ],
        createdAt=now,
    )


class TaskPlanner:
    """Deterministic decomposition + VALIDATED model proposals.

    A model MAY propose a plan (plan_from_model); nothing else about it is
    trusted: capability ids must exist in the registry, risk floors come
    from the manifest (a proposal can only RAISE risk), bounds are re-applied,
    and approval expectations are recomputed from preflight — never accepted.
    """

    def __init__(self, workflow_resolver: Callable[[str], str | None] | None = None,
                 known_capabilities: Callable[[], set[str]] | None = None) -> None:
        self._resolve_workflow = workflow_resolver or (lambda ref: None)
        self._known = known_capabilities or (lambda: set())

    def plan_from_model(self, intent, session_id: str, now: str,
                        proposal: dict) -> TaskPlan:
        """Validate a model-proposed plan structure. Fails CLOSED."""
        if intent.needsClarification:
            raise PlanningError("intent needs clarification before planning")
        try:
            raw_tasks = proposal["tasks"]
            if not isinstance(raw_tasks, list) or not raw_tasks:
                raise PlanningError("proposal has no tasks")
            if len(raw_tasks) > MAX_TASKS:
                raise PlanningError(
                    f"model proposed {len(raw_tasks)} tasks; bound is {MAX_TASKS}")
            known = self._known()
            tasks: list[TaskSpecification] = []
            for i, rt in enumerate(raw_tasks[:MAX_TASKS]):
                cap = rt.get("capabilityId")
                if cap is not None and cap not in known:
                    raise PlanningError(
                        f"model proposed unknown capability '{cap}'")
                risk = rt.get("risk") or "low"
                tasks.append(_task(
                    f"t{i + 1}",
                    str(rt.get("description") or f"step {i + 1}"),
                    capability_id=cap,
                    input=rt.get("input") or {},
                    verification=VerificationRequirement(
                        kind=rt.get("verificationKind") or "audit-only",
                        description=str(rt.get("verification") or "")),
                ).model_copy(update={
                    "risk": risk,
                    "dependsOn": [f"t{d + 1}" for d in (rt.get("dependsOn") or [])
                                  if isinstance(d, int) and 0 <= d < i],
                }))
            plan = TaskPlan(planId=_plan_id(), sessionId=session_id,
                            intent=intent, tasks=tasks, createdAt=now)
        except PlanningError:
            raise
        except Exception as exc:
            raise PlanningError(f"invalid model plan: {exc}") from exc
        self.validate(plan)
        return plan

    def plan(self, intent: AgentIntent, session_id: str, now: str) -> TaskPlan:
        if intent.needsClarification:
            raise PlanningError("intent needs clarification before planning")
        required = [c for c in intent.requiredCapabilities if c]
        run_ref = _run_workflow_ref(intent)
        caps = set(required)
        if caps == {"git.status"}:
            plan = TaskPlan(
                planId=_plan_id(), sessionId=session_id, intent=intent,
                tasks=[_task(
                    "t1", "Read repository status with real git",
                    capability_id="git.status",
                    verification=VerificationRequirement(
                        kind="audit-only",
                        description="git exit-code verification in the Fabric."))],
                createdAt=now)
        elif caps == {"filesystem.write"}:
            write_input = _write_inputs(intent)
            plan = TaskPlan(
                planId=_plan_id(), sessionId=session_id, intent=intent,
                tasks=[_task(
                    "t1", f"Write {write_input.get('path', 'file')}",
                    capability_id="filesystem.write",
                    input=write_input,
                    verification=VerificationRequirement(
                        kind="read-back",
                        description="File reads back byte-identical."))],
                createdAt=now)
        elif run_ref is not None:
            resolved = self._resolve_workflow(run_ref)
            if resolved is None:
                raise PlanningError(f"no stored workflow matches '{run_ref}'")
            plan = plan_run_workflow(intent, session_id, now, resolved)
        elif "workflow.create" in required:
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
            if t.inputFrom == "upstream-output" and not t.dependsOn:
                raise PlanningError(
                    f"task {t.id} declares inputFrom 'upstream-output' but "
                    "names no dependencies; declare dependsOn or use a "
                    "literal input.")
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
