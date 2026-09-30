/**
 * conversationScopes — Ask AURA and the Workspace never share threads.
 *
 * Regression cover for the product split, expressed against the
 * scope-separated architecture (one engine, two scopes):
 *
 *   1. The advisory store (`useConversations`, /stream generation)
 *      must never call the Central Agent client — no submit, no
 *      message, no approve, no cancel. This is the hard invariant.
 *   2. Ask AURA (agent engine, project scope) persists ONLY through
 *      the project conversation routes.
 *   3. Workspace execution (agent engine, `workspace:<projectId>`
 *      scope) persists ONLY through the /workspaces/<id> routes.
 *   4. The two families never share transcripts, and switching scopes
 *      resets the visible thread instead of carrying it across.
 *   5. Handoff is explicit: `handoffToWorkspace` only RECORDS an offer
 *      (a POST to the handoff store); it never executes anything, and
 *      the workspace scope can never be a handoff source.
 *
 * Only the Central Agent client and the HTTP layer are faked; the
 * stores, their scope routing and the handoff guard are the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { submit: [] as unknown[][], message: [] as unknown[][] };

/* In-memory stand-in for the service's disjoint conversation files.
   Keys mirror the ROUTE namespaces, which mirror the on-disk families:
   `project:<id>` (conversations/<id>.json) vs
   `workspace:<id>` (conversations-workspace/<id>.json, Windows-safe
   name on the service side — irrelevant at this HTTP seam). */
const files = new Map<string, { id: string; title: string; messages: { id: string; role: string; content: string; meta?: unknown }[] }[]>();
const fetched: string[] = [];
const handoffPosts: { url: string; body: Record<string, unknown> }[] = [];
let convSeq = 0;
let msgSeq = 0;

function fileFor(url: string): string {
  const u = new URL(url, 'http://x');
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segs[0] === 'workspaces') return `workspace:${segs[1]}`;
  if (segs[0] === 'projects') return `project:${segs[1]}`;
  throw new Error(`unexpected url ${url}`);
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
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

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

  // Handoff routes: record the offer, never execute.
  if (segs[2] === 'ask-aura' && segs[3] === 'handoffs') {
    const body = jsonBody(init as RequestInit | undefined);
    handoffPosts.push({ url: u.pathname, body });
    const hid = 'hnd-1';
    if (segs.length > 4 && segs[5] === 'accept') {
      return { json: () => Promise.resolve({ id: hid, status: 'accepted', projectId: segs[1], targetWorkspaceId: body.workspaceId }) };
    }
    return {
      json: () => Promise.resolve({
        id: hid, status: 'created', projectId: segs[1],
        sourceConversationId: body.sourceConversationId ?? 'conv-x',
        sourceMessageIds: body.sourceMessageIds ?? [],
        title: body.title ?? '', targetWorkspaceId: body.targetWorkspaceId ?? '',
      }),
    };
  }

  const file = fileFor(url);
  const list = files.get(file) ?? [];
  const body = jsonBody(init as RequestInit | undefined);
  const ok = (v: unknown) => ({ json: () => Promise.resolve(v) });
  const isConversations = segs[segs.length - 1] === 'conversations' || (segs.length >= 3 && segs[2] === 'conversations');

  if (isConversations && segs[segs.length - 1] === 'conversations' && method === 'GET') {
    return ok({ conversations: list.map((c) => ({ id: c.id, title: c.title, messageCount: c.messages.length, createdAt: '', updatedAt: '' })) });
  }
  if (isConversations && segs[segs.length - 1] === 'conversations' && method === 'POST') {
    const idPrefix = file.startsWith('workspace:') ? 'wconv' : 'conv';
    const conv = { id: `${idPrefix}-${++convSeq}`, title: String(body.title ?? 'New conversation'), messages: [] as { id: string; role: string; content: string; meta?: unknown }[] };
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
const { useAgentConversations } = await import('./useAgentConversations');

const IDLE_ACTIVITY = { workers: {}, tools: [], phase: null, awaitingApproval: false };

const settle = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

beforeEach(() => {
  files.clear();
  fetched.length = 0;
  handoffPosts.length = 0;
  calls.submit.length = 0;
  calls.message.length = 0;
  convSeq = 0;
  msgSeq = 0;
  useConversations.setState({
    projectId: null, conversations: [], activeId: null, messages: [], phase: 'idle', loading: false,
  });
  useAgentConversations.setState({
    scope: 'project', projectId: null, projectPath: null, workspaceId: null, handoffs: [],
    conversations: [], activeId: null, messages: [], phase: 'idle', loading: false,
    agentUp: null, activity: { ...IDLE_ACTIVITY },
  });
});

describe('advisory /stream has no execution authority', () => {
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

    // Project A thread intact; no workspace-family writes happened.
    await useConversations.getState().loadForProject('projA');
    await settle();
    expect(useConversations.getState().messages.some((m) => m.content.includes('AURA-PROJECT-A-PRIVATE-123'))).toBe(true);
    expect(files.has('workspace:workspace:projA')).toBe(false);
    expect(fetched.some((f) => f.includes('/workspaces/'))).toBe(false);
  });
});

describe('Ask AURA (project scope) and the Workspace stay separate', () => {
  it('Ask AURA drives the agent and persists through project routes only', async () => {
    await useAgentConversations.getState().loadForProject('projA');
    await settle();
    void useAgentConversations.getState().send('Why is the retry failing?');
    await settle();

    expect(calls.submit.length).toBe(1);
    const writes = fetched.filter((f) => f.startsWith('POST') && f.includes('/message'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((f) => f.includes('/projects/projA/'))).toBe(true);
    expect(fetched.some((f) => f.includes('/workspaces/'))).toBe(false);
    expect(files.has('workspace:workspace:projA')).toBe(false);
  });

  it('the workspace execution chat persists through /workspaces routes only', async () => {
    await useAgentConversations.getState().loadForWorkspace('workspace:projA');
    await settle();
    void useAgentConversations.getState().send('Fix the onboarding bug');
    await settle();

    expect(calls.submit.length).toBe(1);
    const writes = fetched.filter((f) => f.startsWith('POST') && f.includes('/message'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((f) => f.includes('/workspaces/'))).toBe(true);
    expect(fetched.some((f) => f.includes('/projects/projA/conversations'))).toBe(false);
    expect(files.get('workspace:workspace:projA')?.[0]?.messages.length).toBe(2);
  });

  it('switching scopes resets the visible thread instead of carrying it across', async () => {
    await useAgentConversations.getState().loadForProject('projA');
    await settle();
    void useAgentConversations.getState().send('PROJECT ONLY MARKER zzz');
    await settle();
    expect(useAgentConversations.getState().messages.some((m) => m.content.includes('PROJECT ONLY MARKER zzz'))).toBe(true);

    await useAgentConversations.getState().loadForWorkspace('workspace:projA');
    await settle();
    expect(useAgentConversations.getState().scope).toBe('workspace');
    expect(useAgentConversations.getState().messages).toEqual([]);
    expect(JSON.stringify(useAgentConversations.getState().messages)).not.toContain('PROJECT ONLY MARKER zzz');
  });
});

describe('explicit handoff', () => {
  it('a project handoff only RECORDS an offer — nothing executes', async () => {
    useAgentConversations.setState({ scope: 'project', projectId: 'projA' });
    const h = await useAgentConversations.getState().handoffToWorkspace('conv-1', ['m1'], 'Build the retry path');

    expect(h.status).toBe('created');
    expect(handoffPosts).toHaveLength(1);
    expect(handoffPosts[0].url).toBe('/projects/projA/ask-aura/handoffs');
    expect(handoffPosts[0].body.targetWorkspaceId).toBe('workspace:projA');
    // Recording an offer never reaches the execution engine.
    expect(calls.submit).toEqual([]);
    expect(useAgentConversations.getState().messages).toEqual([]);
  });

  it('the workspace scope can never be a handoff source', async () => {
    useAgentConversations.setState({ scope: 'workspace', projectId: 'projA', workspaceId: 'workspace:projA' });
    await expect(
      useAgentConversations.getState().handoffToWorkspace('wconv-1', ['m1'], 'nope'),
    ).rejects.toThrow('only be sent from a project');
    expect(handoffPosts).toHaveLength(0);
    expect(calls.submit).toEqual([]);
  });
});
