/**
 * Workflow run contract — the authoritative record of one execution.
 * ==================================================================
 * A `WorkflowRun` is what a run IS, independent of who is watching. The
 * SSE `RunEvent` stream in `../types.ts` stays what it always was — a
 * live projection for a connected UI — and this is the durable truth
 * behind it. The two are deliberately different shapes: an event stream
 * is lossy by nature (nobody may be listening), and a record must not be.
 *
 * Three rules govern this file:
 *
 *   1. **States are explicit and never collapsed.** `failed`, `cancelled`
 *      and `timed-out` are three different things that need three
 *      different responses from a human, and `awaiting-approval` is not a
 *      failure at all — it is a run that is working correctly and waiting.
 *      Collapsing any of them into "failed" destroys exactly the
 *      information an operator needs.
 *
 *   2. **A run references an immutable version, never a definition.** The
 *      graph may be edited while a run is in flight; the run must keep
 *      executing what it started. `versionId` is the whole mechanism.
 *
 *   3. **Nothing here holds a secret or a raw effect.** Node output is
 *      bounded and redacted before it reaches a record (see
 *      `../secrets.ts`), and governed effects are referenced by their
 *      Fabric `invocationId` — the audit trail stays the authority on
 *      what actually happened, and this record points at it.
 */

/* ══════════════════════════════════════════════════════════════════
   States
   ══════════════════════════════════════════════════════════════════ */

/**
 * The state of a whole run.
 *
 *   queued            — created, not yet started
 *   running           — executing nodes
 *   awaiting-approval — parked on a human decision; resumable
 *   succeeded         — every reachable node resolved without failure
 *   failed            — a node failed and the run stopped
 *   cancelled         — a human (or a closing client) aborted it
 *   timed-out         — the run exceeded its wall-clock budget
 */
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/** A run in one of these states will never advance again on its own. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'timed-out'];

export const isTerminalRunState = (s: RunState): boolean => TERMINAL_RUN_STATES.includes(s);

/**
 * The state of one node within a run.
 *
 * `skipped` is not a failure: a Condition fires one port and everything
 * reachable only from the other port is legitimately skipped. `denied` is
 * also not a failure of the node — it is the policy engine working, and it
 * is recorded distinctly so "the workflow is broken" can never be confused
 * with "the workflow was not permitted".
 */
export type NodeState =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'skipped'
  | 'cancelled'
  | 'timed-out';

/* ══════════════════════════════════════════════════════════════════
   Evidence
   ══════════════════════════════════════════════════════════════════ */

/**
 * A pointer from a run into the Capability Fabric's audit trail.
 *
 * This is the "evidence reference" half of the contract, and it is a
 * REFERENCE on purpose. Copying the policy decision, the approval and the
 * verification into the run record would create a second audit authority
 * that could drift from the first. The run says "this node caused
 * invocation X"; the audit trail says what invocation X was and whether
 * it worked. One authority, two indexes into it.
 */
export interface EvidenceRef {
  /** The Fabric invocation id — the join key into `AuditRecord`. */
  invocationId: string;
  capabilityId: string;
  /** Denormalised for listing a run without loading the audit trail. */
  outcome: string;
  decision: string;
  decisionRule: string;
  risk: string;
  /** Null when the capability has no mechanical check. */
  verified: boolean | null;
  approvalId?: string;
  /** The connected-environment node that performed it, when attributable. */
  nodeId?: string;
  at: string;
  durationMs: number;
}

/* ══════════════════════════════════════════════════════════════════
   Node execution record
   ══════════════════════════════════════════════════════════════════ */

export interface StateTransition {
  at: string;
  from: NodeState;
  to: NodeState;
  /** Why, when the transition carries a reason (a denial rule, a timeout). */
  note?: string;
}

export interface NodeRunRecord {
  nodeId: string;
  type: string;
  state: NodeState;
  /**
   * Every state this node passed through, in order.
   *
   * The current `state` says where it ended; this says how it got there,
   * which is what a person debugging actually needs — "queued → running →
   * awaiting-approval → running → succeeded" tells a story that
   * "succeeded" hides. Bounded by `MAX_TRANSITIONS` so a node inside a
   * loop cannot grow the record without limit.
   */
  transitions: StateTransition[];
  /**
   * What this node RECEIVED, redacted and bounded.
   *
   * Recorded because "what did it actually get" is the first question
   * asked of a node that produced the wrong thing, and without it the UI
   * can only show the output and leave the reader to infer the input from
   * the upstream node's output — which is wrong the moment several edges
   * merge into one node.
   */
  input?: { text: string; files?: string[]; truncated?: boolean; fromNodeIds?: string[]; provenance?: string };
  /** Iteration index when this node ran inside a loop subtree; 0 otherwise. */
  iteration: number;
  startedAt?: string;
  finishedAt?: string;
  ms: number;
  /** Short human summary shown on the node face. Never a secret. */
  summary?: string;
  /** Present only on a non-success terminal state. */
  error?: string;
  /**
   * Bounded, redacted copy of what this node emitted, kept so a resumed
   * run can feed downstream nodes without re-executing an effect. This is
   * the checkpoint payload — see `MAX_CHECKPOINT_TEXT`.
   */
  output?: { text: string; data?: unknown; files?: string[]; port?: string; truncated?: boolean; provenance?: string };
  /** Attempts made by the workflow-level retry policy, including the first. */
  attempts: number;
  /** Governed actions this node caused. Usually 0 or 1. */
  evidence: EvidenceRef[];
  /** Set while `state === 'awaiting-approval'`. */
  approval?: { requestId: string; capabilityId: string; requestedAt: string; summary: string };
  /**
   * The agent ledger, for an agent node.
   *
   * Persisted on the run rather than in a store of its own: an agent's
   * trace is meaningless outside the run that produced it, and a separate
   * store would be a second place a run's history lives. Typed as
   * `unknown` here so `run/types.ts` does not depend on the agent module —
   * the shape is `AgentTrace` from `../agent/types`.
   */
  agentTrace?: unknown;
}

/**
 * How much node output is checkpointed.
 *
 * Bounded because a checkpoint file that can grow without limit is a
 * reliability problem pretending to be a durability feature. A node whose
 * output is truncated is marked `truncated: true`, so a resume can say so
 * rather than silently feeding a fragment downstream.
 */
export const MAX_CHECKPOINT_TEXT = 64 * 1024;

/** Transitions kept per node. A loop body would otherwise grow unbounded. */
export const MAX_TRANSITIONS = 60;

/* ══════════════════════════════════════════════════════════════════
   The run
   ══════════════════════════════════════════════════════════════════ */

export type RunTrigger =
  | { kind: 'manual'; by: string }
  | { kind: 'webhook'; tokenId: string }
  | { kind: 'automation'; ruleId: string; runId: string; event: string }
  | { kind: 'mission'; missionId: string; taskId: string }
  | { kind: 'resume'; of: string };

export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** The immutable version actually executing. Never a live definition. */
  versionId: string;
  /** Denormalised for listing; the version is still the authority. */
  workflowName: string;
  projectId: string;
  projectPath: string;
  state: RunState;
  trigger: RunTrigger;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  ms: number;
  /** Populated on `failed` / `timed-out` / `cancelled`. */
  error?: string;
  /** Node id → record. Every node in the version appears once started. */
  nodes: Record<string, NodeRunRecord>;
  /** Workflow variables at the last checkpoint, for resume. */
  vars: Record<string, string>;
  /** Values supplied for `user-input` nodes. */
  inputs: Record<string, string>;
  /** Terminal `output` node results, in completion order. */
  outputs: { nodeId: string; title: string; text: string }[];
  /** Every governed action in the run, flattened for the Runs view. */
  evidence: EvidenceRef[];
  /**
   * Whether this run can be picked up where it stopped.
   *
   * Stated as a field rather than derived at read time because the honest
   * answer depends on state the reader does not have — whether the version
   * still exists, and whether any completed node's effect is replayable.
   * The UX brief requires the run header to say "resumable from step 4" or
   * "not resumable — no checkpoint", and it can only do that if the record
   * carries the answer.
   */
  resumable: boolean;
  /** Why not, when `resumable` is false and the run did not succeed. */
  notResumableReason?: string;
  /** Bounded run log. Node-scoped lines carry their node id. */
  log: { at: string; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string }[];
}

export const MAX_RUN_LOG = 2000;

/** Listing shape — everything the Runs table needs, nothing it does not. */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  versionId: string;
  workflowName: string;
  projectId: string;
  state: RunState;
  trigger: RunTrigger['kind'];
  createdAt: string;
  finishedAt?: string;
  ms: number;
  nodeCount: number;
  succeededCount: number;
  failedCount: number;
  evidenceCount: number;
  approvalCount: number;
  resumable: boolean;
  error?: string;
}

export function summarizeRun(run: WorkflowRun): WorkflowRunSummary {
  const states = Object.values(run.nodes);
  return {
    id: run.id,
    workflowId: run.workflowId,
    versionId: run.versionId,
    workflowName: run.workflowName,
    projectId: run.projectId,
    state: run.state,
    trigger: run.trigger.kind,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    ms: run.ms,
    nodeCount: states.length,
    succeededCount: states.filter((n) => n.state === 'succeeded').length,
    failedCount: states.filter((n) => n.state === 'failed' || n.state === 'timed-out').length,
    evidenceCount: run.evidence.length,
    approvalCount: states.filter((n) => n.state === 'awaiting-approval').length,
    resumable: run.resumable,
    error: run.error,
  };
}
