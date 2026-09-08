"""Central-agent contracts — the language-independent agent layer schema.

These are NEW canonical schemas (no frozen TS counterpart exists). They
describe what the agent DECIDES and OBSERVES; they never restate governance.
RiskLevel / PolicyDecision come from _base; execution outcomes reference the
frozen AuditRecord/ApprovalRequest/Workflow vocabularies by id, never by
redefinition. extra="allow" everywhere; wire naming is camelCase.

Layering rule (python-backend-architecture.md §1): contracts is importable by
everyone and imports only stdlib+pydantic.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel, PolicyDecision, RiskLevel

# ── agent-layer vocabularies ─────────────────────────────────────────────────

IntentUrgency = Literal["immediate", "background", "scheduled"]
IntentComplexity = Literal["single", "multi-step", "workflow"]
AgentSessionState = Literal[
    "planning", "awaiting-approval", "executing", "verifying", "completed",
    "failed", "cancelled",
]
TaskState = Literal[
    "pending", "blocked", "ready", "awaiting-approval", "running", "done",
    "failed", "skipped", "denied", "timed-out", "cancelled",
]
ExecutionRoute = Literal["single-invocation", "workflow-run", "external-tool"]
VerificationKind = Literal["read-back", "exit-code", "schema-match", "audit-only"]
ToolSource = Literal["aura-manifest", "mcp", "plugin"]
TrustLevel = Literal["verified", "known", "unknown", "untrusted"]
#: Closed worker-role vocabulary for task requirements (Phase G).
#: Advisory for routing only — Fabric/policy/allow-list stay authoritative.
WorkerRole = Literal["code", "review", "execute"]

# Mirrors the RunEvent-adjacent observability surface (mission §21).
AgentEventType = Literal[
    "session.started", "intent.compiled", "intent.clarification-needed",
    "plan.created", "capability.discovery", "authority.checked",
    "workflow.compiled", "workflow.validated", "execution.started",
    "invocation.observed", "approval.required", "verification.completed",
    "result.ready", "agent.failed", "agent.cancelled",
    "worker.action", "worker.lifecycle",
]


# ── intent ───────────────────────────────────────────────────────────────────


class IntentEntity(ContractModel):
    """One named thing in the request. Model-provided, registry-gated later:
    entities never carry authority and never name capabilities directly."""

    type: Literal["project", "file", "path", "workflow", "capability",
                  "tool", "text", "other"]
    value: str
    role: str | None = None


class AgentIntent(ContractModel):
    """Structured interpretation of one user request. Compilation NEVER
    executes. confidence/ambiguity are MODEL CLAIMS — advisory only; the
    deterministic clarification policy below decides what actually blocks."""

    goal: str = Field(min_length=1)
    surface: str = "general"
    expectedOutcome: str = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    contextRefs: list[str] = Field(default_factory=list)
    requiredCapabilities: list[str] = Field(default_factory=list)
    urgency: IntentUrgency = "immediate"
    complexity: IntentComplexity = "single"
    approvalLikely: bool = False
    needsClarification: bool = False
    clarificationQuestion: str | None = None
    """Milestone-3 structured fields:"""
    entities: list[IntentEntity] = Field(default_factory=list)
    ambiguity: Literal["clear", "ambiguous", "impossible"] = "clear"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    requestedOutcome: str | None = None


# ── planning ─────────────────────────────────────────────────────────────────


class VerificationRequirement(ContractModel):
    """How a task's success will be CONFIRMED, distinct from it having run.

    Reused at plan level (TaskPlan.acceptance) for OBJECTIVE acceptance:
    one criterion names, in `expect`, the task ids it covers ({"tasks":
    [...]}, empty means all tasks) and passes only when every covered
    task is done and verified — with mechanical kinds additionally
    requiring a covered task verified under that same kind. An objective
    is never "verified" merely because tasks ran."""

    kind: VerificationKind = "audit-only"
    description: str = ""
    expect: dict = Field(default_factory=dict)


class TaskSpecification(ContractModel):
    """One bounded unit of planned work. A task REQUESTS a capability; it can
    never grant one, name a node binary, or widen its own input at runtime."""

    id: str = Field(min_length=1)
    description: str
    capabilityId: str | None = None
    route: ExecutionRoute = "single-invocation"
    input: dict = Field(default_factory=dict)
    """Where the task's invocation arguments come from: a literal dict now,
    the workflow the compiler produces for this plan (inputFrom), or the
    verified outputs of dependency tasks resolved by the execution
    controller at dispatch time ("upstream-output"). Upstream resolution
    only ever ADDS an AURA-owned evidence block to the task text and
    records provenance in TaskOutcome.consumedFrom; it never alters scope,
    capabilities, cwd, or any other input field."""
    inputFrom: Literal["literal", "compiled-workflow", "upstream-output"] = "literal"
    dependsOn: list[str] = Field(default_factory=list)
    """AURA-validated worker pin. Never model-authoritative: the planner
    checks it against the connected-node catalogue, and Fabric routing
    re-validates it at preflight AND dispatch (unknown/unusable nodes
    deny, never substitute). None means deterministic routing."""
    nodeId: str | None = None
    """Task worker requirement (Phase G): the selected worker must
    satisfy this role. None keeps existing first-usable routing. A stated
    role never widens authority — an unsatisfiable role fails the task
    closed before anything dispatches."""
    workerRole: WorkerRole | None = None
    """Task ids whose worker must NOT be reused for this task. An
    independent review is only independent if a different worker
    performs it, so "have another AI review it" has to be enforceable
    and not merely requested. Unsatisfiable exclusion fails the task
    closed — AURA never lets a worker review its own work and call that
    independent."""
    distinctWorkerFrom: list[str] = Field(default_factory=list)
    risk: RiskLevel = "low"
    reversible: bool = True
    verification: VerificationRequirement = Field(default_factory=VerificationRequirement)


class TaskPlan(ContractModel):
    """Ordered, dependency-checked decomposition of one intent."""

    planId: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    intent: AgentIntent
    tasks: list[TaskSpecification] = Field(min_length=1)
    estimatedApprovals: int = 0
    createdAt: str
    """Objective acceptance criteria (Phase H): what must hold for the
    USER's objective to count as verified, beyond per-task success.
    Empty keeps the legacy behavior (per-task verification decides)."""
    acceptance: list[VerificationRequirement] = Field(default_factory=list)


class CapabilityRequirement(ContractModel):
    """What a plan needs from the Fabric, stated before anything runs."""

    capabilityId: str
    reason: str
    taskId: str


# ── discovery + authority ────────────────────────────────────────────────────


class ToolDescriptor(ContractModel):
    """Discovery metadata for ONE invocable tool. Descriptions are UNTRUSTED
    data for mcp/plugin sources and are sanitized before entering any prompt."""

    id: str
    name: str
    description: str
    risk: RiskLevel
    permissions: list[str] = Field(default_factory=list)
    inputFields: list[dict] = Field(default_factory=list)
    sideEffects: bool = False
    reversible: bool = True
    available: bool = True
    source: ToolSource = "aura-manifest"
    trust: TrustLevel = "verified"


class AuthorityRequirement(ContractModel):
    """The policy engine's answer for one capability request — mirrored from
    evaluate_policy, never decided by the agent. The agent READS this; only
    the Fabric acts on it."""

    capabilityId: str
    decision: PolicyDecision
    rule: str
    reason: str
    risk: RiskLevel
    available: bool = True
    approvalRequired: bool = False
    """Scope narrowing is policy-owned; effectiveScope can only be NARROWER
    than requestedScope — never equal-wider, never widened by the agent."""
    requestedScope: str | None = None
    effectiveScope: str | None = None


# ── compilation + execution artifacts ────────────────────────────────────────


class CompiledWorkflowRef(ContractModel):
    """A graph the compiler produced, with its server-independent identity.
    Graph validity is judged by structural checks here AND, once the Python
    workflow engine lands (P6), re-validated there before any run."""

    workflowId: str
    name: str
    description: str
    nodes: list[dict]
    edges: list[dict]
    graphHash: str


class SingleInvocation(ContractModel):
    capabilityId: str
    input: dict
    taskId: str


class ExecutionPlan(ContractModel):
    """What the controller will actually drive, after authority checking."""

    planId: str
    sessionId: str
    route: ExecutionRoute
    singleInvocation: SingleInvocation | None = None
    workflow: CompiledWorkflowRef | None = None
    authority: list[AuthorityRequirement] = Field(default_factory=list)
    blocked: bool = False
    blockReasons: list[str] = Field(default_factory=list)


# ── observation + evidence ───────────────────────────────────────────────────


class TaskOutcome(ContractModel):
    taskId: str
    state: TaskState
    performed: bool = False
    verified: bool | None = None
    invocationIds: list[str] = Field(default_factory=list)
    approvalId: str | None = None
    detail: str = ""
    consumedFrom: list[str] = Field(default_factory=list)
    """Invocation ids of verified upstream tasks whose results were
    resolved into this task's input by the execution controller. Empty
    unless inputFrom == "upstream-output". This is the durable handoff
    lineage: session files and run records persist it, so a restart can
    reconstruct which verified evidence fed which task."""


class AgentVerificationReport(ContractModel):
    """Agent-level outcome verification. Distinct from the per-invocation
    VerificationReport recorded inside each AuditRecord."""

    passed: bool
    outcomes: list[TaskOutcome] = Field(default_factory=list)
    unverifiedActions: list[str] = Field(default_factory=list)
    detail: str = ""
    """Objective acceptance (Phase H): accepted only when every stated
    criterion is mechanically met. Defaults True when a plan states no
    criteria (legacy per-task behavior)."""
    objectiveAccepted: bool = True
    unmetAcceptance: list[str] = Field(default_factory=list)


class EvidenceBundle(ContractModel):
    """Assembled proof. References immutable records; composes nothing new."""

    sessionId: str
    planId: str
    auditRecordIds: list[str] = Field(default_factory=list)
    approvalIds: list[str] = Field(default_factory=list)
    summary: str
    createdAt: str


class AgentResult(ContractModel):
    """outcome is an HONEST terminal vocabulary: denied and timeout are
    never collapsed into failed (mission §15)."""

    status: AgentSessionState
    outcome: Literal[
        "completed", "failed", "blocked", "awaiting-approval",
        "cancelled", "denied", "timeout", "needs-clarification", "unsupported",
    ]
    summary: str
    performed: list[str] = Field(default_factory=list)
    verified: list[str] = Field(default_factory=list)
    evidence: EvidenceBundle | None = None
    failureReason: str | None = None
    """Parked/resumed engine run this result refers to."""
    runId: str | None = None


class AgentMessage(ContractModel):
    role: Literal["user", "agent", "system"]
    content: str
    at: str


# ── session ──────────────────────────────────────────────────────────────────


class AgentSession(ContractModel):
    """Durable session state. Persisted WITHOUT secrets and WITHOUT model
    internals — prompts and raw completions are never written to disk."""

    sessionId: str = Field(pattern=r"^agt-")
    projectId: str | None = None
    state: AgentSessionState = "planning"
    createdAt: str
    updatedAt: str
    messages: list[AgentMessage] = Field(default_factory=list)
    activePlanId: str | None = None
    """The validated TaskPlan body (Phase I): persisted at plan time so a
    restart resumes the SAME plan instead of re-deriving (or re-proposing)
    it from intent. AURA-owned data, never model input at read time."""
    activePlan: dict | None = None
    """The task that actually parked on the pending approval. Recorded
    at park time because a plan can have MORE than one task: assuming
    the parked task is the last planned one spends the human's grant on
    the wrong task, which parks the run a second time on a question the
    human already answered."""
    parkedTaskId: str | None = None
    """Bounded verified handoff evidence from the latest parked leg
    (Phase I): task id → evidence record, seeded as prior_verified on
    resume so verified work is skipped, never re-executed. Cleared when
    the run reaches a terminal non-parked outcome."""
    verifiedEvidence: dict[str, dict] = Field(default_factory=dict)
    lastResult: AgentResult | None = None
    eventCount: int = 0
    correctionChain: list[dict] = Field(default_factory=list)
    """Supervisor correction history: one entry per correction dispatch
    (CorrectionRecord dicts). Append-only. Lets a later resume continue a
    parked correction instead of re-planning from intent, and lets any
    reader reconstruct original → correction → verified without touching
    the audit trail (which stays the immutable record)."""


# ── events ───────────────────────────────────────────────────────────────────


class AgentEvent(ContractModel):
    """One observable step of the agent loop. The future SSE route streams
    these verbatim; persistence stores a bounded tail on the session file."""

    type: AgentEventType
    at: str
    sessionId: str
    payload: dict = Field(default_factory=dict)
