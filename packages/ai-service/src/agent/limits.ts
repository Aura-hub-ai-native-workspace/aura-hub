/**
 * agent/limits — bounds the controller enforces, not bounds it suggests.
 * ==================================================================
 * The precedent is `@aura/workflow`'s engine, which enforces
 * `MAX_LOOP_ITERATIONS = 20` and `MAX_NODE_EXECUTIONS = 400` in the
 * engine itself rather than trusting the author of a workflow. Same
 * discipline here, for the same reason: a limit a caller can raise is a
 * default, and calling it a limit is how a runaway loop gets shipped.
 *
 * Two layers:
 *
 *   HARD_CEILING   the maximum this build will ever permit. Not
 *                  configurable, not overridable, clamped on the way in.
 *   requested      what a caller asks for, clamped to the ceiling.
 *
 * Every check is `>=` against a counter the controller owns. Nothing here
 * asks the model to stop.
 */

import type { AgentLimits, TokenRates } from './types';

/**
 * The absolute maximum for any run in this build.
 *
 * Sized to be generous for real work and still bounded by something a
 * person would recognise as an upper bound. A run that needs more than
 * this is not a longer run; it is a different design.
 */
export const HARD_CEILING: Readonly<Omit<AgentLimits, 'maxCostUsd'>> & { maxCostUsd: number } = Object.freeze({
  maxIterations: 40,
  maxToolCallsPerIteration: 8,
  maxToolCalls: 200,
  maxTokens: 2_000_000,
  maxCostUsd: 25,
  maxWallClockMs: 30 * 60 * 1000,
  maxConsecutiveFailures: 5,
});

/** The bounds a run gets when the caller asks for nothing in particular. */
export const DEFAULT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxIterations: 12,
  maxToolCallsPerIteration: 4,
  maxToolCalls: 40,
  maxTokens: 200_000,
  maxCostUsd: null,
  maxWallClockMs: 5 * 60 * 1000,
  maxConsecutiveFailures: 3,
});

const clampPositive = (requested: number | undefined, fallback: number, ceiling: number): number => {
  const value = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : fallback;
  return Math.min(value, ceiling);
};

/**
 * Turn a partial request into limits this build will honour.
 *
 * Clamping rather than rejecting is deliberate for the numeric bounds: a
 * caller asking for 500 iterations gets 40 and a journal entry saying so,
 * which is more useful than an error and cannot be mistaken for consent
 * to 500. Cost is the exception — see `AgentLimits.maxCostUsd`.
 */
export function resolveLimits(requested: Partial<AgentLimits> = {}): AgentLimits {
  return {
    maxIterations: clampPositive(requested.maxIterations, DEFAULT_LIMITS.maxIterations, HARD_CEILING.maxIterations),
    maxToolCallsPerIteration: clampPositive(requested.maxToolCallsPerIteration, DEFAULT_LIMITS.maxToolCallsPerIteration, HARD_CEILING.maxToolCallsPerIteration),
    maxToolCalls: clampPositive(requested.maxToolCalls, DEFAULT_LIMITS.maxToolCalls, HARD_CEILING.maxToolCalls),
    maxTokens: clampPositive(requested.maxTokens, DEFAULT_LIMITS.maxTokens, HARD_CEILING.maxTokens),
    maxCostUsd: requested.maxCostUsd === null || requested.maxCostUsd === undefined
      ? DEFAULT_LIMITS.maxCostUsd
      : Math.min(Math.max(requested.maxCostUsd, 0), HARD_CEILING.maxCostUsd),
    maxWallClockMs: clampPositive(requested.maxWallClockMs, DEFAULT_LIMITS.maxWallClockMs, HARD_CEILING.maxWallClockMs),
    maxConsecutiveFailures: clampPositive(requested.maxConsecutiveFailures, DEFAULT_LIMITS.maxConsecutiveFailures, HARD_CEILING.maxConsecutiveFailures),
  };
}

/** Which bound was hit, and by how much. */
export interface LimitBreach {
  limit: keyof AgentLimits;
  observed: number;
  cap: number;
  reason: string;
}

/**
 * The counters a run is judged against.
 *
 * Owned by the controller and consulted before every model turn and
 * before every tool call. The tracker never stops anything itself — it
 * reports, and the controller acts — because a bound that could halt from
 * inside a counter would be a second control flow.
 */
export class LimitTracker {
  private startedAt = Date.now();
  private iterations = 0;
  private toolCalls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private consecutiveFailures = 0;

  constructor(
    readonly limits: AgentLimits,
    /**
     * Per-token prices for the active model, or null when it publishes
     * none. Null with a cost cap set is refused by `costEnforceable`
     * before a run starts, so this is never null-with-a-cap here.
     */
    private readonly rates: TokenRates | null = null,
  ) {}

  /** Restart the wall clock. Called once, when the first request goes out. */
  begin(): void {
    this.startedAt = Date.now();
  }

  countIteration(): void { this.iterations += 1; }
  countToolCall(): void { this.toolCalls += 1; }

  countUsage(prompt: number, completion: number): void {
    this.promptTokens += Math.max(0, prompt);
    this.completionTokens += Math.max(0, completion);
  }

  /** A step ended. Anything that is not a clear step forward extends the streak. */
  recordStep(failed: boolean): void {
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;
  }

  get usage() {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }

  get iterationCount(): number { return this.iterations; }
  get toolCallCount(): number { return this.toolCalls; }
  get elapsedMs(): number { return Date.now() - this.startedAt; }

  /**
   * Spend so far, or null when the model publishes no rates.
   *
   * Null is a real answer, not a zero. Reporting an unknown cost as $0.00
   * would be a number a person could reasonably act on, and it would be
   * wrong in the one direction that matters.
   */
  get costUsd(): number | null {
    if (!this.rates) return null;
    return (this.promptTokens / 1000) * this.rates.inputPer1k
      + (this.completionTokens / 1000) * this.rates.outputPer1k;
  }

  /**
   * Whether a further model turn may begin.
   *
   * Checked BEFORE the request, not after: a cap that only notices it has
   * been exceeded has already paid for the turn that exceeded it.
   */
  breachBeforeTurn(): LimitBreach | null {
    if (this.iterations >= this.limits.maxIterations) {
      return { limit: 'maxIterations', observed: this.iterations, cap: this.limits.maxIterations, reason: `Reached the ${this.limits.maxIterations}-iteration limit for this run.` };
    }
    if (this.elapsedMs >= this.limits.maxWallClockMs) {
      return { limit: 'maxWallClockMs', observed: this.elapsedMs, cap: this.limits.maxWallClockMs, reason: `Reached the ${Math.round(this.limits.maxWallClockMs / 1000)}-second time limit for this run.` };
    }
    const total = this.promptTokens + this.completionTokens;
    if (total >= this.limits.maxTokens) {
      return { limit: 'maxTokens', observed: total, cap: this.limits.maxTokens, reason: `Reached the ${this.limits.maxTokens}-token budget for this run.` };
    }
    const cost = this.costUsd;
    if (this.limits.maxCostUsd !== null && cost !== null && cost >= this.limits.maxCostUsd) {
      return { limit: 'maxCostUsd', observed: cost, cap: this.limits.maxCostUsd, reason: `Reached the $${this.limits.maxCostUsd.toFixed(2)} spend limit for this run.` };
    }
    if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      return { limit: 'maxConsecutiveFailures', observed: this.consecutiveFailures, cap: this.limits.maxConsecutiveFailures, reason: `${this.consecutiveFailures} steps in a row did not succeed, so the run stopped rather than keep trying.` };
    }
    return null;
  }

  /** Whether one more tool call may be made in this run. */
  breachBeforeToolCall(): LimitBreach | null {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      return { limit: 'maxToolCalls', observed: this.toolCalls, cap: this.limits.maxToolCalls, reason: `Reached the ${this.limits.maxToolCalls}-action limit for this run.` };
    }
    if (this.elapsedMs >= this.limits.maxWallClockMs) {
      return { limit: 'maxWallClockMs', observed: this.elapsedMs, cap: this.limits.maxWallClockMs, reason: `Reached the ${Math.round(this.limits.maxWallClockMs / 1000)}-second time limit for this run.` };
    }
    return null;
  }
}

/**
 * Whether a cost cap can actually be enforced for this run.
 *
 * A cap without rates is not a weak cap, it is no cap at all wearing the
 * word. Callers must fail closed on `false` — refuse the run — rather than
 * proceed and report the cost as unknown, because the user set the cap
 * precisely to avoid being surprised.
 */
export function costEnforceable(limits: AgentLimits, rates: TokenRates | null): boolean {
  return limits.maxCostUsd === null || rates !== null;
}
