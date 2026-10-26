"""Planner → Workspace handoff: the contract and its translation.

The Planner produces a plan; Workspace executes it. This module is the
seam between the two, and it adds no second execution engine: a handed-
off plan becomes the SAME model-shaped proposal `TaskPlanner.
plan_from_model` already validates, and then runs through the same
discovery, authority, coordinator and verification legs as a request
typed into Workspace.

What crosses the seam is the plan itself — every task's title,
description, target file, related files, dependencies and chosen
worker — never just the goal text.

How a task executes is decided here, deterministically, from what the
plan says:

  * a task with a worker the person chose (a connected coding agent) is
    delegated to that worker, scoped to the task's files;
  * a task with a target file and no worker is written by AURA itself:
    its own reasoning model authors the file content inside the
    Workspace run (`authoring_prompt`), and the Fabric writes and reads
    it back like any other governed write;
  * a task with neither is not actionable and the whole handoff is
    refused before anything starts — the plan stays with the Planner.
"""

from __future__ import annotations

import re
from typing import Any

from . import requested

#: Bounds — the handoff is untrusted input from another process.
MAX_HANDOFF_TASKS = 16
MAX_TEXT = 4000
MAX_FILES_PER_TASK = 12

#: Worker value meaning "AURA picks" — and, only if the owner opted in, "AURA writes it itself".
AURA_WORKER = "aura"


def authoring_allowed() -> bool:
    """May AURA's own reasoning model write project files? Default NO.

    Laya and the local model plan, select agents, trigger them and report; the
    connected coding agents write the code. Writing files from the planning model
    stays available only as an explicit owner opt-in (`allowAuraAuthoring` in
    worker-policy.json), never as a silent fallback when no agent is available.
    """
    from ..workers.billing import owner_setting

    return owner_setting("allowAuraAuthoring", False) is True

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PLAN_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")


class HandoffError(ValueError):
    """The handoff cannot start. `code` is the reason class:

    invalid    — the plan is malformed or not actionable (HTTP 400)
    duplicate  — this plan revision was already sent (HTTP 409)
    unavailable — Workspace cannot carry it out as configured (HTTP 409)
    """

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.extra = extra


def _text(value: object, field: str, *, required: bool = True,
          bound: int = MAX_TEXT) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise HandoffError("invalid", f"{field} must be text")
    value = value.strip()
    if required and not value:
        raise HandoffError("invalid", f"{field} is required")
    if len(value) > bound:
        raise HandoffError("invalid", f"{field} is longer than {bound} characters")
    return value


def _rel_path(value: object, field: str) -> str:
    """A project-relative path. Confinement is re-enforced at execution;
    this only refuses shapes that can never be a project file."""
    path = _text(value, field, bound=300)
    if path.startswith(("/", "\\", "~")) or re.match(r"^[A-Za-z]:", path):
        raise HandoffError("invalid", f"{field} must be relative to the project")
    if ".." in re.split(r"[\\/]", path):
        raise HandoffError("invalid", f"{field} must stay inside the project")
    return path


def validate_handoff(raw: object) -> dict:
    """Normalise and validate a handoff. Fails closed with HandoffError."""
    if not isinstance(raw, dict):
        raise HandoffError("invalid", "plan must be an object")
    if raw.get("source") != "planner":
        raise HandoffError("invalid", "plan.source must be 'planner'")
    plan_id = _text(raw.get("planId"), "plan.planId", bound=96)
    if not _PLAN_ID_RE.fullmatch(plan_id):
        raise HandoffError("invalid", "plan.planId is malformed")
    revision = raw.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise HandoffError("invalid", "plan.revision must be a positive integer")
    goal = _text(raw.get("goal"), "plan.goal")
    raw_tasks = raw.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise HandoffError("invalid", "the plan has no tasks to execute")
    if len(raw_tasks) > MAX_HANDOFF_TASKS:
        raise HandoffError(
            "invalid", f"the plan has {len(raw_tasks)} tasks; Workspace takes "
            f"at most {MAX_HANDOFF_TASKS} in one handoff")

    tasks: list[dict] = []
    seen: set[str] = set()
    for i, rt in enumerate(raw_tasks):
        if not isinstance(rt, dict):
            raise HandoffError("invalid", f"task {i + 1} is not an object")
        tid = _text(rt.get("id"), f"task {i + 1} id", bound=64)
        if not _ID_RE.fullmatch(tid):
            raise HandoffError("invalid", f"task id '{tid}' is malformed")
        if tid in seen:
            raise HandoffError("invalid", f"task id '{tid}' appears twice")
        seen.add(tid)
        title = _text(rt.get("title"), f"task '{tid}' title", bound=300)
        description = _text(rt.get("description"), f"task '{tid}' description",
                            required=False)
        target = rt.get("targetFile")
        target = _rel_path(target, f"task '{tid}' targetFile") if target else None
        files_raw = rt.get("files") or []
        if not isinstance(files_raw, list) or len(files_raw) > MAX_FILES_PER_TASK:
            raise HandoffError(
                "invalid", f"task '{tid}' files must be a list of at most "
                f"{MAX_FILES_PER_TASK} paths")
        files = [_rel_path(f, f"task '{tid}' file") for f in files_raw]
        if target and target not in files:
            files = [target, *files]
        deps = rt.get("dependsOn") or []
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            raise HandoffError("invalid", f"task '{tid}' dependsOn must list task ids")
        expected = _text(rt.get("expectedOutput"), f"task '{tid}' expectedOutput", required=False, bound=600)
        verification = _text(rt.get("verification"), f"task '{tid}' verification", required=False, bound=600)
        requires = rt.get("requires") or []
        if (not isinstance(requires, list) or len(requires) > 6
                or not all(isinstance(r, str) and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", r)
                           for r in requires)):
            raise HandoffError("invalid", f"task '{tid}' requires must list tool ids")
        worker = rt.get("worker")
        if worker is not None:
            worker = _text(worker, f"task '{tid}' worker", bound=64)
            if not _ID_RE.fullmatch(worker):
                raise HandoffError("invalid", f"task '{tid}' worker is malformed")
        if not target and worker in (None, AURA_WORKER) and authoring_allowed():
            raise HandoffError(
                "invalid",
                f"task '{title}' has no target file and no worker, so Workspace "
                "has nothing it can carry out for it. Give it a target file "
                "or choose a worker in the Planner.")
        tasks.append({"id": tid, "title": title, "description": description,
                      "targetFile": target, "files": files,
                      "dependsOn": list(dict.fromkeys(deps)), "worker": worker,
                      "requires": list(dict.fromkeys(requires)),
                      "expectedOutput": expected, "verification": verification})

    for t in tasks:
        for d in t["dependsOn"]:
            if d not in seen:
                raise HandoffError(
                    "invalid", f"task '{t['id']}' depends on unknown task '{d}'")
            if d == t["id"]:
                raise HandoffError("invalid", f"task '{t['id']}' depends on itself")
    ordered = topological(tasks)

    writes = [t["targetFile"] for t in ordered
              if t["targetFile"] and t["worker"] in (None, AURA_WORKER) and authoring_allowed()]
    dupes = sorted({p for p in writes if writes.count(p) > 1})
    if dupes:
        raise HandoffError(
            "invalid", "more than one AURA-written task targets "
            + ", ".join(dupes) + "; merge them or give one a worker")

    # THE REQUEST IS THE AUTHORITY. A plan states its own acceptance
    # criteria, so a plan can always satisfy itself: it may declare
    # "the workflow definition is stored and reads back" and prove
    # exactly that, while the person asked for source code that was
    # never written. A plan that ignores the deliverables the request
    # named is refused HERE, before anything runs, rather than being
    # allowed to report a verified mission it never achieved.
    # A delegated plan (one that hands the request to a connected coding
    # agent) addresses the request through the worker, who receives the
    # request text: the file names need not appear in targetFile. The
    # file-naming check applies only to AURA-authored plans, which is the
    # shape that produced the false "mission verified" report — a plan
    # whose only task stored a workflow definition while the person asked
    # for source code.
    _has_delegated = any(t.get("worker") not in (None, AURA_WORKER)
                         for t in ordered)
    if not _has_delegated:
        _targeted = [p for t in ordered
                     for p in (([t["targetFile"]] if t["targetFile"] else []) + t["files"])]
        _mentioned = [str(t.get(k) or "") for t in ordered
                      for k in ("title", "description", "expectedOutput", "verification")]
        _unaddressed = requested.unaddressed_files(goal, _targeted, _mentioned)
        if _unaddressed:
            raise HandoffError(
                "invalid",
                "the plan does not address " + ", ".join(_unaddressed) +
                ", which the request names; add a task for it, or take it "
                "out of the request")

    acceptance_raw = raw.get("acceptance") or []
    if (not isinstance(acceptance_raw, list) or len(acceptance_raw) > 12
            or not all(isinstance(a, str) for a in acceptance_raw)):
        raise HandoffError("invalid", "plan.acceptance must be a list of at most 12 statements")
    acceptance = [_text(a, "an acceptance criterion", bound=400) for a in acceptance_raw if a.strip()]

    context = None
    ctx_raw = raw.get("context")
    if ctx_raw is not None:
        if not isinstance(ctx_raw, dict):
            raise HandoffError("invalid", "plan.context must be an object")
        sources = []
        for src in (ctx_raw.get("sources") or [])[:12]:
            if isinstance(src, dict) and isinstance(src.get("url"), str) \
                    and src["url"].lower().startswith(("http://", "https://")):
                sources.append({"title": str(src.get("title") or "")[:200], "url": src["url"][:500]})
        context = {"text": _text(ctx_raw.get("text"), "plan.context.text", required=False, bound=8000),
                   "scope": str(ctx_raw.get("scope") or "")[:96], "sources": sources}

    return {"source": "planner", "planId": plan_id, "revision": revision,
            "goal": goal, "tasks": ordered, "acceptance": acceptance, "context": context}


def topological(tasks: list[dict]) -> list[dict]:
    """Dependency order, stable on the plan's own order. Refuses cycles."""
    by_id = {t["id"]: t for t in tasks}
    order: list[dict] = []
    state: dict[str, int] = {}

    def visit(tid: str, trail: list[str]) -> None:
        if state.get(tid) == 2:
            return
        if state.get(tid) == 1:
            cycle = " → ".join([*trail[trail.index(tid):], tid])
            raise HandoffError("invalid", f"the plan's dependencies form a cycle: {cycle}")
        state[tid] = 1
        for d in by_id[tid]["dependsOn"]:
            visit(d, [*trail, tid])
        state[tid] = 2
        order.append(by_id[tid])

    for t in tasks:
        visit(t["id"], [])
    return order


def aura_authored(task: dict) -> bool:
    """Does AURA's own model write this task's file? Only on explicit owner opt-in."""
    return bool(task["targetFile"]) and task["worker"] in (None, AURA_WORKER) and authoring_allowed()


def needs_selection(task: dict) -> bool:
    """A task nobody was named for: Laya selects a connected coding agent for it."""
    return task["worker"] in (None, AURA_WORKER) and not aura_authored(task)


_FRONTEND = re.compile(r"\.(html?|css|scss|jsx|tsx|vue|svelte)$|\b(ui|interface|style|styling|layout|frontend|front-end|page|markup|responsive)\b", re.I)
_BACKEND = re.compile(r"\.(py|go|rs|java|rb|php|sql)$|\b(api|server|backend|back-end|database|storage|engine|logic|service|model|audio engine|library|state)\b", re.I)
_TESTING = re.compile(r"\b(test|tests|testing|verify|verification|lint|integrat\w*|e2e|qa|fix|debug)\b", re.I)


def classify_task(task: dict) -> str:
    """'testing' | 'frontend' | 'backend' | 'general', from what the task itself says."""
    # What the task is called and which files it owns decide its kind. The long
    # brief is not read: it names every part of the project (element ids, file
    # names of the other tasks) and would make every task look like all of them.
    text = " ".join([task["title"], " ".join(task.get("files") or []), task.get("targetFile") or ""])
    if _TESTING.search(task["title"]):
        return "testing"
    front, back = len(_FRONTEND.findall(text)), len(_BACKEND.findall(text))
    if front > back:
        return "frontend"
    if back > front:
        return "backend"
    return "general"


#: Which agent suits which kind of work, in order of preference. Only a hint:
#: availability and the owner's policy decide first.
_PREFERENCE = {"frontend": ("kilo-code", "opencode"), "backend": ("opencode", "kilo-code")}


def select_workers(handoff: dict, candidates: list[dict], unavailable: list[dict]) -> dict:
    """Assign a connected, allowed coding agent to every task that has none.

    Deterministic and explainable (no model call): availability and policy are
    facts, and the choice among available agents follows the kind of work and
    spreads tasks across agents when several are available. Each task also waits
    for the one before it, so only one coding agent runs at a time and the next
    starts only after the previous one finished and passed its checks.

    Returns {"handoff": <new handoff>, "selections": [...]} and raises
    HandoffError("unavailable", ...) naming every blocked agent when a task needs
    an agent and none is available.
    """
    tasks = [dict(t) for t in handoff["tasks"]]
    pending = [t for t in tasks if needs_selection(t)]
    if pending and not candidates:
        blocked = "; ".join(f"{u['id']}: {u['reason']}" for u in unavailable) or "no coding agent is connected"
        raise HandoffError(
            "unavailable",
            "No connected coding agent is available to carry out this plan "
            f"({len(pending)} task(s) need one). {blocked}. Laya plans and coordinates; it does "
            "not write the application itself. Connect an agent, or allow one in "
            "<AURA_HOME>/worker-policy.json.")
    used: dict[str, int] = {c["id"]: 0 for c in candidates}
    selections: list[dict] = []
    previous_worker: str | None = None
    for t in tasks:
        if not needs_selection(t):
            previous_worker = t["worker"] or previous_worker
            continue
        kind = classify_task(t)
        ids = [c["id"] for c in candidates]
        preferred = [w for w in _PREFERENCE.get(kind, ()) if w in ids]
        pool = preferred or ids
        # least-used first; among equals, not the same agent as the previous task
        order = list(preferred) + [w for w in ids if w not in preferred]
        pool = sorted(pool, key=lambda w: (used[w], w == previous_worker, order.index(w)))
        chosen = pool[0]
        used[chosen] += 1
        previous_worker = chosen
        t["worker"] = chosen
        t["workerChoice"] = "selected"
        name = next(c.get("name") or chosen for c in candidates if c["id"] == chosen)
        why = (f"{kind} work" if kind != "general" else "general work") + (
            f"; {chosen} is the preferred agent for it" if chosen in _PREFERENCE.get(kind, ()) else
            "; chosen by availability and to spread work across agents")
        selections.append({"taskId": t["id"], "worker": chosen, "name": name, "kind": kind, "reason": why,
                           "candidates": ids, "unavailable": [{"id": u["id"], "reason": u["reason"]} for u in unavailable]})
    # One agent at a time, in the plan's order: each task waits for the previous one.
    # (Only agent-delegated tasks are chained; a file AURA itself writes by the
    # owner's opt-in is not a coding agent and does not wait for one.)
    previous_delegated: str | None = None
    for t in tasks:
        if aura_authored(t):
            continue
        if previous_delegated and previous_delegated not in t["dependsOn"]:
            t["dependsOn"] = [*t["dependsOn"], previous_delegated]
        previous_delegated = t["id"]
    return {"handoff": {**handoff, "tasks": tasks}, "selections": selections}


#: The largest existing file AURA's authoring model is shown whole. A bigger file
#: would have to be cut to fit, and a rewrite of a cut file silently loses the rest.
MAX_EDITABLE_CHARS = 5_000


def authoring_prompt(goal: str, task: dict, written: dict[str, str],
                     existing: str | None) -> tuple[str, str]:
    """System and user prompt for AURA writing one task's file."""
    system = (
        "You write the complete contents of exactly one file in a software "
        "project. Output ONLY the file's contents — no explanation, no "
        "markdown code fences, no commentary before or after. Keep it "
        "focused on what the task asks; do not invent unrelated features.")
    lines = [
        f"Overall goal: {goal}",
        f"This task: {task['title']}",
    ]
    if task["description"]:
        lines.append(f"Task details: {task['description']}")
    lines.append(f"File to write: {task['targetFile']}")
    if existing is not None:
        lines += ["", "The file already exists and this task CHANGES it. Its current "
                  "contents (output the whole file with the change made, keeping "
                  "what should stay; returning it unchanged fails the task):", existing]
    if written:
        lines += ["", "Files already written earlier in this plan (for "
                  "consistency):"]
        for path, content in list(written.items())[-4:]:
            lines += [f"--- {path} ---", content[:1500]]
    lines += ["", f"Write the full contents of {task['targetFile']} now."]
    return system, "\n".join(lines)


_FENCE = re.compile(r"^\s*```[^\n]*\n(?P<body>.*?)\n?```\s*$", re.DOTALL)


def clean_authored(text: str) -> str:
    """Strip one wrapping code fence a model added despite instructions."""
    match = _FENCE.match(text or "")
    body = match.group("body") if match else (text or "")
    return body if body.endswith("\n") else body + "\n"


def build_proposal(handoff: dict, contents: dict[str, str]) -> dict:
    """The validated handoff as a `plan_from_model` proposal.

    `contents` maps each AURA-authored task id to the file text AURA's
    model wrote for it inside this run.
    """
    proposal_tasks = []
    # Scope each delegated task to its files wherever the planner's
    # narrowing rule allows it (a downstream task may not widen what its
    # dependencies were scoped to). Root tasks always qualify, and they are
    # the ones that can run side by side, so file ownership between
    # parallel workers is kept. A downstream task whose files lie outside
    # its dependencies' scope keeps them in its brief instead; it runs only
    # after those dependencies settle, so it never races them.
    scopes: dict[str, list[str] | None] = {}
    for t in handoff["tasks"]:
        text = t["title"] if not t["description"] else f"{t['title']}\n\n{t['description']}"
        entry: dict[str, Any] = {"id": t["id"], "dependsOn": list(t["dependsOn"])}
        if t.get("requires"):
            entry["requiresTools"] = list(t["requires"])
        if aura_authored(t):
            entry.update({
                "description": (f"Write {t['targetFile']} — {t['title']}"
                                + (f" ({t['expectedOutput']})" if t.get("expectedOutput") else ""))[:400],
                "capabilityId": "filesystem.write",
                "input": {"path": t["targetFile"], "content": contents[t["id"]]},
                "verificationKind": "read-back",
            })
            # A file write carries its path in input, not scopePaths, and
            # the planner's narrowing rule does not constrain tasks
            # downstream of an unscoped one — mirror that exactly.
            scopes[t["id"]] = None
        else:
            if t["files"]:
                text += "\n\nFiles for this task: " + ", ".join(t["files"])
            if t.get("expectedOutput"):
                text += "\n\nExpected output: " + t["expectedOutput"]
            if t.get("verification"):
                text += "\nHow it will be checked: " + t["verification"]
            if handoff.get("acceptance"):
                text += "\n\nThe overall goal counts as met when: " + "; ".join(handoff["acceptance"][:6])
            entry.update({
                "description": t["title"][:400],
                "capabilityId": "agent.delegate",
                "nodeId": t["worker"],
                "workerRole": "code",
                "workerChoice": "selected" if t.get("workerChoice") == "selected" else "named",
                "input": {"task": text[:MAX_TEXT]},
                # The worker's own exit is the mechanical check; the plan's
                # title is what it must have done.
                "verificationKind": "exit-code",
                "verification": (t.get("verification") or f"{t['worker']} completes: {t['title']}")[:500],
            })
            ctx = handoff.get("context")
            if ctx and ctx.get("text"):
                # Settled decisions and research, as data for the worker.
                entry["input"]["context"] = (
                    '<untrusted-data kind="plan-context">' + ctx["text"][:2800] + "</untrusted-data>")
            scope = list(t["files"]) or None
            if scope and t["dependsOn"]:
                upstream = [scopes.get(d) for d in t["dependsOn"]]
                if all(upstream):
                    covered = {p for u in upstream for p in (u or [])}
                    if not all(any(f == c or f.startswith(c.rstrip("/") + "/")
                                   for c in covered) for f in scope):
                        scope = None
            if scope:
                entry["scopePaths"] = scope
            scopes[t["id"]] = scope
        proposal_tasks.append(entry)
    return {"tasks": proposal_tasks}


__all__ = ["AURA_WORKER", "HandoffError", "MAX_HANDOFF_TASKS", "aura_authored", "authoring_allowed",
           "classify_task", "needs_selection", "select_workers",
           "authoring_prompt", "build_proposal", "clean_authored", "topological",
           "validate_handoff"]
