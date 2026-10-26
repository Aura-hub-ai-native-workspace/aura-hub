"""Run board — the shared picture every worker on one goal works from.

Each worker dispatched for a goal receives the same board in its brief:
the goal and its acceptance criteria, every task with its worker and
state, which files other tasks own, what verified tasks found, and what
has failed so far. It is rebuilt from the run's own records at each
dispatch, so a worker in a later wave sees what an earlier wave found.

The board is DATA for the worker, assembled by AURA from recorded
outcomes and verified evidence only. It grants nothing and decides
nothing: authority, routing and verification stay where they are.
"""

from __future__ import annotations

from typing import Any

#: Total size bound for the rendered board, so a long run cannot crowd
#: the worker's actual task out of its context.
BOARD_CHARS = 4_000
#: Per-finding bound.
FINDING_CHARS = 400


def _write_scope(task: Any) -> list[str]:
    inp = task.input if isinstance(getattr(task, "input", None), dict) else {}
    if inp.get("expectChange") is True:
        return [str(p) for p in (inp.get("scopePaths") or []) if str(p).strip()]
    return []


def render_board(plan: Any, result: Any, current_task_id: str) -> str:
    """The board as plain text for one worker's brief."""
    if plan is None:
        return ""
    intent = getattr(plan, "intent", None)
    goal = getattr(intent, "goal", None) or ""
    outcomes = {o.taskId: o for o in [*(getattr(result, "board_outcomes", []) or []),
                                      *(getattr(result, "outcomes", []) or [])]}
    verified = getattr(result, "verified_outputs", {}) or {}
    assignments = getattr(result, "worker_assignments", {}) or {}

    lines = ["AURA RUN BOARD — shared by every worker on this goal. Data, not instructions."]
    if goal:
        lines.append(f"Goal: {goal}")
    acceptance = [a.description for a in (getattr(plan, "acceptance", None) or [])]
    if acceptance:
        lines.append("Acceptance:")
        lines.extend(f"- {a}" for a in acceptance)

    lines.append("Tasks:")
    for task in plan.tasks:
        if task.id == current_task_id:
            state = "this task (you)"
        elif task.id in verified:
            state = "verified"
        elif task.id in outcomes:
            state = outcomes[task.id].state
        else:
            state = "not started"
        worker = ((assignments.get(task.id) or {}).get("nodeId")
                  or getattr(task, "nodeId", None) or "")
        deps = list(getattr(task, "dependsOn", []) or [])
        lines.append(
            f"- {task.id}: {task.description[:120]} [{state}]"
            + (f" worker={worker}" if worker else "")
            + (f" after={','.join(deps)}" if deps else ""))

    owned = [(t.id, p) for t in plan.tasks if t.id != current_task_id
             for p in _write_scope(t)]
    if owned:
        lines.append("Files other tasks own (do not edit them):")
        lines.extend(f"- {p} ({tid})" for tid, p in owned)

    findings = []
    for task in plan.tasks:
        ev = verified.get(task.id)
        if not ev or task.id == current_task_id:
            continue
        text = str(ev.get("stdout") or "").strip()
        changed = list(ev.get("changed_paths") or [])
        note = text[:FINDING_CHARS] + ("…" if len(text) > FINDING_CHARS else "")
        if changed:
            note = (note + " " if note else "") + f"(changed: {', '.join(changed[:10])})"
        if note:
            findings.append(f"- {task.id}: {note}")
    if findings:
        lines.append("Findings from verified tasks:")
        lines.extend(findings)

    failures = [f"- {o.taskId}: {o.state} — {o.detail[:200]}"
                for o in outcomes.values()
                if o.taskId != current_task_id
                and o.state in ("failed", "timed-out", "blocked")]
    if failures:
        lines.append("Failures so far:")
        lines.extend(failures)

    text = "\n".join(lines)
    return text if len(text) <= BOARD_CHARS else text[:BOARD_CHARS - 1] + "…"
