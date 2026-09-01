/**
 * agent/types — the service's agent contract, as the UI reads it.
 * ==================================================================
 * These mirror `packages/ai-service/src/workflow/agent/types.ts` exactly.
 * They are declared here rather than imported because the renderer is a
 * separate compilation unit from the node service — the same reason every
 * other service shape in `ai/aiClient.ts` is declared rather than imported.
 * The service remains the authority; this is its wire shape.
 *
 * ── Availability ──────────────────────────────────────────────────
 * Whether the node can be used is the SERVICE's answer, read from
 * `NodeSpecInfo.disabled` on `GET /workflows/specs`. It is never assumed
 * here and never hardcoded either way: if the service marks the node
 * disabled the UI says disabled, and if it does not, the UI treats it as
 * any other node. The palette already renders `spec.disabled` generically,
 * so that path needs no agent-specific branch.
 */

import type { EvidenceRef } from '../../../ai/aiClient';

/* ── bounds ────────────────────────────────────────────────────────── */

/**
 * What a definition may ask for. The service CLAMPS these to its own
 * ceilings rather than trusting them, because a workflow definition can
 * be imported or model-generated, and a bound a definition can raise is
 * not a bound.
 */
export interface AgentBounds {
  maxIterations: number;
  timeoutMs: number;
  maxTokens: number;
  /** Capability ids the agent may request — enforced as a subset of the
   *  workflow's authority envelope by the service. */
  tools: string[];
  maxConsecutiveFailures: number;
}

export const AGENT_CEILINGS: AgentBounds = {
  maxIterations: 25,
  timeoutMs: 10 * 60_000,
  maxTokens: 200_000,
  tools: [],
  maxConsecutiveFailures: 5,
};

export const AGENT_DEFAULTS: AgentBounds = {
  maxIterations: 10,
  timeoutMs: 60_000,
  maxTokens: 10_000,
  tools: [],
  maxConsecutiveFailures: 3,
};

/** Why an invocation stopped. Never collapsed into "done". */
export type AgentStopReason =
  | 'completed'
  | 'max-iterations'
  | 'timeout'
  | 'token-budget'
  | 'consecutive-failures'
  /** A tool call is parked on a human decision. The one resumable stop. */
  | 'awaiting-approval'
  /**
   * Policy refused a tool call outright. Distinct from `failed` because it
   * is the governance layer working, not a malfunction — the response is a
   * person changing the policy or the workflow, never a retry.
   */
  | 'denied'
  | 'cancelled'
  | 'failed';

/** The three ways an agent node legitimately terminates. */
export type AgentPort = 'done' | 'needs-human' | 'failed';

/**
 * An agent that stops must say which bound stopped it. "Agent failed" is
 * not a usable fact; "reached its 10-iteration cap with no final answer"
 * is.
 */
/**
 * Eight distinct endings, kept apart on purpose.
 *
 * A bound being hit, a policy refusal, a human declining and a genuine
 * malfunction call for four different responses from an operator.
 * Collapsing any of them into "failed" would cost the reader the one fact
 * that tells them what to do next.
 */
export const STOP_SENTENCE: Record<AgentStopReason, string> = {
  completed: 'Produced its final answer.',
  'max-iterations': 'Reached its iteration limit without producing a final answer.',
  timeout: 'Ran out of its wall-clock budget before producing a final answer.',
  'token-budget': 'Used its whole token budget before producing a final answer.',
  'consecutive-failures': 'Stopped after too many tool calls failed in a row.',
  'awaiting-approval': 'Parked on a decision only you can make. This is the one stop that can be resumed.',
  denied: 'Your policy refused a tool call. Nothing is broken — the governance layer did its job, and a retry would only spend the remaining budget rediscovering the refusal.',
  cancelled: 'Cancelled before it finished.',
  failed: 'Stopped on a terminal failure — the model, a tool, or output validation.',
};

export const STOP_TONE: Record<AgentStopReason, 'positive' | 'attention' | 'critical'> = {
  completed: 'positive',
  'max-iterations': 'attention',
  timeout: 'attention',
  'token-budget': 'attention',
  'consecutive-failures': 'critical',
  'awaiting-approval': 'attention',
  // Not critical: a refusal is the system working as designed.
  denied: 'attention',
  cancelled: 'attention',
  failed: 'critical',
};

/** Which port the outer workflow continued from, per stop reason. */
export const PORT_FOR_STOP: Record<AgentStopReason, AgentPort> = {
  completed: 'done',
  'awaiting-approval': 'needs-human',
  denied: 'needs-human',
  'max-iterations': 'failed',
  timeout: 'failed',
  'token-budget': 'failed',
  'consecutive-failures': 'failed',
  cancelled: 'failed',
  failed: 'failed',
};

/* ── provenance ────────────────────────────────────────────────────
   How much a value is worth as *instruction*. Only `authored` — a task a
   person typed into the node — is an instruction; everything else is
   evidence, and is fenced before a model sees it. Mirrors
   `packages/ai-service/src/workflow/provenance.ts`. */

export type Provenance = 'external' | 'tool' | 'system' | 'authored';

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  authored: 'authored by you',
  system: 'produced inside AURA',
  tool: 'returned by a tool',
  external: 'from outside AURA',
};

/** True when a value must be shown as data rather than as instruction. */
export const isInstruction = (p: Provenance): boolean => p === 'authored';

/* ── the ledger ────────────────────────────────────────────────────── */

export type BeatKind =
  | 'intent'
  | 'plan'
  | 'proposal'
  | 'permission'
  | 'execution'
  | 'observation'
  | 'decision'
  | 'intervention'
  | 'result';

export interface AgentBeat {
  seq: number;
  iteration: number;
  at: string;
  kind: BeatKind;
  /** Who caused this beat. `ai` reasons, `fabric` gates, `human` decides. */
  actor: 'ai' | 'fabric' | 'human' | 'system';
  text: string;
  /**
   * True when `text` came from outside AURA — a command's stdout, an HTTP
   * response, a file. A property of the record, not a styling choice made
   * downstream, which is what makes the quarantine a control rather than
   * a convention.
   */
  untrusted?: boolean;
  capabilityId?: string;
  evidence?: EvidenceRef;
  rule?: string;
  decision?: string;
  tokens?: number;
}

export interface AgentTrace {
  beats: AgentBeat[];
  iterations: number;
  tokensUsed: number;
  ms: number;
  stopReason: AgentStopReason;
  port: AgentPort;
  output: string;
  evidence: EvidenceRef[];
  /** Tools requested but refused, with why. Never silently dropped. */
  refusedTools: { capabilityId: string; reason: string }[];
  approval?: { requestId: string; capabilityId: string };
  /**
   * The bounds that ACTUALLY applied, after the runtime clamped them.
   *
   * A node configured with 1000 iterations ran with 25, and a trace that
   * showed only the configuration would misdescribe what happened. The UI
   * shows these, and marks any value the runtime lowered.
   */
  effectiveBounds: AgentBounds;
  /**
   * Where `tokensUsed` came from.
   *
   *   provider  — the model reported usage for every call.
   *   estimated — at least one call reported none and a heuristic stood in.
   *   mixed     — some of each.
   *
   * Shown because the number is enforced against a budget, and a budget
   * enforced on an estimate is a different promise from one enforced on a
   * measurement. "9,900 / 10,000 tokens" without this implies a precision
   * the value does not have.
   */
  tokenSource: 'provider' | 'estimated' | 'mixed';
  /** What the agent's input was worth, and how it was therefore treated. */
  inputProvenance: Provenance;
  /**
   * True when the node had no authored task and its upstream value was not
   * trusted as instruction — so the agent was told to *summarise* that
   * value rather than pursue it. It changes what the agent was asked, so
   * it is surfaced rather than buried.
   */
  taskWasQuarantined: boolean;
  /**
   * Enough state to pick the agent up where it stopped. Present only for
   * `awaiting-approval` — resuming past a bound would make the bound a
   * suggestion.
   */
  resume?: {
    transcript: { role: 'user' | 'assistant'; text: string }[];
    pendingCall: { capabilityId: string; input: Record<string, unknown> };
    iteration: number;
    tokensUsed: number;
    elapsedMs: number;
  };
  /** Always absent or `false` on a finished ledger. See `PartialAgentTrace`. */
  partial?: false;
}

/**
 * A ledger still being written.
 *
 * While an agent is thinking, the service checkpoints the beats so far
 * onto the run record, so a reader that connects late — or reconnects
 * after a drop — sees the reasoning in progress instead of nothing until
 * the node ends. That snapshot has `beats` and *nothing else*: no stop
 * reason, no effective bounds, no evidence, no output, because none of
 * them are known yet.
 *
 * It is a separate type rather than the finished one with optional fields
 * so that the compiler forces the distinction to be handled. A reader must
 * not mistake a snapshot for a verdict, and the surest way to guarantee
 * that is to make "read the stop reason" not typecheck until you have
 * established which one you are holding.
 */
export interface PartialAgentTrace {
  partial: true;
  beats: AgentBeat[];
}

/** Either kind of ledger, as it arrives on a `NodeRunRecord`. */
export type AnyAgentTrace = AgentTrace | PartialAgentTrace;

/** Narrows a ledger to the in-progress snapshot. */
export const isPartialTrace = (t: AnyAgentTrace): t is PartialAgentTrace =>
  (t as { partial?: boolean }).partial === true;


/* ── presentation ──────────────────────────────────────────────────── */

export const BEAT_LABEL: Record<BeatKind, string> = {
  intent: 'Intent',
  plan: 'Plan',
  proposal: 'Proposal',
  permission: 'Permission',
  execution: 'Execution',
  observation: 'Observation',
  decision: 'Decision',
  intervention: 'Intervention',
  result: 'Result',
};

export const ACTOR_LABEL: Record<AgentBeat['actor'], string> = {
  ai: 'AI',
  fabric: 'Fabric',
  human: 'You',
  system: 'System',
};

/** The agent family hue — indigo. Adjacent to intelligence violet
 *  (it reasons) and distinct from it (it acts). */
export const AGENT_COLOR = '#6366f1';

/** What the UI edits at author time: the bounds plus the task. */
export interface AgentConfig {
  objective: string;
  bounds: AgentBounds;
}
