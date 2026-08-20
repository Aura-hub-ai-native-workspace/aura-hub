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
 *   1 suggest    the same policy AND the same scope as 0.
 *   2 execute    the shipped default: low auto, medium asks, high needs
 *     low-risk   explicit authorization — plus a narrower SCOPE that does
 *                not offer irreversible capabilities at all.
 *   3 approved   the same policy as 2, with irreversible capabilities
 *     workflows  back in scope so the loop may propose them. They still
 *                park on a human; what changes is that they can be asked
 *                for.
 *   4 bounded    medium-risk actions run unattended. High risk still
 *     autonomy   requires authorization, and all four floors still hold —
 *                which is exactly why this level is safe to offer at all.
 *   5 long-      the SAME permissions as level 4. What changes is the
 *     running    budget, not the authority: "long-running" is a claim
 *                about duration, and encoding it as extra permission
 *                would be dishonest about what the user agreed to.
 *
 * Three pairs of levels therefore share a `PolicyConfig` — 0/1, 2/3, 4/5
 * — and differ in scope or in budget. That is not an oversight, and it is
 * worth being explicit about why, because the obvious reading of level 3
 * does not survive contact with the engine:
 *
 *   "Approved workflows run unattended" would mean `workflow.run` becoming
 *   `auto-execute` while medium risk generally stays `ask-user`. The
 *   `overrides` map cannot express that. Every configurable layer in
 *   `evaluatePolicy` is folded with `stricter()`, so an override can raise
 *   a decision and can never lower one — writing `auto-execute` there
 *   changes nothing at all. That property is deliberate and it is the
 *   reason a hostile configuration file cannot buy its way past a gate;
 *   weakening it to make a ladder rung work would trade a real security
 *   guarantee for a label.
 *
 *   Expressing level 3 properly needs a notion the engine does not have:
 *   "this specific plan was already approved". That is a second kind of
 *   authorization, and adding one here would put a second approval
 *   authority next to the Fabric's. It is written up in QUESTIONS.md
 *   rather than invented.
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
 * The `PolicyConfig` a level installs.
 *
 * `base` is the operator's saved policy, so their own restrictions are
 * kept: node overrides and node allowlists are carried through untouched,
 * because a level says how bold AURA may be and an allowlist says which
 * machines may be involved — two different questions, and the ladder has
 * no business answering the second.
 */
export function autonomyPolicy(level: AutonomyLevel, base: PolicyConfig = DEFAULT_POLICY): PolicyConfig {
  // The operator's own overrides are carried through. Every one of them
  // can only ever make the engine stricter (see `apply` in policy.ts), so
  // keeping them is safe by construction — and dropping them would let
  // choosing a ladder level quietly undo a restriction somebody set.
  const overrides: Record<string, PolicyDecision> = { ...base.overrides };

  if (level <= 1) {
    // Derived from the manifest, so a capability added tomorrow is denied
    // at level 0 without anyone remembering to add it here. A hand-written
    // list is exactly how "observe" quietly becomes "observe, except".
    for (const capability of CAPABILITY_MANIFEST) {
      if (!isReadOnly(capability)) overrides[capability.id] = 'deny';
    }
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
    // Level 2 is "execute low-risk". An irreversible capability would park
    // on a human rather than run, so offering it is not a safety question
    // — it is a question of what the loop should be reaching for. At level
    // 2 it should not be reaching for anything it cannot undo; from level
    // 3 it may propose one, and a person still decides.
    .filter((c) => !(level === 2 && c.irreversible))
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
  const expected = autonomyPolicy(level, installed);
  if (JSON.stringify(installed.byRisk) !== JSON.stringify(expected.byRisk)) return false;
  if (installed.allowAutonomous !== expected.allowAutonomous) return false;
  // Only the keys the LEVEL sets are compared. An operator's own overrides
  // are not the ladder's business: they can only tighten, so their presence
  // is never a reason to refuse a run, and demanding a byte-identical
  // configuration would make every restriction somebody added look like
  // policy drift.
  for (const id of levelManagedOverrides(level)) {
    if (installed.overrides[id] !== expected.overrides[id]) return false;
  }
  return true;
}

/** The override keys a level sets for itself. Empty above level 1. */
function levelManagedOverrides(level: AutonomyLevel): string[] {
  if (level > 1) return [];
  return CAPABILITY_MANIFEST.filter((c) => !isReadOnly(c)).map((c) => c.id);
}
