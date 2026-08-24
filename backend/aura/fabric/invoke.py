"""Governed invocation — the ONE execution path of the Python backend.

Port of capability-fabric/src/fabric.ts invoke() (:447-…), consuming the
already-migrated canonical modules: aura.policy (the one decision engine),
aura.audit (append-only trail), aura.approvals (single-use spend).

Order IS the security argument, exactly as in TS:
  unknown → contract → routing(nodeAvailable) → policy → approval →
  execute → verify → settle(audit).
Every early return still settles: an audit record exists for every
attempted invocation, whatever the outcome.

This module decides NOTHING about risk on its own; it feeds aura.policy.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from ..audit import AuditStore
from ..approvals import ApprovalLedger, approval_key, usable_pending
from ..canonical import fingerprint_invocation
from ..jsonutil import dumps_compact
from ..policy.engine import (
    CapabilityDescriptor as PolicyCapability,
    PolicyInput,
    PolicySubject,
    evaluate_policy,
    grants_for,
    sanitize_policy,
)
from .manifest import BUILTIN_MANIFEST, CapabilityDescriptor

NO_VERIFICATION: dict[str, Any] = {
    "passed": None,
    "kind": None,
    "detail": "This action has no mechanical check, so success is reported from the executor alone.",
}

_SECRET = ("apikey", "token", "secret", "password")


class Executor(Protocol):
    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        """Perform the effect. Returns (output, detail)."""
        ...

    def verify(
        self, input: dict[str, Any], context: dict[str, Any], output: Any | None
    ) -> dict[str, Any] | None:
        """Mechanical confirmation. None when the capability declares none."""
        ...


def _invocation_id() -> str:
    return f"inv-{uuid.uuid4().hex[:12]}"


def summarize_input(capability: CapabilityDescriptor, input: dict[str, Any]) -> str:
    """Bounded, redacted summary for the audit record (fabric.ts:147-161)."""
    parts: list[str] = []
    for f in capability.input:
        raw = input.get(f.name)
        if raw is None:
            continue
        if f.name.lower().replace("_", "") in _SECRET:
            parts.append(f"{f.name}=<redacted>")
            continue
        text = raw if isinstance(raw, str) else dumps_compact(raw)
        parts.append(f"{f.name}={text[:57]}…" if len(text) > 60 else f"{f.name}={text}")
    return " ".join(parts) or "(no arguments)"


def describe_target(capability: CapabilityDescriptor, input: dict[str, Any]) -> str | None:
    for key in ("path", "url", "command", "name", "branch", "message", "projectId"):
        value = input.get(key)
        if isinstance(value, str) and value.strip():
            return value[:77] + "…" if len(value) > 80 else value
    return "AURA Hub" if capability.surface == "aura-internal" else None


def validate_input(capability: CapabilityDescriptor, input: dict[str, Any]) -> str | None:
    """Reject arguments violating the declared contract (fabric.ts:179-192)."""
    for f in capability.input:
        value = input.get(f.name)
        if value is None or value == "":
            if f.required:
                return f"{f.name} is required."
            continue
        actual = "array" if isinstance(value, list) else type(value).__name__
        if f.type == "number":
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif f.type == "boolean":
            ok = isinstance(value, bool)
        elif f.type == "array":
            ok = isinstance(value, list)
        elif f.type == "object":
            ok = isinstance(value, dict)
        else:
            ok = isinstance(value, str)
        if not ok:
            return f"{f.name} should be a {f.type}, got {actual}."
    return None


@dataclass
class FabricConfig:
    """Everything the pipeline needs, injected — this package stays free of I/O."""

    policy_config: dict[str, Any] = field(default_factory=dict)
    permissions: dict[str, bool] = field(default_factory=lambda: {"read": True, "write": True})
    executors: dict[str, Executor] = field(default_factory=dict)
    audit_store: AuditStore | None = None
    ledger: ApprovalLedger | None = None
    emit: Callable[[dict[str, Any]], None] | None = None
    clock: Callable[[], float] = time.monotonic
    now: Callable[[], str] = lambda: __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def sanitized_policy(self) -> dict[str, Any]:
        return sanitize_policy(self.policy_config or {})


def _settle(
    cfg: FabricConfig,
    invocation_id: str,
    capability_id: str,
    context: dict[str, Any],
    capability: CapabilityDescriptor | None,
    outcome: str,
    detail: str,
    verification: dict[str, Any] | None,
    policy: dict[str, Any],
    started: float,
    started_at: str,
    approval_id: str | None = None,
    output: Any | None = None,
) -> dict[str, Any]:
    ended_at = cfg.now()
    duration_ms = round((cfg.clock() - started) * 1000, 1)
    actor = context.get("actor") or {}
    record: dict[str, Any] = {
        "invocationId": invocation_id,
        "at": ended_at,
        "capabilityId": capability_id,
        "actor": {
            "kind": actor.get("kind", "agent"),
            "id": actor.get("id", "central-agent"),
        },
        "projectId": context.get("projectId"),
        "risk": capability.risk if capability else "low",
        "decision": policy["decision"],
        "decisionRule": policy["rule"],
        "outcome": outcome,
        "verified": (verification or {}).get("passed"),
        "durationMs": duration_ms,
        "inputSummary": policy.pop("_input_summary", "(no arguments)"),
        **({"taskId": context["taskId"]} if context.get("taskId") else {}),
        **({"workflowId": context["workflowId"]} if context.get("workflowId") else {}),
        **({"approvalId": approval_id} if approval_id else {}),
    }
    try:
        cfg.audit_store.append(record)
    except Exception:
        pass  # a lost log write must never fail an execution that happened
    result = {
        "invocationId": invocation_id,
        "capabilityId": capability_id,
        "outcome": outcome,
        "detail": detail,
        "verification": verification if verification is not None else NO_VERIFICATION,
        "policy": {k: policy[k] for k in ("decision", "rule", "risk", "reason")},
        "at": started_at,
    }
    if output is not None:
        result["output"] = output
    if approval_id:
        result["approvalId"] = approval_id
    return result


def invoke_fabric(
    capability_id: str,
    input: dict[str, Any],
    context: dict[str, Any],
    cfg: FabricConfig,
) -> dict[str, Any]:
    """The single governed path. Mirrors fabric.ts invoke() stage by stage."""
    started = cfg.clock()
    started_at = cfg.now()
    invocation_id = _invocation_id()

    capability = next((c for c in BUILTIN_MANIFEST if c.id == capability_id), None)
    if capability is None:
        return _settle(
            cfg, invocation_id, capability_id, context, None, "failed",
            f'No capability is registered under "{capability_id}".', None,
            {"decision": "deny", "rule": "unknown-capability", "risk": "low",
             "reason": "The Fabric does not know this capability.",
             "_input_summary": "(unknown capability)"},
            started, started_at)

    if cfg.emit:
        cfg.emit({
            "type": "invocation.requested", "at": started_at,
            "invocationId": invocation_id, "capabilityId": capability_id,
        })

    # 1. contract
    invalid = validate_input(capability, input)
    if invalid:
        return _settle(cfg, invocation_id, capability_id, context, capability, "failed",
                       f"{invalid} Correct the argument and call it again.", None,
                       {"decision": "deny", "rule": "invalid-input", "risk": capability.risk,
                        "reason": invalid, "_input_summary": summarize_input(capability, input)},
                       started, started_at)

    # 2. routing — internal capabilities never depend on an external node;
    #    node-backed capabilities arrive with P5 executors.
    node_available: bool | None = True if capability.requiresNodeCapability is None else None

    # 3. policy — the ONLY decision point
    evaluation = evaluate_policy(PolicyInput(
        capability=PolicyCapability(
            id=capability.id, name=capability.name, risk=capability.risk,
            permissions=list(capability.permissions),
            irreversible=capability.irreversible or None,
        ),
        config=cfg.sanitized_policy(),
        granted=grants_for(cfg.permissions),
        nodeAvailable=node_available,
        subject=PolicySubject(
            actorKind=(context.get("actor") or {}).get("kind"),
            actorId=(context.get("actor") or {}).get("id"),
            projectId=context.get("projectId"),
            taskId=context.get("taskId"),
        ),
    ))
    evaluation["_input_summary"] = summarize_input(capability, input)

    if evaluation["decision"] == "deny":
        if cfg.emit:
            cfg.emit({"type": "invocation.denied", "at": cfg.now(),
                      "invocationId": invocation_id, "reason": evaluation["reason"]})
        return _settle(cfg, invocation_id, capability_id, context, capability, "denied",
                       evaluation["reason"], None, evaluation, started, started_at)

    # 4. approval — ask-user / require-approval parks unless an authorization
    #    is already spendable. The agent can NEVER decide this itself.
    spent_named = False
    if evaluation["decision"] != "auto-execute":
        ledger = cfg.ledger
        key = approval_key(capability_id, context, invocation_id)
        fingerprint = fingerprint_invocation(capability_id, input, context)
        open_request = ledger.open_for_key(key) if ledger else None

        named_id = context.get("approvalId")
        if named_id:
            named = ledger.by_id(named_id) if ledger else None
            usable = ApprovalLedger.named_approval_usable(named, capability_id, fingerprint)
            if usable and ledger.consume(named["id"]):
                if cfg.emit:
                    cfg.emit({"type": "approval.granted", "at": cfg.now(),
                              "requestId": named["id"]})
                spent_named = True
            else:
                reason = ("The approval named for this call does not authorize it — "
                          "the action or its arguments changed since it was granted."
                          if named else
                          "The approval named for this call no longer exists.")
                if cfg.emit:
                    cfg.emit({"type": "invocation.denied", "at": cfg.now(),
                              "invocationId": invocation_id, "reason": reason})
                return _settle(
                    cfg, invocation_id, capability_id, context, capability,
                    "awaiting-approval",
                    f"{capability.name} was not run: {('the authorization on record is for a '
                       'different action than the one requested. Nothing has run, and the '
                       'request stands.') if named else ('the authorization it named no longer '
                       'exists. Nothing has run.')}",
                    None, evaluation, started, started_at, named["id"] if named else None)

        pre_granted = spent_named or (
            open_request is not None
            and open_request.get("state") == "granted"
            and not open_request.get("consumedAt")
            and ledger.consume(open_request["id"]) is not None
        )

        if not pre_granted:
            request = open_request if (open_request or {}).get("state") == "pending" else {
                "id": f"apr-{invocation_id}",
                "state": "pending",
                "requestedAt": cfg.now(),
                "summary": evaluation["reason"],
                "rule": evaluation["rule"],
                "projectId": context.get("projectId"),
                "taskId": context.get("taskId"),
                "target": describe_target(capability, input),
                "onAccept": f"{capability.name} runs now"
                            + (", and the Fabric checks it actually worked"
                               if capability.verify else "")
                            + f". {capability.output}",
                "onDecline": "Nothing runs, and the request is recorded as declined.",
                "items": [{
                    "invocationId": invocation_id,
                    "capabilityId": capability_id,
                    "title": capability.name,
                    "detail": summarize_input(capability, input),
                    "risk": capability.risk,
                    "irreversible": capability.irreversible,
                    "fingerprint": fingerprint,
                }],
            }
            if (open_request or {}).get("state") != "pending":
                ledger.register(key, request)
                if cfg.emit:
                    cfg.emit({"type": "approval.required", "at": request["requestedAt"],
                              "requestId": request["id"]})
            return _settle(cfg, invocation_id, capability_id, context, capability,
                           "awaiting-approval",
                           f"{capability.name} is ready and waiting on your go-ahead. Nothing has run.",
                           None, evaluation, started, started_at, request["id"])

    # 5. execute
    executor = cfg.executors.get(capability_id)
    if executor is None:
        return _settle(cfg, invocation_id, capability_id, context, capability, "unsupported",
                       f"{capability.name} is planned for but has no executor yet, so nothing was run.",
                       None, evaluation, started, started_at)

    if cfg.emit:
        cfg.emit({"type": "invocation.started", "at": cfg.now(),
                  "invocationId": invocation_id, "capabilityId": capability_id})
    try:
        output, run_detail = executor.run(input, context)
    except Exception as exc:  # noqa: BLE001 — executor faults become failed settlements
        return _settle(cfg, invocation_id, capability_id, context, capability, "failed",
                       f"{capability.name} failed: {exc}", None, evaluation,
                       started, started_at)

    # 6. verify — read-back etc.; unverified ≠ failed, but it is reported.
    verification = NO_VERIFICATION
    if capability.verify:
        try:
            verification = executor.verify(input, context, output) or NO_VERIFICATION
        except Exception as exc:  # noqa: BLE001
            verification = {"passed": False, "kind": capability.verify,
                            "detail": f"Verification errored: {exc}"}
        if not verification.get("passed"):
            return _settle(cfg, invocation_id, capability_id, context, capability,
                           "unverified", verification.get("detail", ""), verification,
                           evaluation, started, started_at)

    # succeeded covers both a passed check AND an honest null check;
    # only a FAILED mechanical check downgrades to unverified (fabric.ts:~700).
    outcome = "unverified" if verification.get("passed") is False else "succeeded"
    return _settle(cfg, invocation_id, capability_id, context, capability, outcome,
                   run_detail, verification, evaluation, started, started_at,
                   output=output)


def describe_authority(
    capability_id: str,
    context: dict[str, Any],
    cfg: FabricConfig,
) -> dict[str, Any] | None:
    """What policy WOULD say, without running anything (fabric.ts evaluate()).

    Read-only preflight for planners: returns None for an unknown capability
    so 'no such capability' stays distinguishable from 'denied'.
    """
    capability = next((c for c in BUILTIN_MANIFEST if c.id == capability_id), None)
    if capability is None:
        return None
    node_available: bool | None = True if capability.requiresNodeCapability is None else None
    return evaluate_policy(PolicyInput(
        capability=PolicyCapability(
            id=capability.id, name=capability.name, risk=capability.risk,
            permissions=list(capability.permissions),
            irreversible=capability.irreversible or None,
        ),
        config=cfg.sanitized_policy(),
        granted=grants_for(cfg.permissions),
        nodeAvailable=node_available,
        subject=PolicySubject(
            actorKind=(context.get("actor") or {}).get("kind"),
            actorId=(context.get("actor") or {}).get("id"),
            projectId=context.get("projectId"),
            taskId=context.get("taskId"),
        ),
    ))


__all__ = [
    "Executor",
    "FabricConfig",
    "NO_VERIFICATION",
    "describe_authority",
    "describe_target",
    "invoke_fabric",
    "summarize_input",
    "usable_pending",
    "validate_input",
]
