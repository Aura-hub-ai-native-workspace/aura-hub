/**
 * approvalStore — pending authorization requests, on disk.
 * ==================================================================
 * Same shape as `policyStore.ts`, and the same mechanism `MissionStore`
 * and `workflow/store.ts` already use: the shared config home plus an
 * atomic write-then-rename. No new database, no second persistence
 * system — an approval is a small, short-lived record and a JSON file is
 * the honest size of the problem.
 *
 *   ~/.aura/fabric-approvals.json      (AURA_HOME aware)
 *
 * Only *pending* requests are ever written. The Fabric refuses to
 * restore anything else on load, so an unspent grant cannot survive a
 * restart and silently authorize an action later — the task asks again
 * instead. Decided requests are already in the audit trail.
 */

import type { ApprovalPersistence, ApprovalRequest } from '@aura/capability-fabric';
import { homePath, readJsonFile, writeJsonFile } from '../persist';

const FILE = () => homePath('fabric-approvals.json');

/** Drop anything that is not a usable pending request. */
function usable(value: unknown): value is ApprovalRequest {
  const r = value as ApprovalRequest | null;
  return Boolean(
    r && typeof r.id === 'string' && r.id
    && r.state === 'pending'
    && Array.isArray(r.items) && r.items.length > 0
    && typeof r.items[0]?.capabilityId === 'string',
  );
}

export function createApprovalStore(): ApprovalPersistence {
  return {
    load() {
      const raw = readJsonFile<unknown[]>(FILE(), []);
      return Array.isArray(raw) ? raw.filter(usable) : [];
    },
    save(requests) {
      writeJsonFile(FILE(), requests.filter(usable));
    },
  };
}

export function approvalFilePath(): string {
  return FILE();
}
