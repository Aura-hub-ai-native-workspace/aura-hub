/**
 * Actuation tiers - HOW a capability actually reaches the world.
 * ==================================================================
 * The manifest already says WHAT a capability does and on which
 * `ExecutionSurface` it runs. It could not say how directly it gets
 * there, and that turns out to be the thing a user most needs to know
 * before saying yes.
 *
 * Six tiers, most direct first:
 *
 *   1 native-api     A real API with a contract. Errors are typed,
 *                    results are structured, failure is reported.
 *   2 cli            A command-line tool. Stable-ish, exit codes,
 *                    text output that has to be parsed.
 *   3 ipc            A local protocol - MCP over stdio or HTTP, a
 *                    language server, a daemon socket. Schemas arrive
 *                    from the other side rather than being known here.
 *   4 browser        A driven browser. The page is a moving target and
 *                    everything it returns is attacker-shaped.
 *   5 accessibility  The OS accessibility tree. Works on anything with
 *                    a UI; breaks on a layout change; sees the user's
 *                    whole screen.
 *   6 gui            Synthetic clicks and keystrokes at screen
 *                    coordinates. No contract at all. Cannot verify
 *                    what it did beyond looking again.
 *
 * -- Why this is a first-class field ----------------------------------
 * Two properties fall out of it, and neither is expressible without it:
 *
 *   The tier is recorded on every journal entry. "AURA renamed the file"
 *   and "AURA clicked at (412, 380) hoping to rename the file" are
 *   different events, and after the fact only the tier tells them apart.
 *
 *   The tier RAISES effective risk. A capability that is low-risk over a
 *   native API is not low-risk when it is being driven by synthesised
 *   clicks, because the failure modes are different: an API call fails
 *   loudly, a misplaced click succeeds at something else.
 *
 * -- The rule that matters most ---------------------------------------
 * NEVER SILENTLY SUBSTITUTE A LOWER TIER FOR A HIGHER ONE. If a
 * capability was going to run over a native API and the API is
 * unavailable, falling back to clicking buttons is a different action
 * with a different risk profile, and it must be re-decided, not
 * inherited. `substitutionIsSilent()` below is what a caller checks;
 * the driver registry refuses the substitution outright.
 */

import type { RiskLevel } from './types';

export type ActuationTier = 1 | 2 | 3 | 4 | 5 | 6;

export const TIER_ID: Record<ActuationTier, string> = {
  1: 'native-api',
  2: 'cli',
  3: 'ipc',
  4: 'browser',
  5: 'accessibility',
  6: 'gui',
};

export const TIER_LABEL: Record<ActuationTier, string> = {
  1: 'a native API',
  2: 'a command-line tool',
  3: 'a local protocol (IPC)',
  4: 'a driven browser',
  5: 'the accessibility tree',
  6: 'synthetic mouse and keyboard input',
};

/**
 * What the user is told before approving. Written as consequences, not
 * as taxonomy: "tier 5" means nothing to anyone the first time.
 */
export const TIER_USER_NOTE: Record<ActuationTier, string> = {
  1: 'Runs against a real API. Failures are reported rather than guessed at.',
  2: 'Runs a command-line tool and reads its output. Exit codes are real; output is parsed.',
  3: 'Talks to a local process over a protocol. The other side declares its own schemas, which AURA did not write.',
  4: 'Drives a browser page. Page content is treated as untrusted data and can never instruct AURA.',
  5: 'Reads and operates the accessibility tree of a running application. This can see application content beyond the target.',
  6: 'Synthesises mouse and keyboard input at screen coordinates. There is no contract and no way to confirm what was clicked except by looking again.',
};

/**
 * The minimum risk a tier imposes, whatever the capability claims.
 *
 * Tiers 1-3 impose no floor: they have contracts, and the capability's
 * own declared risk is the honest figure. Tier 4 and above impose one,
 * because their failure modes are not the capability's failure modes.
 */
export const TIER_RISK_FLOOR: Record<ActuationTier, RiskLevel | null> = {
  1: null,
  2: null,
  3: null,
  4: 'medium',
  5: 'medium',
  6: 'high',
};

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** The stricter of two risk levels. Effective risk only ever escalates. */
export function stricterRisk(a: RiskLevel, b: RiskLevel | null | undefined): RiskLevel {
  if (!b) return a;
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/**
 * The risk this capability actually carries, given how it will be
 * actuated. Fed to the existing policy engine as a floor; it does not
 * make a decision of its own, because there is exactly one place a
 * decision is made.
 */
export function effectiveRisk(declared: RiskLevel, tier: ActuationTier): RiskLevel {
  return stricterRisk(declared, TIER_RISK_FLOOR[tier]);
}

/**
 * Whether swapping `from` for `to` would quietly weaken how an action is
 * performed. True means it must be refused or re-approved, never done
 * on the caller's behalf.
 */
export function substitutionIsSilent(from: ActuationTier, to: ActuationTier): boolean {
  return to > from;
}

/** One line for the journal and the approval dialog. */
export function describeTier(tier: ActuationTier): string {
  return `tier ${tier} (${TIER_ID[tier]}) — ${TIER_USER_NOTE[tier]}`;
}
