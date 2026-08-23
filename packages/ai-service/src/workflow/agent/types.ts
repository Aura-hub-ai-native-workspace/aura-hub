/**
 * Agentic AI Node — the contract, not the autonomy.
 * ==================================================================
 * Every other workflow node is a function: config in, typed output out,
 * behaviour fully determined by its configuration. The agent node is a
 * **contract**: you specify a boundary and something inside it reasons.
 * This file is that boundary, expressed as types the runtime enforces.
 *
 * The single rule the whole design serves:
 *
 *   **The model can never expand its own authority.**
 *
 * Everything below follows from it. Bounds are fixed before the first
 * token is generated and are never re-read from anything the model
 * produced. The tool set is resolved from the workflow's authority
 * envelope, not from the prompt. Tool calls become Fabric invocations,
 * which are evaluated by the one policy engine and written to the one
 * audit trail — the agent has no execution path of its own, so there is
 * nothing for it to escalate into.
 *
 * ── The nine beats ─────────────────────────────────────────────────
 * A run of an agent is not one event, it is a sequence, and each beat
 * causes the next. Recording them as typed rows rather than free text is
 * what makes an agent's behaviour reviewable after the fact instead of
 * merely narrated. `observation` rows in particular are marked untrusted
 * — tool output is data the agent read, never instruction it must follow,
 * and the trace has to keep that distinction visible.
 */

import type { EvidenceRef } from '../run/types';

/* ══════════════════════════════════════════════════════════════════
   The contract
   ══════════════════════════════════════════════════════════════════ */

/**
 * Hard bounds on one agent invocation.
 *
 * Every field has a ceiling as well as a default. A configuration is
 * CLAMPED to the ceiling rather than trusted, because these values arrive
 * from a workflow definition — which may have been imported, or generated
 * by a model — and a bound a definition can raise is not a bound.
 */
export interface AgentBounds {
  /** Reasoning cycles. One cycle = one model call plus at most one tool call. */
  maxIterations: number;
  /** Wall clock for the whole invocation. */
  timeoutMs: number;
  /** Total tokens across every model call in the invocation. */
  maxTokens: number;
  /**
   * Capability ids the agent may request.
   *
   * Enforced as a subset of the workflow's authority envelope — see
   * `bounds.ts`. An id here that the envelope does not contain is dropped
   * with a stated reason; it never silently widens anything.
   */
  tools: string[];
  /** Consecutive failed tool calls before the agent is stopped. */
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

/** Why an agent invocation stopped. Never collapsed into "done". */
export type AgentStopReason =
  /** The model produced its final answer. */
  | 'completed'
  | 'max-iterations'
  | 'timeout'
  | 'token-budget'
  | 'consecutive-failures'
  /** A tool call is parked on a human decision. Resumable. */
  | 'awaiting-approval'
  /**
   * Policy refused a tool call outright.
   *
   * Distinct from `failed` because it is not a malfunction — it is the
   * governance layer working, and the response to it is a person changing
   * the policy or the workflow, not a retry. Feeding a denial back to the
   * model as "that didn't work" would have it spend its remaining budget
   * rediscovering that it is not allowed.
   */
  | 'denied'
  | 'cancelled'
  /** The model, a tool, or output validation failed terminally. */
  | 'failed';

/** The three ways an agent node legitimately terminates. */
export type AgentPort = 'done' | 'needs-human' | 'failed';

export const PORT_FOR_STOP: Record<AgentStopReason, AgentPort> = {
  completed: 'done',
  'awaiting-approval': 'needs-human',
  // A refusal needs a person, not a retry — so it leaves by the port a
  // workflow author can actually route somewhere useful.
  denied: 'needs-human',
  'max-iterations': 'failed',
  timeout: 'failed',
  'token-budget': 'failed',
  'consecutive-failures': 'failed',
  cancelled: 'failed',
  failed: 'failed',
};

/* ══════════════════════════════════════════════════════════════════
   The ledger
   ══════════════════════════════════════════════════════════════════ */

export type BeatKind =
  /** The task as given, plus the context manifest actually sent. */
  | 'intent'
  /** The stated approach for this iteration, before any tool runs. */
  | 'plan'
  /** A named capability with concrete arguments. */
  | 'proposal'
  /** The Fabric's decision and the rule behind it. Always recorded. */
  | 'permission'
  /** Ran via the Fabric. Duration, surface, audit id. */
  | 'execution'
  /** What came back — quarantined as untrusted data. */
  | 'observation'
  /** A claim, with links to the observations supporting it. */
  | 'decision'
  /** Approve, decline, redirect or stop. */
  | 'intervention'
  /** Typed output, or a stated reason for stopping. */
  | 'result';

export interface AgentBeat {
  seq: number;
  iteration: number;
  at: string;
  kind: BeatKind;
  /** Who caused this beat. `ai` reasons, `fabric` gates, `human` decides. */
  actor: 'ai' | 'fabric' | 'human' | 'system';
  /** Redacted, bounded text. */
  text: string;
  /**
   * True when `text` came from outside AURA — a command's stdout, an HTTP
   * response, a file. Rendered as quarantined data everywhere it appears.
   * This is the prompt-injection control, and it is a property of the
   * record rather than a styling choice made downstream.
   */
  untrusted?: boolean;
  capabilityId?: string;
  /** The audit-trail pointer for an `execution` beat. */
  evidence?: EvidenceRef;
  /** Policy rule for a `permission` beat. */
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
  /** Final answer, or the reason there is none. Redacted. */
  output: string;
  /** Every governed action the agent caused. */
  evidence: EvidenceRef[];
  /** Tools requested but refused, with why. Never silently dropped. */
  refusedTools: { capabilityId: string; reason: string }[];
  /** Set when `stopReason === 'awaiting-approval'`. */
  approval?: { requestId: string; capabilityId: string };
  /**
   * The bounds that ACTUALLY applied, after clamping.
   *
   * Recorded because a node configured with 1000 iterations ran with 25,
   * and a trace that showed only the configuration would misdescribe what
   * happened. What a reviewer needs is what the runtime enforced.
   */
  effectiveBounds: AgentBounds;
  /**
   * Where `tokensUsed` came from.
   *
   *   provider  — the model provider reported usage for every call.
   *   estimated — at least one call reported none, and a character-count
   *               heuristic stood in for it.
   *   mixed     — some of each.
   *
   * Stated because the number is enforced against a budget, and a budget
   * enforced on an estimate is a different promise from one enforced on a
   * measurement. A UI showing "9,900 / 10,000 tokens" without saying which
   * would be implying a precision the value does not have.
   */
  tokenSource: 'provider' | 'estimated' | 'mixed';
  /**
   * Enough state to pick the agent up where it stopped.
   *
   * Present only when `stopReason === 'awaiting-approval'`, which is the
   * one stop that is resumable: every other stop is either finished or
   * a bound being hit, and resuming past a bound would make the bound a
   * suggestion. Redacted like everything else on the record.
   */
  resume?: {
    /** The model transcript so far, so the agent keeps its reasoning. */
    transcript: { role: 'user' | 'assistant'; text: string }[];
    /** The parked call, re-issued verbatim once a human decides. */
    pendingCall: { capabilityId: string; input: Record<string, unknown> };
    iteration: number;
    tokensUsed: number;
    /** Wall clock already spent, so the budget is not silently restarted. */
    elapsedMs: number;
  };
}

/** How much transcript is kept for a resume. Bounded like everything else. */
export const MAX_TRANSCRIPT_ENTRIES = 40;

/** Beats are bounded like every other record in this system. */
export const MAX_BEATS = 500;
export const MAX_BEAT_TEXT = 4000;
