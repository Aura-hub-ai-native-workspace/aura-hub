"""The one governed path to a side effect.

A port of packages/capability-fabric/src/fabric.ts.

Every call follows the same seven steps, in this order, with no way to
skip one:

    resolve -> policy -> approval -> execute -> verify -> recover -> audit

Nothing in AURA should cause an external effect except through here.

The Fabric owns no missions and no schedule. `mission_id`/`task_id` on a
context are correlation keys into the authoritative mission record, used
for the audit trail and nothing else.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable
from itertools import count
from typing import Any

from ..policy import (
    DEFAULT_POLICY,
    PolicyConfig,
    PolicyDecision,
    PolicyEvaluation,
    PolicyInput,
    PolicySubject,
    RiskLevel,
    evaluate_policy,
    grants_for,
)
from .host import FabricHost
from .manifest import describe_fabric_capability
from .types import (
    ApprovalItem,
    ApprovalPersistence,
    ApprovalRequest,
    AuditPersistence,
    AuditRecord,
    CapabilityDescriptor,
    Executor,
    ExecutorResult,
    FabricEvent,
    Invocation,
    InvocationContext,
    InvocationOutcome,
    InvocationResult,
    NodeResolution,
    VerificationReport,
    now_iso,
)

# ── recovery bounds ──────────────────────────────────────────────────

MAX_ATTEMPTS = 3
BASE_BACKOFF_MS = 400

# Only these failures are worth retrying. Anything else escalates
# immediately — retrying a permission error or a bad argument three times
# is noise, not resilience.
_TRANSIENT = re.compile(
    r"\b(timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up"
    r"|429|503|temporarily)\b",
    re.IGNORECASE,
)

_SECRET_FIELD = re.compile(r"^(apiKey|token|secret|password)$", re.IGNORECASE)

_TARGET_KEYS = ("path", "url", "command", "name", "branch", "message", "projectId")

NO_VERIFICATION = VerificationReport(
    passed=None,
    kind=None,
    detail=(
        "This action has no mechanical check, so success is reported from the "
        "executor alone."
    ),
)


def is_transient(detail: str) -> bool:
    return bool(_TRANSIENT.search(detail or ""))


_seq = count(1)


def _invocation_id() -> str:
    """Mirrors the reference's `inv<base36 ms><seq>` shape."""
    ms = int(time.time() * 1000)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    encoded = ""
    n = ms
    while n:
        encoded = digits[n % 36] + encoded
        n //= 36
    return f"inv{encoded or '0'}{next(_seq)}"


def summarize_input(
    capability: CapabilityDescriptor, input_: dict[str, Any]
) -> str:
    """Bounded, redacted input summary for the audit record."""
    parts: list[str] = []
    for spec in capability.input:
        raw = input_.get(spec.name)
        if raw is None:
            continue
        if _SECRET_FIELD.match(spec.name):
            parts.append(f"{spec.name}=<redacted>")
            continue
        text = _js_str(raw)
        parts.append(f"{spec.name}={text[:57] + '…' if len(text) > 60 else text}")
    return " ".join(parts) or "(no arguments)"


def _js_str(value: Any) -> str:
    """`String(value)` as JavaScript would render it.

    The audit summary is compared against the TypeScript backend's, so
    Python's `True`/`None` would be a visible divergence in the trail.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, list):
        return ",".join(_js_str(v) for v in value)
    return str(value)


def describe_target(
    capability: CapabilityDescriptor, input_: dict[str, Any]
) -> str | None:
    """The thing an action acts on, for the approval prompt.

    Picks the first argument that reads like a target so the user sees
    "src/app.ts" rather than having to infer it from a capability id.
    """
    for key in _TARGET_KEYS:
        value = input_.get(key)
        if isinstance(value, str) and value.strip():
            return f"{value[:77]}…" if len(value) > 80 else value
    return "AURA Hub" if capability.surface == "aura-internal" else None


def validate(capability: CapabilityDescriptor, input_: dict[str, Any]) -> str | None:
    """Reject arguments that do not satisfy the declared contract."""
    for spec in capability.input:
        value = input_.get(spec.name)
        if value is None or value == "":
            if spec.required:
                return f"{spec.name} is required."
            continue
        actual = _type_name(value)
        expected = spec.type
        if expected == "string[]":
            if actual != "string[]":
                return f"{spec.name} should be a {expected}, got {actual}."
        elif actual != expected:
            return f"{spec.name} should be a {expected}, got {actual}."
    return None


def _type_name(value: Any) -> str:
    """`typeof` as JavaScript reports it, for contract error parity."""
    if isinstance(value, list):
        return "string[]"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


class CapabilityFabric:
    def __init__(self, host: FabricHost) -> None:
        self._host = host
        self._executors: dict[str, Executor] = {}
        self._listeners: list[Callable[[FabricEvent], None]] = []
        self._audit_log: list[AuditRecord] = []
        self._policy: PolicyConfig = DEFAULT_POLICY
        # Live authorization requests, keyed by `_approval_key()`.
        self._approvals: dict[str, ApprovalRequest] = {}
        self._approval_store: ApprovalPersistence | None = None
        self._audit_store: AuditPersistence | None = None

    # ── durable backing ──────────────────────────────────────────────

    def attach_audit_store(self, store: AuditPersistence) -> None:
        """Give the audit trail a life beyond this process.

        Unlike approvals, EVERYTHING is restored: an audit record is a
        statement about something that already happened, so dropping it
        on restart would not be cautious, it would be forgetful.
        """
        self._audit_store = store
        self._audit_log = [*store.load(), *self._audit_log]

    def attach_approval_store(self, store: ApprovalPersistence) -> None:
        """Give pending authorization requests a life beyond this process.

        **Only `pending` requests are restored.** A grant that was given
        but never spent is deliberately dropped: reinstating it would mean
        a restart silently re-authorizing an action whose user is no
        longer there to see it happen. The task simply asks again, which
        is the safe direction to fail in.
        """
        self._approval_store = store
        for request in store.load():
            if request.state != "pending":
                continue
            if not request.items:
                continue
            item = request.items[0]
            if request.mission_id and request.task_id:
                key = f"{request.mission_id}:{request.task_id}:{item.capability_id}"
            elif request.run_id and request.workflow_node_id:
                key = f"{request.run_id}:{request.workflow_node_id}:{item.capability_id}"
            else:
                key = f"inv:{item.invocation_id}"
            self._approvals[key] = request

    def _persist_approvals(self) -> None:
        if self._approval_store is None:
            return
        self._approval_store.save(
            [r for r in self._approvals.values() if r.state == "pending"]
        )

    def _record(self, entry: AuditRecord) -> None:
        """The ONE place an audit record is written.

        Both writers (a settled invocation and a human approval decision)
        go through here so persistence can never be added to one path and
        forgotten on the other. A failing store must not take down an
        execution that already happened — a lost write is better than a
        lost effect.
        """
        self._audit_log.append(entry)
        if self._audit_store is not None:
            try:
                self._audit_store.append(entry)
            except Exception:  # noqa: BLE001, S110 - a lost write beats a lost effect
                pass

    # ── registration ─────────────────────────────────────────────────

    def register(self, executor: Executor) -> None:
        self._executors[executor.capability_id] = executor

    def is_supported(self, capability_id: str) -> bool:
        return capability_id in self._executors

    def supported(self) -> list[str]:
        return sorted(self._executors)

    def set_policy(self, policy: PolicyConfig) -> None:
        self._policy = policy

    def get_policy(self) -> PolicyConfig:
        return self._policy

    # ── events ───────────────────────────────────────────────────────

    def on(self, listener: Callable[[FabricEvent], None]) -> Callable[[], None]:
        self._listeners.append(listener)

        def off() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return off

    def _emit(self, event: FabricEvent) -> None:
        for listener in list(self._listeners):
            # One bad listener must not take down an execution in flight.
            try:
                listener(event)
            except Exception:  # noqa: BLE001, S110 - a bad listener must not stop an execution
                pass

    def audit(self) -> list[AuditRecord]:
        return list(self._audit_log)

    # ── approvals ────────────────────────────────────────────────────

    @staticmethod
    def _approval_key(
        capability_id: str, context: InvocationContext, invocation_id: str
    ) -> str:
        """Identity of an authorization request.

        Keyed by what is being authorized — the mission task and
        capability — rather than by the invocation, because a user
        pressing Run three times on a gated task is asking the same
        question three times, not asking three questions.

        A workflow run has the same shape of identity: the same node of
        the same run asking for the same capability is ONE question,
        however many times the run is resumed. Without this a resumed run
        would mint a fresh request and the answer the user already gave
        would be stranded against the old one.
        """
        if context.mission_id and context.task_id:
            return f"{context.mission_id}:{context.task_id}:{capability_id}"
        if context.run_id and context.workflow_node_id:
            return f"{context.run_id}:{context.workflow_node_id}:{capability_id}"
        return f"inv:{invocation_id}"

    def pending_approvals(self) -> list[ApprovalRequest]:
        return [r for r in self._approvals.values() if r.state == "pending"]

    def approval_by_id(self, approval_id: str) -> ApprovalRequest | None:
        for request in self._approvals.values():
            if request.id == approval_id:
                return request
        return None

    def decide_approval(
        self,
        approval_id: str,
        granted: bool,
        decided_by: str = "user",
        reason: str | None = None,
    ) -> ApprovalRequest | None:
        """Record a human's decision and write the audit record for it.

        Returns None when the request is unknown or no longer pending —
        which is what makes a double-click, a replayed request or a stale
        browser tab harmless rather than a second authorization.
        """
        request = self.approval_by_id(approval_id)
        if request is None or request.state != "pending":
            return None

        request.state = "granted" if granted else "denied"
        request.decided_at = now_iso()
        request.decided_by = decided_by

        item = request.items[0] if request.items else None
        self._record(
            AuditRecord(
                invocation_id=item.invocation_id if item else request.id,
                at=request.decided_at,
                capability_id=item.capability_id if item else "unknown",
                actor=_human(decided_by),
                project_id=request.project_id,
                mission_id=request.mission_id,
                task_id=request.task_id,
                risk=_as_risk(item.risk if item else "low"),
                # The policy decision that opened the gate, kept alongside
                # the human answer so the record shows both why it was
                # asked and what was said.
                decision=(
                    PolicyDecision.REQUIRE_APPROVAL
                    if request.rule == "irreversible-floor"
                    else PolicyDecision.ASK_USER
                ),
                decision_rule=request.rule or "approval",
                approval_id=request.id,
                outcome="awaiting-approval" if granted else "denied",
                verified=None,
                duration_ms=0,
                input_summary=(
                    f"decision reason: {reason}" if reason else (item.detail if item else "")
                ),
                approval_decision="granted" if granted else "denied",
                decided_by=decided_by,
            )
        )

        self._emit(
            FabricEvent(
                type="approval.granted" if granted else "approval.denied",
                at=request.decided_at,
                payload={"requestId": request.id},
            )
        )
        # A decided request leaves the pending set, so a restart never
        # resurrects a question the user has already answered.
        self._persist_approvals()
        return request

    def consume_approval(self, approval_id: str) -> ApprovalRequest | None:
        """Spend a granted approval.

        Single-use: the grant is stamped consumed and a second attempt
        finds nothing, so a refresh or a replayed request cannot
        re-authorize an action that already ran.
        """
        request = self.approval_by_id(approval_id)
        if request is None or request.state != "granted" or request.consumed_at:
            return None
        request.consumed_at = now_iso()
        self._persist_approvals()
        return request

    # ── pre-flight ───────────────────────────────────────────────────

    def evaluate(
        self, capability_id: str, context: InvocationContext
    ) -> PolicyEvaluation | None:
        """What policy *would* say, without running anything.

        The mission engine needs this: it must know whether a task will
        need authorization BEFORE it starts work, so the task can be
        parked cleanly rather than half-executed and then blocked.

        Returns None for an unknown capability so the caller can tell "no
        such capability" apart from "denied".
        """
        capability = describe_fabric_capability(capability_id)
        if capability is None:
            return None

        # Resolve the node here too. A pre-flight check that ignored
        # routing would tell the caller "this will run" for a node the
        # real invocation is about to refuse — the two must agree.
        resolution = self._resolve(capability, context, capability_id)
        if not resolution.ok:
            return PolicyEvaluation(
                decision=PolicyDecision.DENY,
                rule=resolution.code or "denied",
                risk=capability.risk,
                reason=resolution.reason,
            )
        return self._evaluate_policy(capability, context, resolution)

    # ── the one path ─────────────────────────────────────────────────

    async def invoke(
        self,
        capability_id: str,
        input_: dict[str, Any],
        context: InvocationContext,
    ) -> InvocationResult:
        started_at = now_iso()
        started = time.monotonic()
        invocation = Invocation(
            id=_invocation_id(),
            capability_id=capability_id,
            input=input_,
            context=context,
            requested_at=started_at,
        )

        capability = describe_fabric_capability(capability_id)
        if capability is None:
            return self._settle(
                invocation, None, "failed",
                f'No capability is registered under "{capability_id}".',
                NO_VERIFICATION,
                PolicyEvaluation(
                    decision=PolicyDecision.DENY, rule="unknown-capability",
                    risk=RiskLevel.LOW, reason="The Fabric does not know this capability.",
                ),
                started, started_at, 1,
            )

        self._emit(
            FabricEvent(
                type="invocation.requested", at=started_at,
                payload={"invocationId": invocation.id, "capabilityId": capability_id},
            )
        )

        # 1. contract
        invalid = validate(capability, input_)
        if invalid:
            return self._settle(
                invocation, capability, "failed",
                f"{invalid} Correct the argument and call it again.",
                NO_VERIFICATION,
                PolicyEvaluation(
                    decision=PolicyDecision.DENY, rule="invalid-input",
                    risk=capability.risk, reason=invalid,
                ),
                started, started_at, 1,
            )

        # 2. routing — which node, before anything is decided about it.
        # Resolution feeds policy rather than bypassing it: naming a node
        # changes WHICH node is evaluated, never WHETHER evaluation happens.
        resolution = self._resolve(capability, context, capability_id)
        if not resolution.ok:
            self._emit(
                FabricEvent(
                    type="invocation.denied", at=now_iso(),
                    payload={"invocationId": invocation.id, "reason": resolution.reason},
                )
            )
            return self._settle(
                invocation, capability, "denied", resolution.reason, NO_VERIFICATION,
                PolicyEvaluation(
                    decision=PolicyDecision.DENY, rule=resolution.code or "denied",
                    risk=capability.risk, reason=resolution.reason,
                ),
                started, started_at, 0,
            )
        # The executor is handed its node; it discovers nothing itself.
        invocation.node = resolution.node

        # 3. policy
        evaluation = self._evaluate_policy(capability, context, resolution)
        if evaluation.decision is PolicyDecision.DENY:
            self._emit(
                FabricEvent(
                    type="invocation.denied", at=now_iso(),
                    payload={"invocationId": invocation.id, "reason": evaluation.reason},
                )
            )
            return self._settle(
                invocation, capability, "denied", evaluation.reason, NO_VERIFICATION,
                evaluation, started, started_at, 0,
            )

        # 4. approval
        if evaluation.decision is not PolicyDecision.AUTO_EXECUTE:
            parked = await self._gate(
                invocation, capability, input_, context, evaluation, started, started_at
            )
            if parked is not None:
                return parked

        # 5. execute — with bounded recovery
        executor = self._executors.get(capability_id)
        if executor is None:
            return self._settle(
                invocation, capability, "unsupported",
                f"{capability.name} is planned for but has no executor yet, so nothing "
                f"was run. {capability.description}",
                NO_VERIFICATION, evaluation, started, started_at, 0,
            )

        self._emit(
            FabricEvent(
                type="invocation.started", at=now_iso(),
                payload={"invocationId": invocation.id, "capabilityId": capability_id},
            )
        )

        attempts = 0
        last = ExecutorResult(ok=False, detail="Not attempted.")
        while attempts < MAX_ATTEMPTS:
            attempts += 1
            try:
                last = await executor.run(invocation)
            except Exception as error:  # noqa: BLE001 - an executor throw is a failure, not a crash
                last = ExecutorResult(
                    ok=False, detail=str(error) or "The executor threw with no message."
                )
            if last.ok:
                break
            if attempts >= MAX_ATTEMPTS or not is_transient(last.detail):
                break
            self._emit(
                FabricEvent(
                    type="invocation.retrying", at=now_iso(),
                    payload={
                        "invocationId": invocation.id,
                        "attempt": attempts + 1,
                        "reason": last.detail,
                    },
                )
            )
            # Exponential backoff, bounded by MAX_ATTEMPTS so this loop
            # always terminates.
            await asyncio.sleep(BASE_BACKOFF_MS * 2 ** (attempts - 1) / 1000)

        if not last.ok:
            # "did not succeed", not "did not complete" — a command that
            # ran and exited non-zero did complete, and saying otherwise
            # misdescribes what the user needs to look at.
            tried = "" if attempts == 1 else f" after {attempts} attempts"
            # The executor's own output is carried through on failure too.
            # It distinguishes "timed out at 124, half-done" from "exited
            # 1", and names the node that failed.
            return self._settle(
                invocation, capability, "failed",
                f"{capability.name} did not succeed{tried}. {last.detail}",
                NO_VERIFICATION, evaluation, started, started_at, attempts,
                output=last.output,
            )

        # 6. verify
        verification = NO_VERIFICATION
        verify_fn = getattr(executor, "verify", None)
        if capability.verify and verify_fn is not None:
            try:
                verification = await verify_fn(invocation, last)
            except Exception as error:  # noqa: BLE001
                verification = VerificationReport(
                    passed=False, kind=capability.verify,
                    detail=f"The check itself could not run: {error}",
                )
            self._emit(
                FabricEvent(
                    type=(
                        "verification.passed" if verification.passed
                        else "verification.failed"
                    ),
                    at=now_iso(),
                    payload={"invocationId": invocation.id, "detail": verification.detail},
                )
            )
        elif capability.verify:
            verification = VerificationReport(
                passed=None, kind=capability.verify,
                detail=(
                    "This capability declares a check, but its executor does not "
                    "implement one yet."
                ),
            )

        outcome: InvocationOutcome = (
            "unverified" if verification.passed is False else "succeeded"
        )
        detail = (
            f"{capability.name} ran, but the check did not confirm it. {verification.detail}"
            if outcome == "unverified"
            else f"{capability.name} completed. {last.detail}"
        )
        return self._settle(
            invocation, capability, outcome, detail, verification, evaluation,
            started, started_at, attempts, output=last.output,
        )

    # ── internals ────────────────────────────────────────────────────

    def _resolve(
        self,
        capability: CapabilityDescriptor,
        context: InvocationContext,
        capability_id: str,
    ) -> NodeResolution:
        if self._host.resolve_node is None:
            return NodeResolution(ok=True)
        executor = self._executors.get(capability_id)
        supports = getattr(executor, "supports_node", None) if executor else None
        return self._host.resolve_node(capability, context, supports)

    def _evaluate_policy(
        self,
        capability: CapabilityDescriptor,
        context: InvocationContext,
        resolution: NodeResolution,
    ) -> PolicyEvaluation:
        if self._host.resolve_node is not None:
            # Derived from the same resolution when the host does routing,
            # so the boolean floor and the router can never disagree.
            node_available = (
                bool(resolution.node) if capability.requires_node_capability else None
            )
        else:
            node_available = self._host.node_available(capability)
        return evaluate_policy(
            PolicyInput(
                subject=PolicySubject(
                    capability_id=capability.id,
                    risk=capability.risk,
                    permissions=capability.permissions,
                    irreversible=capability.irreversible,
                    node_id=resolution.node.id if resolution.node else None,
                    capability_name=capability.name,
                    node_name=resolution.node.name if resolution.node else "",
                ),
                node_available=node_available,
                granted=frozenset(
                    grants_for(self._host.permissions_for(capability, context))
                ),
            ),
            self._policy,
        )

    async def _gate(
        self,
        invocation: Invocation,
        capability: CapabilityDescriptor,
        input_: dict[str, Any],
        context: InvocationContext,
        evaluation: PolicyEvaluation,
        started: float,
        started_at: str,
    ) -> InvocationResult | None:
        """Ask the human. Returns a parked result, or None to proceed."""
        # Identity of the QUESTION, not of the attempt.
        key = self._approval_key(capability.id, context, invocation.id)
        open_request = self._approvals.get(key)

        # Already answered "yes" out of band (the approval UI). Spend it —
        # once — and fall through to execution.
        pre_granted = (
            open_request is not None
            and open_request.state == "granted"
            and not open_request.consumed_at
            and self.consume_approval(open_request.id) is not None
        )
        if pre_granted:
            return None

        if open_request is not None and open_request.state == "pending":
            request = open_request
        else:
            request = ApprovalRequest(
                id=f"apr-{invocation.id}",
                state="pending",
                requested_at=now_iso(),
                summary=evaluation.reason,
                rule=evaluation.rule,
                project_id=context.project_id,
                mission_id=context.mission_id,
                task_id=context.task_id,
                workflow_id=context.workflow_id,
                run_id=context.run_id,
                workflow_node_id=context.workflow_node_id,
                target=describe_target(capability, input_),
                # Both consequences are stated, because an approval prompt
                # that only says what happens if you say yes is not a real
                # choice.
                on_accept=(
                    f"{capability.name} runs now"
                    + (", and the Fabric checks it actually worked" if capability.verify else "")
                    + f". {capability.output}."
                ),
                on_decline=(
                    "Nothing runs. The task stays where it is with the decline recorded "
                    "against it, and the rest of the mission is untouched."
                    if context.task_id
                    else "Nothing runs, and the request is recorded as declined."
                ),
                items=[
                    ApprovalItem(
                        invocation_id=invocation.id,
                        capability_id=capability.id,
                        title=capability.name,
                        detail=summarize_input(capability, input_),
                        risk=capability.risk,
                        irreversible=bool(capability.irreversible),
                    )
                ],
            )
            self._approvals[key] = request
            self._emit(
                FabricEvent(
                    type="approval.required", at=request.requested_at,
                    payload={"requestId": request.id, "capabilityId": capability.id},
                )
            )
            # Durable the moment it is asked, so a crash between asking and
            # answering does not lose the question.
            self._persist_approvals()

        # The host may still grant inline (a caller carrying an explicit
        # per-invocation authorization). Otherwise the request stays open
        # and the invocation is parked, not failed.
        try:
            granted = await self._host.request_approval(request, context)
        except Exception:  # noqa: BLE001 - a throwing host is a refusal, never a bypass
            granted = False

        if not granted:
            return self._settle(
                invocation, capability, "awaiting-approval",
                f"{capability.name} is ready and waiting on your go-ahead. Nothing has run.",
                NO_VERIFICATION, evaluation, started, started_at, 0,
                approval_id=request.id,
            )

        if request.state == "pending":
            request.state = "granted"
            request.decided_at = now_iso()
            request.decided_by = context.actor.id
            request.consumed_at = request.decided_at
            self._emit(
                FabricEvent(
                    type="approval.granted", at=request.decided_at,
                    payload={"requestId": request.id},
                )
            )
            self._persist_approvals()
        return None

    def _executed_node_id(
        self,
        invocation: Invocation,
        capability: CapabilityDescriptor | None,
        attempts: int,
        output: Any,
    ) -> str | None:
        """The node work actually ran on, or None when nothing ran.

        A capability that routes to no node has no acting node, so nothing
        in its output may claim one. `system.install` is why this guard
        exists: its result names the node being INSTALLED, which is the
        object of the work, not the actor performing it. Without this,
        `output.nodeId` would be read as attribution and the audit would
        report that a not-yet-installed tool executed its own installation.
        """
        if capability is None or not capability.requires_node_capability:
            return None
        reported = None
        if isinstance(output, dict):
            candidate = output.get("nodeId")
            if isinstance(candidate, str) and candidate:
                reported = candidate
        if reported:
            return reported
        return invocation.node.id if attempts > 0 and invocation.node else None

    def _settle(
        self,
        invocation: Invocation,
        capability: CapabilityDescriptor | None,
        outcome: InvocationOutcome,
        detail: str,
        verification: VerificationReport,
        policy: PolicyEvaluation,
        started: float,
        started_at: str,
        attempts: int,
        approval_id: str | None = None,
        output: Any = None,
    ) -> InvocationResult:
        ended_at = now_iso()
        duration_ms = int((time.monotonic() - started) * 1000)

        result = InvocationResult(
            invocation_id=invocation.id,
            capability_id=invocation.capability_id,
            outcome=outcome,
            detail=detail,
            output=output,
            verification=verification,
            policy=policy,
            approval_id=approval_id,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            attempts=attempts,
        )

        executed = self._executed_node_id(invocation, capability, attempts, output)
        self._record(
            AuditRecord(
                invocation_id=invocation.id,
                at=ended_at,
                capability_id=invocation.capability_id,
                actor=invocation.context.actor,
                project_id=invocation.context.project_id,
                mission_id=invocation.context.mission_id,
                task_id=invocation.context.task_id,
                workflow_id=invocation.context.workflow_id,
                run_id=invocation.context.run_id,
                workflow_node_id=invocation.context.workflow_node_id,
                risk=policy.risk,
                decision=policy.decision,
                decision_rule=policy.rule,
                approval_id=approval_id,
                outcome=outcome,
                verified=verification.passed,
                duration_ms=duration_ms,
                input_summary=(
                    summarize_input(capability, invocation.input)
                    if capability
                    else "(unknown capability)"
                ),
                # Routing is recorded in full: what was asked for, what the
                # Fabric chose, and what actually ran. Collapsing these
                # would hide a substitution — the one thing routing must
                # never do quietly.
                #
                # `executed_node_id` means EXECUTED, not resolved. A call
                # denied by policy resolves a node and then never runs on
                # it, so falling back to the resolved node there would have
                # the audit assert execution that did not happen.
                # `attempts > 0` is the honest gate.
                node_id=executed,
                requested_node_id=invocation.context.node_id,
                executed_node_id=executed,
            )
        )

        self._emit(
            FabricEvent(
                type="invocation.completed", at=ended_at,
                payload={"invocationId": invocation.id, "outcome": outcome},
            )
        )
        return result


def _human(identity: str):
    from .types import InvocationActor

    return InvocationActor(kind="human", id=identity)


def _as_risk(value: Any) -> RiskLevel:
    if isinstance(value, RiskLevel):
        return value
    try:
        return RiskLevel(value)
    except ValueError:
        return RiskLevel.LOW
