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
