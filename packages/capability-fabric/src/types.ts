/**
 * types — the Capability Fabric domain.
 * ==================================================================
 * The Fabric is the single governed path by which anything in AURA Hub
 * causes a side effect. It answers one question per call:
 *
 *   "May this actor perform this action, on this target, right now —
 *    and did it actually work?"
 *
 * It owns nothing else. Missions, task graphs, scheduling, checkpoints
 * and timelines belong to Mission Control v3 (`MissionRecord`,
 * `ExecutionDag`); node identity and health belong to
 * `@aura/connected-environment`. Both are referenced by id here and
 * never re-modelled. See docs/CONSOLIDATION_MAP.md.
 *
 * No React, no Node, no fetch. Executors are injected by the host.
 */

import type { AgentRole, CapabilityId as NodeCapabilityId } from '@aura/connected-environment';

/**
 * Risk vocabulary. Structurally identical to Mission Control's
 * `TaskRisk` (`mission/types.ts:184`) **on purpose** — the two are meant
 * to be interchangeable so a task's planned risk and an action's actual
 * risk are expressed in one language. It is redeclared rather than
 * imported only because dependency direction forbids this package
 * depending on `ai-service`.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * What the policy engine decided. Mirrors §5 of the brief exactly.
 *
 *   auto-execute      — run now, record it, do not interrupt the user
 *   ask-user          — a single inline confirmation
 *   require-approval  — an explicit, reviewable authorization record
 *   deny              — refuse, with a reason and a next step
 */
export type PolicyDecision = 'auto-execute' | 'ask-user' | 'require-approval' | 'deny';

/** Coarse permission scopes. Checked against the acting node's grants. */
export type PermissionScope =
  | 'project.read'
  | 'project.write'
  | 'process.execute'
  | 'network.outbound'
  | 'account.authorize'
  | 'resource.destroy'
  | 'aura.read'
  | 'aura.write';

/** Where a capability actually runs. */
export type ExecutionSurface =
  /** An AURA subsystem, reached through `WorkspaceManager`. */
  | 'aura-internal'
  /** A local process, through the existing allow-listed spawn primitives. */
  | 'local-process'
  /** An outbound HTTP call. */
  | 'http'
  /** A driven browser session. */
  | 'browser';

/* ══════════════════════════════════════════════════════════════════
   Capability descriptors
   ══════════════════════════════════════════════════════════════════ */

/**
 * A field in a capability's input contract. Deliberately a tiny hand-rolled
 * shape rather than a schema library: the Fabric needs to *describe and
 * validate* a handful of scalar arguments, and adding a validation
 * dependency to a package that has none would be a bigger commitment than
 * the problem warrants.
 */
export interface CapabilityField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description: string;
}

/**
 * How the Fabric confirms an action actually did what it claimed. A
 * capability with `verify: null` is one whose effect cannot currently be
 * checked — that is recorded honestly on the result rather than reported
 * as a pass.
 */
export type VerificationKind =
  /** Re-read state through another capability and compare. */
  | 'read-back'
  /** The executor's own exit code / status is the proof. */
  | 'exit-code'
  /** An HTTP response confirms the effect. */
  | 'http-status'
  /** No mechanical check exists. */
  | null;

export interface CapabilityDescriptor {
  /** Dotted, stable, namespaced: `terminal.execute`, `project.create`. */
  id: string;
  name: string;
  description: string;
  category: string;
  surface: ExecutionSurface;
  risk: RiskLevel;
  /** Every scope this capability needs. All must be granted. */
  permissions: PermissionScope[];
  input: CapabilityField[];
  /** Plain description of what a successful result contains. */
  output: string;
  verify: VerificationKind;
  /**
   * For capabilities that run outside AURA: the node capability that must
   * be provided by some connected node before this can run at all.
   * `@aura/connected-environment` resolves it.
   */
  requiresNodeCapability?: NodeCapabilityId;
  /**
   * True when this capability is irreversible by the Fabric. Drives the
   * policy engine's hard floor — an irreversible action can never be
   * auto-executed regardless of configured risk.
   */
  irreversible?: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   Invocation
   ══════════════════════════════════════════════════════════════════ */

/** Who is asking, and on whose behalf. */
export interface InvocationActor {
  kind: 'agent' | 'human' | 'system';
  /** Accountability label — see `AgentRole`. Absent for human/system. */
  role?: AgentRole;
  /** Free-text id for audit (`agent:devops`, `user`, `automation:rule-7`). */
  id: string;
}

/**
 * Everything an invocation needs that is not its arguments. `missionId`
 * and `taskId` point into the authoritative `MissionRecord` — they are
 * correlation keys for the audit trail, never a mission model.
 */
/**
 * A connected environment node, reduced to what routing needs.
 * ------------------------------------------------------------------
 * Deliberately NOT a registry. This is a projection of the catalogue plus
 * the last environment scan, built where the provided-capability set is
 * already built and carrying the same freshness. The catalogue stays the
 * only source of truth for what a node is; this says only which node, what
 * it provides, and what to run.
 */
export interface NodeRef {
  id: string;
  name: string;
  /** Node capabilities this node provides, e.g. `coding-agent`. */
  capabilities: string[];
  /** Executable name from the catalogue entry's probe, when it has one. */
  binary?: string;
}

/** Why a node could not be resolved. Every one denies before execution. */
export type NodeResolutionFailure =
  | 'unknown-node'
  | 'node-not-connected'
  | 'node-lacks-capability'
  /** Provides the capability, but AURA cannot drive this particular tool. */
  | 'node-unsupported'
  | 'no-provider';

/**
 * The outcome of routing. `ok` with no `node` means the capability needs
 * none — an AURA-internal action, or one with no `requiresNodeCapability`.
 */
export type NodeResolution =
  | { ok: true; node?: NodeRef }
  | { ok: false; code: NodeResolutionFailure; reason: string };

export interface InvocationContext {
  actor: InvocationActor;
  projectId: string | null;
  /** Absolute path the action operates in, when it operates on a project. */
  cwd?: string;
  missionId?: string;
  taskId?: string;
  /** Milliseconds. The executor must abort past this. */
  timeoutMs?: number;
  /**
   * Capability ids the human has explicitly authorized for THIS call.
   * Carried on the context rather than held on the host because approval
   * is per-invocation: a grant for one action must never silently cover
   * the next one. Absent means nothing was approved.
   */
  approvedCapabilities?: string[];
  /**
   * The node the caller wants this to run on — routing **intent**, not a
   * report of what ran.
   *
   * Optional: omitting it preserves existing behaviour exactly. Naming a
   * node narrows the choice and can only ever *deny* — an unknown,
   * disconnected, or unsuitable node fails resolution rather than being
   * quietly replaced with a working one.
   */
  nodeId?: string;
}

export interface Invocation {
  id: string;
  capabilityId: string;
  input: Record<string, unknown>;
  context: InvocationContext;
  requestedAt: string;
  /**
   * The node the Fabric resolved for this call, handed to the executor.
   *
   * This is why executors no longer discover anything: routing is decided
   * once, under policy, and the result is passed down. Absent when the
   * capability needs no node.
   */
  node?: NodeRef;
}

export type InvocationOutcome =
  | 'succeeded'
  /** Ran, but did not do what it claimed — verification failed. */
  | 'unverified'
  /** Policy said no. Not a failure; a governance outcome. */
  | 'denied'
  /** Waiting on a human. The invocation is parked, not lost. */
  | 'awaiting-approval'
  /** The executor errored. Recoverable in principle. */
  | 'failed'
  /** No executor is registered for this capability. */
  | 'unsupported';

export interface VerificationReport {
  /** Null when `kind` is null — no check exists, and we say so. */
  passed: boolean | null;
  kind: VerificationKind;
  detail: string;
}

export interface InvocationResult {
  invocationId: string;
  capabilityId: string;
  outcome: InvocationOutcome;
  /** Always populated, always phrased with a next step. */
  detail: string;
  /** Executor payload — stdout, a record, a status. */
  output?: unknown;
  verification: VerificationReport;
  policy: PolicyEvaluation;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** How many attempts the recovery loop made, including the first. */
  attempts: number;
}

/* ══════════════════════════════════════════════════════════════════
   Policy and approval
   ══════════════════════════════════════════════════════════════════ */

export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** Why, in plain language. Shown to the user on any non-auto decision. */
  reason: string;
  /** Which rule produced it, for audit: `risk-default`, `override`, … */
  rule: string;
  risk: RiskLevel;
}

/** Configurable, per §5. A host may persist and edit this. */
export interface PolicyConfig {
  /** Decision for each risk level when nothing more specific applies. */
  byRisk: Record<RiskLevel, PolicyDecision>;
  /** Capability-id overrides, highest precedence after hard floors. */
  overrides: Record<string, PolicyDecision>;
  /**
   * When false, every decision that would be `auto-execute` becomes
   * `ask-user`. The single switch a cautious user reaches for.
   */
  allowAutonomous: boolean;
}

export type ApprovalState = 'pending' | 'granted' | 'denied' | 'expired';

/**
 * A human authorization record. Batched per §23: several invocations
 * needing authorization at the same moment become ONE request the user
 * reviews together, rather than a sequence of interruptions.
 */
export interface ApprovalRequest {
  id: string;
  state: ApprovalState;
  requestedAt: string;
  decidedAt?: string;
  /** What the user is being asked to authorize, in their words. */
  summary: string;
  /** The invocations this request covers. */
  items: {
    invocationId: string;
    capabilityId: string;
    title: string;
    detail: string;
    risk: RiskLevel;
    irreversible: boolean;
  }[];

  /* ── correlation into the authoritative MissionRecord ──────────── */
  projectId?: string;
  missionId?: string;
  taskId?: string;

  /* ── why the gate opened, and what the user is choosing between ── */
  /** The policy rule that demanded this. Recorded for audit. */
  rule?: string;
  /** Plain-language consequence of granting. */
  onAccept?: string;
  /** Plain-language consequence of declining. */
  onDecline?: string;
  /** Human-readable target the action acts on (file, branch, node). */
  target?: string;

  /* ── decision record ───────────────────────────────────────────── */
  /** Who decided. `user` for a person, or an agent id. */
  decidedBy?: string;
  /**
   * When the grant was actually spent on an execution. A granted approval
   * is **single-use**: consuming it stamps this, and a second attempt to
   * spend it is refused. This is what stops a page refresh, a reconnect,
   * or a replayed request from re-authorizing an action.
   */
  consumedAt?: string;
}

/**
 * Durable storage for pending authorization requests, supplied by the
 * host. Deliberately the narrowest possible port — load once at startup,
 * save the pending set after each change — so this package needs no
 * filesystem, no database and no knowledge of where AURA keeps things.
 */
export interface ApprovalPersistence {
  load(): ApprovalRequest[];
  save(requests: ApprovalRequest[]): void;
}

/* ══════════════════════════════════════════════════════════════════
   Executors — the only place side effects happen
   ══════════════════════════════════════════════════════════════════ */

export interface ExecutorResult {
  ok: boolean;
  detail: string;
  output?: unknown;
}

/**
 * The host registers one of these per capability it can genuinely
 * perform. A capability with no registered executor resolves to
 * `unsupported` — which is how the Fabric stays honest about a 100-entry
 * capability list backed by a handful of real implementations.
 */
export interface Executor {
  capabilityId: string;
  /**
   * Can this executor actually drive that node?
   *
   * Routing decides *which* node by capability; only the executor knows
   * which nodes it can really operate — six tools may all declare
   * `coding-agent` while AURA has a verified non-interactive invocation
   * for one of them. Consulted during resolution so an unusable node is
   * refused before policy rather than discovered at spawn time.
   *
   * Omitting it means "any node providing the capability will do", which
   * is the correct default for executors that shell out generically.
   */
  supportsNode?(node: NodeRef): boolean;
  run(invocation: Invocation): Promise<ExecutorResult>;
  /**
   * Optional read-back check. Called only when the capability declares a
   * verification kind and `run` reported success.
   */
  verify?(invocation: Invocation, result: ExecutorResult): Promise<VerificationReport>;
}

/* ══════════════════════════════════════════════════════════════════
   Events (§25)
   ══════════════════════════════════════════════════════════════════ */

export type FabricEvent =
  | { type: 'invocation.requested'; at: string; invocation: Invocation }
  | { type: 'invocation.denied'; at: string; invocationId: string; reason: string }
  | { type: 'invocation.started'; at: string; invocationId: string; capabilityId: string }
  | { type: 'invocation.retrying'; at: string; invocationId: string; attempt: number; reason: string }
  | { type: 'invocation.completed'; at: string; result: InvocationResult }
  | { type: 'verification.passed'; at: string; invocationId: string; detail: string }
  | { type: 'verification.failed'; at: string; invocationId: string; detail: string }
  | { type: 'approval.required'; at: string; request: ApprovalRequest }
  | { type: 'approval.granted'; at: string; requestId: string }
  | { type: 'approval.denied'; at: string; requestId: string };

export type FabricEventListener = (event: FabricEvent) => void;

/* ══════════════════════════════════════════════════════════════════
   Audit (§21)
   ══════════════════════════════════════════════════════════════════ */

/**
 * One immutable record per governed action. This is the answer to "what
 * did the system do, on whose authority, and did it work" — the question
 * an execution layer with real permissions must always be able to answer.
 */
export interface AuditRecord {
  invocationId: string;
  at: string;
  capabilityId: string;
  actor: InvocationActor;
  projectId: string | null;
  missionId?: string;
  taskId?: string;
  risk: RiskLevel;
  decision: PolicyDecision;
  decisionRule: string;
  approvalId?: string;
  outcome: InvocationOutcome;
  verified: boolean | null;
  durationMs: number;
  /** Redacted, bounded summary of the input. Never raw secrets. */
  inputSummary: string;
  /**
   * The environment node that performed the work, when the executor named
   * one. Several nodes can provide the same capability, so `capabilityId`
   * alone cannot answer "which agent touched this project?" — this can.
   * Absent means unattributable, never a guess.
   *
   * Kept as the executed node. `requestedNodeId` below records what was
   * asked for, so a routing decision is never hidden by collapsing the two.
   */
  nodeId?: string;
  /** The node the caller asked for, when they named one. */
  requestedNodeId?: string;
  /** The node the Fabric resolved and handed to the executor. */
  executedNodeId?: string;
  /**
   * Present only on records written for a **human authorization decision**
   * rather than an execution. `approvalId` above identifies which request
   * was decided; this says which way, and `decidedBy` says by whom.
   *
   * Governance needs the decision itself on the record, not merely the
   * execution that followed it: a decline produces no execution at all, and
   * "nobody ever authorized this" must be as auditable as "somebody did".
   */
  approvalDecision?: 'granted' | 'denied';
  decidedBy?: string;
}
