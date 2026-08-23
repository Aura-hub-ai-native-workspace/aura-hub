"""The Capability Fabric domain.

A port of packages/capability-fabric/src/types.ts.

The Fabric is the single governed path by which anything in AURA Hub
causes a side effect. It answers one question per call:

    "May this actor perform this action, on this target, right now —
     and did it actually work?"

It owns nothing else. Missions, task graphs, scheduling and timelines
belong elsewhere and are referenced by id here, never re-modelled.

No HTTP, no filesystem, no subprocess. Executors are injected by the
host.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, runtime_checkable

from ..policy.types import PermissionScope, PolicyDecision, PolicyEvaluation, RiskLevel

ExecutionSurface = Literal["aura-internal", "local-process", "http", "browser"]
VerificationKind = Literal["read-back", "exit-code", "http-status"] | None
ApprovalState = Literal["pending", "granted", "denied", "expired"]
InvocationOutcome = Literal[
    "succeeded",
    # Ran, but did not do what it claimed — verification failed.
    "unverified",
    # Policy said no. Not a failure; a governance outcome.
    "denied",
    # Waiting on a human. The invocation is parked, not lost.
    "awaiting-approval",
    # The executor errored. Recoverable in principle.
    "failed",
    # No executor is registered for this capability.
    "unsupported",
]
NodeResolutionFailure = Literal[
    "unknown-node",
    "node-not-connected",
    "node-lacks-capability",
    # Provides the capability, but AURA cannot drive this particular tool.
    "node-unsupported",
    "no-provider",
]
FieldType = Literal["string", "number", "boolean", "string[]"]


def now_iso() -> str:
    """A timestamp in the exact shape JavaScript's `toISOString()` emits.

    The frontend parses these, and the audit trail is compared against
    the TypeScript backend's, so `+00:00` would be a contract change
    rather than a formatting preference.
    """
    now = datetime.now(UTC)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


def _compact(pairs: dict[str, Any], *, keep_null: tuple[str, ...] = ()) -> dict[str, Any]:
    """Drop absent optional keys, the way `JSON.stringify` drops undefined.

    Keys named in `keep_null` are explicitly nullable in the contract and
    are emitted even when None, because their absence would mean
    something different from their being null.
    """
    return {k: v for k, v in pairs.items() if v is not None or k in keep_null}


@dataclass(frozen=True)
class CapabilityField:
    name: str
    type: FieldType
    required: bool
    description: str


@dataclass(frozen=True)
class CapabilityDescriptor:
    id: str
    name: str
    description: str
    category: str
    surface: ExecutionSurface
    risk: RiskLevel
    permissions: tuple[PermissionScope, ...]
    output: str
    verify: VerificationKind = None
    input: tuple[CapabilityField, ...] = ()
    requires_node_capability: str | None = None
    irreversible: bool = False


@dataclass(frozen=True)
class InvocationActor:
    kind: Literal["agent", "human", "system"]
    id: str
    role: str | None = None

    def to_json(self) -> dict[str, Any]:
        return _compact({"kind": self.kind, "id": self.id, "role": self.role})


@dataclass(frozen=True)
class NodeRef:
    """A projection of the node catalogue — deliberately not a registry."""

    id: str
    name: str
    capabilities: tuple[str, ...] = ()
    binary: str | None = None


@dataclass(frozen=True)
class NodeResolution:
    """The outcome of routing.

    `ok` with no node means the capability needs none — an AURA-internal
    action, or one with no `requires_node_capability`.
    """

    ok: bool
    node: NodeRef | None = None
    code: NodeResolutionFailure | None = None
    reason: str = ""


@dataclass
class InvocationContext:
    actor: InvocationActor
    project_id: str | None = None
    # Absolute path the action operates in. Resolved by the host from the
    # project registry — never taken from a request body.
    cwd: str | None = None
    mission_id: str | None = None
    task_id: str | None = None
    # Correlation keys into the authoritative workflow run record. The
    # Fabric owns no workflow state. `workflow_node_id` is a node in a
    # workflow GRAPH — deliberately not called `node_id`, which already
    # means the environment node that performs work.
    workflow_id: str | None = None
    run_id: str | None = None
    workflow_node_id: str | None = None
    timeout_ms: int | None = None
    # Capability ids the human has explicitly authorized for THIS call.
    # Carried on the context rather than held on the host, because a grant
    # for one action must never silently cover the next one.
    approved_capabilities: tuple[str, ...] = ()
    # The node the caller wants this to run on — routing INTENT, not a
    # report of what ran. Naming a node can only ever deny.
    node_id: str | None = None


@dataclass
class Invocation:
    id: str
    capability_id: str
    input: dict[str, Any]
    context: InvocationContext
    requested_at: str
    # The node the Fabric resolved, handed to the executor. Executors
    # discover nothing themselves.
    node: NodeRef | None = None


@dataclass(frozen=True)
class VerificationReport:
    # None when `kind` is None — no check exists, and we say so.
    passed: bool | None
    kind: VerificationKind
    detail: str

    def to_json(self) -> dict[str, Any]:
        return {"passed": self.passed, "kind": self.kind, "detail": self.detail}


@dataclass(frozen=True)
class ExecutorResult:
    ok: bool
    detail: str
    output: Any = None


@runtime_checkable
class Executor(Protocol):
    """The host registers one per capability it can genuinely perform.

    A capability with no registered executor resolves to `unsupported` —
    which is how the Fabric stays honest about a 30-entry manifest backed
    by a handful of real implementations.
    """

    capability_id: str

    async def run(self, invocation: Invocation) -> ExecutorResult: ...


@dataclass(frozen=True)
class ApprovalItem:
    invocation_id: str
    capability_id: str
    title: str
    detail: str
    risk: RiskLevel
    irreversible: bool

    def to_json(self) -> dict[str, Any]:
        return {
            "invocationId": self.invocation_id,
            "capabilityId": self.capability_id,
            "title": self.title,
            "detail": self.detail,
            "risk": self.risk.value if hasattr(self.risk, "value") else self.risk,
            "irreversible": self.irreversible,
        }


@dataclass
class ApprovalRequest:
    """A human authorization record.

    Batched: several invocations needing authorization at the same moment
    become ONE request the user reviews together, rather than a sequence
    of interruptions.
    """

    id: str
    state: ApprovalState
    requested_at: str
    summary: str
    items: list[ApprovalItem] = field(default_factory=list)
    decided_at: str | None = None
    project_id: str | None = None
    mission_id: str | None = None
    task_id: str | None = None
    workflow_id: str | None = None
    run_id: str | None = None
    workflow_node_id: str | None = None
    rule: str | None = None
    on_accept: str | None = None
    on_decline: str | None = None
    target: str | None = None
    decided_by: str | None = None
    # When the grant was actually spent. A granted approval is SINGLE-USE:
    # consuming it stamps this, and a second attempt is refused. That is
    # what stops a refresh, a reconnect or a replayed request from
    # re-authorizing an action.
    consumed_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        return _compact(
            {
                "id": self.id,
                "state": self.state,
                "requestedAt": self.requested_at,
                "decidedAt": self.decided_at,
                "summary": self.summary,
                "items": [i.to_json() for i in self.items],
                "projectId": self.project_id,
                "missionId": self.mission_id,
                "taskId": self.task_id,
                "workflowId": self.workflow_id,
                "runId": self.run_id,
                "workflowNodeId": self.workflow_node_id,
                "rule": self.rule,
                "onAccept": self.on_accept,
                "onDecline": self.on_decline,
                "target": self.target,
                "decidedBy": self.decided_by,
                "consumedAt": self.consumed_at,
            }
        )

    @staticmethod
    def from_json(raw: dict[str, Any]) -> ApprovalRequest:
        return ApprovalRequest(
            id=raw["id"],
            state=raw["state"],
            requested_at=raw.get("requestedAt", ""),
            summary=raw.get("summary", ""),
            items=[
                ApprovalItem(
                    invocation_id=i.get("invocationId", ""),
                    capability_id=i.get("capabilityId", ""),
                    title=i.get("title", ""),
                    detail=i.get("detail", ""),
                    risk=i.get("risk", "low"),
                    irreversible=bool(i.get("irreversible", False)),
                )
                for i in raw.get("items", [])
            ],
            decided_at=raw.get("decidedAt"),
            project_id=raw.get("projectId"),
            mission_id=raw.get("missionId"),
            task_id=raw.get("taskId"),
            workflow_id=raw.get("workflowId"),
            run_id=raw.get("runId"),
            workflow_node_id=raw.get("workflowNodeId"),
            rule=raw.get("rule"),
            on_accept=raw.get("onAccept"),
            on_decline=raw.get("onDecline"),
            target=raw.get("target"),
            decided_by=raw.get("decidedBy"),
            consumed_at=raw.get("consumedAt"),
        )


@dataclass
class InvocationResult:
    invocation_id: str
    capability_id: str
    outcome: InvocationOutcome
    # Always populated, always phrased with a next step.
    detail: str
    verification: VerificationReport
    policy: PolicyEvaluation
    started_at: str
    ended_at: str
    duration_ms: int
    # How many attempts the recovery loop made, including the first.
    attempts: int
    output: Any = None
    # The request this invocation is parked behind, present only when the
    # outcome is `awaiting-approval`. Without it a parked caller can see
    # that approval is needed but not which request answers it.
    approval_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        return _compact(
            {
                "invocationId": self.invocation_id,
                "capabilityId": self.capability_id,
                "outcome": self.outcome,
                "detail": self.detail,
                "output": self.output,
                "verification": self.verification.to_json(),
                "policy": {
                    "decision": self.policy.decision.value,
                    "reason": self.policy.reason,
                    "rule": self.policy.rule,
                    "risk": self.policy.risk.value,
                },
                "approvalId": self.approval_id,
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
                "durationMs": self.duration_ms,
                "attempts": self.attempts,
            }
        )


@dataclass
class AuditRecord:
    """One immutable record per governed action.

    The answer to "what did the system do, on whose authority, and did it
    work" — the question an execution layer with real permissions must
    always be able to answer.
    """

    invocation_id: str
    at: str
    capability_id: str
    actor: InvocationActor
    project_id: str | None
    risk: RiskLevel
    decision: PolicyDecision
    decision_rule: str
    outcome: InvocationOutcome
    verified: bool | None
    duration_ms: int
    # Redacted, bounded summary of the input. Never raw secrets.
    input_summary: str
    mission_id: str | None = None
    task_id: str | None = None
    workflow_id: str | None = None
    run_id: str | None = None
    workflow_node_id: str | None = None
    approval_id: str | None = None
    # The environment node that performed the work, when the executor
    # named one. Absent means unattributable, never a guess.
    node_id: str | None = None
    requested_node_id: str | None = None
    executed_node_id: str | None = None
    # Present only on records written for a HUMAN AUTHORIZATION DECISION
    # rather than an execution. A decline produces no execution at all,
    # and "nobody ever authorized this" must be as auditable as "somebody
    # did".
    approval_decision: Literal["granted", "denied"] | None = None
    decided_by: str | None = None

    def to_json(self) -> dict[str, Any]:
        return _compact(
            {
                "invocationId": self.invocation_id,
                "at": self.at,
                "capabilityId": self.capability_id,
                "actor": self.actor.to_json(),
                "projectId": self.project_id,
                "missionId": self.mission_id,
                "taskId": self.task_id,
                "workflowId": self.workflow_id,
                "runId": self.run_id,
                "workflowNodeId": self.workflow_node_id,
                "risk": self.risk.value if hasattr(self.risk, "value") else self.risk,
                "decision": (
                    self.decision.value if hasattr(self.decision, "value") else self.decision
                ),
                "decisionRule": self.decision_rule,
                "approvalId": self.approval_id,
                "outcome": self.outcome,
                "verified": self.verified,
                "durationMs": self.duration_ms,
                "inputSummary": self.input_summary,
                "nodeId": self.node_id,
                "requestedNodeId": self.requested_node_id,
                "executedNodeId": self.executed_node_id,
                "approvalDecision": self.approval_decision,
                "decidedBy": self.decided_by,
            },
            keep_null=("projectId", "verified"),
        )


@dataclass(frozen=True)
class FabricEvent:
    type: str
    at: str
    payload: dict[str, Any] = field(default_factory=dict)


class ApprovalPersistence(Protocol):
    def load(self) -> list[ApprovalRequest]: ...
    def save(self, requests: list[ApprovalRequest]) -> None: ...


class AuditPersistence(Protocol):
    """Append-only. There is deliberately no `save(all)`.

    An audit trail that can be rewritten by the thing it audits is not an
    audit trail.
    """

    def load(self) -> list[AuditRecord]: ...
    def append(self, record: AuditRecord) -> None: ...
