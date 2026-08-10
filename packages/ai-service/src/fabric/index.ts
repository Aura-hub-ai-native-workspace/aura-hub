/**
 * fabric — wiring the Capability Fabric to this service.
 * ==================================================================
 * Supplies the three host decisions the Fabric refuses to make for
 * itself: what the acting node may do, whether a provider exists, and
 * how a human is asked.
 *
 * Approval handling here is deliberately conservative. The service has
 * no UI, so it cannot ask anyone anything; an invocation that needs
 * authorization is therefore **parked, not performed**. The desktop
 * carries the approval UI and re-invokes with an explicit grant token.
 * A service that auto-granted its own approvals would make the entire
 * policy layer decorative.
 */

import {
  CapabilityFabric,
  type CapabilityDescriptor,
  type FabricHost,
  type InvocationContext,
  type NodeRef,
  type NodeResolution,
} from '@aura/capability-fabric';
import { allExecutors } from './executors';
import { loadPolicy } from './policyStore';
import { createApprovalStore } from './approvalStore';
import type { WorkspaceManager } from '../workspace';

/**
 * Grants for the local machine. AURA is a single-user desktop app and
 * the service already runs with the user's own privileges, so read,
 * write and execute are genuinely available. `autonomous` stays false:
 * the *policy* engine decides what runs unattended, and it should not be
 * pre-empted by a blanket grant here.
 */
const LOCAL_GRANTS = { read: true, write: true, execute: true, autonomous: false };

export interface FabricDeps {
  manager: WorkspaceManager;
  /**
   * Which node capabilities are currently provided. Read at decision
   * time (not construction time) so a node connected mid-session takes
   * effect immediately. When it yields nothing, node-backed capabilities
   * are denied with a connect suggestion rather than failing mid-run.
   */
  providedNodeCapabilities?: () => Set<string>;
  /**
   * Nodes present on this machine right now, in catalogue order.
   *
   * Same freshness and same source as `providedNodeCapabilities` — both
   * are projections of the last environment scan, built together. This is
   * not a second registry: the catalogue remains authoritative, and these
   * refs carry only what routing needs.
   */
  presentNodes?: () => NodeRef[];
}

/**
 * Route a capability to a node. §22.4.
 *
 * The rules, in order:
 *   1. No `requiresNodeCapability` → no node needed.
 *   2. `aura-internal` → runs inside AURA, no node needed.
 *   3. A node was REQUESTED → it must exist, be present, and provide the
 *      capability. Any failure denies. A requested node is never silently
 *      swapped for one that would have worked.
 *   4. Nothing requested → the first present provider in catalogue order.
 *      Deterministic and documented, never arbitrary.
 */
function resolveNodeFor(
  capability: CapabilityDescriptor,
  context: InvocationContext,
  present: NodeRef[],
  canUse?: (node: NodeRef) => boolean,
): NodeResolution {
  const needed = capability.requiresNodeCapability;
  if (!needed) return { ok: true };
  if (capability.surface === 'aura-internal') return { ok: true };

  const usable = (node: NodeRef) => (canUse ? canUse(node) : true);

  const requested = context.nodeId?.trim();
  if (requested) {
    const node = present.find((n) => n.id === requested);
    if (!node) {
      // Deliberately does not distinguish "never existed" from "not
      // running" here — both mean the caller cannot have what they asked
      // for, and the reason names the node so it is actionable.
      return {
        ok: false,
        code: 'unknown-node',
        reason: `'${requested}' is not a connected node on this machine. Connect it, or omit the node to let AURA choose.`,
      };
    }
    if (!node.capabilities.includes(needed)) {
      return {
        ok: false,
        code: 'node-lacks-capability',
        reason: `${node.name} does not provide ${needed}, which ${capability.name.toLowerCase()} needs.`,
      };
    }
    if (!usable(node)) {
      // Refused, not redirected. Substituting a different agent here is
      // exactly the silent behaviour routing exists to prevent.
      return {
        ok: false,
        code: 'node-unsupported',
        reason: `${node.name} provides ${needed}, but AURA has no verified way to drive it yet, so nothing was run.`,
      };
    }
    return { ok: true, node };
  }

  // Catalogue order, filtered to what the executor can actually drive.
  const node = present.find((n) => n.capabilities.includes(needed) && usable(n));
  if (!node) {
    const providers = present.filter((n) => n.capabilities.includes(needed));
    if (providers.length > 0) {
      return {
        ok: false,
        code: 'node-unsupported',
        reason: `${providers.map((p) => p.name).join(', ')} provide ${needed}, but AURA has no verified way to drive any of them yet.`,
      };
    }
    return {
      ok: false,
      code: 'no-provider',
      reason: `Nothing connected provides ${needed} yet. Connect a node that does and this becomes available.`,
    };
  }
  return { ok: true, node };
}

export function createFabric(deps: FabricDeps): CapabilityFabric {
  const host: FabricHost = {
    permissionsFor(_capability: CapabilityDescriptor, _context: InvocationContext) {
      return LOCAL_GRANTS;
    },

    nodeAvailable(capability: CapabilityDescriptor): boolean | null {
      if (!capability.requiresNodeCapability) return null;
      // Internal AURA capabilities never depend on an external node.
      if (capability.surface === 'aura-internal') return true;
      const provided = deps.providedNodeCapabilities?.();
      if (!provided) return false;
      return provided.has(capability.requiresNodeCapability);
    },

    resolveNode(
      capability: CapabilityDescriptor,
      context: InvocationContext,
      canUse?: (node: NodeRef) => boolean,
    ): NodeResolution {
      return resolveNodeFor(capability, context, deps.presentNodes?.() ?? [], canUse);
    },

    async requestApproval(request, context) {
      // Granted only if THIS call carried an explicit authorization for
      // every capability in the request. No UI here means no implicit yes,
      // and a grant never outlives the invocation that carried it.
      const approved = new Set(context.approvedCapabilities ?? []);
      return request.items.every((item) => approved.has(item.capabilityId));
    },
  };

  const fabric = new CapabilityFabric(host);
  for (const executor of allExecutors(deps.manager)) fabric.register(executor);
  // The operator's saved caution settings outlive the process. Loaded
  // through `sanitizePolicy`, so a corrupt file degrades to the shipped
  // default instead of loosening anything.
  fabric.setPolicy(loadPolicy());
  // Pending gates outlive the process too: a question asked before a
  // restart is still waiting for its answer afterwards, with the same id.
  fabric.attachApprovalStore(createApprovalStore());
  return fabric;
}
