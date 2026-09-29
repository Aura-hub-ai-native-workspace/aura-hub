/**
 * agentRunPersistence — a reopened thread must be able to redraw the
 * execution timeline it drew live.
 * =====================================================================
 * Stage C regression: `persistAssistant` used to strip the run record
 * to a plan COUNT (`{ planId, steps: n }`) and drop the event frames
 * entirely. The transcript survived, but the execution timeline could
 * not be reconstructed after reopening the Workspace — the right panel
 * fell back to an honest idle, losing the plan, the worker identity,
 * the governed actions and the verification the run actually recorded.
 *
 * The contract now: the assistant message persists the run's own
 * frames (capped), `restoreMessages` hands them back verbatim through
 * the real `select()` path, and the WorkspaceScreen fold
 * (`meta.frames` → `derivePlan`/`buildV2Timeline`) can rebuild the
 * same cards. No fabrication: what the backend never sent still never
 * renders.
 *
 * Only `centralAgentClient` and the persistence seam (`aiClient`) are
 * mocked; the store, its frame handling, its persistence call and its
 * restoration path are the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The live frame sink, captured from the store's own subscription. */
let emit: ((frame: unknown) => void) | null = null;
/** Resolves the in-flight submit, ending the run on our schedule. */
let resolveSubmit: ((value: unknown) => void) | null = null;
/** Session ids submit() was called with, in order. */
let submitCalls: Array<string | undefined> = [];
/** Session ids message() was called with, in order. */
let messageCalls: string[] = [];
/** What the persistence seam was asked to append, in order. */
let appended: Array<{ role: string; content: string; meta?: unknown }> = [];
/** The thread store backing the mocked persistence seam. */
const stored = new Map<string, {
  id: string; title: string; createdAt: string; updatedAt: string;
  messages: Array<{ id: string; role: string; content: string; createdAt: string; meta?: unknown; error?: boolean }>;
}>();

let sidCounter = 0;

vi.mock('./centralAgentClient', () => ({
  newClientSessionId: () => `agt-gen-${sidCounter++}`,
  centralAgentClient: {
    health: () => Promise.resolve({ ok: true }),
    events: (_sid: string, cb: (frame: unknown) => void) => {
      emit = cb;
      return () => { emit = null; };
    },
    /* The turn ends only when the test resolves it — frames must be
       emittable while the run is genuinely in flight. The response
       echoes the session the submit actually named. */
    submit: (_text: string, opts: { sessionId?: string } = {}) => {
      submitCalls.push(opts.sessionId);
      return new Promise((res) => {
        resolveSubmit = (v) => res({ ...(v as Record<string, unknown>), sessionId: opts.sessionId, requestId: 'req-1' });
      });
    },
    message: (sid: string) => {
      messageCalls.push(sid);
      return Promise.reject(new Error('no such session: ' + sid));
    },
    cancel: () => Promise.resolve(),
    planReview: () => Promise.resolve(null),
  },
}));

vi.mock('./aiClient', () => ({
  aiClient: {
    listWorkspaceConversations: () =>
      Promise.resolve({ conversations: [] }),
    getWorkspaceConversation: (cid: string) => Promise.resolve(stored.get(cid)),
    createWorkspaceConversation: () => {
      stored.set('conv-test', { id: 'conv-test', title: 'Workspace', createdAt: '', updatedAt: '', messages: [] });
      return Promise.resolve(stored.get('conv-test'));
    },
    renameWorkspaceConversation: () => Promise.resolve(),
    removeWorkspaceConversation: () => Promise.resolve(),
    appendWorkspaceMessage: (_cid: string, msg: { role: string; content: string; meta?: unknown; error?: boolean }) => {
      appended.push(msg);
      // Upsert: send() reuses the seeded activeId without a create call,
      // exactly as the real workspace does for an existing thread.
      if (!stored.has('conv-test')) {
        stored.set('conv-test', { id: 'conv-test', title: 'Workspace', createdAt: '', updatedAt: '', messages: [] });
      }
      const conv = stored.get('conv-test')!;
      conv.messages.push({
        id: `m${conv.messages.length + 1}`, role: msg.role, content: msg.content,
        createdAt: '', meta: msg.meta, error: msg.error,
      });
      return Promise.resolve();
    },
  },
}));

const { useWorkspaceConversations } = await import('./useAgentConversations');

const state = () => useWorkspaceConversations.getState();

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

function frame(type: string, payload: Record<string, unknown> = {}, seq = 1) {
  return { type, at: '2026-01-01T00:00:00Z', sessionId: 'agt-gen-0', payload, seq };
}

const COMPLETED = {
  result: {
    status: 'completed', outcome: 'completed',
    summary: 'The task is done and verified.',
    performed: ['t1'], verified: ['t1'],
    evidence: { sessionId: 'agt-test', planId: '', auditRecordIds: [], approvalIds: [], summary: 'ok', createdAt: '' },
  },
};

/** Starts a turn, runs a real 1-task plan through it, ends the run. */
async function runOneTaskTurn(prompt: string) {
  void state().send(prompt);
  await settle();
  emit?.(frame('plan.created', {
    objective: prompt,
    expectedOutcome: 'a green test run',
    plan: [{ id: 't1', description: 'Implement the function and its test', role: 'code', dependsOn: [] }],
  }, 1));
  emit?.(frame('worker.lifecycle', { taskId: 't1', worker: 'claude-code', lifecycle: 'ACTIVE', state: 'running' }, 2));
  emit?.(frame('invocation.observed', { taskId: 't1', state: 'done', verified: true, detail: '1 test passed' }, 3));
  resolveSubmit?.(COMPLETED);
  await settle();
}

beforeEach(() => {
  emit = null;
  resolveSubmit = null;
  submitCalls = [];
  messageCalls = [];
  sidCounter = 0;
  appended = [];
  stored.clear();
  useWorkspaceConversations.setState({
    projectId: null, projectPath: null, conversations: [], activeId: 'conv-test',
    messages: [], phase: 'idle', loading: false, agentUp: null,
    activity: { workers: {}, tools: [], phase: null, awaitingApproval: false },
    frames: [],
  });
});

describe('the run record survives a thread round-trip', () => {
  it('persists the run frames alongside the answer', async () => {
    await runOneTaskTurn('add a function and its test');

    const assistant = appended.filter((m) => m.role === 'assistant').at(-1);
    expect(assistant).toBeTruthy();
    const agent = (assistant!.meta as { agent?: { frames?: Array<{ type: string }> } } | null)?.agent;
    const types = (agent?.frames ?? []).map((f) => f.type);
    expect(types).toContain('plan.created');
    expect(types).toContain('worker.lifecycle');
    expect(types).toContain('invocation.observed');
  });

  it('caps persisted frames so a long run cannot grow the thread unboundedly', async () => {
    void state().send('a very long run');
    await settle();
    for (let i = 0; i < 450; i += 1) {
      emit?.(frame('worker.lifecycle', { taskId: 't1', lifecycle: 'ACTIVE' }, i));
    }
    resolveSubmit?.(COMPLETED);
    await settle();

    const assistant = appended.filter((m) => m.role === 'assistant').at(-1);
    const agent = (assistant!.meta as { agent?: { frames?: unknown[] } } | null)?.agent;
    expect((agent?.frames ?? []).length).toBeLessThanOrEqual(400);
  });

  it('restores the frames verbatim through select() so the timeline can be rebuilt', async () => {
    await runOneTaskTurn('add a function and its test');

    /* A reload: the same thread, read back through the real path. */
    await state().select('conv-test');
    const restored = state().messages.filter((m) => m.role === 'assistant').at(-1);
    const frames = restored?.agent?.frames ?? [];
    expect(frames).toHaveLength(3);
    expect(frames[1]).toMatchObject({ type: 'worker.lifecycle', payload: { worker: 'claude-code' } });

    /* The fold the Workspace performs over the restored record — the
       same pure derivations the live timeline uses. */
    const { derivePlan } = await import('../screens/agentWorkspaceV2/runViews');
    const plan = derivePlan(frames);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: 't1', worker: 'claude-code', state: 'done', verified: true });
  });

  it('restores an old thread with no persisted frames to an honest idle timeline', async () => {
    stored.set('conv-old', {
      id: 'conv-old', title: 'Old', createdAt: '', updatedAt: '',
      messages: [{ id: 'm1', role: 'assistant', content: 'older answer', createdAt: '', meta: { agent: { sessionId: 'agt-old' } } }],
    });
    await state().select('conv-old');

    const restored = state().messages.at(-1);
    expect(restored?.agent?.frames).toEqual([]);
  });

  it('recovers a follow-up whose remembered session no longer exists, on a fresh session', async () => {
    /* A thread whose assistant message carries a session id the service
       no longer knows (restart, AURA_HOME change). The follow-up must
       land on a FRESH session — never spend the old run's authority —
       and still complete. */
    await runOneTaskTurn('first task');
    resolveSubmit?.(COMPLETED);
    await settle();

    void state().send('follow-up task');
    await settle();
    resolveSubmit?.(COMPLETED);
    await settle();

    expect(messageCalls).toEqual(['agt-gen-0']);
    // The recovery submitted on a DIFFERENT, freshly-minted session.
    expect(submitCalls).toEqual(['agt-gen-0', 'agt-gen-1']);
    const assistant = state().messages.filter((m) => m.role === 'assistant').at(-1);
    expect(assistant?.status).toBe('done');
    expect(assistant?.error).toBeUndefined();
  });
});
