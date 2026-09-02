"""Evidence collector — assembles proof from immutable records.

Reads the append-only audit store and links records to the invocations a
run actually made. It creates no records and redacts nothing that the
Fabric has not already redacted (inputSummary is bounded+redacted at
settlement time).
"""

from __future__ import annotations

from ..contracts import EvidenceBundle, TaskOutcome


class EvidenceCollector:
    def __init__(self, audit_loader) -> None:
        self._load = audit_loader  # () -> list[dict]

    def collect(
        self,
        session_id: str,
        plan_id: str,
        outcomes: list[TaskOutcome],
        summary: str,
        now: str,
    ) -> EvidenceBundle:
        wanted: set[str] = set()
        approvals: set[str] = set()
        for o in outcomes:
            wanted.update(o.invocationIds)
            if o.approvalId:
                approvals.add(o.approvalId)
        record_ids = [
            r.get("invocationId")
            for r in self._load()
            if r.get("invocationId") in wanted
        ]
        return EvidenceBundle(
            sessionId=session_id,
            planId=plan_id,
            auditRecordIds=sorted(record_ids),
            approvalIds=sorted(approvals),
            summary=summary,
            createdAt=now,
        )
