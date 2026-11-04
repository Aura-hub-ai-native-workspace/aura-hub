/**
 * Stopping a Start Building answer tells the truth (F-24, path 1).
 *
 * `stop()` used to fire the backend cancel, discard its result, and abort the
 * local stream at once, so the turn read "Stopped" whether or not the agent
 * had been reached or had stopped. Now:
 *
 *   - a request that lands leaves the turn "stopping" (not "cancelled") and the
 *     stream running; only the agent's own reply, `outcome: 'cancelled'`,
 *     confirms it;
 *   - a request that fails leaves the turn streaming, with the reason on screen;
 *   - an answer that finishes while a stop is pending is shown as done, with
 *     a note that it finished first;
 *   - a repeated press while a request is in flight sends one request;
 *   - leaving the conversation mid-answer still stops it, and a failed stop is
 *     logged, not swallowed.
 *
 * Only the client's network methods are faked; the store, the turn state
 * machine and the rendering are the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('../backend/backendSession', async (orig) => ({
  ...(await orig<typeof import('../backend/backendSession')>()),
  backendFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

import { centralAgentClient, type AgentResult } from './centralAgentClient';
import { useGeneralChat, type GeneralTurn } from './useGeneralChat';
import { Turn } from '../components/GeneralChat';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const result = (outcome: string, summary = 'the answer'): { result: AgentResult; sessionId: string } => ({
  result: { outcome, summary, status: outcome } as unknown as AgentResult, sessionId: 's',
});

let chatCall: ReturnType<typeof deferred<{ result: AgentResult; sessionId: string }>>;
let chatSignal: AbortSignal | undefined;
const cancel = vi.fn();

const turn = (): GeneralTurn => useGeneralChat.getState().turns[0];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
  cancel.mockReset();
  chatCall = deferred();
  chatSignal = undefined;
  vi.spyOn(centralAgentClient, 'events').mockReturnValue(() => {});
  vi.spyOn(centralAgentClient, 'chats').mockResolvedValue({ chats: [] } as never);
  vi.spyOn(centralAgentClient, 'chat').mockImplementation((_m, opts) => {
    chatSignal = opts?.signal;
    return chatCall.promise as never;
  });
  vi.spyOn(centralAgentClient, 'cancel').mockImplementation(cancel as never);
  useGeneralChat.setState({ sessionId: null, turns: [], phase: 'idle', stopRequesting: false });
});

afterEach(async () => {
  // The store keeps its in-flight turn at module level: settle whatever a test
  // left pending so the next one starts with nothing running.
  chatCall.resolve(result('completed'));
  await flush();
  vi.useRealTimers();
});

async function startTurn() {
  void useGeneralChat.getState().send('build me a thing');
  await flush();
  expect(turn().status).toBe('streaming');
  expect(useGeneralChat.getState().phase).toBe('working');
}

describe('a stop that lands', () => {
  it('shows "stopping", keeps the stream, and only the agent confirms the stop', async () => {
    cancel.mockResolvedValue({ cancelled: true, cancellation: {} });
    await startTurn();
    await useGeneralChat.getState().stop();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(turn().status).toBe('stopping');                 // not "cancelled": nothing has confirmed it
    expect(turn().stopNote).toMatch(/waiting for the agent to confirm/i);
    expect(chatSignal?.aborted).toBe(false);                // the stream is still being read
    expect(useGeneralChat.getState().phase).toBe('working');

    chatCall.resolve(result('cancelled', 'partial'));       // the agent's own outcome
    await flush();
    expect(turn().status).toBe('cancelled');
    expect(turn().stopNote).toBeUndefined();
    expect(useGeneralChat.getState().phase).toBe('idle');
  });

  it('shows an answer that finished first as done, with a note, not as stopped', async () => {
    cancel.mockResolvedValue({ cancelled: true, cancellation: {} });
    await startTurn();
    await useGeneralChat.getState().stop();
    chatCall.resolve(result('completed', 'the finished answer'));   // won the race
    await flush();
    expect(turn().status).toBe('done');
    expect(turn().answer).toBe('the finished answer');
    expect(turn().stopNote).toMatch(/finished before the stop took effect/i);
  });
});

describe('a stop that fails', () => {
  it('leaves the answer running and says so', async () => {
    cancel.mockRejectedValue(new TypeError('Failed to fetch'));
    await startTurn();
    await useGeneralChat.getState().stop();

    expect(turn().status).toBe('streaming');                // not "cancelled"
    expect(turn().stopNote).toMatch(/could not stop the answer/i);
    expect(turn().stopNote).toMatch(/still being made/i);
    expect(chatSignal?.aborted).toBe(false);
    expect(useGeneralChat.getState().phase).toBe('working');
    expect(useGeneralChat.getState().stopRequesting).toBe(false);   // the person can try again

    chatCall.resolve(result('completed'));
    await flush();
    expect(turn().status).toBe('done');                     // the run really did continue
  });

  it('shows the refusal the agent gave', async () => {
    cancel.mockRejectedValue(new Error('no such session: s'));
    await startTurn();
    await useGeneralChat.getState().stop();
    expect(turn().stopNote).toContain('no such session');
    expect(turn().status).toBe('streaming');
  });

  it('can be retried, and a later success then works', async () => {
    cancel.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ cancelled: true, cancellation: {} });
    await startTurn();
    await useGeneralChat.getState().stop();
    expect(turn().status).toBe('streaming');
    await useGeneralChat.getState().stop();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(turn().status).toBe('stopping');
    chatCall.resolve(result('cancelled'));
    await flush();
    expect(turn().status).toBe('cancelled');
  });
});

describe('repeated presses', () => {
  it('send one request while one is in flight', async () => {
    const pending = deferred<unknown>();
    cancel.mockReturnValue(pending.promise);
    await startTurn();
    const first = useGeneralChat.getState().stop();
    const second = useGeneralChat.getState().stop();
    const third = useGeneralChat.getState().stop();
    expect(useGeneralChat.getState().stopRequesting).toBe(true);
    expect(turn().status).toBe('stopping');
    pending.resolve({ cancelled: true, cancellation: {} });
    await Promise.all([first, second, third]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(useGeneralChat.getState().stopRequesting).toBe(false);
  });

  it('stopping with nothing in flight does nothing', async () => {
    await useGeneralChat.getState().stop();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('leaving the conversation mid-answer', () => {
  it('still sends the stop, detaches the stream, and logs a failed stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cancel.mockRejectedValue(new Error('unreachable'));
    await startTurn();
    useGeneralChat.getState().newChat();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chatSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/could not stop the answer/i);
    expect(useGeneralChat.getState().turns).toEqual([]);
  });
});

describe('what the person sees', () => {
  const view = (t: Partial<GeneralTurn>) => renderToStaticMarkup(createElement(Turn, {
    turn: {
      id: 't', question: 'q', answer: '', status: 'streaming', live: { answer: 'partial text', steps: [], sources: [], research: null } as never,
      sources: [], research: null, nextActions: [], recorded: [], model: null, ...t,
    },
  }));

  it('shows the note for a failed stop and keeps the live answer', () => {
    const html = view({ stopNote: 'Could not stop the answer: AURA could not be reached. It is still being made.' });
    expect(html).toContain('data-testid="general-stop-note"');
    expect(html).toContain('still being made');
    expect(html).toContain('partial text');
    expect(html).not.toContain('Stopped');
  });

  it('shows the live answer while stopping, not "Stopped"', () => {
    const html = view({ status: 'stopping', stopNote: 'Stop requested. Waiting for the agent to confirm.' });
    expect(html).toContain('partial text');
    expect(html).not.toContain('Stopped');
    expect(html).toContain('Waiting for the agent to confirm');
  });

  it('says "Stopped" only for a confirmed cancellation', () => {
    expect(view({ status: 'cancelled', answer: '' })).toContain('Stopped.');
  });
});
