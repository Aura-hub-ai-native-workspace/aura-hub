/**
 * tiers — the actuation ladder, declared rather than assumed.
 * ==================================================================
 * When AURA acts on an application that is not AURA, there is almost
 * always more than one way in. Those ways are not equivalent, and the
 * difference between them is the difference between an action that is
 * reliable and one that is a guess about pixels.
 *
 * The ladder, highest authority first:
 *
 *   1 native-api     — a real, documented, in-process or linked API.
 *   2 ipc            — D-Bus, Apple Events, COM, a named pipe, a socket.
 *   3 cli            — the application's own command-line interface.
 *   4 plugin         — an extension the application itself loads.
 *   5 accessibility  — the platform a11y tree (AT-SPI, AX, UIAutomation).
 *   6 gui            — synthetic input against rendered pixels.
 *
 * Three rules govern this file, and they exist because the bottom of
 * the ladder is genuinely dangerous:
 *
 *   • **Declared, not assumed.** A capability says which tier it runs
 *     at. Nothing infers a tier from what happened to work.
 *   • **Never silently substitute downward.** If tier 2 is declared and
 *     unavailable, the answer is `not-executed` — not "we tried the GUI
 *     instead". A caller that asked for D-Bus and got synthetic
 *     keystrokes was lied to about what its action did.
 *   • **Tier raises effective risk.** A tier-6 action is never
 *     `auto-execute`, under any configuration (`policy.ts`).
 *
 * This file is the single authority on what a tier *means*. The policy
 * engine is the single authority on what a tier *costs*. Neither
 * duplicates the other: `tierFloor()` below states the floor as data,
 * and `evaluatePolicy` is the only thing that applies it.
 *
 * No React, no Node. The desktop app, the service and a test all read
 * the same ladder.
 */

import type { PolicyDecision, RiskLevel } from './types';

/* ══════════════════════════════════════════════════════════════════
   The ladder
   ══════════════════════════════════════════════════════════════════ */

/**
 * Numeric on purpose: "highest tier available" is then an ordering
 * question with one obvious answer, and `a < b` means "a is more
 * authoritative than b" everywhere without a lookup table.
 */
export type ActuationTier = 1 | 2 | 3 | 4 | 5 | 6;

export type ActuationTierName =
  | 'native-api'
  | 'ipc'
  | 'cli'
  | 'plugin'
  | 'accessibility'
  | 'gui';

export const TIER_NAME: Record<ActuationTier, ActuationTierName> = {
  1: 'native-api',
  2: 'ipc',
  3: 'cli',
  4: 'plugin',
  5: 'accessibility',
  6: 'gui',
};

export const TIER_BY_NAME: Record<ActuationTierName, ActuationTier> = {
  'native-api': 1,
  ipc: 2,
  cli: 3,
  plugin: 4,
  accessibility: 5,
  gui: 6,
};

/** Every tier, most authoritative first. The iteration order for "best available". */
export const TIER_LADDER: ActuationTier[] = [1, 2, 3, 4, 5, 6];

export const isActuationTier = (v: unknown): v is ActuationTier =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6;

/**
 * One line a human can read in an approval dialog. The point of showing
 * the tier to a person is that "AURA will type into the window" and
 * "AURA will call the application's API" deserve different answers, and
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
   Per-platform support — declared, never guessed
   ══════════════════════════════════════════════════════════════════ */

export type TargetPlatform = 'linux' | 'darwin' | 'win32';

export const TARGET_PLATFORMS: TargetPlatform[] = ['linux', 'darwin', 'win32'];

/** Map `process.platform` onto the three platforms this project ships on. */
export function targetPlatformOf(nodePlatform: string): TargetPlatform | null {
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'win32') return 'win32';
  return null;
}

/**
 * What a driver claims about one platform, before anything is probed.
 *
 * `supported: false` is a first-class answer and the common one. A
 * tier-6 driver written against X11 does not work on Wayland and does
 * not work on Windows, and saying so in data is how the capability
 * reports `not-executed` instead of failing at spawn time with an
 * ENOENT the user has to interpret.
 */
export interface PlatformDeclaration {
  platform: TargetPlatform;
  /** Can this driver work on this platform at all, in principle? */
  supported: boolean;
  /**
   * Executables, buses or services that must be present for the claim
   * to hold on a particular machine. Checked at runtime by the probe;
   * listed here so an unmet requirement can be *named* to the user.
   */
  requires: string[];
  /** Why, in one line. Shown when support is refused. */
  note: string;
}

/**
 * Runtime availability, after probing this machine.
 *
 *   available    — probed, and the requirements are met here.
 *   unavailable  — probed, and they are not. Names what is missing.
 *   unsupported  — the driver does not claim this platform at all.
 *   unknown      — not probed yet. NEVER treated as available.
 */
export type TierAvailability = 'available' | 'unavailable' | 'unsupported' | 'unknown';

export interface TierProbe {
  tier: ActuationTier;
  availability: TierAvailability;
  /** Plain language, always with what is missing or what answered. */
  detail: string;
  /** Requirements that were checked and found absent. */
  missing?: string[];
  /** The platform the probe ran on. */
  platform: TargetPlatform | null;
}

/**
 * `true` only for `available`. Written as a function rather than a
 * comparison so that no call site can accidentally treat `unknown` as
 * usable by writing `!== 'unavailable'`.
 */
export const isTierUsable = (a: TierAvailability): boolean => a === 'available';

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

/* ══════════════════════════════════════════════════════════════════
   Choosing a tier
   ══════════════════════════════════════════════════════════════════ */

export type TierSelectionFailure =
  /** The capability declares no tiers at all. */
  | 'no-tier-declared'
  /** Every declared tier is unsupported on this platform. */
  | 'platform-unsupported'
  /** Declared and supported, but this machine lacks the requirements. */
  | 'requirements-missing';

/**
 * The outcome of picking a tier. A failure is not an error: it is the
 * `not-executed` answer, carrying enough detail for the user to fix it
 * or to decide they do not want to.
 */
export type TierSelection =
  | { ok: true; tier: ActuationTier; probe: TierProbe }
  | {
      ok: false;
      code: TierSelectionFailure;
      reason: string;
      /** Every tier considered, and why each was rejected. */
      considered: TierProbe[];
    };

/**
 * Pick the highest-authority tier that is actually available.
 *
 * "Highest available" is the whole point of the ladder, and the reason
 * this returns a failure rather than the next thing that happens to work
 * is the reason the ladder is worth having: a caller that declared
 * tiers [2, 3] and got neither must be told so, not quietly handed a
 * tier-6 approximation of what it asked for.
 *
 * `probes` is supplied by the caller — this function performs no I/O and
 * knows nothing about this machine, so the selection rule can be tested
 * against every combination without a desktop session.
 */
export function selectTier(declared: ActuationTier[], probes: TierProbe[]): TierSelection {
  if (!declared.length) {
    return {
      ok: false,
      code: 'no-tier-declared',
      reason: 'This capability does not say how it reaches the application, so AURA will not guess at one.',
      considered: [],
    };
  }

  const byTier = new Map(probes.map((p) => [p.tier, p]));
  const considered: TierProbe[] = [];

  for (const tier of TIER_LADDER) {
    if (!declared.includes(tier)) continue;
    const probe: TierProbe = byTier.get(tier) ?? {
      tier,
      availability: 'unknown',
      detail: `Tier ${tier} (${TIER_NAME[tier]}) was never probed, and an unprobed tier is never assumed to work.`,
      platform: null,
    };
    considered.push(probe);
    if (isTierUsable(probe.availability)) return { ok: true, tier, probe };
  }

  const anySupported = considered.some((p) => p.availability !== 'unsupported');
  const missing = [...new Set(considered.flatMap((p) => p.missing ?? []))];

  return anySupported
    ? {
        ok: false,
        code: 'requirements-missing',
        reason: missing.length
          ? `Nothing on this machine can perform it: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available.`
          : 'Every way AURA knows to perform this was probed and none answered on this machine.',
        considered,
      }
    : {
        ok: false,
        code: 'platform-unsupported',
        reason: 'None of the ways AURA knows to perform this exist on this operating system.',
        considered,
      };
}
