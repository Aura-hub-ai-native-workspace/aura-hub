import type { ApprovalRequest, ApprovalState, RiskLevel } from './fabricClient';

/**
 * agentApprovals — read the Central Agent's own ledger into the gate.
 *
 * Agent-parked approvals live on :4320 (the agent ledger), not on the
 * workflow service's :4319 Fabric ledger. Resolving a parked id through
 * the wrong ledger leaves the gate on "Loading the authorization
 * details…" forever, with a working Approve path underneath that the
 * user can never reach.
 *
 * The mapper below is validation, not invention: a row missing the
 * fields the gate renders (id, requestedAt, summary, one item naming
 * a capability) resolves to null and the gate stays hidden — exactly
 * like an unknown id. An unknown state or risk also resolves to null:
 * this is an authorization surface, so version skew fails closed
 * rather than rendering a gate with a guessed label. `invocationId`
 * falls back to the approval id as a display join key; nothing
 * rendered or decided uses it (the decision path names the approval
 * id and the session id, never this key).
 */

export interface AgentApprovalItem {
  invocationId?: string;
  capabilityId: string;
  title?: string;
  detail?: string;
  risk?: string;
  irreversible?: boolean;
}

export interface AgentApprovalRow {
  id: string;
  state: string;
  summary: string;
  requestedAt?: string;
  target?: string;
  onAccept?: string;
  onDecline?: string;
  rule?: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  missionId?: string;
  items?: AgentApprovalItem[];
}

const STATES: ApprovalState[] = ['pending', 'granted', 'denied', 'expired'];
const RISKS: RiskLevel[] = ['low', 'medium', 'high'];

export function agentApprovalToRequest(row: AgentApprovalRow): ApprovalRequest | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  if (typeof row.requestedAt !== 'string' || typeof row.summary !== 'string') return null;
  if (!Array.isArray(row.items) || row.items.length === 0) return null;
  const first = row.items[0];
  if (!first || typeof first.capabilityId !== 'string' || !first.capabilityId) return null;
  if (!(STATES as string[]).includes(row.state)) return null;
  for (const it of row.items) {
    if (typeof it.capabilityId !== 'string' || !it.capabilityId) return null;
    if (!(RISKS as string[]).includes(it.risk ?? '')) return null;
  }
  return {
    id: row.id,
    state: row.state as ApprovalState,
    requestedAt: row.requestedAt,
    summary: row.summary,
    items: row.items.map((it) => ({
      invocationId: typeof it.invocationId === 'string' && it.invocationId ? it.invocationId : row.id,
      capabilityId: it.capabilityId,
      title: typeof it.title === 'string' ? it.title : '',
      detail: typeof it.detail === 'string' ? it.detail : '',
      risk: it.risk as RiskLevel,
      irreversible: it.irreversible === true,
    })),
    target: row.target,
    onAccept: row.onAccept,
    onDecline: row.onDecline,
    rule: row.rule,
    sessionId: row.sessionId,
    projectId: row.projectId,
    taskId: row.taskId,
    missionId: row.missionId,
  };
}
