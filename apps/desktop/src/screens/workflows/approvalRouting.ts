import type { ApprovalRequest } from '../../ai/fabricClient';

/** Where one inbox item's decision must go. */
export type DecisionTarget =
  | { kind: 'fabric' }
  | { kind: 'agent'; sessionId: string }
  | { kind: 'unroutable'; reason: string };

/**
 * Route an approval decision without guessing.
 *
 * Fabric items go through the Fabric ledger. Agent items go through the
 * owning session's approve endpoint — which requires that session's id.
 * An agent item with no session id is unroutable: answering it against a
 * hardcoded session (or any other session) would spend another session's
 * grant, so it is refused with a reason instead.
 */
export function decisionTarget(a: Pick<ApprovalRequest, 'id'> & { source: 'fabric' | 'agent'; sessionId?: unknown }): DecisionTarget {
  if (a.source === 'fabric') return { kind: 'fabric' };
  if (typeof a.sessionId === 'string' && a.sessionId) return { kind: 'agent', sessionId: a.sessionId };
  return {
    kind: 'unroutable',
    reason: `Approval ${a.id} has no owning session, so it cannot be decided here. Open the session that raised it.`,
  };
}
