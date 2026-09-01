"""Verification engine — ACTION PERFORMED vs RESULT VERIFIED.

Reads only what the Fabric already recorded (task outcomes carrying the
per-invocation verification reports). It composes no new authority and can
upgrade nothing: an action that ran without a passing mechanical check is
reported as unverified, never as success.
"""

from __future__ import annotations

from ..contracts import AgentVerificationReport, TaskOutcome, TaskPlan


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
        detail = "All tasks completed with passing verification." if passed else (
            "Run parked awaiting a human approval decision." if pending_approval
            else "Not every action could be verified; see per-task outcomes.")
        return AgentVerificationReport(
            passed=passed, outcomes=rows, unverifiedActions=unverified, detail=detail,
        )
