"""Verification engine — ACTION PERFORMED vs RESULT VERIFIED.

Reads only what the Fabric already recorded (task outcomes carrying the
per-invocation verification reports). It composes no new authority and can
upgrade nothing: an action that ran without a passing mechanical check is
reported as unverified, never as success.
"""

from __future__ import annotations

from ..contracts import AgentVerificationReport, TaskOutcome, TaskPlan
from . import requested

#: Task states that count as settled for objective acceptance. "skipped"
#: is a task whose verification was already proven — on an earlier leg of
#: the same run, or because AURA determined from verified upstream
#: evidence that it was not needed. Both carry verified=True; neither is
#: a task that failed to happen.
_SETTLED = frozenset({"done", "skipped"})


class VerificationEngine:
    def verify(self, plan: TaskPlan, outcomes: list[TaskOutcome]) -> AgentVerificationReport:
        by_task = {t.id: t for t in plan.tasks}
        rows: list[TaskOutcome] = []
        unverified: list[str] = []
        for outcome in outcomes:
            task = by_task.get(outcome.taskId)
            verified_flag = outcome.verified if task else None
            kind = task.verification.kind if task else "audit-only"
            # audit-only verification passes when the invocation was performed
            # and recorded; mechanical kinds need the Fabric's own pass flag.
            effective = (
                True if (outcome.performed and kind == "audit-only")
                else verified_flag
            )
            row = outcome.model_copy(update={"verified": effective})
            rows.append(row)
            if outcome.state not in ("done",) or effective is not True:
                if outcome.state == "done":
                    unverified.append(outcome.taskId)
        # Only the tasks the acceptance criteria name decide whether the run
        # passed. A task no criterion names is optional: its failure is
        # reported, but it does not turn a satisfied objective into a failure.
        # With no criteria, every task is required (the legacy rule).
        required = self.required_task_ids(plan)
        decisive = rows if required is None else [r for r in rows if r.taskId in required]
        critical_failure = any(r.state in ("failed", "blocked") for r in decisive)
        passed = bool(decisive) and not critical_failure \
            and all(r.verified is True for r in decisive)
        # Phase H — objective acceptance: "tasks completed" is not
        # "objective verified". Each stated criterion must be mechanically
        # met by the covered task outcomes; otherwise the objective stays
        # unaccepted even when every task verified.
        accepted, unmet = self.verify_objective(plan, rows)
        if passed and not accepted:
            detail = ("All tasks verified, but the objective acceptance "
                      f"criteria are unmet: {'; '.join(unmet)}.")
        else:
            detail = "All tasks completed with passing verification." if passed else (
                "Not every action could be verified; see per-task outcomes.")
        return AgentVerificationReport(
            passed=passed and accepted, outcomes=rows,
            unverifiedActions=unverified, detail=detail,
            objectiveAccepted=accepted, unmetAcceptance=unmet,
        )

    @staticmethod
    def required_task_ids(plan: TaskPlan) -> set[str] | None:
        """The task ids the acceptance criteria require, or None when every
        task is required (no criteria, or a criterion that names no tasks)."""
        criteria = list(getattr(plan, "acceptance", None) or [])
        if not criteria:
            return None
        required: set[str] = set()
        for criterion in criteria:
            wanted = (criterion.expect or {}).get("tasks")
            if wanted is None:
                return None
            required.update(wanted)
        return required

    @staticmethod
    def verify_objective(plan: TaskPlan,
                         rows: list[TaskOutcome]) -> tuple[bool, list[str]]:
        """Mechanical objective acceptance. A criterion covers the task
        ids in expect["tasks"] (or all tasks when unnamed) and is met
        only when every covered task is SETTLED and verified; mechanical
        kinds additionally need a covered task verified under that same
        kind, so a plan cannot claim read-back proof from audit-only
        records. No criteria → accepted (legacy behavior).

        Settled means done, or skipped-because-already-proven. A run that
        finishes in a later leg, where the earlier
        task is restored as skipped with its verification intact; reading
        that as "not done" made every multi-worker objective unacceptable
        the moment it crossed an approval, which then fell through to a
        summary that said "completed" anyway. One of those had to give,
        and it is not the honesty of the final answer.

        THE REQUEST IS ALSO A CRITERION. The acceptance above is evaluated
        against the PLAN, and a plan states its own acceptance criteria — so
        a plan can always satisfy itself. That is how a run whose only task
        stored a workflow definition could report "every acceptance criterion
        is met" for a request to write source code: the plan's criterion
        ("the definition is stored and reads back") was met, and nothing
        asked whether the REQUEST was served. The request is the only
        statement of what was actually wanted, so a run that never
        addressed the deliverables it named is not a verified objective,
        however well the plan verified its own."""
        unmet: list[str] = list(VerificationEngine.unaddressed_request(plan))
        unmet += VerificationEngine.unaddressed_git_status(plan, rows)
        criteria = list(getattr(plan, "acceptance", None) or [])
        if not criteria:
            return (not unmet), unmet
        by_id = {r.taskId: r for r in rows}
        for index, criterion in enumerate(criteria):
            label = criterion.description or f"criterion {index + 1}"
            wanted = (criterion.expect or {}).get("tasks")
            covered = [r for tid, r in by_id.items()
                       if wanted is None or tid in wanted]
            if wanted is not None and not set(wanted) <= set(by_id):
                unmet.append(f"{label}: names unknown tasks")
                continue
            bad = [r.taskId for r in covered
                   if r.state not in _SETTLED or r.verified is not True]
            if bad:
                unmet.append(
                    f"{label}: unverified tasks: {', '.join(sorted(bad))}")
                continue
            if criterion.kind != "audit-only":
                # Covered tasks' declared kinds come from the plan.
                planned = {t.id: t for t in plan.tasks}
                if not any(
                        (planned.get(r.taskId) is not None
                         and planned[r.taskId].verification.kind
                         == criterion.kind)
                        for r in covered):
                    unmet.append(
                        f"{label}: no covered task verified under "
                        f"'{criterion.kind}'")
        return (not unmet), unmet

    @staticmethod
    def unaddressed_git_status(plan: TaskPlan, rows: list[TaskOutcome]) -> list[str]:
        """A git status request is served only by evidence from a git.status
        task: that task must have run (performed, with a recorded invocation)
        and finished. Any other successful result, including a project listing,
        is not evidence of repository status, however well the plan verified
        its own criteria."""
        intent = getattr(plan, "intent", None)
        request = str(getattr(intent, "goal", "") or "") if intent else ""
        if not requested.asks_for_git_status(request):
            return []
        git_ids = [t.id for t in (getattr(plan, "tasks", None) or [])
                   if getattr(t, "capabilityId", None) == "git.status"]
        if not git_ids:
            return ["the request asked for git status, which no git.status task addressed"]
        evidenced = [r for r in rows
                     if r.taskId in git_ids and r.state == "done"
                     and r.performed and r.invocationIds]
        if not evidenced:
            return ["the request asked for git status, and no git.status task produced evidence of it"]
        return []

    @staticmethod
    def unaddressed_request(plan: TaskPlan) -> list[str]:
        """What the REQUEST asked for that the plan never addressed.

        Two failures live here, and both were seen in a real run:

        · the request named a file (src/math.js) and no task targeted it
          or even mentioned it — the plan quietly did something else;
        · the plan's only task created a WORKFLOW DEFINITION, whose
          evidence is a stored graph hash. That is proof of a stored
          graph, never of source-code implementation, so it cannot
          satisfy a request that did not ask for a workflow.

        A request that names no file and asks for no workflow is left
        alone: there is nothing concrete to check it against, and a plan
        that satisfies its own criteria is all anyone has to go on.
        """
        intent = getattr(plan, "intent", None)
        request = str(getattr(intent, "goal", "") or "") if intent else ""
        if not request:
            return []
        tasks = list(getattr(plan, "tasks", None) or [])
        if not tasks:
            return []
        # Delegated work is addressed by the worker receiving the request:
        # the file the request names is in the task's input text, and the
        # worker acts on the request. Such a plan is NOT subject to the
        # file-naming check below — only plans that author their own
        # content (filesystem.write, workflow.create, ...) are.
        if any(getattr(t, "capabilityId", None) == "agent.delegate"
               for t in tasks):
            return []
        targeted = [p for t in tasks
                    for p in (([getattr(t, "targetFile", None)]
                               if getattr(t, "targetFile", None) else [])
                              + list(getattr(t, "files", None) or []))]
        mentioned = [str(getattr(t, k, "") or "") for t in tasks
                     for k in ("description", "title", "expectedOutput",
                               "verification")]
        unmet = [f"the request asked for {f}, which no task addressed"
                 for f in requested.unaddressed_files(request, targeted,
                                                      mentioned)]
        # A stored workflow definition is not a source-code implementation.
        if not requested.asks_for_workflow(request) and all(
                getattr(t, "capabilityId", None) == "workflow.create"
                for t in tasks):
            unmet.append(
                "the plan only stored a workflow definition, which is not "
                "evidence that the requested work was implemented")
        return unmet
