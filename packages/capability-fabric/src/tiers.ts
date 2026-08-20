/**
 * tiers — what an actuation tier COSTS.
 * ==================================================================
 * The ladder itself lives in `@aura/connected-environment/tiers`: what a
 * tier is, which one is available on this machine, and how to choose
 * between them. That is environment knowledge, and the application
 * adapters that declare tiers live down there too.
 *
 * What lives HERE is the half that needs the policy vocabulary — the
 * floor a tier imposes and the risk it raises. Those are governance
 * statements, and governance statements belong beside the one policy
 * engine that applies them.
 *
 * The ladder is re-exported so that `@aura/capability-fabric` remains a
 * single import for anything reasoning about tiers, without there being
 * two definitions of what tier 6 means.
 */

import type { PolicyDecision, RiskLevel } from './types';
import type { ActuationTier } from '@aura/connected-environment';

export * from '@aura/connected-environment/tiers';

/**
 * One line a human can read in an approval dialog. The point of showing
 * the tier to a person is that "AURA will call the application's API"
 * and "AURA will type into the window" deserve different answers, and
 * only one of them is obvious from the capability's name.
 */
export const TIER_DESCRIPTION: Record<ActuationTier, string> = {
  1: 'Calls the application\'s own API directly. The application knows it happened.',
  2: 'Sends the application a message on its documented IPC channel.',
  3: 'Runs the application\'s own command-line interface.',
  4: 'Acts through an extension the application loaded itself.',
  5: 'Reads and drives the accessibility tree the application publishes.',
  6: 'Moves the pointer and types keys at the screen. AURA cannot see whether the window it is aiming at is the one you expect.',
};

/* ══════════════════════════════════════════════════════════════════
   What a tier costs
   ══════════════════════════════════════════════════════════════════ */

/**
 * The lowest decision a tier may ever produce.
 *
 * Only tier 6 has a floor, and the floor is `ask-user`: synthetic input
 * against rendered pixels is never silent. AURA cannot verify that the
 * window it is about to type into is the window the user has in mind —
 * a focus change between the decision and the keystroke is invisible to
 * it — so a person confirms, every time.
 *
 * Tier 5 has no floor but does raise risk (`tierRisk` below): reading an
 * accessibility tree is genuinely observational and genuinely reliable,
 * but *driving* one still acts on a UI that can move underneath it.
 *
 * Returned as data. `policy.ts` is the only thing that applies it, so
 * there is still exactly one place a decision is made.
 */
export function tierFloor(tier: ActuationTier | undefined): PolicyDecision | null {
  return tier === 6 ? 'ask-user' : null;
}

/**
 * How a tier changes a capability's declared risk.
 *
 * Escalate-only, matching the policy engine's own rule: a low-risk
 * capability performed by typing at the screen is not a low-risk action,
 * but a high-risk capability performed through a native API is still
 * high risk. Nothing here can make anything cheaper.
 */
export function tierRisk(declared: RiskLevel, tier: ActuationTier | undefined): RiskLevel {
  if (tier === undefined) return declared;
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  // Tier 5 drives a UI that can move underneath it; tier 6 also cannot
  // see what it is aiming at. Both are at least medium regardless of
  // what the capability declared for its API-tier form.
  const floorRisk: RiskLevel | null = tier >= 5 ? 'medium' : null;
  if (!floorRisk) return declared;
  return rank[floorRisk] > rank[declared] ? floorRisk : declared;
}

