"""Supervisor — deterministic correction decisions over worker evidence.

The supervisor does NOT plan, does NOT execute, and does NOT interpret
beyond evidence. It reads task outcomes plus the executor-level evidence
(scope checks, exit codes, timeouts) and returns a verdict that the
Central Agent — or a workflow driver — acts on through the EXISTING
governed paths (Fabric invoke with approval, workflow resume).

Division of labor, enforced by construction:

- DETERMINISTIC here: refusal conditions, budget accounting, scope
  subset checks, verdict derivation, corrective-invocation assembly.
- INTERPRETATION elsewhere: whether a parked deviation is safe to
  continue is the Central Agent's call (possibly model-assisted); this
  module only ever proposes the *shape* of a safe correction.

A correction is always a NEW governed invocation: the corrective input
carries `correctionOf`/`attempt` fields, so its approval fingerprint
differs and every correction is re-gated. Nothing here grants authority.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

#: Corrective attempts allowed AFTER the initial run (initial + budget
#: total runs). Bounded by construction: decide() refuses past this.
MAX_CORRECTION_ATTEMPTS = 2


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── verdict vocabularies (small, closed) ──────────────────────────────

# Per-task verdicts. PARKED_* all mean "not accepted, evidence preserved,
# worker must not continue uncontrolled". FAILED_* are terminal for the
# attempt. BLOCKED marks downstream tasks gated on an unverified upstream.
TASK_VERIFIED = "verified"
TASK_FAILED = "failed"
TASK_PARKED_DEVIATION = "parked-deviation"
TASK_PARKED_TIMEOUT = "parked-timeout"
TASK_PARKED_CANCELLED = "parked-cancelled"
TASK_PARKED_UNVERIFIED = "parked-unverified"
TASK_DENIED = "denied"
TASK_BLOCKED = "blocked"

# Run verdicts.
RUN_CONTINUE = "continue"
RUN_PARKED = "parked"
RUN_FAILED = "failed"
RUN_FAILED_FOR_REVIEW = "failed-for-review"
RUN_BLOCKED = "blocked"


@dataclass
class TaskVerdict:
    task_id: str
    status: str
    correctable: bool = False
    reasons: list[str] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunVerdict:
    status: str
    tasks: list[TaskVerdict] = field(default_factory=list)
    attempts_used: int = 0
    budget_remaining: int = 0
    detail: str = ""


@dataclass
class CorrectionRecord:
    """One attributable correction step. Serializable for audit/persistence."""

    task_contract_id: str
    task_id: str
    worker_node_id: str | None
    attempt: int
    parent_attempt: int | None
    verdict: str
    reasons: list[str] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)
    corrective_input: dict[str, Any] | None = None
    created_at: str = field(default_factory=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskContractId": self.task_contract_id,
            "taskId": self.task_id,
            "workerNodeId": self.worker_node_id,
            "attempt": self.attempt,
            "parentAttempt": self.parent_attempt,
            "verdict": self.verdict,
            "reasons": list(self.reasons),
            "evidence": dict(self.evidence),
            "correctiveInput": (dict(self.corrective_input)
                                if self.corrective_input is not None else None),
            "createdAt": self.created_at,
        }

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> "CorrectionRecord":
        return CorrectionRecord(
            task_contract_id=str(raw.get("taskContractId", "")),
            task_id=str(raw.get("taskId", "")),
            worker_node_id=raw.get("workerNodeId"),
            attempt=int(raw.get("attempt", 0)),
            parent_attempt=raw.get("parentAttempt"),
            verdict=str(raw.get("verdict", "")),
            reasons=list(raw.get("reasons") or []),
            evidence=dict(raw.get("evidence") or {}),
            corrective_input=(dict(raw["correctiveInput"])
                              if raw.get("correctiveInput") is not None else None),
            created_at=str(raw.get("createdAt", "")),
        )


def _scope_subset(proposed: list[str], approved: list[str]) -> bool:
    """Every proposed path must fall inside some approved path (or equal it)."""
    def inside(path: str, scope: list[str]) -> bool:
        return any(path == prefix or path.startswith(prefix + "/")
                   for prefix in scope)
    return all(inside(p, approved) for p in proposed)


def validate_correction_scope(proposed: list[str] | None,
                              approved: list[str]) -> tuple[bool, str]:
    """A correction may keep or NARROW the approved scope — never widen it.

    Returns (ok, reason). A wider scope is refused here; obtaining it
    requires a fresh approval through the normal authority path.
    """
    if proposed is None:
        return True, ""
    if not isinstance(proposed, list) or any(not isinstance(p, str) for p in proposed):
        return False, "corrective scope must be a list of paths."
    if _scope_subset(proposed, approved):
        return True, ""
    return (False,
            "corrective scope exceeds the approved scope; "
            "a wider scope needs a fresh approval, never an automatic grant.")


def decide_task(outcome_state: str, evidence: dict[str, Any] | None,
                *, verified: bool | None = None) -> TaskVerdict:
    """Derive one task's verdict from its terminal state plus evidence.

    `outcome_state` is the ExecutionController/TaskOutcome state vocabulary
    (done/failed/blocked/awaiting-approval/denied/timed-out/cancelled).
    `evidence` carries executor-level facts the state alone cannot express:
    scopeDeviation, exitCode, timedOut. Pure function — no I/O, no model.
    """
    evidence = dict(evidence or {})
    task_id = str(evidence.get("taskId") or "")

    if outcome_state == "denied":
        return TaskVerdict(task_id, TASK_DENIED, False,
                           ["policy denied this task; a correction cannot override a denial."],
                           evidence)
    if outcome_state == "cancelled":
        # An operator-cancelled run must never auto-retry: re-dispatching
        # would defy the cancellation.
        return TaskVerdict(task_id, TASK_PARKED_CANCELLED, False,
                           ["run was cancelled; automatic re-dispatch is refused."],
                           evidence)
    if outcome_state == "timed-out":
        return TaskVerdict(task_id, TASK_PARKED_TIMEOUT, True,
                           ["run exceeded its time budget; retry is transient-safe within budget."],
                           evidence)
    if outcome_state in ("failed", "blocked"):
        return TaskVerdict(task_id, TASK_FAILED, True,
                           [f"run ended {outcome_state}; retry within budget is allowed."],
                           evidence)
    if outcome_state == "awaiting-approval":
        return TaskVerdict(task_id, TASK_BLOCKED, False,
                           ["run is parked on a human approval; the supervisor does not decide it."],
                           evidence)
    if outcome_state == "done":
        if evidence.get("scopeDeviation"):
            outside = ((evidence.get("scopeCheck") or {}).get("outside")) or []
            shown = ", ".join(outside[:5])
            return TaskVerdict(
                task_id, TASK_PARKED_DEVIATION, True,
                [f"worker files fell outside the declared scope: {shown}.",
                 "Changes preserved as evidence; nothing reverted."],
                evidence)
        if verified is True:
            return TaskVerdict(task_id, TASK_VERIFIED, False, [], evidence)
        return TaskVerdict(task_id, TASK_PARKED_UNVERIFIED, True,
                           ["run finished but verification did not pass."],
                           evidence)
    return TaskVerdict(task_id, TASK_FAILED, False,
                       [f"unknown terminal state {outcome_state!r}; refusing to continue."],
                       evidence)


def decide_run(task_decisions: list[tuple[str, str, dict[str, Any] | None,
                                          bool | None]],
               depends_on: dict[str, list[str]] | None = None,
               *, attempts_used: int = 1,
               budget: int = MAX_CORRECTION_ATTEMPTS,
               task_contract_id: str = "") -> RunVerdict:
    """Decide a whole supervised step over per-task (state, evidence) pairs.

    Each entry: (task_id, outcome_state, evidence, verified). Downstream
    tasks whose dependencies did not verify are marked BLOCKED and never
    cleared to run — a parked upstream blocks its dependents by
    construction. Budget gates CORRECT-ability, not PARKING: parking is
    always allowed; only re-dispatch consumes budget.
    """
    depends_on = depends_on or {}
    verdicts: dict[str, TaskVerdict] = {}
    for task_id, state, evidence, verified in task_decisions:
        verdicts[task_id] = decide_task(state, evidence, verified=verified)

    # Propagate blocking downstream in dependency order (stable, bounded).
    # A task that verified on its own but consumed an unverified upstream
    # result is BLOCKED: its verification is meaningless. Tasks that
    # already failed/parked/denied keep their own (more informative)
    # status while still blocking everything below them.
    blocked_ids = {tid for tid, v in verdicts.items()
                   if v.status not in (TASK_VERIFIED,)}
    changed = True
    while changed:
        changed = False
        for tid, deps in depends_on.items():
            if tid not in verdicts:
                continue
            if verdicts[tid].status != TASK_VERIFIED:
                blocked_ids.add(tid)
                continue
            if any(d in blocked_ids for d in deps):
                verdicts[tid] = TaskVerdict(
                    tid, TASK_BLOCKED, False,
                    ["blocked: an upstream task did not verify."],
                    verdicts[tid].evidence)
                blocked_ids.add(tid)
                changed = True

    ordered = [verdicts[tid] for tid, _, _, _ in task_decisions
               if tid in verdicts]
    remaining = max(0, (1 + budget) - attempts_used)
    bad = [v for v in ordered if v.status != TASK_VERIFIED]
    if not bad:
        return RunVerdict(RUN_CONTINUE, ordered, attempts_used,
                          remaining, "All tasks verified.")
    if any(v.status == TASK_DENIED for v in ordered):
        return RunVerdict(RUN_FAILED, ordered, attempts_used, remaining,
                          "Policy denied a task; corrections cannot override denials.")
    if all(v.status == TASK_BLOCKED for v in ordered):
        return RunVerdict(RUN_BLOCKED, ordered, attempts_used, remaining,
                          "Tasks blocked on approvals or unverified upstreams.")
    if remaining <= 0:
        return RunVerdict(
            RUN_FAILED_FOR_REVIEW, ordered, attempts_used, 0,
            "Correction budget exhausted. All evidence preserved for review; "
            "no further automatic attempts.")
    return RunVerdict(
        RUN_PARKED, ordered, attempts_used, remaining,
        "Parked with evidence preserved; a bounded correction may re-dispatch "
        "through the governed path.")


def build_correction(*, task_contract_id: str, task_id: str,
                     capability_id: str, base_input: dict[str, Any],
                     approved_scope: list[str],
                     deviation: TaskVerdict,
                     attempt: int, budget: int = MAX_CORRECTION_ATTEMPTS,
                     narrower_scope: list[str] | None = None,
                     extra_context: str = "") -> dict[str, Any]:
    """Assemble a corrective invocation's input — data, never execution.

    Rules enforced here (deterministically):
    - attempt/accounting: corrections allowed only within budget;
    - scope: corrective scope must equal the approved scope or a narrower
      subset — widening is refused, never auto-approved;
    - attribution: correctionOf/attempt ride in the input so the approval
      fingerprint differs and every correction is re-gated;
    - instruction: deterministic template grounded in the deviation
      evidence; caller-supplied extra context is appended as context
      material only and can never widen scope or argv.
    Raises ValueError on refusal (budget/scope), so callers cannot mistake
    a refused correction for an approved one.
    """
    # `attempt` is the UPCOMING attempt number (initial dispatch is 1).
    # Runs allowed in total: 1 + budget. Attempt N is allowed iff N <= 1+budget.
    if attempt < 2:
        raise ValueError("corrections start at attempt 2; the initial dispatch is attempt 1.")
    if attempt > 1 + budget:
        raise ValueError(
            f"correction budget exhausted ({budget} corrections used); "
            "park for review instead.")
    proposed = list(narrower_scope) if narrower_scope is not None else list(approved_scope)
    ok, reason = validate_correction_scope(proposed, approved_scope)
    if not ok:
        raise ValueError(reason)
    if deviation.status not in (TASK_PARKED_DEVIATION, TASK_PARKED_UNVERIFIED,
                                TASK_PARKED_TIMEOUT, TASK_FAILED):
        raise ValueError(
            f"task {task_id} is {deviation.status}; only parked/failed "
            "tasks accept corrections.")

    outside = ((deviation.evidence.get("scopeCheck") or {}).get("outside")) or []
    lines = [
        f"CORRECTION attempt {attempt} for task {task_id} "
        f"(contract {task_contract_id}).",
        f"Deviation: {'; '.join(deviation.reasons) or 'see evidence'}.",
    ]
    if outside:
        lines.append("Out-of-scope files from the previous attempt (do NOT touch these): "
                     + ", ".join(outside[:10]) + ".")
    lines.append("Authorized scope (do not leave it): " + ", ".join(proposed) + ".")
    if extra_context.strip():
        lines.append("Additional context: " + extra_context.strip()[:2000])
    corrective_task = str(base_input.get("task") or "")
    instruction = "\n".join(lines) + "\n\nOriginal task:\n" + corrective_task

    corrective_input = dict(base_input)
    corrective_input["task"] = instruction
    corrective_input["scopePaths"] = proposed
    corrective_input["correctionOf"] = task_id
    corrective_input["attempt"] = attempt
    return {
        "capabilityId": capability_id,
        "input": corrective_input,
        "parentAttempt": attempt - 1,
        "attempt": attempt,
        "scopePaths": proposed,
    }
