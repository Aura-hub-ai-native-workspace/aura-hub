/**
 * conversationScopes — Ask AURA advises, the Workspace executes.
 *
 * Regression cover for the product split:
 *
 *   1. ADVISORY HAS NO EXECUTION AUTHORITY. Sending through the Ask
 *      AURA store (`useConversations`) must never call the Central
 *      Agent client — no submit, no message, no approve, no cancel.
 *      Advice streams from `/stream` with project context and persists
 *      in that project's file. This is the hard invariant.
 *   2. The Workspace execution store drives the Central Agent and
 *      persists in the workspace-scoped file, never in a project's.
 *   3. The two stores never share transcripts.
 *   4. Handoff is explicit: offering sets a pending banner and sends
 *      nothing; only an explicit consume+send executes.
 *   5. Project A/B advisory threads stay isolated; the Workspace never
 *      inherits a project's private thread.
 *
 * Only the Central Agent client and the HTTP layer are faked; both
 * stores, their routing and the handoff are the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { submit: [] as unknown[][], message: [] as unknown[][] };

/* In-memory stand-in for the service's disjoint conversation files. */
const files = new Map<string, { id: string; title: string; messages: { id: string; role: string; content: string; meta?: unknown }[] }[]>();
const fetched: string[] = [];
let convSeq = 0;
let msgSeq = 0;

function fileFor(url: string): string {
  const m = url.match(/\/(projects\/([^/]+)|workspace)\/conversations/);
  if (!m) throw new Error(`unexpected url ${url}`);
  return m[1] === 'workspace' ? '__workspace__' : `project:${m[2]}`;
}

function jsonBody(init?: RequestInit): Record<string, unknown> {
  try { return JSON.parse(String(init?.body ?? '{}')); } catch { return {}; }
}

/** Minimal web-stream body yielding the given SSE chunks. */
function sseBody(chunks: string[]) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => enc.encode(c));
  return {
    getReader() {
      let i = 0;
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (i >= queue.length) return { done: true, value: undefined };
          const value = queue[i++];
          return { done: false, value };
        },
        releaseLock() {},
      };
    },
  };
}

vi.mock('./centralAgentClient', () => ({
  newClientSessionId: () => 'agt-new-session',
  centralAgentClient: {
    health: () => Promise.resolve({ ok: true }),
    events: () => () => {},
    submit: (...args: unknown[]) => {
      calls.submit.push(args);
      return Promise.resolve({
        result: {
          status: 'completed', outcome: 'completed', summary: 'executed answer',
          performed: ['t1'], verified: ['t1'], evidence: null,
        },
        sessionId: 'agt-new-session',
        requestId: 'req-1',
      });
    },
    message: (...args: unknown[]) => {
      calls.message.push(args);
      return Promise.resolve({
        result: {
          status: 'completed', outcome: 'completed', summary: 'follow-up answer',
          performed: [], verified: [], evidence: null,
        },
        requestId: 'req-2',
      });
    },
    cancel: () => Promise.resolve({ cancelled: true }),
    approve: () => Promise.resolve({
      approval: { id: 'a', state: 'granted' },
      result: { status: 'completed', outcome: 'completed', summary: 'approved', performed: [], verified: [], evidence: null },
    }),
    planReview: () => Promise.resolve(null),
  },
}));

const fetchStub = async (url: string, init?: RequestInit) => {
  fetched.push(`${init?.method ?? 'GET'} ${url}`);
  const u = new URL(url, 'http://x');
  const method = init?.method ?? 'GET';

  // The advisory generation path: one streamed answer, then done.
  if (u.pathname === '/stream' && method === 'POST') {
    return {
      body: sseBody([
        'data: {"type":"token","text":"advisory answer"}\n\n',
        'data: {"type":"done"}\n\n',
        'data: [DONE]\n\n',
      ]),
    };
  }

  const file = fileFor(u.pathname);
  const list = files.get(file) ?? [];
  const segs = u.pathname.split('/').filter(Boolean);
  const body = jsonBody(init as RequestInit | undefined);
  const ok = (v: unknown) => ({ json: () => Promise.resolve(v) });

  if (segs[segs.length - 1] === 'conversations' && method === 'GET') {
    return ok({ conversations: list.map((c) => ({ id: c.id, title: c.title, messageCount: c.messages.length, createdAt: '', updatedAt: '' })) });
  }
  if (segs[segs.length - 1] === 'conversations' && method === 'POST') {
    const conv = { id: `conv-${++convSeq}`, title: String(body.title ?? 'New conversation'), messages: [] as { id: string; role: string; content: string; meta?: unknown }[] };
    files.set(file, [conv, ...list]);
    return ok(conv);
  }
  const cid = segs[segs.indexOf('conversations') + 1];
  const conv = list.find((c) => c.id === cid);
  if (!conv) return ok({ error: 'no such conversation' });
  if (segs[segs.length - 1] === 'message' && method === 'POST') {
    const msg = { id: `msg-${++msgSeq}`, role: String(body.role ?? 'user'), content: String(body.content ?? ''), meta: body.meta };
    conv.messages.push(msg);
    return ok(msg);
  }
  return ok({ ...conv });
};

vi.stubGlobal('fetch', fetchStub);

const { useConversations } = await import('./useConversations');
const { useWorkspaceConversations } = await import('./useAgentConversations');

const IDLE_ACTIVITY = { workers: {}, tools: [], phase: null, awaitingApproval: false };

const settle = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

beforeEach(() => {
  files.clear();
  fetched.length = 0;
  calls.submit.length = 0;
  calls.message.length = 0;
  convSeq = 0;
  msgSeq = 0;
  useConversations.setState({
    projectId: null, conversations: [], activeId: null, messages: [], phase: 'idle', loading: false,
  });
  useWorkspaceConversations.setState({
    projectId: null, projectPath: null, conversations: [], activeId: null,
    messages: [], phase: 'idle', loading: false, agentUp: null, activity: { ...IDLE_ACTIVITY },
    pendingHandoff: null,
  });
});

describe('Ask AURA advises and never executes', () => {
  it('routes advice through /stream with project scope and zero central-agent calls', async () => {
    useConversations.setState({ projectId: 'projA' });
    await useConversations.getState().send('Explain thread isolation');
    await settle();

    // THE invariant: the advisory surface cannot reach the execution engine.
    expect(calls.submit).toEqual([]);
    expect(calls.message).toEqual([]);

    const streamCalls = fetched.filter((f) => f.includes('/stream'));
    expect(streamCalls.length).toBe(1);
    const msgs = useConversations.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('advisory answer');
    expect(msgs[1].status).toBe('done');
  });

  it('persists advisory threads per project and keeps A/B isolated', async () => {
    useConversations.setState({ projectId: 'projA' });
    await useConversations.getState().send('My private project identifier is AURA-PROJECT-A-PRIVATE-123');
    await settle();
    expect(files.get('project:projA')?.[0]?.messages.length).toBe(2);

    useConversations.setState({
      projectId: 'projB', conversations: [], activeId: null, messages: [], phase: 'idle', loading: false,
    });
    await useConversations.getState().loadForProject('projB');
    await settle();
    expect(useConversations.getState().messages).toEqual([]);
    expect(files.get('project:projB') ?? []).toEqual([]);

    // Project A thread intact; workspace file untouched by advice.
    await useConversations.getState().loadForProject('projA');
    await settle();
    expect(useConversations.getState().messages.some((m) => m.content.includes('AURA-PROJECT-A-PRIVATE-123'))).toBe(true);
    expect(files.has('__workspace__')).toBe(false);
  });
});

describe('Workspace executes and stays separate', () => {
  it('drives the central agent and persists in the workspace file only', async () => {
    await useWorkspaceConversations.getState().loadForWorkspace('projA', '/tmp/projA');
    await useWorkspaceConversations.getState().send('Fix the onboarding bug');
    await settle();

    expect(calls.submit.length).toBe(1);
    const writes = fetched.filter((f) => f.startsWith('POST'));
    expect(writes.some((f) => f.includes('/workspace/conversations'))).toBe(true);
    expect(writes.some((f) => f.includes('/projects/'))).toBe(false);
    expect(files.has('project:projA')).toBe(false);
  });

  it('never inherits a project advisory thread', async () => {
    useConversations.setState({ projectId: 'projA' });
    await useConversations.getState().send('Project A advisor context = BBBBB');
    await settle();

    await useWorkspaceConversations.getState().loadForWorkspace(null, null);
    await settle();
    expect(useWorkspaceConversations.getState().messages).toEqual([]);
  });

  it('starts a fresh session when the working project changes mid-thread', async () => {
    await useWorkspaceConversations.getState().loadForWorkspace('projA', '/tmp/projA');
    await useWorkspaceConversations.getState().send('first objective');
    await settle();
    expect(calls.submit.length).toBe(1);

    useWorkspaceConversations.setState({ projectId: 'projB', projectPath: '/tmp/projB' });
    await useWorkspaceConversations.getState().send('second objective');
    await settle();

    expect(calls.message.length).toBe(0);
    expect(calls.submit.length).toBe(2);
  });
});

describe('explicit handoff', () => {
  it('offering stages a banner and executes nothing', async () => {
    await useWorkspaceConversations.getState().loadForWorkspace('projA', '/tmp/projA');
    useWorkspaceConversations.getState().offerHandoff({
      text: 'Task from Ask AURA (project "projA"):\n\nQuestion: How should we fix X?',
      sourceProjectId: 'projA',
      sourceProjectName: 'projA',
      offeredAt: new Date().toISOString(),
    });

    expect(useWorkspaceConversations.getState().pendingHandoff?.text).toContain('How should we fix X?');
    expect(calls.submit.length).toBe(0);
    expect(useWorkspaceConversations.getState().messages).toEqual([]);
  });

  it('only an explicit consume+send executes the offered task', async () => {
    await useWorkspaceConversations.getState().loadForWorkspace('projA', '/tmp/projA');
    useWorkspaceConversations.getState().offerHandoff({
      text: 'Do the thing',
      sourceProjectId: 'projA',
      sourceProjectName: 'projA',
      offeredAt: new Date().toISOString(),
    });
    const handoff = useWorkspaceConversations.getState().consumeHandoff();
    expect(handoff?.text).toBe('Do the thing');
    expect(useWorkspaceConversations.getState().pendingHandoff).toBeNull();

    await useWorkspaceConversations.getState().send(handoff!.text);
    await settle();
    expect(calls.submit.length).toBe(1);
  });

  it('dismiss drops the offer without a trace', () => {
    useWorkspaceConversations.getState().offerHandoff({
      text: 'Do the thing',
      sourceProjectId: 'projA',
      sourceProjectName: 'projA',
      offeredAt: new Date().toISOString(),
    });
    useWorkspaceConversations.getState().dismissHandoff();
    expect(useWorkspaceConversations.getState().pendingHandoff).toBeNull();
    expect(calls.submit.length).toBe(0);
  });
});
