/**
 * fabricClient — the Capability Fabric's governance surface.
 * ------------------------------------------------------------------
 * Same shape as `missionClient` / `diagnosisClient`: thin fetch wrappers
 * over the service, no state of its own.
 *
 * The important property of this file is what it *cannot* say. There is
 * no way to send a capability grant: `decide()` names an approval
 * request id and an answer, and the service looks the capability up from
 * the request it stored. A compromised or hand-crafted client can
 * therefore replay a decision, but it can never invent an authorization
 * for something the Fabric did not itself decide to ask about.
 */
import { aiClient } from './aiClient';

const BASE = aiClient.base;

export type RiskLevel = 'low' | 'medium' | 'high';
export type PolicyDecision = 'auto-execute' | 'ask-user' | 'require-approval' | 'deny';
export type ApprovalState = 'pending' | 'granted' | 'denied' | 'expired';

export interface ApprovalItem {
  invocationId: string;
  capabilityId: string;
  title: string;
  detail: string;
  risk: RiskLevel;
  irreversible: boolean;
}

/** Mirrors the service's `ApprovalRequest`. Read-only on this side. */
export interface ApprovalRequest {
  id: string;
  state: ApprovalState;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  consumedAt?: string;
  summary: string;
  items: ApprovalItem[];
  projectId?: string;
  missionId?: string;
  taskId?: string;
  rule?: string;
  onAccept?: string;
  onDecline?: string;
  target?: string;
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
}

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

export interface DecideResult {
  approval?: ApprovalRequest;
  resumed?: boolean;
  declined?: boolean;
  ok?: boolean;
  error?: string;
  detail?: string;
}

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

export const fabricClient = {
  approvals: (): Promise<{ approvals: ApprovalRequest[] }> =>
    fetch(`${BASE}/fabric/approvals`).then((r) => r.json()),

  /**
   * Answer one request. `granted` is the whole decision — the capability,
   * the mission and the task all come from the stored request.
   *
   * A 409 means it was already decided (another tab, a double-click, a
   * replayed request). That is a successful outcome for the user, not an
   * error to retry: the answer they wanted is already recorded.
   */
  decide: (id: string, granted: boolean, reason?: string): Promise<DecideResult> =>
    fetch(`${BASE}/fabric/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted, reason }),
    }).then((r) => r.json()),

  policy: (): Promise<{ policy: PolicyConfig }> =>
    fetch(`${BASE}/fabric/capabilities`).then((r) => r.json()),

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
    fetch(`${BASE}/fabric/capabilities`).then(async (r) => {
      if (!r.ok) throw new Error(`Capability catalogue failed (${r.status})`);
      return r.json();
    }),

  setPolicy: (patch: Partial<PolicyConfig>): Promise<{ policy: PolicyConfig; file: string }> =>
    fetch(`${BASE}/fabric/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => r.json()),

  audit: (): Promise<{ audit: unknown[] }> =>
    fetch(`${BASE}/fabric/audit`).then((r) => r.json()),

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
    fetch(`${BASE}/fabric/mission/${projectId}/${missionId}`).then((r) => r.json()),
};
