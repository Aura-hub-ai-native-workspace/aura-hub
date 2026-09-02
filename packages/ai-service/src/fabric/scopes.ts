/**
 * scopes — what an in-flight run is allowed to ask for.
 * ==================================================================
 * The Fabric asks its host one question before policy runs: *what may
 * this actor do?* Until now the answer was a constant — read, write and
 * execute, for every caller, always. That was defensible when the only
 * callers were missions a human had already approved, and it is not
 * defensible once a workflow definition (importable, AI-generated,
 * webhook-triggered) can be the caller.
 *
 * This module holds the per-run answer. It is a **narrowing** mechanism
 * and only a narrowing mechanism:
 *
 *   • It can take capability away from a run. It can never add any — the
 *     ceiling is still `LOCAL_GRANTS`, and a scope not in the ceiling is
 *     not grantable here.
 *   • It decides nothing about risk, approval or floors. A narrowed grant
 *     produces a `permission-denied` from the EXISTING policy engine; no
 *     new decision path is introduced.
 *   • It is keyed by `runId`, registered when a run starts and removed
 *     when it ends, so a grant cannot outlive the run that earned it.
 *
 * The scopes come from the run's authority envelope, which is computed
 * from the node types actually present in the executing VERSION. So a
 * workflow with no shell node cannot run a command, even if something
 * later in the run tried to — the graph the human reviewed is the graph
 * that bounds it.
 */

import type { PermissionScope } from '@aura/capability-fabric';

export interface Grants {
  read: boolean;
  write: boolean;
  execute: boolean;
  autonomous: boolean;
}

/**
 * The ceiling. AURA is a single-user desktop app and the service already
 * runs with the user's own privileges, so read, write and execute are
 * genuinely available; `autonomous` stays false because the policy engine
 * decides what runs unattended and must not be pre-empted here.
 */
export const LOCAL_GRANTS: Grants = { read: true, write: true, execute: true, autonomous: false };

/**
 * Which coarse flag each scope needs. Mirrors `grantsFor()` in
 * `policy.ts` — the mapping is stated there and read here rather than
 * being invented, so the two cannot drift into disagreeing about what
 * "write" means.
 *
 * `account.authorize`, `resource.destroy` and `system.modify` are absent
 * on purpose: no flag grants them, at any level, and the human-only
 * floors in the policy engine are what satisfy them.
 */
const FLAG_FOR_SCOPE: Partial<Record<PermissionScope, keyof Grants>> = {
  'project.read': 'read',
  'aura.read': 'read',
  'project.write': 'write',
  'aura.write': 'write',
  'process.execute': 'execute',
  'network.outbound': 'execute',
};

/** Narrow the ceiling to exactly the flags a set of scopes needs. */
export function grantsForScopes(scopes: PermissionScope[]): Grants {
  const out: Grants = { read: false, write: false, execute: false, autonomous: false };
  for (const scope of scopes) {
    const flag = FLAG_FOR_SCOPE[scope];
    if (!flag) continue;
    // `&&` with the ceiling, so this can only ever subtract.
    if (LOCAL_GRANTS[flag]) out[flag] = true;
  }
  return out;
}

/**
 * Live per-run grants.
 *
 * A `Map` rather than anything persisted: a scope that survived a restart
 * would be a standing permission for a run that is no longer executing,
 * which is precisely the mistake the Fabric already refuses to make with
 * unspent approvals.
 */
export class RunScopeRegistry {
  private readonly byRun = new Map<string, Grants>();

  register(runId: string, scopes: PermissionScope[]): Grants {
    const grants = grantsForScopes(scopes);
    this.byRun.set(runId, grants);
    return grants;
  }

  release(runId: string): void {
    this.byRun.delete(runId);
  }

  /**
   * Grants for an invocation.
   *
   * A call carrying a `runId` with no registration is NOT given the
   * ceiling. An unregistered run is one nobody computed an envelope for,
   * and the safe reading of "I do not know what this is allowed to do" is
   * "nothing", not "everything".
   */
  forRun(runId: string | undefined): Grants | null {
    if (!runId) return null;
    return this.byRun.get(runId) ?? { read: false, write: false, execute: false, autonomous: false };
  }

  active(): number {
    return this.byRun.size;
  }
}
