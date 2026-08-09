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

export interface PolicyConfig {
  byRisk: Record<RiskLevel, PolicyDecision>;
  overrides: Record<string, PolicyDecision>;
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

  setPolicy: (patch: Partial<PolicyConfig>): Promise<{ policy: PolicyConfig; file: string }> =>
    fetch(`${BASE}/fabric/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => r.json()),

  audit: (): Promise<{ audit: unknown[] }> =>
    fetch(`${BASE}/fabric/audit`).then((r) => r.json()),
};
