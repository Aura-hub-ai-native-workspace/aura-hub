/**
 * agentActivity — what the workspace claims is happening must be true.
 *
 * The activity line is the one place the conversation says something
 * about the machinery: "Working · using Git". It is derived from the
 * live frames, so it is honest while a turn runs. The risk is at the
 * edges — a turn that ends by a route the teardown does not cover
 * leaves the last true statement on screen after it has stopped being
 * true.
 *
 * That is what happened with Stop. `stop()` clears `inflight` before
 * the in-flight `finally { finish() }` runs, so `finish()`'s
 * `inflight === flight` guard fails and the live state was never torn
 * down: the workspace went on saying "Working" after the user had
 * stopped the work. These tests hold that edge.
 *
 * Only the Central Agent client is mocked, and only so a turn can be
 * held in flight — the store, its frame handling and its teardown are
 * the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The live frame sink, captured from the store's own subscription. */
let emit: ((frame: unknown) => void) | null = null;
let cancelled: string[] = [];

vi.mock('./centralAgentClient', () => ({
  newClientSessionId: () => 'agt-test',
  centralAgentClient: {
    health: () => Promise.resolve({ ok: true }),
    events: (_sid: string, cb: (frame: unknown) => void) => {
      emit = cb;
      return () => { emit = null; };
    },
    /* The turn never resolves on its own: every one of these tests is
       about what happens to a turn that is still in flight. */
    submit: () => new Promise(() => {}),
    message: () => new Promise(() => {}),
    cancel: (sid: string) => { cancelled.push(sid); return Promise.resolve(); },
    planReview: () => Promise.resolve(null),
  },
}));

const { useAgentConversations } = await import('./useAgentConversations');

const state = () => useAgentConversations.getState();

/** Lets the store's awaited internals run without resolving the turn. */
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function frame(type: string, payload: Record<string, unknown> = {}) {
  return { type, at: '2026-01-01T00:00:00Z', sessionId: 'agt-test', payload, seq: 1 };
}

/** Starts a turn and puts one real worker frame through it. */
async function startWorkingTurn() {
  void state().send('do the thing');
  await settle();
  emit?.(frame('worker.lifecycle', { nodeId: 'opencode', lifecycle: 'ACTIVE', worker: 'OpenCode' }));
}

beforeEach(() => {
  emit = null;
  cancelled = [];
  useAgentConversations.setState({
    projectId: null, projectPath: null, conversations: [], activeId: null,
    messages: [], phase: 'idle', loading: false, agentUp: null,
    activity: { workers: {}, tools: [], phase: null, awaitingApproval: false },
  });
});

describe('activity is live state, and only live state', () => {
  it('reports what is actually happening while it happens', async () => {
    await startWorkingTurn();

    expect(state().phase).toBe('working');
    expect(state().activity.phase).toBe('Working');
    expect(state().activity.workers).toEqual({ opencode: 'ACTIVE' });
    expect(state().activity.tools).toEqual(['OpenCode']);
  });

  it('stops claiming work the moment the user stops it', async () => {
    await startWorkingTurn();
    expect(state().activity.phase).toBe('Working'); // the turn really was live

    state().stop();
    await settle();

    expect(state().phase).toBe('idle');
    expect(state().activity.phase).toBeNull();
    expect(state().activity.workers).toEqual({});
    expect(cancelled).toEqual(['agt-test']);
  });

  it('keeps the record of what ran, which is a fact about the past', async () => {
    await startWorkingTurn();
    state().stop();
    await settle();

    // The tool list survives a stop for the same reason it survives a
    // normal finish: OpenCode really was used. It is shown beside the
    // answer, not as a live indicator.
    expect(state().activity.tools).toEqual(['OpenCode']);
  });

  it('marks the stopped turn as stopped, not as failed or done', async () => {
    await startWorkingTurn();
    state().stop();
    await settle();

    const assistant = state().messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('cancelled');
    expect(assistant?.agent?.cancelled).toBe(true);
    expect(assistant?.agent?.outcome).toBeNull();
  });

  it('invents nothing from a frame the backend did not fill in', async () => {
    void state().send('do the thing');
    await settle();
    emit?.(frame('worker.lifecycle', {}));

    expect(state().activity.workers).toEqual({});
    expect(state().activity.tools).toEqual([]);
  });

  it('names only capabilities the backend reported as available', async () => {
    void state().send('do the thing');
    await settle();
    emit?.(frame('capability.discovery', {
      tools: [
        { id: 'git.status', available: true },
        { id: 'github.pr.create', available: false },
      ],
    }));

    expect(state().activity.tools).toEqual(['Git']);
  });
});
