import { describe, expect, it } from 'vitest';
import { sourcesFromContext, type AgentChatMessage } from './useAgentConversations';

const msg = (sources: { id: number; title: string; url: string }[]): AgentChatMessage => ({
  id: 'm', role: 'assistant', content: 'x', status: 'done',
  agent: { sessionId: 's', outcome: 'completed', requestId: null, progress: [], events: [], plan: null, performed: [], verified: [], evidenceSummary: null, runId: null, needsInput: false, cancelled: false, tools: [], sources },
});

describe('sources that travel with a plan', () => {
  it('collects real web sources once each, across the conversation', () => {
    const out = sourcesFromContext([
      msg([{ id: 1, title: 'A', url: 'https://a.test/x' }, { id: 2, title: 'B', url: 'https://b.test/y' }]),
      msg([{ id: 1, title: 'A again', url: 'https://a.test/x' }]),
    ]);
    expect(out).toEqual([{ title: 'A', url: 'https://a.test/x' }, { title: 'B', url: 'https://b.test/y' }]);
  });
  it('never forwards a non-web url as a source', () => {
    expect(sourcesFromContext([msg([{ id: 1, title: 'local', url: 'file:///etc/passwd' }, { id: 2, title: 'js', url: 'javascript:alert(1)' }])])).toEqual([]);
  });
  it('is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `S${i}`, url: `https://s${i}.test/` }));
    expect(sourcesFromContext([msg(many)])).toHaveLength(12);
  });
});
