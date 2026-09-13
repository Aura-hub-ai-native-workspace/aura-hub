"""Verification engine — ACTION PERFORMED vs RESULT VERIFIED.

Reads only what the Fabric already recorded (task outcomes carrying the
per-invocation verification reports). It composes no new authority and can
upgrade nothing: an action that ran without a passing mechanical check is
reported as unverified, never as success.
"""

from __future__ import annotations

from ..contracts import AgentVerificationReport, TaskOutcome, TaskPlan

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
                if outcome.state in ("done", "awaiting-approval"):
                    unverified.append(outcome.taskId)
        critical_failure = any(r.state in ("failed", "blocked") for r in rows)
        pending_approval = any(r.state == "awaiting-approval" for r in rows)
        passed = bool(rows) and not critical_failure and not pending_approval \
            and all(r.verified is True for r in rows)
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
                "Run parked awaiting a human approval decision." if pending_approval
                else "Not every action could be verified; see per-task outcomes.")
        return AgentVerificationReport(
            passed=passed and accepted, outcomes=rows,
            unverifiedActions=unverified, detail=detail,
            objectiveAccepted=accepted, unmetAcceptance=unmet,
        )

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
        parks for approval finishes in a later leg, where the earlier
        task is restored as skipped with its verification intact; reading
        that as "not done" made every multi-worker objective unacceptable
        the moment it crossed an approval, which then fell through to a
        summary that said "completed" anyway. One of those had to give,
        and it is not the honesty of the final answer."""
        criteria = list(getattr(plan, "acceptance", None) or [])
        if not criteria:
            return True, []
        by_id = {r.taskId: r for r in rows}
        unmet: list[str] = []
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
