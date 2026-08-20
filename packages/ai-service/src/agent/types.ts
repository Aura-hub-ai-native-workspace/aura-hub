/**
 * agent/types — the vocabulary of a governed agent run.
 * ==================================================================
 * A bounded plan → act → observe loop whose ONLY actuators are Fabric
 * capabilities. It has no direct process access, no direct filesystem
 * access and no direct network access; every effect it can cause is a
 * `fabric.invoke(...)`, which means every effect it can cause is
 * re-validated, re-policied and audited before it happens.
 *
 * This is a NEW loop, not a change to the mission engine. Mission Control
 * v3 stays the deterministic governed path — `mission/execution/engine.ts`
 * forbids re-planning and continues to. The two coexist the way the
 * Fabric's audit trail and Mission Control's timeline coexist: different
 * questions, one authority each.
 */

import type { PermissionScope, RiskLevel } from '@aura/capability-fabric';

/* ══════════════════════════════════════════════════════════════════
   Outcomes
   ══════════════════════════════════════════════════════════════════ */

/**
 * What one step of the loop actually did. Six values, and they must stay
 * six: collapsing any pair loses the distinction that makes the loop safe
 * to reason about afterwards.
 *
 *   success           — it ran and nothing contradicted the claim
 *   failure           — it did not run, or provably had no effect
 *   partial           — it ran; the effect could not be confirmed
 *   unknown           — it may or may not have taken effect
 *   not-executed      — refused before anything happened
 *   requires-approval — parked on a human; has NOT run
 *
 * `unknown` is the load-bearing one. A transient error says the transport
 * failed; it never says the effect did not happen. Reporting that as
 * `failure` asserts something nobody knows, and reporting it as `success`
 * is worse.
 */
export type StepOutcome =
  | 'success'
  | 'failure'
  | 'partial'
  | 'unknown'
  | 'not-executed'
  | 'requires-approval';

/** Why a run ended. Every value is a bound being reached, or a decision. */
export type RunOutcome =
  /** The model stopped asking for tools and produced an answer. */
  | 'completed'
  /** A hard cap was hit. `RunResult.limit` names which. */
  | 'limit-reached'
  /** The kill switch was tripped. */
  | 'killed'
  /** A step needs a human and the loop cannot proceed without it. */
  | 'blocked-on-approval'
  /** The loop itself failed — the provider was unreachable, and so on. */
  | 'failed'
  /** The loop never started: the gate refused it. */
  | 'refused';

/* ══════════════════════════════════════════════════════════════════
   Limits
   ══════════════════════════════════════════════════════════════════ */

/**
 * Every bound on a run. All of them are enforced by the controller and
 * none of them is advisory — the precedent is `@aura/workflow`'s
 * `MAX_LOOP_ITERATIONS` / `MAX_NODE_EXECUTIONS`, which are checked in the
 * engine rather than suggested to the author of a workflow.
 */
export interface AgentLimits {
  /** Model turns. One iteration is one request plus its tool calls. */
  maxIterations: number;
  /** Tool calls the model may ask for in ONE turn. Excess is refused. */
  maxToolCallsPerIteration: number;
  /** Tool calls across the whole run. */
  maxToolCalls: number;
  /** Prompt + completion tokens, summed across every turn. */
  maxTokens: number;
  /**
   * Spend ceiling in US dollars.
   *
   * Enforceable only when the active model publishes per-token rates
   * (`ModelCapabilities.inputCostPer1k` / `outputCostPer1k`). A run that
   * sets this cap without rates available is REFUSED rather than run with
   * an unenforceable cap — an advisory cost limit is worse than none,
   * because it reads as protection.
   */
  maxCostUsd: number | null;
  /** Wall clock from the first request to the last. */
  maxWallClockMs: number;
  /**
   * Consecutive steps ending `failure` or `unknown` before the run stops.
   * Reset by any `success` or `partial`.
   */
  maxConsecutiveFailures: number;
}

/** Per-1000-token rates for the active model, when it publishes them. */
export interface TokenRates {
  inputPer1k: number;
  outputPer1k: number;
}

/* ══════════════════════════════════════════════════════════════════
   Budget
   ══════════════════════════════════════════════════════════════════ */

/**
 * A run's limits together with the capabilities it may reach.
 *
 * The pair travels together because a sub-agent must inherit a strictly
 * smaller version of BOTH — smaller limits with the parent's full reach
 * is not a smaller budget, it is the same authority in a hurry.
 */
export interface AgentBudget {
  limits: AgentLimits;
  /** Capability ids this run may call. Never widened at runtime. */
  scope: readonly string[];
}

/* ══════════════════════════════════════════════════════════════════
   Autonomy
   ══════════════════════════════════════════════════════════════════ */

/**
 * The autonomy ladder.
 *
 *   0 observe              — read only; the loop proposes nothing
 *   1 suggest              — read only; the loop proposes actions to a human
 *   2 execute low-risk     — SHIPPED DEFAULT
 *   3 approved workflows   — plus running what a human already approved
 *   4 bounded autonomy     — medium-risk actions run unattended
 *   5 long-running missions— level 4's permissions, larger budgets
 *
 * Every level is a preset over the EXISTING `PolicyConfig` — `byRisk`,
 * `overrides`, `allowAutonomous`. There is no second policy engine, and
 * the four hard floors (irreversible, destructive, authorization, system)
 * are non-overridable at every level because `evaluatePolicy` checks them
 * before it consults any configuration.
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/* ══════════════════════════════════════════════════════════════════
   Journal
   ══════════════════════════════════════════════════════════════════ */

/**
 * One entry in a run's journal.
 *
 * The journal is the loop's own execution record, in the same relationship
 * to the Fabric's audit trail that Mission Control's timeline already has:
 * the Fabric remains the single authority on what ran and on whose
 * authority, and every entry that describes an action carries the
 * `invocationId` of the audit record rather than restating it. What lives
 * here and nowhere else is the loop's own control flow — which turn asked
 * for what, what was refused before it reached the Fabric, which cap was
 * hit, when the kill switch was pulled.
 *
 * Between the two, a run is reconstructible without the process that ran
 * it: `run.started` fixes the objective and the bounds, `model.turn`
 * records every request and reply, and `tool.result` records the exact
 * text that was fed back — so the message list can be rebuilt literally
 * rather than approximately.
 */
export type AgentJournalEntry =
  | {
      type: 'run.started'; seq: number; at: string; runId: string;
      /** Set when this run is a sub-agent. Its budget is strictly smaller. */
      parentRunId?: string;
      objective: string;
      /** The exact system prompt, so a replay reproduces the same turn. */
      systemPrompt: string;
      level: AutonomyLevel;
      limits: AgentLimits;
      scope: readonly string[];
      /** Fingerprint of the policy in force. See `policyFingerprint`. */
      policy: string;
      model: string;
    }
  | {
      type: 'model.turn'; seq: number; at: string; runId: string;
      iteration: number;
      /** What the model said, verbatim. */
      text: string;
      finishReason: string;
      promptTokens: number;
      completionTokens: number;
      /** Tool calls requested this turn, before any of them was judged. */
      requested: { id: string; name: string; argumentsSummary: string }[];
    }
  | {
      type: 'tool.refused'; seq: number; at: string; runId: string;
      iteration: number;
      /** The name the model emitted, exactly as emitted. */
      requestedName: string;
      argumentsSummary: string;
      /** `unknown-tool`, `out-of-scope`, `malformed-arguments`, … */
      rule: string;
      reason: string;
      /**
       * The Fabric audit record for this refusal, when the refusal was
       * made BY the Fabric. Absent when the loop refused it first — a
       * scope violation never reaches the Fabric, and inventing an
       * invocation id for it would put a call in the audit trail that was
       * never made.
       */
      invocationId?: string;
    }
  | {
      type: 'checkpoint'; seq: number; at: string; runId: string;
      iteration: number;
      capabilityId: string;
      /** True when prior state was captured and a revert is possible. */
      captured: boolean;
      /** How the prior state was read — itself a Fabric capability. */
      via?: string;
      /** The invocation that read it, for the audit trail. */
      invocationId?: string;
      /**
       * The invocation that would put things back, INCLUDING the prior
       * state itself.
       *
       * This is what makes the checkpoint a checkpoint rather than a note
       * that one was taken. The capture is a Fabric read whose result is
       * the prior contents, and an audit record stores only a redacted
       * argument summary — so if the prior state were not written here it
       * would exist nowhere once the process ended, and "revert never
       * depends on git" would be false the moment it mattered.
       *
       * Absent when nothing could restore it: prior state that was too
       * large to record, or a capability with no inverse in the manifest.
       * Absence is the honest signal that a revert is not available.
       */
      restore?: { capabilityId: string; input: Record<string, unknown> };
      /** Why not, when `captured` is false. Always stated. */
      why?: string;
    }
  | {
      type: 'tool.result'; seq: number; at: string; runId: string;
      iteration: number;
      capabilityId: string;
      /** The Fabric audit record. The authority on what happened. */
      invocationId: string;
      outcome: StepOutcome;
      /** The Fabric's own outcome, kept distinct from the loop's reading. */
      fabricOutcome: string;
      verified: boolean | null;
      policyRule: string;
      risk: RiskLevel;
      approvalId?: string;
      /** Exactly what was fed back to the model, so replay is literal. */
      observation: string;
    }
  | {
      type: 'limit.reached'; seq: number; at: string; runId: string;
      limit: keyof AgentLimits;
      observed: number;
      cap: number;
    }
  | {
      type: 'kill'; seq: number; at: string; runId: string;
      by: string;
      reason: string;
      /** Steps that were in flight when the switch was pulled. */
      inFlight: string[];
    }
  | {
      type: 'run.finished'; seq: number; at: string; runId: string;
      outcome: RunOutcome;
      iterations: number;
      toolCalls: number;
      promptTokens: number;
      completionTokens: number;
      costUsd: number | null;
      /** The model's final answer, when it produced one. */
      answer: string;
    };

/**
 * Durable storage for run journals.
 *
 * `durable` is not decoration. The agent loop refuses to arm without a
 * durable journal, because a bounded autonomous loop nobody can
 * reconstruct afterwards is not governed — it is merely bounded. An
 * in-memory implementation reports `false` and is therefore usable for
 * tests and unusable for a real run, which is the correct asymmetry.
 */
export interface AgentJournal {
  readonly durable: boolean;
  append(entry: AgentJournalEntry): void;
  /** Every entry for one run, in sequence order. */
  read(runId: string): AgentJournalEntry[];
  /** Run ids this journal holds, newest first. */
  runs(): string[];
}

/* ══════════════════════════════════════════════════════════════════
   Results
   ══════════════════════════════════════════════════════════════════ */

export interface AgentRunResult {
  runId: string;
  outcome: RunOutcome;
  /** Which cap ended the run, when `outcome` is `limit-reached`. */
  limit?: keyof AgentLimits;
  /** The model's final answer, or the reason there is none. */
  answer: string;
  detail: string;
  iterations: number;
  toolCalls: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd: number | null;
  /** Every step, in order. Same facts as the journal, already in memory. */
  steps: {
    capabilityId: string;
    invocationId: string;
    outcome: StepOutcome;
    detail: string;
  }[];
  /** Approvals this run is waiting on, when it parked. */
  pendingApprovals: string[];
  /**
   * The bounds and reach this run actually got, after clamping and after
   * the level narrowed the scope.
   *
   * Returned rather than assumed because it is what a sub-agent must be
   * derived from: `deriveSubAgentBudget` halves what the parent HAS, and a
   * caller reading its own request back would halve what it ASKED for.
   */
  budget: AgentBudget;
}

/* ══════════════════════════════════════════════════════════════════
   Scope classification — derived, never hand-listed
   ══════════════════════════════════════════════════════════════════ */

/**
 * Scopes that only read. A capability needing nothing outside this set
 * cannot change anything, which is what "observe" means at ladder level 0.
 */
export const READ_ONLY_SCOPES: ReadonlySet<PermissionScope> = new Set<PermissionScope>([
  'project.read',
  'aura.read',
]);

/**
 * Scopes that make an action a WRITE for checkpoint purposes.
 *
 * `network.outbound` is deliberately absent, and the omission is the
 * interesting part. A checkpoint records prior state so a revert does not
 * depend on git; there is no prior state to record on somebody else's
 * server, and pretending to checkpoint an HTTP call would produce a
 * checkpoint that cannot restore anything. Outbound calls are governed by
 * their declared risk instead, which is what `http.request: medium`
 * already does.
 */
export const MUTATING_SCOPES: ReadonlySet<PermissionScope> = new Set<PermissionScope>([
  'project.write',
  'aura.write',
  'process.execute',
  'resource.destroy',
  'account.authorize',
  'system.modify',
]);
