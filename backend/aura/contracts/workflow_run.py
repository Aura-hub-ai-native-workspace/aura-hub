"""WorkflowRun + AgentTrace — schema/workflow-run.schema.json (run/types.ts, agent/types.ts).

States never collapse; evidence is a reference into the audit trail, never a
copy; `resumable` is stated on the record, not derived at read time.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from ._base import ContractModel

RunState = Literal[
    "queued", "running", "awaiting-approval", "succeeded", "failed", "cancelled", "timed-out"
]
TERMINAL_RUN_STATES = ("succeeded", "failed", "cancelled", "timed-out")

NodeState = Literal[
    "queued", "running", "awaiting-approval", "succeeded", "failed",
    "denied", "skipped", "cancelled", "timed-out",
]

Provenance = Literal["external", "tool", "system", "authored"]


class StateTransition(ContractModel):
    at: str
    from_: NodeState = Field(alias="from")
    to: NodeState
    note: str | None = None


class EvidenceRef(ContractModel):
    invocationId: str
    capabilityId: str
    outcome: str
    decision: str
    decisionRule: str
    risk: str
    verified: bool | None
    at: str
    durationMs: float
    approvalId: str | None = None
    nodeId: str | None = None


class AgentBounds(ContractModel):
    maxIterations: int
    timeoutMs: int
    maxTokens: int
    maxConsecutiveFailures: int
    tools: list[str]


BeatKind = Literal[
    "intent", "plan", "proposal", "permission", "execution",
    "observation", "decision", "intervention", "result",
]
BeatActor = Literal["ai", "fabric", "human", "system"]


class AgentBeat(ContractModel):
    seq: int
    iteration: int
    at: str
    kind: BeatKind
    actor: BeatActor
    text: str  # redacted+bounded (MAX_BEAT_TEXT=4000)
    untrusted: bool | None = None  # prompt-injection control, property of the record
    capabilityId: str | None = None
    evidence: EvidenceRef | None = None
    rule: str | None = None
    decision: str | None = None
    tokens: int | None = None


StopReason = Literal[
    "completed", "max-iterations", "timeout", "token-budget",
    "consecutive-failures", "awaiting-approval", "denied", "cancelled", "failed",
]
AgentPort = Literal["done", "needs-human", "failed"]

PORT_FOR_STOP: dict[StopReason, AgentPort] = {
    "completed": "done",
    "awaiting-approval": "needs-human",
    "denied": "needs-human",
    "max-iterations": "failed",
    "timeout": "failed",
    "token-budget": "failed",
    "consecutive-failures": "failed",
    "cancelled": "failed",
    "failed": "failed",
}


class AgentResume(ContractModel):
    """Present ONLY when stopReason === 'awaiting-approval'."""

    transcript: list[dict]  # {role: 'user'|'assistant', text} — max 40 entries
    pendingCall: dict  # {capabilityId, input}
    iteration: int
    tokensUsed: int
    elapsedMs: float


class AgentTrace(ContractModel):
    beats: list[AgentBeat]  # max 500
    iterations: int | None = None
    tokensUsed: int | None = None
    ms: float | None = None
    stopReason: StopReason | None = None
    port: AgentPort | None = None
    output: str | None = None
    evidence: list[EvidenceRef] | None = None
    refusedTools: list[dict] | None = None  # {capabilityId, reason}
    approval: dict | None = None  # {requestId, capabilityId}
    effectiveBounds: AgentBounds | None = None
    tokenSource: Literal["provider", "estimated", "mixed"] | None = None
    partial: bool | None = None  # snapshot flag: True → carries ONLY beats


class NodeRunRecord(ContractModel):
    nodeId: str
    type: str
    state: NodeState
    transitions: list[StateTransition]  # max 60
    iteration: int
    ms: float
    attempts: int
    evidence: list[EvidenceRef]
    input: dict | None = None
    startedAt: str | None = None
    finishedAt: str | None = None
    summary: str | None = None
    error: str | None = None
    output: dict | None = None  # bounded checkpoint payload (MAX_CHECKPOINT_TEXT=64KiB)
    approval: dict | None = None  # {requestId, capabilityId, requestedAt, summary}
    agentTrace: AgentTrace | None = None


# ── RunTrigger discriminated union (run/types.ts:197-202) ───────────────────


class ManualTrigger(ContractModel):
    kind: Literal["manual"]
    by: str


class WebhookTrigger(ContractModel):
    kind: Literal["webhook"]
    tokenId: str


class AutomationTrigger(ContractModel):
    kind: Literal["automation"]
    ruleId: str
    runId: str
    event: str


class MissionTrigger(ContractModel):
    kind: Literal["mission"]
    missionId: str
    taskId: str


class ResumeTrigger(ContractModel):
    kind: Literal["resume"]
    of: str


RunTrigger = Annotated[
    ManualTrigger | WebhookTrigger | AutomationTrigger | MissionTrigger | ResumeTrigger,
    Field(discriminator="kind"),
]


class WorkflowRun(ContractModel):
    id: str
    workflowId: str
    versionId: str
    workflowName: str
    projectId: str
    projectPath: str
    state: RunState
    trigger: RunTrigger
    createdAt: str
    ms: float
    nodes: dict[str, NodeRunRecord]  # every node in the version once started
    vars: dict[str, str]
    inputs: dict[str, str]
    outputs: list[dict]  # {nodeId, title, text}
    evidence: list[EvidenceRef]
    resumable: bool  # STATED, not derived
    log: list[dict]  # {at, nodeId|null, level, text} — max 2000
    startedAt: str | None = None
    finishedAt: str | None = None
    error: str | None = None
    notResumableReason: str | None = None
    supersededBy: str | None = None
    supersededAt: str | None = None
