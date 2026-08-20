/**
 * fabric/desktopExecutors — the three read-only desktop capabilities.
 * ==================================================================
 * These are the executors for `desktop.applications.discover`,
 * `desktop.accessibility.observe` and `desktop.windows.observe`. They do
 * three things and no more: call the one environment scanner, call the
 * tier-5 driver, call the tier-6 driver.
 *
 * Two properties they hold that matter more than what they do:
 *
 *   • **Every one of them reports the tier it ran at.** Not the tier it
 *     was permitted to run at — the one it used. The Fabric prefers this
 *     report over its own selection when writing the journal, so an
 *     executor that stayed silent would produce a journal entry that
 *     could not answer "did AURA call the API or read the screen?".
 *
 *   • **They never fall back.** A driver that refuses returns the
 *     refusal. There is no "try the other tier" branch anywhere in this
 *     file, and the reason there is none is that adding one would make
 *     the recorded tier a guess.
 *
 * `effectStarted: false` is claimed throughout, and it is claimed
 * honestly: every one of these is a read. Nothing about the outside
 * world changes whether they succeed or fail, so a retry repeats
 * nothing.
 */

import type { Executor, ExecutorResult, Invocation } from '@aura/capability-fabric';
import { scanApplications } from '../environment';
import { accessibilityDriver, guiDriver, type TierDriver } from '../desktop/drivers';

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? (v as string[]) : undefined;

/**
 * Turn a driver's observation into an executor result.
 *
 * Shared by both observation capabilities because the shape of the
 * answer is identical and the only difference is which rung produced it
 * — which is exactly the thing that must be recorded rather than
 * flattened away.
 */
async function observeThrough(driver: TierDriver): Promise<ExecutorResult> {
  const result = await driver.observe();
  if (!result.ok) {
    return {
      ok: false,
      detail: result.reason,
      // A refusal to read is proven not to have touched anything.
      effectStarted: false,
      // The tier is reported even on refusal: "tier 6 could not read"
      // and "tier 5 could not read" are different facts, and a journal
      // that recorded neither could not distinguish them.
      tier: driver.tier,
      output: { missing: result.missing },
    };
  }
  const { observation } = result;
  return {
    ok: true,
    detail: `${observation.detail} Read through ${observation.via}.`,
    effectStarted: false,
    tier: observation.tier,
    output: {
      tier: observation.tier,
      via: observation.via,
      count: observation.items.length,
      items: observation.items,
    },
  };
}

const applicationsDiscover: Executor = {
  capabilityId: 'desktop.applications.discover',
  async run(invocation: Invocation): Promise<ExecutorResult> {
    // `ids` narrows the sweep, and narrowing is the user's lever on how
    // sensitive the answer is — so it is passed through rather than
    // being treated as an optimisation the executor may ignore.
    const ids = strings(invocation.input.ids);
    const scan = await scanApplications(ids);
    const found = scan.applications.filter((a) => a.present).length;
    return {
      ok: true,
      effectStarted: false,
      // The sensitivity the scan REACHED is in the headline, not buried
      // in the payload. A caller that asked for an inventory and swept a
      // confidential entry has to be told in the sentence it will read.
      detail:
        `${found} of ${scan.applications.length} known applications are installed on this ${scan.platform ?? 'unrecognised'} machine. ` +
        `This scan reached ${scan.sensitivity}-sensitivity observations.` +
        (scan.undetectableCount
          ? ` ${scan.undetectableCount} could not be detected on this platform at all and are reported as such rather than as absent.`
          : ''),
      output: scan,
    };
  },
};

const accessibilityObserve: Executor = {
  capabilityId: 'desktop.accessibility.observe',
  run: () => observeThrough(accessibilityDriver),
};

const windowsObserve: Executor = {
  capabilityId: 'desktop.windows.observe',
  run: () => observeThrough(guiDriver),
};

export const desktopExecutors: Executor[] = [
  applicationsDiscover,
  accessibilityObserve,
  windowsObserve,
];
