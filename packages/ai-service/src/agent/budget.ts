/**
 * agent/budget — a sub-agent gets strictly less. Never equal.
 * ==================================================================
 * "Strictly" is the whole rule. A sub-agent that inherits its parent's
 * budget is not a sub-agent, it is the same agent with a second name, and
 * a tree of them is an unbounded loop wearing a hierarchy. Equality is
 * refused as firmly as excess.
 *
 * Two things shrink, and both must:
 *
 *   LIMITS   every numeric bound is at most half the parent's remaining
 *            allowance, and strictly below it. Halving guarantees a tree
 *            of depth d costs at most the parent's budget however wide it
 *            is, and it terminates: a bound of 1 has no smaller positive
 *            value, so the descent stops rather than recursing forever.
 *
 *   SCOPE    a PROPER subset of the parent's capabilities. The highest
 *            risk tier present is what gets dropped, because delegation
 *            should narrow authority, and narrowing anything else would
 *            be arbitrary — a sub-agent that kept `git.push` and lost
 *            `filesystem.list` is smaller by count and not by power.
 *
 * A parent whose budget cannot be halved, or whose scope cannot lose a
 * tier without emptying, cannot spawn a sub-agent. That is a real answer
 * and it is returned as one.
 */

import { describeFabricCapability, type RiskLevel } from '@aura/capability-fabric';
import type { AgentBudget, AgentLimits } from './types';

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export type SubAgentBudget =
  | { ok: true; budget: AgentBudget; dropped: string[] }
  | { ok: false; reason: string };

/** Half, rounded down, and never equal to the input. */
function halve(value: number): number {
  return Math.min(Math.floor(value / 2), value - 1);
}

function halveLimits(limits: AgentLimits): AgentLimits | null {
  const next: AgentLimits = {
    maxIterations: halve(limits.maxIterations),
    maxToolCallsPerIteration: halve(limits.maxToolCallsPerIteration),
    maxToolCalls: halve(limits.maxToolCalls),
    maxTokens: halve(limits.maxTokens),
    maxCostUsd: limits.maxCostUsd === null ? null : limits.maxCostUsd / 2,
    maxWallClockMs: halve(limits.maxWallClockMs),
    maxConsecutiveFailures: halve(limits.maxConsecutiveFailures),
  };
  // Any bound that cannot go below its parent and stay usable means the
  // parent is already at the bottom of what can be subdivided.
  const numeric: (keyof AgentLimits)[] = [
    'maxIterations', 'maxToolCallsPerIteration', 'maxToolCalls',
    'maxTokens', 'maxWallClockMs', 'maxConsecutiveFailures',
  ];
  for (const key of numeric) {
    if ((next[key] as number) < 1) return null;
  }
  return next;
}

/**
 * Derive a sub-agent's budget from its parent's.
 *
 * `remaining` is the parent's UNSPENT allowance, not its original one.
 * Deriving from the original would let a parent that had already used
 * nine tenths of its budget hand out a half of the whole — which is how a
 * bounded run stops being bounded.
 */
export function deriveSubAgentBudget(parent: AgentBudget): SubAgentBudget {
  const limits = halveLimits(parent.limits);
  if (!limits) {
    return {
      ok: false,
      reason: 'This run’s remaining budget cannot be divided any further, so it cannot delegate.',
    };
  }

  if (parent.scope.length <= 1) {
    return {
      ok: false,
      reason: 'A sub-agent must be able to do strictly less than its parent, and this run has too few capabilities to give up any.',
    };
  }

  // Rank what the parent may do, and drop the boldest tier present.
  const ranked = parent.scope.map((id) => ({
    id,
    risk: describeFabricCapability(id)?.risk ?? 'high',
  }));
  const highest = ranked.reduce((max, c) => Math.max(max, RISK_ORDER[c.risk]), 0);
  const kept = ranked.filter((c) => RISK_ORDER[c.risk] < highest).map((c) => c.id);
  const dropped = ranked.filter((c) => RISK_ORDER[c.risk] === highest).map((c) => c.id);

  if (kept.length === 0) {
    return {
      ok: false,
      reason: 'Every capability this run holds is at the same risk level, so a sub-agent could only be given the same authority or none.',
    };
  }

  return { ok: true, budget: { limits, scope: kept }, dropped };
}

/**
 * Whether one budget really is strictly smaller than another.
 *
 * Exported because it is the property, not the derivation, that must
 * hold: a future strategy that produces budgets some other way is still
 * required to pass this, and `scripts/agent-loop-verify.mjs` asserts it
 * against `deriveSubAgentBudget`'s output rather than trusting it.
 */
export function isStrictlySmaller(child: AgentBudget, parent: AgentBudget): boolean {
  const numeric: (keyof AgentLimits)[] = [
    'maxIterations', 'maxToolCallsPerIteration', 'maxToolCalls',
    'maxTokens', 'maxWallClockMs', 'maxConsecutiveFailures',
  ];
  for (const key of numeric) {
    if ((child.limits[key] as number) >= (parent.limits[key] as number)) return false;
  }
  if (parent.limits.maxCostUsd !== null) {
    if (child.limits.maxCostUsd === null || child.limits.maxCostUsd >= parent.limits.maxCostUsd) return false;
  }

  const parentScope = new Set(parent.scope);
  // Subset…
  for (const id of child.scope) if (!parentScope.has(id)) return false;
  // …and proper.
  return child.scope.length < parent.scope.length;
}
