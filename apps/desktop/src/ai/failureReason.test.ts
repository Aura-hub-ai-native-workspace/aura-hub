import { describe, expect, it } from 'vitest';
import { metaWithReason, reasonFromMeta, sanitizeFailureReason } from './failureReason';

describe('a failed turn keeps its reason across a restart', () => {
  it('persists, serialises, reloads and shows the same specific reason', () => {
    const reason = 'The request could not be planned: model plan rejected: task t1 scopePaths must be a non-empty list';
    const stored = JSON.parse(JSON.stringify({ role: 'assistant', content: '', error: true, meta: metaWithReason(undefined, true, reason) }));
    expect(reasonFromMeta(stored.meta)).toBe(reason);          // not the generic message
  });

  it('keeps the agent meta and adds the reason beside it', () => {
    const meta = metaWithReason({ agent: { sessionId: 's1' } }, true, 'worker refused: billing policy') as { agent: { sessionId: string }; errorReason: string };
    expect(meta.agent.sessionId).toBe('s1');
    expect(meta.errorReason).toBe('worker refused: billing policy');
  });

  it('stores nothing for a message that did not fail, or failed with no reason', () => {
    expect(metaWithReason({ agent: 1 }, false, 'x')).toEqual({ agent: 1 });
    expect(metaWithReason(undefined, true, '   ')).toBeUndefined();
    expect(reasonFromMeta(undefined)).toBeUndefined();
    expect(reasonFromMeta({ errorReason: 7 })).toBeUndefined();
  });

  it.each([
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['request failed with api_key=sk-live-SECRET123456789', 'SECRET123456789'],
    ['token: ghp_abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'],
    ['fetch https://user:hunter2@example.com/x?key=ABCDEF failed', 'hunter2'],
    ['id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'eyJhbGci'],
    ['password=correct-horse-battery', 'correct-horse'],
  ])('never persists a secret: %s', (raw, leaked) => {
    const out = sanitizeFailureReason(raw);
    expect(out).not.toContain(leaked);
    expect(out).toContain('redacted');
  });

  it('keeps a task id and ordinary prose intact, collapses multi-line diagnostics, and bounds length', () => {
    expect(sanitizeFailureReason('task-mvg6d8e1-xw86rh failed: timed out after 180s')).toBe('task-mvg6d8e1-xw86rh failed: timed out after 180s');
    expect(sanitizeFailureReason('line one\n   at stack frame\nline three')).toBe('line one at stack frame line three');
    expect(sanitizeFailureReason('x'.repeat(5000)).length).toBeLessThanOrEqual(600);
  });
});
