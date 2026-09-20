import { describe, expect, it } from 'vitest';
import { decisionTarget } from './approvalRouting';

describe('decisionTarget', () => {
  it('routes fabric items to the fabric ledger', () => {
    expect(decisionTarget({ id: 'a1', source: 'fabric' })).toEqual({ kind: 'fabric' });
  });

  it('routes agent items with a session to that session', () => {
    expect(decisionTarget({ id: 'a2', source: 'agent', sessionId: 'ses-9' })).toEqual({
      kind: 'agent',
      sessionId: 'ses-9',
    });
  });

  it('refuses agent items with no session instead of guessing one', () => {
    for (const item of [
      { id: 'a3', source: 'agent' as const },
      { id: 'a4', source: 'agent' as const, sessionId: '' },
      { id: 'a5', source: 'agent' as const, sessionId: 42 as unknown as string },
    ]) {
      const target = decisionTarget(item);
      expect(target.kind).toBe('unroutable');
      if (target.kind === 'unroutable') expect(target.reason).toContain(item.id);
    }
  });
});
