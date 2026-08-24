"""Approval lifecycle — port of fabric.ts approval semantics (:336–670).

Scope (Phase 2b): identity keys, pending-only persistence, human decisions
(with their exact audit-record projection), single-use consumption, and the
named-approval usability check used by argument-bound spending. The full
invoke() pipeline that CALLS these belongs to Phase 4; its end-to-end
differential battery lands there too.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from ..canonical import fingerprint_invocation

__all__ = ["ApprovalLedger", "approval_key", "now_iso", "usable_pending"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def approval_key(capability_id: str, context: dict[str, Any], invocation_id: str) -> str:
    """Identity of the QUESTION, not of the attempt (fabric.ts:347–356)."""
    if context.get("missionId") and context.get("taskId"):
        return f"{context['missionId']}:{context['taskId']}:{capability_id}"
    # Same node of same run asking same capability = ONE question across resumes.
    if context.get("runId") and context.get("workflowNodeId"):
        return f"{context['runId']}:{context['workflowNodeId']}:{capability_id}"
    return f"inv:{invocation_id}"


def usable_pending(value: Any) -> bool:
    """Store load/save gate — mirrors ai-service/fabric/approvalStore.ts:24–32."""
    return bool(
        isinstance(value, dict)
        and isinstance(value.get("id"), str) and value["id"]
        and value.get("state") == "pending"
        and isinstance(value.get("items"), list) and len(value["items"]) > 0
        and isinstance((value.get("items") or [{}])[0].get("capabilityId"), str)
    )


class ApprovalLedger:
    """In-memory pending/granted requests with durable pending-only backing."""

    def __init__(
        self,
        audit_append: Callable[[dict[str, Any]], None] | None = None,
        emit: Callable[[dict[str, Any]], None] | None = None,
        clock: Callable[[], str] = now_iso,
    ) -> None:
        self._approvals: dict[str, dict[str, Any]] = {}   # approvalKey → request
        self._store: Any = None                            # (load, save) pair
        self._audit_append = audit_append
        self._emit = emit
        self._clock = clock

    # ── durability ───────────────────────────────────────────────────────

    def attach_store(self, load: Callable[[], list[Any]], save: Callable[[list[Any]], None]) -> None:
        """Restore usable PENDING requests only; unspent grants never survive restarts."""
        self._store = save
        for raw in load():
            if usable_pending(raw):
                key = self._restore_key(raw)
                if key:
                    self._approvals[key] = raw

    @staticmethod
    def _restore_key(request: dict[str, Any]) -> str | None:
        """Rebuild the dedup key for a restored request (fabric.ts:273–283)."""
        items = request.get("items") or []
        if not items:
            return None
        cap = items[0].get("capabilityId")
        if request.get("missionId") and request.get("taskId"):
            return f"{request['missionId']}:{request['taskId']}:{cap}"
        if request.get("runId") and request.get("workflowNodeId"):
            return f"{request['runId']}:{request['workflowNodeId']}:{cap}"
        # A standalone request is keyed by its own invocation — still restorable.
        return f"inv:{items[0].get('invocationId')}"

    def _persist(self) -> None:
        if self._store is not None:
            self._store([r for r in self._approvals.values() if r.get("state") == "pending"])

    # ── queries ──────────────────────────────────────────────────────────

    def pending(self) -> list[dict[str, Any]]:
        return [r for r in self._approvals.values() if r.get("state") == "pending"]

    def by_id(self, approval_id: str) -> dict[str, Any] | None:
        for r in self._approvals.values():
            if r.get("id") == approval_id:
                return r
        return None

    def open_for_key(self, key: str) -> dict[str, Any] | None:
        return self._approvals.get(key)

    # ── mutations ────────────────────────────────────────────────────────

    def register(self, key: str, request: dict[str, Any]) -> None:
        """Park a freshly built pending request (fabric.ts:644–650)."""
        self._approvals[key] = request
        self._persist()

    def replace(self, key: str, request: dict[str, Any]) -> None:
        self._approvals[key] = request

    def mark_granted_inline(self, key: str, request: dict[str, Any], decided_by: str) -> None:
        """Host-granted inline path (fabric.ts:661–668): grant AND consume atomically."""
        if request.get("state") == "pending":
            ts = self._clock()
            request["state"] = "granted"
            request["decidedAt"] = ts
            request["decidedBy"] = decided_by
            request["consumedAt"] = ts
            self._emit_granted(request["id"], ts)
            self._persist()

    def decide(
        self,
        approval_id: str,
        granted: bool,
        decided_by: str = "user",
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        """Record a human decision + write its audit record (fabric.ts:376–416).

        Returns null when unknown or no longer pending — which makes double-
        clicks, replays and stale tabs harmless instead of second authorizations.
        """
        request = self.by_id(approval_id)
        if not request or request.get("state") != "pending":
            return None

        ts = self._clock()
        request["state"] = "granted" if granted else "denied"
        request["decidedAt"] = ts
        request["decidedBy"] = decided_by

        items = request.get("items") or [{}]
        item = items[0]
        self._audit({
            "invocationId": item.get("invocationId") or request["id"],
            "at": ts,
            "capabilityId": item.get("capabilityId") or "unknown",
            "actor": {"kind": "human", "id": decided_by},
            "projectId": request.get("projectId"),
            **({"missionId": request["missionId"]} if request.get("missionId") else {}),
            **({"taskId": request["taskId"]} if request.get("taskId") else {}),
            "risk": item.get("risk") or "low",
            # The policy decision that opened the gate, kept beside the answer.
            "decision": "require-approval" if request.get("rule") == "irreversible-floor" else "ask-user",
            "decisionRule": request.get("rule") or "approval",
            "approvalId": request["id"],
            "outcome": "awaiting-approval" if granted else "denied",
            "verified": None,
            "durationMs": 0,
            "inputSummary": f"decision reason: {reason}" if reason else (item.get("detail") or ""),
            "approvalDecision": "granted" if granted else "denied",
            "decidedBy": decided_by,
        })

        if self._emit is not None:
            self._emit({
                "type": "approval.granted" if granted else "approval.denied",
                "at": ts,
                "requestId": request["id"],
            })
        self._persist()
        return request

    def consume(self, approval_id: str) -> dict[str, Any] | None:
        """Single-use spend (fabric.ts:423–429); replay finds nothing."""
        request = self.by_id(approval_id)
        if not request or request.get("state") != "granted" or request.get("consumedAt"):
            return None
        request["consumedAt"] = self._clock()
        self._persist()
        return request

    # ── argument-bound spending helper (P4 invoke uses this) ────────────

    @staticmethod
    def named_approval_usable(
        request: dict[str, Any] | None,
        capability_id: str,
        fingerprint: str,
    ) -> bool:
        """Granted, unspent, AND fingerprint-matching — all three (fabric.ts:573–576)."""
        return bool(
            request
            and request.get("state") == "granted"
            and not request.get("consumedAt")
            and any(
                i.get("capabilityId") == capability_id and i.get("fingerprint") == fingerprint
                for i in request.get("items", [])
            )
        )

    @staticmethod
    def fingerprint_for(capability_id: str, input: dict[str, Any], context: dict[str, Any]) -> str:
        """Recomputed at spend time from arguments actually presented."""
        return fingerprint_invocation(capability_id, input, context)

    # ── plumbing ─────────────────────────────────────────────────────────

    def _audit(self, record: dict[str, Any]) -> None:
        if self._audit_append is not None:
            self._audit_append(record)

    def _emit_granted(self, request_id: str, at: str) -> None:
        if self._emit is not None:
            self._emit({"type": "approval.granted", "at": at, "requestId": request_id})
