/**
 * The driver registry - which driver actuates a capability, at which tier.
 * ==================================================================
 * The node catalogue (`@aura/connected-environment`'s `CATALOG`) remains
 * the single answer to "what is this machine, and what can it do". It is
 * not extended here, and nothing here can add a node to it. Invariant 5
 * stands: one catalogue.
 *
 * What was missing is one level down. The catalogue says a node PROVIDES
 * a capability; it never said WHO WOULD DRIVE IT or HOW DIRECTLY. Before
 * MCP that gap was invisible, because every driver was bespoke and lived
 * next to its executor. With MCP it becomes the central question: one
 * driver implementation yields every server the ecosystem produces, each
 * arriving with its own schemas, and each of those is an actuation path
 * that has to be attributable.
 *
 * So: `(capabilityId, nodeId) -> driver`, with the tier on the driver.
 *
 * -- MCP is the default, bespoke is the exception ---------------------
 * A bespoke driver is a permanent maintenance cost that buys reach into
 * exactly one system. An MCP driver is written once and reaches every
 * server anyone publishes. Bespoke drivers are therefore reserved for
 * what MCP cannot reach: the local process surface, the filesystem, git,
 * and the browser, all of which need a governed primitive that a remote
 * protocol has no business owning.
 *
 * -- The substitution rule --------------------------------------------
 * `resolve()` will never hand back a driver at a HIGHER tier than the
 * caller asked for. Being unable to reach something over its API is not
 * permission to start clicking at coordinates; it is a fact to report.
 * A caller that genuinely wants the lower-fidelity path asks for it
 * explicitly, and the tier it gets is the tier the journal records and
 * the user approves.
 */

import type { ActuationTier } from './tier';
import { TIER_ID, substitutionIsSilent } from './tier';

/**
 * A driver is the thing that actually performs a capability. It is
 * deliberately NOT an `Executor`: an executor is registered against one
 * capability id and is the Fabric's own interface, while a driver is an
 * actuation path that may serve many capabilities on many nodes.
 */
export interface CapabilityDriver {
  /** Stable id: 'mcp:filesystem', 'cdp', 'git-cli'. */
  id: string;
  tier: ActuationTier;
  /** Node ids this driver can drive. '*' means node-independent. */
  nodes: readonly string[];
  /** Capability ids it can actuate. '*' means "whatever it advertises". */
  capabilities: readonly string[];
  /**
   * Whether the driver can run RIGHT NOW. Probed, never assumed: a
   * driver that reports available and then cannot run turns a governance
   * decision into a runtime surprise.
   */
  available(): Promise<{ ok: boolean; detail: string }>;
}

/** Why a resolution failed, in the caller's language. */
export type DriverResolutionFailure =
  | { code: 'no-driver'; reason: string }
  | { code: 'tier-substitution-refused'; reason: string; wanted: ActuationTier; offered: ActuationTier };

export type DriverResolution =
  | { ok: true; driver: CapabilityDriver }
  | ({ ok: false } & DriverResolutionFailure);

export class DriverRegistry {
  private readonly drivers: CapabilityDriver[] = [];

  register(driver: CapabilityDriver): void {
    const clash = this.drivers.find((d) => d.id === driver.id);
    if (clash) {
      throw new Error(`Driver id "${driver.id}" is already registered. Driver ids identify an actuation path in the journal, so two paths cannot share one.`);
    }
    this.drivers.push(driver);
  }

  list(): readonly CapabilityDriver[] {
    return this.drivers;
  }

  /** Every driver that could actuate this capability, most direct first. */
  candidates(capabilityId: string, nodeId?: string): CapabilityDriver[] {
    return this.drivers
      .filter((d) => d.capabilities.includes('*') || d.capabilities.includes(capabilityId))
      .filter((d) => !nodeId || d.nodes.includes('*') || d.nodes.includes(nodeId))
      .sort((a, b) => a.tier - b.tier);
  }

  /**
   * Resolve one driver.
   *
   * `maxTier` is the caller's declared ceiling: the least direct path it
   * is willing to accept. Absent, it means tier 3 - AURA will use an
   * API, a CLI or a local protocol without asking, and will not reach for
   * a browser, the accessibility tree or synthetic input unless somebody
   * decided that it should.
   */
  resolve(capabilityId: string, opts: { nodeId?: string; maxTier?: ActuationTier } = {}): DriverResolution {
    const ceiling: ActuationTier = opts.maxTier ?? 3;
    const all = this.candidates(capabilityId, opts.nodeId);

    if (all.length === 0) {
      return {
        ok: false, code: 'no-driver',
        reason: `Nothing is registered to actuate ${capabilityId}${opts.nodeId ? ` on ${opts.nodeId}` : ''}. This is a gap, not a failure - no substitute was attempted.`,
      };
    }

    const within = all.filter((d) => !substitutionIsSilent(ceiling, d.tier));
    if (within.length === 0) {
      const offered = all[0];
      return {
        ok: false, code: 'tier-substitution-refused',
        wanted: ceiling, offered: offered.tier,
        reason:
          `${capabilityId} can only be actuated through ${TIER_ID[offered.tier]} (tier ${offered.tier}), ` +
          `and this call allows at most ${TIER_ID[ceiling]} (tier ${ceiling}). ` +
          `A lower-fidelity path is a different action with different failure modes, so it was not substituted. ` +
          `Re-request with maxTier ${offered.tier} if that is what you meant.`,
      };
    }

    return { ok: true, driver: within[0] };
  }
}
