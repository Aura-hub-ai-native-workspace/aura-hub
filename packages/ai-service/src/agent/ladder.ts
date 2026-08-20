/**
 * agent/ladder — autonomy as a preset, not a second engine.
 * ==================================================================
 * Six levels, each of which produces an ordinary `PolicyConfig` for the
 * ONE policy engine in `@aura/capability-fabric/policy`. Nothing here
 * evaluates anything. There is no parallel decision path, no bypass, and
 * no level at which a floor stops applying — `evaluatePolicy` checks the
 * four hard floors before it consults any configuration and returns
 * early, so no value this file can produce is capable of reaching them.
 *
 * What each level actually is:
 *
 *   0 observe    reads run; every mutating capability is DENIED by an
 *                explicit per-capability override, derived from the
 *                manifest rather than listed here.
 *   1 suggest    identical policy to 0. The difference is behavioural,
 *                not permissive: the loop is allowed to PROPOSE actions
 *                to a human. A proposal is not an action, so it needs no
 *                policy of its own — and levels 0 and 1 producing the
 *                same config is the honest encoding of that, not an
 *                oversight.
 *   2 execute    the shipped default: low auto, medium asks, high needs
 *     low-risk   explicit authorization. This is `DEFAULT_POLICY`.
 *   3 approved   level 2, plus running what a human has already approved:
 *     workflows  `workflow.run` and `mission.start` become auto-execute
 *                through the existing `overrides` map. Both are medium
 *                risk and reversible; the approval they act on has
 *                already happened at the mission checkpoint.
 *   4 bounded    medium-risk actions run unattended. High risk still
 *     autonomy   requires authorization, and all four floors still hold —
 *                which is exactly why this level is safe to offer at all.
 *   5 long-      the SAME permissions as level 4. What changes is the
 *     running    budget, not the authority: "long-running" is a claim
 *                about duration, and encoding it as extra permission
 *                would be dishonest about what the user agreed to.
 *
 * Levels 4 and 5 RELAX relative to the default, which is why a level is
 * an operator setting persisted through the existing `policyStore`, and
 * never something a run installs for its own duration. A loop that could
 * widen the policy it is judged by is not governed by it.
 */

import {
  CAPABILITY_MANIFEST,
  DEFAULT_POLICY,
  sanitizePolicy,
  type CapabilityDescriptor,
  type PolicyConfig,
  type PolicyDecision,
} from '@aura/capability-fabric';
import { READ_ONLY_SCOPES, type AutonomyLevel } from './types';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [0, 1, 2, 3, 4, 5];

/** The level AURA ships at. Stated once, here. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 2;

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: 'Observe',
  1: 'Suggest',
  2: 'Execute low-risk',
  3: 'Approved workflows',
  4: 'Bounded autonomy',
  5: 'Long-running missions',
};

/** A capability that cannot change anything. */
export function isReadOnly(capability: CapabilityDescriptor): boolean {
  return capability.permissions.every((p) => READ_ONLY_SCOPES.has(p));
}

/**
 * Capabilities a human has already authorized by another route.
 *
 * Both are medium risk, both are reversible, and both act on a plan that
 * passed a Mission Control checkpoint before it could exist. Level 3 says
 * "run what was approved"; this is the list of ways to do that, and it is
 * short on purpose — a long list here would be autonomy smuggled in under
 * a narrower name.
 */
const PRE_APPROVED_CAPABILITIES = ['workflow.run', 'mission.start'] as const;

/**
 * The `PolicyConfig` a level installs.
 *
 * `base` is the operator's saved policy, so their own restrictions are
 * kept: node overrides and node allowlists are carried through untouched,
 * because a level says how bold AURA may be and an allowlist says which
 * machines may be involved — two different questions, and the ladder has
 * no business answering the second.
 */
export function autonomyPolicy(level: AutonomyLevel, base: PolicyConfig = DEFAULT_POLICY): PolicyConfig {
  const overrides: Record<string, PolicyDecision> = { ...DEFAULT_POLICY.overrides };

  if (level <= 1) {
    // Derived from the manifest, so a capability added tomorrow is denied
    // at level 0 without anyone remembering to add it here. A hand-written
    // list is exactly how "observe" quietly becomes "observe, except".
    for (const capability of CAPABILITY_MANIFEST) {
      if (!isReadOnly(capability)) overrides[capability.id] = 'deny';
    }
  }

  if (level >= 3) {
    for (const id of PRE_APPROVED_CAPABILITIES) overrides[id] = 'auto-execute';
  }

  const byRisk: PolicyConfig['byRisk'] = level >= 4
    ? { low: 'auto-execute', medium: 'auto-execute', high: 'require-approval' }
    : { ...DEFAULT_POLICY.byRisk };

  // Everything untrusted-shaped goes through the existing sanitizer, so
  // this file cannot introduce a decision string the engine does not
  // recognise even by accident.
  return sanitizePolicy({
    byRisk,
    overrides,
    nodeOverrides: base.nodeOverrides,
    nodeAllowlists: base.nodeAllowlists,
    // Turning autonomy off is the user's global "ask me first" and it
    // outranks the ladder: a level cannot switch it back on for them.
    allowAutonomous: base.allowAutonomous,
  });
}

/**
 * The capabilities a run at this level may CALL.
 *
 * Distinct from what policy permits, and narrower on purpose. Policy
 * decides whether an action may happen; scope decides whether the model
 * is ever offered it. Offering `git.push` at level 0 and relying on the
 * override to deny it would work, and would also fill the run journal
 * with refusals for actions that were never on the table.
 *
 * `supported` is the set with a real executor behind it — passing
 * `fabric.supported()` is what keeps the offered tools honest about the
 * 24 that actually work, rather than the 33 the manifest describes.
 */
export function autonomyScope(level: AutonomyLevel, supported?: readonly string[]): string[] {
  const available = supported ? new Set(supported) : null;
  return CAPABILITY_MANIFEST
    .filter((c) => (available ? available.has(c.id) : true))
    .filter((c) => (level <= 1 ? isReadOnly(c) : true))
    .filter((c) => {
      // Level 2 is "execute low-risk". High-risk capabilities are still
      // reachable — they park on an approval rather than running — but a
      // level-2 run is not meant to be reaching for them unprompted, and
      // an irreversible one is never worth offering unattended.
      if (level === 2 && c.irreversible) return false;
      return true;
    })
    .map((c) => c.id);
}

/**
 * A short, stable identity for a policy configuration.
 *
 * Recorded in the journal so a replay can prove which rules were in force,
 * and compared before a run starts so a loop cannot execute under a policy
 * other than the one its level describes. Deterministic: same config, same
 * string, regardless of key insertion order.
 */
export function policyFingerprint(policy: PolicyConfig): string {
  const stable = {
    byRisk: policy.byRisk,
    overrides: Object.keys(policy.overrides).sort().map((k) => `${k}=${policy.overrides[k]}`),
    nodeOverrides: Object.keys(policy.nodeOverrides ?? {}).sort().map((k) => `${k}=${policy.nodeOverrides![k]}`),
    nodeAllowlists: Object.keys(policy.nodeAllowlists ?? {}).sort().map((k) => `${k}=[${[...policy.nodeAllowlists![k]].sort().join(',')}]`),
    allowAutonomous: policy.allowAutonomous,
  };
  // A tiny non-cryptographic digest. This is an identity for comparison
  // and a label for a log line, not a security boundary — the policy
  // itself is the security boundary, and it is right there in the config.
  const text = JSON.stringify(stable);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `pol-${(h >>> 0).toString(36)}`;
}

/**
 * Whether the policy actually installed on the Fabric is the one this
 * level describes.
 *
 * Checked before a run starts. Without it, an operator at level 4 whose
 * saved policy had drifted would get level-4 budgets under level-2 rules,
 * or worse the reverse — and the journal would record a level the run was
 * never actually governed by.
 *
 * The installed policy is used as its own base, so the operator's node
 * overrides and allowlists are carried through identically and cancel
 * out. What is left being compared is exactly what the ladder claims to
 * decide — `byRisk`, `overrides`, and whether autonomy is on at all.
 */
export function policyMatchesLevel(level: AutonomyLevel, installed: PolicyConfig): boolean {
  return policyFingerprint(installed) === policyFingerprint(autonomyPolicy(level, installed));
}
