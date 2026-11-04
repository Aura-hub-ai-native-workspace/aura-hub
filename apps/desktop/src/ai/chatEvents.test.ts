import { describe, expect, it } from 'vitest';
import type { AgentEventFrame } from './centralAgentClient';
import { EMPTY_TURN, foldChatEvent, linkCitations, type LiveTurn } from './chatEvents';

const frame = (type: string, payload: Record<string, unknown> = {}): AgentEventFrame =>
  ({ type, at: 't', sessionId: 'agt-1', payload, seq: 1 } as unknown as AgentEventFrame);
const run = (frames: AgentEventFrame[]): LiveTurn => frames.reduce(foldChatEvent, EMPTY_TURN);

describe('foldChatEvent', () => {
  it('shows the real pipeline as it happens and streams the answer token by token', () => {
    const turn = run([
      frame('intent.classified', { intent: 'research-question' }),
      frame('context.retrieved', { records: 3, scope: 'general' }),
      frame('research.started', { reason: 'a simple question: a light lookup' }),
      frame('research.sources', { sources: [{ id: 1, title: 'A', url: 'https://a.test' }] }),
      frame('research.completed', { status: 'ok', count: 1 }),
      frame('model.invoked', { providers: [{ id: 'ollama-local', model: 'qwen2.5-coder:1.5b' }] }),
      frame('answer.token', { text: 'It is ' }),
      frame('answer.token', { text: 'a guide [1].' }),
      frame('answer.citations', { cited: [1] }),
    ]);
    expect(turn.steps.map((s) => s.label)).toEqual([
      'Understood as a question that needs research', 'Read 3 saved notes on this conversation',
      'Found 1 source', 'Asking qwen2.5-coder:1.5b']);
    expect(turn.answer).toBe('It is a guide [1].');
    expect(turn.sources).toHaveLength(1);
    expect(turn.cited).toEqual([1]);
  });

  it('reports unavailable research with the reason, and no sources', () => {
    const turn = run([frame('research.started', {}),
      frame('research.completed', { status: 'unavailable', count: 0, kind: 'not-configured', detail: 'No gateway' })]);
    expect(turn.research).toMatchObject({ status: 'unavailable', kind: 'not-configured' });
    expect(turn.steps.at(-1)).toMatchObject({ tone: 'warn', label: 'Web research unavailable — no search gateway is configured' });
    expect(turn.sources).toEqual([]);
  });

  it('says plainly when no reasoning model exists', () => {
    const turn = run([frame('model.invoked', { providers: [] })]);
    expect(turn.steps[0]).toMatchObject({ label: 'No reasoning model is configured', tone: 'warn' });
  });

  it('records a failure and ignores events it does not know', () => {
    const turn = run([frame('something.else', { x: 1 }), frame('answer.failed', { reason: 'timed out' })]);
    expect(turn.failed).toBe('timed out');
    expect(turn.steps).toEqual([]);
  });
});

describe('linkCitations', () => {
  const sources = [{ id: 1, url: 'https://a.test/x' }, { id: 2, url: 'https://b.test' }];
  it('links only markers that point at a real source', () => {
    expect(linkCitations('A [1] and B [2], but [3] is invented.', sources))
      .toBe('A [1](https://a.test/x) and B [2](https://b.test), but [3] is invented.');
  });
  it('does not double-link and leaves ordinary brackets alone', () => {
    expect(linkCitations('See [1](https://a.test/x) and arr[0] and [12].', sources))
      .toBe('See [1](https://a.test/x) and arr[0] and [12].');
  });
});
