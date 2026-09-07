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

#: agent.delegate input fields the model may populate. Everything else —
#: node binaries, commands, approvals, policy, secrets — is rejected.
_DELEGATE_INPUT_KEYS = {"task", "model", "context", "scopePaths"}

#: Per-task proposal keys. "risk" is accepted but advisory only: authority
#: preflight recomputes risk from the manifest (a proposal can only be
#: confirmed, never believed). Anything else fails closed.
_MODEL_TASK_KEYS = {
    "id", "description", "capabilityId", "nodeId", "dependsOn",
    "inputFrom", "input", "scopePaths", "verificationKind",
    "verification", "risk",
}

#: inputFrom values a model may propose. "compiled-workflow" is
#: compiler-owned and never model-proposable.
_MODEL_INPUT_FROM = {"literal", "upstream-output"}

_TASK_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,31}")
_MAX_SCOPE_PATHS = 16
_MAX_SCOPE_LEN = 256
_MAX_TASK_TEXT = 8000


class PlanningError(Exception):
    pass


def _check_scope_paths(raw: object, task_label: str) -> list[str]:
    """Strict shape validation for model-proposed scopePaths. The
    executor re-validates before spawning and supervision enforces at
    runtime; this gate keeps malformed/escaping scope out of plans."""
    if not isinstance(raw, list) or not raw:
        raise PlanningError(
            f"task {task_label} scopePaths must be a non-empty list")
    if len(raw) > _MAX_SCOPE_PATHS:
        raise PlanningError(
            f"task {task_label} declares {len(raw)} scope paths; bound "
            f"is {_MAX_SCOPE_PATHS}")
    out: list[str] = []
    for p in raw:
        if not isinstance(p, str) or not p.strip():
            raise PlanningError(
                f"task {task_label} has a non-string scope path")
        s = p.strip().replace("\\", "/")
        if (len(s) > _MAX_SCOPE_LEN or s.startswith("/")
                or s.startswith("~") or ".." in s.split("/")
                or s in (".", "")):
            raise PlanningError(
                f"task {task_label} scope path {p!r} is not a bounded "
                "repo-relative path")
        out.append(s)
    if len(set(out)) != len(out):
        raise PlanningError(
            f"task {task_label} repeats a scope path")
    return out


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
                  known_capabilities: Callable[[], set[str]] | None = None,
                  known_nodes: Callable[[], set[str]] | None = None) -> None:
        self._resolve_workflow = workflow_resolver or (lambda ref: None)
        self._known = known_capabilities or (lambda: set())
        # Connected-node ids usable for nodeId validation. None means the
        # planner cannot verify worker pins, so any requested nodeId is
        # rejected (fail closed); omitting nodeId always stays valid.
        self._known_nodes = known_nodes

    def known_capability_ids(self) -> set[str]:
        return set(self._known())

    def known_node_ids(self) -> set[str]:
        return set(self._known_nodes()) if self._known_nodes else set()

    def plan_from_model(self, intent, session_id: str, now: str,
                        proposal: dict) -> TaskPlan:
        """Validate a model-proposed plan structure. Fails CLOSED.

        The model proposes structure only — descriptions, dependencies,
        scope, verification text. AURA owns identity (canonical ids in
        topological order), ordering, worker authorization (nodeId checked
        against the connected catalogue, Fabric re-checks at preflight
        and dispatch), and risk (manifest-owned at preflight).
        """
        if intent.needsClarification:
            raise PlanningError("intent needs clarification before planning")
        try:
            if not isinstance(proposal, dict):
                raise PlanningError("proposal must be an object")
            extra_top = set(proposal) - {"tasks"}
            if extra_top:
                raise PlanningError(
                    f"proposal carries unsupported fields: {sorted(extra_top)}")
            raw_tasks = proposal.get("tasks")
            if not isinstance(raw_tasks, list) or not raw_tasks:
                raise PlanningError("proposal has no tasks")
            if len(raw_tasks) > MAX_TASKS:
                raise PlanningError(
                    f"model proposed {len(raw_tasks)} tasks; bound is {MAX_TASKS}")
            known = self._known()
            # Pass 1 — per-task shape, authority rejection, id registry.
            staged: list[dict] = []
            seen_ids: set[str] = set()
            for i, rt in enumerate(raw_tasks):
                if not isinstance(rt, dict):
                    raise PlanningError(f"proposal task {i} is not an object")
                extra = set(rt) - _MODEL_TASK_KEYS
                if extra:
                    raise PlanningError(
                        f"proposal task {i} carries unsupported fields: "
                        f"{sorted(extra)}")
                label = str(rt.get("id") or f"#{i}")
                if rt.get("id") is not None:
                    if (not isinstance(rt["id"], str)
                            or not _TASK_ID_RE.fullmatch(rt["id"])):
                        raise PlanningError(
                            f"proposal task id {rt['id']!r} is malformed")
                    if rt["id"] in seen_ids:
                        raise PlanningError(
                            f"duplicate proposal task id '{rt['id']}'")
                    seen_ids.add(rt["id"])
                cap = rt.get("capabilityId")
                if cap is not None:
                    if not isinstance(cap, str) or cap not in known:
                        raise PlanningError(
                            f"model proposed unknown capability '{cap}'")
                from_ = rt.get("inputFrom") or "literal"
                if from_ not in _MODEL_INPUT_FROM:
                    raise PlanningError(
                        f"task {label} proposes unsupported inputFrom "
                        f"'{from_}'")
                node = rt.get("nodeId")
                if node is not None:
                    self._check_node(node, label)
                staged.append({"index": i, "label": label, "raw": rt,
                               "cap": cap, "from": from_})
            # Pass 2 — dependency resolution to positional form.
            by_label = {s["label"]: s["index"] for s in staged}
            for s in staged:
                deps = (s["raw"].get("dependsOn") or [])
                if not isinstance(deps, list):
                    raise PlanningError(
                        f"task {s['label']} dependsOn must be a list")
                resolved: list[int] = []
                for d in deps:
                    if isinstance(d, bool):
                        raise PlanningError(
                            f"task {s['label']} has a malformed dependency")
                    if isinstance(d, int):
                        # Legacy positional form: index into proposal order.
                        if not 0 <= d < len(staged):
                            raise PlanningError(
                                f"task {s['label']} depends on unknown "
                                f"position {d}")
                        resolved.append(d)
                    elif isinstance(d, str):
                        if d not in by_label:
                            raise PlanningError(
                                f"task {s['label']} depends on unknown "
                                f"task '{d}'")
                        if by_label[d] == s["index"]:
                            raise PlanningError(
                                f"task {s['label']} depends on itself")
                        resolved.append(by_label[d])
                    else:
                        raise PlanningError(
                            f"task {s['label']} has a malformed dependency")
                s["deps"] = resolved
            # Pass 3 — AURA owns identity + ordering: canonical ids in
            # topological order (ties keep proposal order), deps remapped.
            order = _topo_indices(len(staged),
                                  [s["deps"] for s in staged])
            canon = {pos: f"t{k + 1}" for k, pos in enumerate(order)}
            tasks: list[TaskSpecification] = []
            for k, pos in enumerate(order):
                s = staged[pos]
                rt = s["raw"]
                tid = canon[pos]
                dep_ids = sorted({canon[d] for d in s["deps"]})
                if s["from"] == "upstream-output" and not dep_ids:
                    raise PlanningError(
                        f"task {tid} declares inputFrom 'upstream-output' "
                        "but names no dependencies")
                task_input = self._model_task_input(
                    rt, s["cap"], s["label"], tid)
                scope = self._model_scope(rt, task_input, s["label"], tid)
                if scope is not None:
                    task_input = {**task_input, "scopePaths": scope}
                ver_kind = rt.get("verificationKind") or "audit-only"
                ver_desc = str(rt.get("verification") or "")
                if s["cap"] == "agent.delegate" and not ver_desc.strip():
                    raise PlanningError(
                        f"task {tid} delegates to an agent but states no "
                        "verification requirement")
                if len(ver_desc) > 500:
                    raise PlanningError(
                        f"task {tid} verification text exceeds its bound")
                risk = rt.get("risk") or "low"
                tasks.append(TaskSpecification(
                    id=tid,
                    description=str(rt.get("description")
                                    or f"step {s['index'] + 1}"),
                    capabilityId=s["cap"],
                    input=task_input,
                    inputFrom=s["from"],  # type: ignore[arg-value]
                    dependsOn=dep_ids,
                    nodeId=rt.get("nodeId"),
                    risk=risk,  # type: ignore[arg-value]
                    verification=VerificationRequirement(
                        kind=ver_kind,  # type: ignore[arg-value]
                        description=ver_desc),
                ))
            self._check_scope_narrowing(tasks)
            plan = TaskPlan(planId=_plan_id(), sessionId=session_id,
                            intent=intent, tasks=tasks, createdAt=now)
        except PlanningError:
            raise
        except Exception as exc:
            raise PlanningError(f"invalid model plan: {exc}") from exc
        self.validate(plan)
        return plan

    def _check_node(self, node: object, label: str) -> None:
        if not isinstance(node, str) or not node.strip():
            raise PlanningError(f"task {label} has a malformed nodeId")
        if self._known_nodes is None:
            raise PlanningError(
                f"task {label} requests node '{node}' but this planner "
                "cannot verify workers; omit nodeId for deterministic "
                "routing")
        if node not in self._known_nodes():
            raise PlanningError(
                f"task {label} requests unknown node '{node}'")

    @staticmethod
    def _model_task_input(rt: dict, cap: str | None, label: str,
                          tid: str) -> dict:
        """Task input from a proposal. Non-delegate capabilities keep the
        legacy passthrough (executor + policy stay the backstop, as proven
        by test_model_plan_cannot_widen_executor_scope). agent.delegate —
        the new Phase F surface — is allow-listed: task text, model hint,
        context, scope. Binaries, commands, approvals, policy, secrets can
        never arrive through a model plan."""
        raw_input = rt.get("input") or {}
        if not isinstance(raw_input, dict):
            raise PlanningError(f"task {tid} input must be an object")
        if cap != "agent.delegate":
            return dict(raw_input)
        extra = set(raw_input) - _DELEGATE_INPUT_KEYS
        if extra:
            raise PlanningError(
                f"task {tid} delegate input carries unsupported fields: "
                f"{sorted(extra)}")
        task_text = str(raw_input.get("task") or "")
        if not task_text.strip():
            raise PlanningError(
                f"task {tid} delegates to an agent with no task text")
        if len(task_text) > _MAX_TASK_TEXT:
            raise PlanningError(
                f"task {tid} task text exceeds its bound")
        out = {"task": task_text}
        for key in ("model", "context"):
            if raw_input.get(key) is not None:
                val = raw_input[key]
                if not isinstance(val, str) or not val.strip():
                    raise PlanningError(
                        f"task {tid} delegate input '{key}' must be text")
                if len(val) > _MAX_TASK_TEXT:
                    raise PlanningError(
                        f"task {tid} delegate input '{key}' exceeds its bound")
                out[key] = val
        return out

    @staticmethod
    def _model_scope(rt: dict, task_input: dict, label: str,
                     tid: str) -> list[str] | None:
        """Merge top-level scopePaths with input.scopePaths (conflicts
        fail closed) and shape-validate. Returns None when unscoped."""
        top = rt.get("scopePaths")
        inner = task_input.get("scopePaths")
        if top is None and inner is None:
            return None
        if top is not None and inner is not None and top != inner:
            raise PlanningError(
                f"task {tid} states scopePaths twice with different values")
        return _check_scope_paths(top if top is not None else inner, tid)

    @staticmethod
    def _check_scope_narrowing(tasks: list[TaskSpecification]) -> None:
        """A downstream task cannot expand upstream authority merely
        because it received upstream output: when a task and ALL its
        dependencies declare scope, the task scope must be a subset of
        the union. Unscoped legs stay comparable-free (supervision +
        approval still bind them)."""
        by_id = {t.id: t for t in tasks}
        for t in tasks:
            scope = (t.input.get("scopePaths")
                     if isinstance(t.input, dict) else None)
            if not scope or not t.dependsOn:
                continue
            dep_scopes = [(by_id[d].input.get("scopePaths")
                           if isinstance(by_id[d].input, dict) else None)
                          for d in t.dependsOn if d in by_id]
            if any(not s for s in dep_scopes):
                continue
            union: set[str] = set()
            for s in dep_scopes:
                union.update(s or [])

            def _covered(path: str) -> bool:
                # Same path, or strictly beneath a dependency scope dir.
                return any(path == d or path.startswith(d.rstrip("/") + "/")
                           for d in union)

            wider = [p for p in scope if not _covered(p)]
            if wider:
                raise PlanningError(
                    f"task {t.id} scope {wider} expands beyond its "
                    "dependencies' scope; downstream scope must be the "
                    "same or narrower")

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


def _topo_indices(n: int, deps: list[list[int]]) -> list[int]:
    """Positional topological order; ties keep proposal order. Raises
    PlanningError on cycles (fail closed before AURA assigns identity)."""
    done: set[int] = set()
    out: list[int] = []
    while len(out) < n:
        runnable = [i for i in range(n)
                    if i not in done and all(d in done for d in deps[i])]
        if not runnable:
            raise PlanningError("model proposal contains a dependency cycle")
        out.extend(runnable)
        done.update(runnable)
    return out


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
