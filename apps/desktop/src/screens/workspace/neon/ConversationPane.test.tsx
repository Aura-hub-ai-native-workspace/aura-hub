/**
 * ConversationPane — the workspace reads as a conversation.
 *
 * The screen this replaced rendered a run console: an objective header,
 * a run-state pill, a timeline of actor rows carrying task ids and
 * lifecycle words, and a result card printing `outcome: failed ·
 * performed: [t1]`. Every one of those was a true statement about
 * orchestration and none of them was an answer.
 *
 * These tests hold the new contract, and most of them are about what
 * must NOT be on screen. A greeting renders as prose. Work shows a
 * quiet activity line while it happens and nothing once it is done. A
 * failure says what happened in English. No id, enum or event name
 * reaches the transcript at any point.
 *
 * Rendered with `renderToStaticMarkup`; no DOM environment exists in
 * this repo. Handlers are read off the element tree where a click
 * matters.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';

import type { ApprovalRequest } from '../../../ai/fabricClient';

import type { AgentActivity, AgentChatMessage } from '../../../ai/useAgentConversations';
import { ConversationPane } from './ConversationPane';

/* ── fixtures ────────────────────────────────────────────────────── */

/**
 * The pane holds composer and scroll state, so its handlers cannot be
 * invoked without a DOM and this repo has none. Two claims are therefore
 * checked against the source itself: that there is exactly one way for a
 * message to leave the pane, and exactly one way for an approval answer
 * to leave it. Both are structural claims, and reading them structurally
 * is more honest than simulating a click that never happens.
 */
const SOURCE = readFileSync(new URL('./ConversationPane.tsx', import.meta.url), 'utf8');

const IDLE: AgentActivity = { workers: {}, tools: [], phase: null, awaitingApproval: false };

function user(content: string): AgentChatMessage {
  return { id: `u-${content.slice(0, 6)}`, role: 'user', content, status: 'done' };
}

function assistant(
  content: string,
  over: Partial<AgentChatMessage> = {},
  agent: Partial<NonNullable<AgentChatMessage['agent']>> = {},
): AgentChatMessage {
  return {
    id: `a-${content.slice(0, 6)}`,
    role: 'assistant',
    content,
    status: 'done',
    agent: {
      sessionId: 'agt-3f1a9b2c4d5e', outcome: 'completed', requestId: 'req-aabbccddeeff',
      progress: [], events: [], plan: null, approvalId: null,
      performed: [], verified: [], evidenceSummary: null, runId: null,
      needsInput: false, cancelled: false, tools: [],
      ...agent,
    },
    ...over,
  };
}

type PaneProps = ComponentProps<typeof ConversationPane>;

function pane(messages: AgentChatMessage[], over: Partial<PaneProps> = {}) {
  const props: PaneProps = {
    messages,
    activity: IDLE,
    busy: false,
    agentUp: true,
    approvals: {},
    deciding: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRegenerate: vi.fn(),
    onDecide: vi.fn(),
    projectName: null,
    ...over,
  };
  return <ConversationPane {...props} />;
}

const render = (...args: Parameters<typeof pane>) => renderToStaticMarkup(pane(...args));

function count(markup: string, testid: string): number {
  return markup.split(`data-testid="${testid}"`).length - 1;
}

/* ── it reads as a conversation ──────────────────────────────────── */

describe('ConversationPane — a greeting reads like a reply', () => {
  it('renders the exchange as prose, not as a run', () => {
    const markup = render([
      user('Hi'),
      assistant('Hey! 👋 How can I help you today?'),
    ]);

    expect(markup).toContain('Hi');
    expect(markup).toContain('How can I help you today?');
    expect(count(markup, 'chat-message')).toBe(2);
    expect(markup).toContain('data-role="user"');
    expect(markup).toContain('data-role="assistant"');
  });

  it('shows no phase strip, plan, timeline or outcome badge', () => {
    const markup = render([user('Hi'), assistant('Hey!')]);

    for (const gone of ['INTENT', 'PLAN', 'PERMISSION', 'EXECUTION', 'VERIFICATION', 'RESULT']) {
      expect(markup).not.toContain(gone);
    }
    expect(markup).not.toContain('run-timeline');
    expect(markup).not.toContain('Objective');
    expect(markup).not.toContain('completed');
  });

  it('offers a starting point when there is nothing to show', () => {
    const markup = render([]);
    expect(markup).toContain('How can I help?');
    expect(count(markup, 'chat-suggestion')).toBeGreaterThan(0);
  });
});

/* ── exactly one composer ────────────────────────────────────────── */

describe('ConversationPane — one composer', () => {
  it('renders exactly one message input and one send control', () => {
    const markup = render([user('Hi')]);
    expect(count(markup, 'agent-composer')).toBe(1);
    expect(count(markup, 'agent-submit')).toBe(1);
    expect(markup.split('<textarea').length - 1).toBe(1);
  });

  it('swaps send for stop while AURA is working, still one control', () => {
    const markup = render([user('Do the thing')], { busy: true });
    expect(count(markup, 'agent-stop')).toBe(1);
    expect(count(markup, 'agent-submit')).toBe(0);
    expect(markup.split('<textarea').length - 1).toBe(1);
  });

  it('offers its starting prompts as sendable text, not as separate flows', () => {
    const markup = render([]);
    expect(markup).toContain('What can you do?');
    expect(count(markup, 'chat-suggestion')).toBe(4);
    // A suggestion is a shortcut into the same composer path, so it must
    // not be a link, a form or anything that navigates.
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<a ');
  });

  it('routes every outbound message through the single onSend prop', () => {
    // The composer holds state, so its handler cannot be invoked without
    // a DOM. What matters is instead structural and readable from the
    // source: there is one way out of this pane and it is the prop.
    expect(SOURCE).toContain('onSend(trimmed)');
    expect(SOURCE).toContain('onSend(s)');
    expect(SOURCE.match(/onSend\(/g)).toHaveLength(2);
    expect(SOURCE).toContain('const trimmed = text.trim()');

    for (const transport of ['fetch(', 'EventSource', 'centralAgentClient', 'fabricClient.']) {
      expect(SOURCE).not.toContain(transport);
    }
  });
});

/* ── capability activity ─────────────────────────────────────────── */

describe('ConversationPane — activity appears only when it is real', () => {
  it('shows nothing while idle', () => {
    expect(count(render([user('Hi')]), 'agent-activity')).toBe(0);
  });

  it('shows nothing once the turn is over, though the tool record remains', () => {
    // What the store looks like after a finished turn: the tools survive
    // as the record of what ran, the phase does not. A line reading
    // "using Git" under a live dot would be claiming present tense for
    // something that is over.
    const finished: AgentActivity = {
      workers: {}, tools: ['Git'], phase: null, awaitingApproval: false,
    };
    const markup = render([user('Check the repo'), assistant('Clean.')], { activity: finished });

    expect(count(markup, 'agent-activity')).toBe(0);
    expect(markup).not.toContain('using Git');
  });

  it('names what AURA is doing and what it is using', () => {
    const activity: AgentActivity = {
      workers: { opencode: 'ACTIVE' },
      tools: ['Git', 'OpenCode'],
      phase: 'Working',
      awaitingApproval: false,
    };
    const markup = render([user('Fix the bug')], { activity, busy: true });

    expect(count(markup, 'agent-activity')).toBe(1);
    expect(markup).toContain('Working · using Git and OpenCode');
  });

  it('never prints a raw event name, lifecycle word or node id', () => {
    const activity: AgentActivity = {
      workers: { opencode: 'SPAWNING' },
      tools: ['Git'],
      phase: 'Working',
      awaitingApproval: false,
    };
    const markup = render([user('Fix the bug')], { activity, busy: true });

    for (const raw of ['SPAWNING', 'worker.lifecycle', 'invocation.observed',
      'agent.delegate', 'filesystem.write', 'capability.discovery']) {
      expect(markup).not.toContain(raw);
    }
  });

  it('keeps a finished turn’s tool record beside the answer', () => {
    const markup = render([
      user('Check the repo'),
      assistant('The working tree is clean.', {}, { tools: ['Git'] }),
    ]);
    expect(markup).toContain('Used Git');
    expect(count(markup, 'tool-trace-toggle')).toBe(1);
  });
});

/* ── honesty about outcomes ──────────────────────────────────────── */

describe('ConversationPane — failures are reported, never dressed up', () => {
  it('says nothing extra when the turn completed', () => {
    const markup = render([assistant('Done.', {}, { outcome: 'completed' })]);
    expect(count(markup, 'outcome-note')).toBe(0);
  });

  it.each([
    ['failed', 'did not work'],
    ['denied', 'not permitted'],
    ['timeout', 'took too long'],
    ['blocked', 'could not start'],
    ['unsupported', 'cannot do that'],
  ])('explains %s in plain words', (outcome, phrase) => {
    const markup = render([assistant('', {}, { outcome: outcome as never })]);
    expect(count(markup, 'outcome-note')).toBe(1);
    expect(markup).toContain(phrase);
    expect(markup).not.toContain(`outcome: ${outcome}`);
  });

  it('never claims completion for a failed turn', () => {
    const markup = render([assistant('', {}, { outcome: 'failed' })]);
    expect(markup).toContain('not marked it done');
  });

  it('renders a transport failure as something the user can act on', () => {
    const markup = render([
      assistant('', { status: 'error', error: 'TypeError: Failed to fetch' }),
    ]);
    expect(count(markup, 'chat-error')).toBe(1);
    expect(markup).toContain('could not reach the AURA service');
    expect(markup).not.toContain('TypeError');
  });

  it('marks a stopped turn as stopped, not as failed', () => {
    const markup = render([assistant('partial', { status: 'cancelled' })]);
    expect(markup).toContain('Stopped.');
    expect(count(markup, 'chat-error')).toBe(0);
  });
});

/* ── no backend vocabulary reaches the transcript ────────────────── */

describe('ConversationPane — the transcript carries no internals', () => {
  it('prints no session id, request id, run id or task id', () => {
    const markup = render([
      user('Fix the bug'),
      assistant('I fixed it.', {}, {
        sessionId: 'agt-3f1a9b2c4d5e',
        requestId: 'req-aabbccddeeff',
        runId: 'run-991122',
        performed: ['implement-1'],
        verified: ['implement-1'],
        evidenceSummary: '2 audit records',
      }),
    ]);

    for (const secret of ['agt-3f1a9b2c4d5e', 'req-aabbccddeeff', 'run-991122',
      'implement-1', 'performed', 'verified', 'evidence', 'session']) {
      expect(markup).not.toContain(secret);
    }
  });

  it('says the agent is down in words when it is down', () => {
    const markup = render([], { agentUp: false });
    expect(count(markup, 'agent-offline')).toBe(1);
    expect(markup).toContain('AURA is not running');
    expect(markup).not.toContain('ECONNREFUSED');
  });
});

/* ── approvals go through the existing gate ──────────────────────── */

describe('ConversationPane — approvals', () => {
  const parked = assistant('', {}, { outcome: 'awaiting-approval', approvalId: 'apr-1' });

  it('says an approval is needed, in words', () => {
    const markup = render([parked]);
    expect(count(markup, 'outcome-note')).toBe(1);
    expect(markup).toContain('needs your approval');
  });

  it('renders no gate until the real request has been resolved', () => {
    const markup = render([parked], { approvals: { 'apr-1': null } });
    expect(markup).toContain('Loading the authorization details');
    expect(markup).not.toContain('Authorization required');
  });

  it('renders the existing gate once the real request is in hand', () => {
    const request: ApprovalRequest = {
      id: 'apr-1',
      state: 'pending',
      requestedAt: '2026-01-01T00:00:00Z',
      summary: 'Write the migration file',
      items: [{
        invocationId: 'inv-1',
        capabilityId: 'filesystem.write',
        title: 'Write a file',
        detail: 'db/migrations/0004.sql',
        risk: 'high',
        irreversible: true,
      }],
    };
    const markup = render([parked], { approvals: { 'apr-1': request } });

    expect(markup).toContain('Authorization required');
    expect(markup).toContain('Approve and run');
    expect(markup).toContain('Write the migration file');
    expect(markup).not.toContain('Loading the authorization details');
  });

  it('never decides locally — the answer leaves through the prop', () => {
    // The gate owns its own decline-reason state, so the click cannot be
    // driven here. The claim under test is that this pane forwards and
    // stores nothing: no ledger call, no local grant, no state of its own.
    expect(SOURCE).toContain('onDecide={(_id, granted, reason) => onDecide(granted, reason)}');
    expect(SOURCE).toContain('onDecide(m.id, granted, reason)');
    expect(SOURCE.match(/onDecide\(/g)).toHaveLength(2);

    for (const decidingLocally of ['approve(', 'decide(', 'granted: true', 'setApprov']) {
      expect(SOURCE).not.toContain(decidingLocally);
    }
    // The gate itself is the existing one, not a copy.
    expect(SOURCE).toContain("import { ApprovalGate } from '../../missions/ApprovalGate'");
  });
});
