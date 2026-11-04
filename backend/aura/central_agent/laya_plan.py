"""Laya changes the plan when no local model is configured.

Three kinds of change, each one decided by Laya and each one a proposal:
* add a review of an implementation step, done by a different agent;
* drop an implementation step Laya judges not needed (never the last one, never one
  another step depends on);
* run two adjacent, independent steps in the order Laya prefers.

A change is applied only when Laya is at least `floor` sure, and only if the plan
still passes the same validation as any plan. Anything else is left as it was.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

#: Asks Laya one choice: (brief, instructions, criteria) -> (choice, probability) or None.
Asker = Callable[[str, str, dict[str, str]], "tuple[str, float] | None"]

REVIEW_INSTRUCTIONS = "Does the work described in `body` need a second agent to check it?"
REVIEW_CRITERIA = {
    "review": "it builds new features, pages, endpoints or logic that users or other code will rely on",
    "skip": "it only changes documentation, comments, text or configuration",
}
NEEDED_INSTRUCTIONS = "Is the step described in `body` needed to complete the request?"
NEEDED_CRITERIA = {
    "needed": "the request needs this step",
    "not_needed": "it repeats another step or is outside the request",
}
ORDER_INSTRUCTIONS = "Which of the two steps in `body` should run first?"


def _impl(task: dict[str, Any]) -> bool:
    from .plan_handoff import classify_task, needs_selection

    return needs_selection(task) and classify_task(task) in ("frontend", "backend", "general")


def _brief(task: dict[str, Any]) -> str:
    return f"{task.get('title') or ''}\n{task.get('description') or ''}".strip()


def _review_of(tasks: list[dict[str, Any]], tid: str) -> bool:
    return any(t.get("reviewOf") == tid for t in tasks)


def _depended_on(tasks: list[dict[str, Any]], tid: str) -> bool:
    return any(tid in t.get("dependsOn", []) for t in tasks)


def _valid(tasks: list[dict[str, Any]], handoff: dict[str, Any]) -> dict[str, Any] | None:
    from .plan_handoff import HandoffError, validate_handoff

    try:
        return validate_handoff({**handoff, "tasks": tasks})
    except HandoffError:
        return None


def propose_changes(handoff: dict[str, Any], ask: Asker, floor: float) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (handoff, changes). The handoff is unchanged when nothing passes."""
    from .plan_handoff import validate_handoff

    tasks = [dict(t) for t in handoff["tasks"]]
    changes: list[dict[str, Any]] = []

    def accept(new_tasks: list[dict[str, Any]], change: dict[str, Any]) -> bool:
        nonlocal tasks
        if _valid(new_tasks, handoff) is None:
            return False
        tasks = new_tasks
        changes.append(change)
        return True

    # 1. Add a review after each implementation step that Laya wants reviewed.
    for t in [t for t in tasks if _impl(t)]:
        if _review_of(tasks, t["id"]):
            continue
        pick = ask(_brief(t), REVIEW_INSTRUCTIONS, REVIEW_CRITERIA)
        if not pick or pick[0] != "review" or pick[1] < floor:
            continue
        review = {
            "id": f"{t['id']}-review", "title": f"Review: {t['title']}",
            "description": (f"Review the work from '{t['title']}'. Check correctness, build quality and "
                            "reusability. Report what is wrong; fix only what is clearly broken."),
            "targetFile": None, "files": [], "dependsOn": [t["id"]], "worker": None, "requires": [],
            "expectedOutput": "A short review: what was checked and what needs fixing.",
            "verification": "", "reviewOf": t["id"],
        }
        at = tasks.index(t) + 1
        accept([*tasks[:at], review, *tasks[at:]], {
            "kind": "add_review", "taskId": review["id"], "of": t["id"], "probability": round(pick[1], 2),
            "text": f"Laya added a review of '{t['title']}' by a different agent ({round(pick[1] * 100)}% sure).",
        })

    # 2. Drop an implementation step Laya judges not needed (never the last one).
    for t in [t for t in tasks if _impl(t)]:
        if len([x for x in tasks if _impl(x)]) <= 1 or _depended_on(tasks, t["id"]) or _review_of(tasks, t["id"]):
            continue
        pick = ask(_brief(t), NEEDED_INSTRUCTIONS, NEEDED_CRITERIA)
        if not pick or pick[0] != "not_needed" or pick[1] < floor:
            continue
        remaining = [x for x in tasks if x["id"] != t["id"]]
        accept(remaining, {
            "kind": "remove_step", "taskId": t["id"], "probability": round(pick[1], 2),
            "text": f"Laya dropped '{t['title']}' as not needed ({round(pick[1] * 100)}% sure).",
        })

    # 3. Run two adjacent, independent steps in the order Laya prefers.
    i = 0
    while i < len(tasks) - 1:
        a, b = tasks[i], tasks[i + 1]
        independent = (_impl(a) and _impl(b) and a["id"] not in b.get("dependsOn", [])
                       and b["id"] not in a.get("dependsOn", []))
        if independent:
            criteria = {"a": a["title"], "b": b["title"]}
            pick = ask(f"{a['title']}\n{b['title']}", ORDER_INSTRUCTIONS, criteria)
            if pick and pick[0] == "b" and pick[1] >= floor:
                swapped = [*tasks[:i], b, a, *tasks[i + 2:]]
                accept(swapped, {
                    "kind": "reorder", "taskId": b["id"], "before": a["id"], "probability": round(pick[1], 2),
                    "text": f"Laya ran '{b['title']}' before '{a['title']}' ({round(pick[1] * 100)}% sure).",
                })
        i += 1

    if not changes:
        return handoff, []
    return {**handoff, "tasks": validate_handoff({**handoff, "tasks": tasks})["tasks"]}, changes
