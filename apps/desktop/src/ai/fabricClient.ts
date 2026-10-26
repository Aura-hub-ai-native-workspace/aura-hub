import { backendFetch } from '../backend/backendSession';
/**
 * fabricClient — the Capability Fabric's governance surface.
 * ------------------------------------------------------------------
 * Same shape as `missionClient` / `diagnosisClient`: thin fetch wrappers
 * over the service, no state of its own.
 *
 * The important property of this file is what it *cannot* say. There is
 * no way to send a capability grant
 * request id and an answer, and the service looks the capability up from
 * the request it stored. A compromised or hand-crafted client can
 * therefore replay a decision, but it can never invent an authorization
 * for something the Fabric did not itself decide to ask about.
 *
 * `invokeAsUser` does not weaken that. It sends no grant either — it
 * presents this boot's UI token, which says *where the call came from*,
 * not *what may be done*. The service alone decides what that channel is
 * worth, and policy still evaluates every floor: a direct action is
 * exempt from the one gate that exists to ask the user, and from nothing
 * else. See `uiToken.ts` and `policy.ts`.
 */
import { aiClient } from './aiClient';
import { userActionHeaders } from './uiToken';

const BASE = aiClient.base;

export type RiskLevel = 'low' | 'medium' | 'high';
export type PolicyDecision = 'auto-execute' | 'deny';

/* ── Mission capability annotation ────────────────────────────────── */

/** One task's capability projection. Mirrors `CapabilityBinding`. */
export interface CapabilityBinding {
  taskId: string;
  requires: string[];
  rationale: string;
  risk: RiskLevel;
  unsupported: string[];
}

/** A required capability with nothing behind it. Mirrors `CapabilityGap`. */
export interface CapabilityGap {
  capabilityId: string;
  reason: string;
  taskIds: string[];
}

/**
 * The additive annotation over a finished plan. Derived on demand by the
 * service and never persisted onto the `MissionRecord` — which is exactly
 * why this is a read, not a second store.
 */
export interface MissionCapabilityAnnotation {
  assumptions: string[];
  openQuestions: string[];
  requiredCapabilities: string[];
  bindings: CapabilityBinding[];
  gaps: CapabilityGap[];
}

/* ── system.install (§25) ─────────────────────────────────────────── */

/**
 * The four outcomes an install can honestly report.
 *
 * `guided` means **AURA executed nothing** — it is a handoff, not a
 * failure, and any surface showing it must say so. The outer
 * `InvocationResult.ok` is `false` for everything except `installed`
 * (§25.1), so UI branches on THIS field and never on `ok`.
 */
export type InstallOutcome = 'installed' | 'guided' | 'failed' | 'unverified';

export interface InstallResultView {
  installOutcome: InstallOutcome;
  nodeId: string;
  privilege: 'user' | 'root';
  requiresUserAction: boolean;
  /** Guided only: exactly what the user should run. Never run by AURA. */
  command?: string;
  why?: string;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  probe?: { present: boolean; version?: string; detail: string };
}

export type UninstallOutcome = 'uninstalled' | 'guided' | 'failed' | 'unverified';

export interface UninstallResultView {
  uninstallOutcome: UninstallOutcome;
  nodeId: string;
  privilege: 'user' | 'root';
  requiresUserAction: boolean;
  command?: string;
  why?: string;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  probe?: { present: boolean; version?: string; detail: string };
}

/** What `/fabric/invoke` returns. Only the fields this app reads. */
export interface InvocationResultView {
  invocationId: string;
  outcome: 'succeeded' | 'failed' | 'denied' | 'unsupported';
  detail: string;
  output?: unknown;
  policy?: { decision: PolicyDecision; rule: string; risk: RiskLevel; reason: string };
}

/**
 * Parse a Fabric JSON body without ever throwing transport noise as data.
 *
 * An unreadable body (proxy HTML, empty reset) becomes a thrown Error with
 * the HTTP status, which every caller already catches. Accepted statuses
 * (notably decide's 409 "already decided") return their bodies untouched —
 * the callers that understand those shapes keep owning them.
 */
async function readJson<T>(res: Response, what: string, acceptStatuses: number[] = []): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${what} failed: the service answered ${res.status} with no readable body.`);
  }
  if (!res.ok && !acceptStatuses.includes(res.status)) {
    const detail =
      body && typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : null;
    throw new Error(detail ?? `${what} failed (${res.status}).`);
  }
  return body as T;
}

/**
 * One capability as the *running service* describes it. Only the fields
 * the desktop actually reads are typed here — notably
 * `requiresNodeCapability`, which is the sole real link between a Fabric
 * capability and a Connected Environment node.
 */
export interface CapabilityDescriptorView {
  id: string;
  name: string;
  risk: RiskLevel;
  supported: boolean;
  requiresNodeCapability?: string;
  /**
   * The rest of the descriptor as the service sends it. `/fabric/capabilities`
   * spreads the whole `CapabilityDescriptor` (`{ ...c, supported }`), so these
   * are on the wire already — they are typed here because the Permission
   * Envelope reads them, and reading them from the service is what keeps the
   * service authoritative about risk rather than the renderer.
   */
  description?: string;
  category?: string;
  surface?: 'aura-internal' | 'local-process' | 'http' | 'browser';
  permissions?: PermissionScope[];
  irreversible?: boolean;
  output?: string;
  verify?: 'read-back' | 'exit-code' | 'http-status' | null;
}

/** Coarse permission scopes, as declared by the service's manifest. */
export type PermissionScope =
  | 'project.read'
  | 'project.write'
  | 'process.execute'
  | 'network.outbound'
  | 'account.authorize'
  | 'resource.destroy'
  | 'system.modify'
  | 'aura.read'
  | 'aura.write';

export interface CapabilityCatalogue {
  capabilities: CapabilityDescriptorView[];
  supportedCount: number;
  providedNodeCapabilities: string[];
  policy: PolicyConfig;
}

export interface PolicyConfig {
  byRisk: Record<RiskLevel, PolicyDecision>;
  overrides: Record<string, PolicyDecision>;
  /**
   * Per-node rules, keyed `"@<nodeId>"` or `"<capabilityId>@<nodeId>"`.
   * Deny-only in effect: these can exclude a node, never lower what
   * acting through it costs.
   */
  nodeOverrides?: Record<string, PolicyDecision>;
  /** capability id → node ids permitted to perform it. */
  nodeAllowlists?: Record<string, string[]>;
  allowAutonomous: boolean;
}

export const fabricClient = {
  /**
   * Run a capability through the Fabric.
   *
   * Carries no authority of its own: the service decides policy and records
   * the audit. A call the policy refuses comes back refused, at once.
   */
  invoke: (
    capabilityId: string,
    input: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ): Promise<InvocationResultView> =>
    backendFetch(`${BASE}/fabric/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilityId, input, context }),
    }).then((r) => readJson(r, 'Running capability')),

  /**
   * Run a capability *because the user just asked for it here*.
   *
   * Use this only from a control the person actually clicked, where the
   * label said what would happen. It is a separate method rather than a
   * flag on `invoke` so that reaching for it is a deliberate act that
   * shows up in review — an agent-driven path calling this would be a
   * visible mistake, not a silently passed `true`.
   *
   * The extra header is the whole difference. Everything else — policy,
   * floors, node routing, verification, audit — runs exactly as it does
   * for `invoke`.
   */
  invokeAsUser: async (
    capabilityId: string,
    input: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ): Promise<InvocationResultView> => {
    const res = await backendFetch(`${BASE}/fabric/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await userActionHeaders()) },
      body: JSON.stringify({ capabilityId, input, context }),
    });
    return readJson(res, 'Running capability');
  },

  policy: (): Promise<{ policy: PolicyConfig }> =>
    backendFetch(`${BASE}/fabric/capabilities`).then((r) => readJson(r, 'Reading policy')),

  /**
   * The full manifest as the running service holds it, including each
   * capability's `requiresNodeCapability`.
   *
   * Read over HTTP rather than by importing `@aura/capability-fabric`:
   * the desktop has never depended on that package, and a compile-time
   * copy of the manifest could disagree with the service actually
   * answering — which is exactly the kind of confident-but-wrong state
   * this architecture avoids.
   */
  capabilities: (): Promise<CapabilityCatalogue> =>
    backendFetch(`${BASE}/fabric/capabilities`).then((r) => readJson(r, 'Capability catalogue')),

  setPolicy: (patch: Partial<PolicyConfig>): Promise<{ policy: PolicyConfig; file: string }> =>
    backendFetch(`${BASE}/fabric/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => readJson(r, 'Saving policy')),

  audit: (): Promise<{ audit: unknown[] }> =>
    backendFetch(`${BASE}/fabric/audit`).then((r) => readJson(r, 'Reading audit')),

  /**
   * What a planned mission will actually need, and what is missing.
   *
   * This route already existed and had no client: the service computes it
   * with `annotateMissionCapabilities()` over the stored plan. Reading it
   * is how the Hub can say "Docker is required but isn't installed"
   * without inferring anything of its own.
   */
  missionCapabilities: (
    projectId: string,
    missionId: string,
  ): Promise<MissionCapabilityAnnotation | { error: string }> =>
    backendFetch(`${BASE}/fabric/mission/${projectId}/${missionId}`).then((r) => readJson(r, 'Reading mission capabilities')),
};
