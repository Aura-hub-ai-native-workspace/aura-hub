/**
 * decideAskAction — conversation answers directly; work needs a project; an
 * unknown routing answer never becomes a chat reply.
 */
import { describe, expect, it } from 'vitest';
import { decideAskAction } from './askAuraRouting';

describe('decideAskAction', () => {
  it('keeps the direct answer for conversation', () => {
    expect(decideAskAction({ route: 'conversation' }, null)).toEqual({ kind: 'stream' });
  });

  it('sends work to the mission pipeline with the active project folder', () => {
    expect(decideAskAction({ route: 'mission' }, '/tmp/aura-alpha-e2e')).toEqual({
      kind: 'mission', projectPath: '/tmp/aura-alpha-e2e',
    });
  });

  it('asks for a project before work when none is open', () => {
    expect(decideAskAction({ route: 'mission' }, null)).toEqual({ kind: 'needs-project' });
  });

  it('shows a clarification as a question, not an answer', () => {
    expect(decideAskAction({ route: 'clarify', question: 'Which file?' }, null)).toEqual({
      kind: 'clarify', question: 'Which file?',
    });
  });

  it('fails closed when the routing decision is unavailable', () => {
    expect(decideAskAction(null, '/tmp/aura-alpha-e2e')).toEqual({ kind: 'unavailable' });
  });

  it('treats an unrecognised route as unavailable, never as conversation', () => {
    expect(decideAskAction({ route: 'chat' as never }, null)).toEqual({ kind: 'unavailable' });
  });
});
