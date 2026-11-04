import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupChat } from './GroupChat';
import type { TimelineItem } from '../../../ai/groupTimeline';

const items: TimelineItem[] = [
  { kind: 'user', id: 'u1', text: 'Build me a shop site', at: '' },
  { kind: 'ceo', id: 'c1', text: 'Next step: Carry out the requested change', status: 'done', error: null, at: '' },
  {
    kind: 'task', id: 't1', taskId: 'implement', sessionId: 's1', worker: 'OpenCode', capability: 'agent.delegate',
    brief: 'You are the implementer. Task: build the shop page.', state: 'running', verified: null, detail: null, at: '',
    lines: [{ stream: 'stdout', text: 'writing index.html' }, { stream: 'stderr', text: 'warning: slow' }],
  },
];

describe('GroupChat', () => {
  const html = renderToStaticMarkup(<GroupChat items={items} streaming status="OpenCode is working · 1 task in this request" />);

  it('puts the person on the right and the CEO and workers on the left', () => {
    expect(html).toContain('data-role="user"');
    expect(html).toMatch(/justify-end[^>]*data-role="user"|data-role="user"[^>]*justify-end|justify-end"[^>]*data-testid="chat-message"/);
    expect(html).toContain('AURA · CEO');
    expect(html).toContain('data-testid="task-card"');
  });

  it("shows the worker's name, the exact prompt sent to it and its live terminal", () => {
    expect(html).toContain('OpenCode');
    expect(html).toContain('Prompt sent to OpenCode');
    expect(html).toContain('You are the implementer. Task: build the shop page.');
    expect(html).toContain('data-testid="task-terminal"');
    expect(html).toContain('writing index.html');
    expect(html).toContain('warning: slow');
  });

  it('keeps a status line on screen while work runs', () => {
    expect(html).toContain('data-testid="group-status"');
    expect(html).toContain('OpenCode is working');
  });

  it('labels a step AURA runs itself by what it does, not as an agent', () => {
    const search: TimelineItem = {
      kind: 'task', id: 't2', taskId: 'research', sessionId: 's1', worker: null, capability: 'web.research',
      brief: 'Research the request', state: 'done', verified: true, detail: null, lines: [], at: '',
    };
    const out = renderToStaticMarkup(<GroupChat items={[search]} streaming={false} status="" />);
    expect(out).toContain('Web search');
    expect(out).toContain('What it does');
    expect(out).not.toContain('Prompt sent to');
  });

  it('shows no status line when nothing runs', () => {
    const idle = renderToStaticMarkup(<GroupChat items={items.slice(0, 2)} streaming={false} status="" />);
    expect(idle).not.toContain('data-testid="group-status"');
  });
});
