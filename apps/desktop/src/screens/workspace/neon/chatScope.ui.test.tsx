/**
 * Execution Chat UI — the workspace surface reads as a workspace.
 *
 * The pane is the workspace's chat, and its identity must be honest:
 * it says "Execution Chat", not the project discussion's name, and the
 * only bridge from the project discussion is the handoff inbox, which
 * renders ONLY offers that are still `created`.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo). A few
 * claims are held against the source itself, where a click matters.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';

import type { Handoff } from '../../../ai/aiClient';
import type { AgentActivity } from '../../../ai/useAgentConversations';
import { ConversationPane } from './ConversationPane';

const SOURCE = readFileSync(new URL('./ConversationPane.tsx', import.meta.url), 'utf8');

const IDLE: AgentActivity = { workers: {}, tools: [], phase: null, awaitingApproval: false };

function handoff(over: Partial<Handoff> = {}): Handoff {
  const now = new Date().toISOString();
  return {
    id: 'hnd_ui1', projectId: 'p1', sourceConversationId: 'conv_ui',
    sourceMessageIds: ['m1', 'm2'], title: 'Build the retry path',
    targetWorkspaceId: 'workspace:p1', status: 'created',
    createdAt: now, updatedAt: now, ...over,
  };
}

type PaneProps = ComponentProps<typeof ConversationPane>;

function pane(over: Partial<PaneProps> = {}) {
  const props: PaneProps = {
    messages: [],
    activity: IDLE,
    busy: false,
    agentUp: true,
    approvals: {},
    deciding: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRegenerate: vi.fn(),
    onDecide: vi.fn(),
    handoffs: [],
    onAcceptHandoff: vi.fn(),
    projectName: 'Retry Bot',
    ...over,
  };
  return <ConversationPane {...props} />;
}

const render = (over: Partial<PaneProps> = {}) => renderToStaticMarkup(pane(over));
const count = (markup: string, testid: string) => markup.split(`data-testid="${testid}"`).length - 1;

describe('Execution Chat identity', () => {
  it('announces itself as the workspace execution chat, not the project discussion', () => {
    const markup = render({ projectName: 'Retry Bot' });
    expect(markup).toContain('Execution Chat');
    expect(markup).toContain('Workspace execution in Retry Bot');
    expect(markup).toContain('aria-label="Workspace execution chat"');
    expect(count(markup, 'workspace-chat-title')).toBe(1);
    // The old shared headline must not come back.
    expect(markup).not.toContain('>AURA</h2>');
  });

  it('the empty state points execution at the workspace, and discussion back at Ask AURA', () => {
    const markup = render();
    expect(markup).toContain('Ready to execute.');
    // Static markup HTML-escapes the apostrophe, so assert the escaped form.
    expect(markup).toContain('plans and discussions live in the project&#x27;s Ask AURA');
  });

  it('keeps exactly one composer exit and one stop control in the source', () => {
    expect(SOURCE.match(/onSend\(trimmed\)/g)).toHaveLength(1);
    expect(SOURCE).toContain('data-testid="agent-submit"');
    expect(SOURCE).toContain('data-testid="agent-stop"');
  });

  it('shows the offline badge when the agent is down', () => {
    expect(render({ agentUp: false })).toContain('AURA is not running');
    expect(render({ agentUp: true })).not.toContain('AURA is not running');
  });
});

describe('handoff inbox', () => {
  it('renders a created handoff as an offer with an accept control', () => {
    const markup = render({ handoffs: [handoff()] });
    expect(count(markup, 'handoff-panel')).toBe(1);
    expect(count(markup, 'handoff-card')).toBe(1);
    expect(markup).toContain('Task received from Project Ask AURA');
    expect(markup).toContain('Build the retry path');
    expect(markup).toContain('Source: Ask AURA · 2 message(s)');
    expect(count(markup, 'handoff-accept')).toBe(1);
    expect(markup).toContain('Start execution');
  });

  it('hides the inbox when nothing is offered — decided handoffs leave it', () => {
    const markup = render({
      handoffs: [
        handoff({ id: 'hnd_a', status: 'accepted' }),
        handoff({ id: 'hnd_c', status: 'cancelled' }),
      ],
    });
    expect(markup).not.toContain('handoff-panel');
    expect(markup).not.toContain('Task received from Project Ask AURA');
  });

  it('the empty state yields to a handoff offer even with no messages', () => {
    const markup = render({ handoffs: [handoff()] });
    expect(markup).not.toContain('Ready to execute.');
    expect(count(markup, 'handoff-card')).toBe(1);
  });

  it('acceptance leaves the pane through exactly one prop, and the pane never decides by itself', () => {
    expect(SOURCE.match(/onAcceptHandoff/g)?.length).toBeGreaterThanOrEqual(3); // type, destructure, use
    expect(SOURCE).toContain('onAccept={onAcceptHandoff}');
    // The inbox filters to `created` — nothing else is ever offered.
    expect(SOURCE).toContain("h.status === 'created'");
  });

  it('an accepted handoff can render notes alongside the task', () => {
    const markup = render({ handoffs: [handoff({ notes: 'All tests green and lint clean' })] });
    expect(markup).toContain('All tests green and lint clean');
  });
});
