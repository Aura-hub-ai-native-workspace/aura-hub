/**
 * Chat scope separation — one engine, two scopes, no leakage.
 * ==================================================================
 * The root cause this suite holds in place: the conversation store was
 * keyed only by projectId, so the Hub workspace shared the project's
 * Ask AURA transcript. Now the engine carries a scope (project =
 * ask_aura, workspace = execution), each scope lists and persists
 * through its OWN routes, and every turn captures its owner at send()
 * time so a late stream frame can never be persisted into the other
 * scope.
 *
 * Only the two clients are mocked: `centralAgentClient` so a turn can
 * be held in flight and resumed by the test, and `aiClient` so the
 * persistence ROUTE (project vs workspace) is observable. The store,
 * its scope guards and its owner capture are the real ones.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the mock surface ────────────────────────────────────────────── */

interface MockMsg { id: string; role: 'user' | 'assistant'; content: string; at: string; meta?: unknown; error?: boolean }
interface MockConv {
  id: string; title: string; createdAt: string; updatedAt: string;
  messages: MockMsg[]; scope?: string; kind?: string;
  projectId?: string; workspaceId?: string; archived?: boolean;
}

const projectConvs = new Map<string, MockConv[]>();
const workspaceConvs = new Map<string, MockConv[]>();

/** Every persistence call, recorded by ROUTE so tests can assert scope. */
const appendedProject: { pid: string; cid: string; msg: { role: string; content: string } }[] = [];
const appendedWorkspace: { wsId: string; cid: string; msg: { role: string; content: string } }[] = [];
const createdHandoffs: { projectId: string; input: { sourceConversationId: string; sourceMessageIds: string[]; title: string; targetWorkspaceId: string } }[] = [];
const acceptedHandoffs: { projectId: string; hid: string; workspaceId: string; conversationId?: string }[] = [];

let convSeq = 0;
const mkConv = (prefix: string, over: Partial<MockConv> = {}): MockConv => {
  convSeq += 1;
  const now = new Date().toISOString();
  return { id: `${prefix}_c${convSeq}`, title: 'New conversation', createdAt: now, updatedAt: now, messages: [], ...over };
};

const summaries = (items: MockConv[]) =>
  items.filter((c) => !c.archived).map((c) => ({
    id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messageCount: c.messages.length, preview: c.messages[c.messages.length - 1]?.content.slice(0, 80) ?? '',
    scope: c.scope, kind: c.kind,
  }));

vi.mock('./aiClient', () => ({
  aiClient: {
    listConversations: (pid: string) => Promise.resolve({ conversations: summaries(projectConvs.get(pid) ?? []) }),
    getConversation: (pid: string, cid: string) => {
      const c = (projectConvs.get(pid) ?? []).find((x) => x.id === cid);
      return c ? Promise.resolve({ ...c, messages: [...c.messages] }) : Promise.reject(new Error('no such conversation'));
    },
    createConversation: (pid: string) => {
      const c = mkConv('conv', { scope: 'project', kind: 'ask_aura', projectId: pid });
      projectConvs.set(pid, [c, ...(projectConvs.get(pid) ?? [])]);
      return Promise.resolve({ ...c, messages: [] });
    },
    renameConversation: (pid: string, cid: string, title: string) => {
      const c = (projectConvs.get(pid) ?? []).find((x) => x.id === cid);
      if (!c) return Promise.reject(new Error('no such conversation'));
      c.title = title;
      return Promise.resolve({ ...c });
    },
    removeConversation: (pid: string, cid: string) => {
      projectConvs.set(pid, (projectConvs.get(pid) ?? []).filter((x) => x.id !== cid));
      return Promise.resolve({ ok: true });
    },
    appendMessage: (pid: string, cid: string, msg: { role: 'user' | 'assistant'; content: string }) => {
      appendedProject.push({ pid, cid, msg });
      const c = (projectConvs.get(pid) ?? []).find((x) => x.id === cid);
      c?.messages.push({ id: `m${c.messages.length + 1}`, role: msg.role, content: msg.content, at: new Date().toISOString() });
      return Promise.resolve({ id: `m${c?.messages.length ?? 1}`, role: msg.role, content: msg.content, at: new Date().toISOString() });
    },
    removeLastAssistantMessage: () => Promise.resolve({ ok: true }),

    listWorkspaceConversations: (wsId: string) => Promise.resolve({ conversations: summaries(workspaceConvs.get(wsId) ?? []) }),
    getWorkspaceConversation: (wsId: string, cid: string) => {
      const c = (workspaceConvs.get(wsId) ?? []).find((x) => x.id === cid);
      return c ? Promise.resolve({ ...c, messages: [...c.messages] }) : Promise.reject(new Error('no such conversation'));
    },
    createWorkspaceConversation: (wsId: string) => {
      const pid = wsId.startsWith('workspace:') ? wsId.slice('workspace:'.length) : wsId;
      const c = mkConv('wconv', { scope: 'workspace', kind: 'execution', projectId: pid, workspaceId: wsId });
      workspaceConvs.set(wsId, [c, ...(workspaceConvs.get(wsId) ?? [])]);
      return Promise.resolve({ ...c, messages: [] });
    },
    renameWorkspaceConversation: (wsId: string, cid: string, title: string) => {
      const c = (workspaceConvs.get(wsId) ?? []).find((x) => x.id === cid);
      if (!c) return Promise.reject(new Error('no such conversation'));
      c.title = title;
      return Promise.resolve({ ...c });
    },
    removeWorkspaceConversation: (wsId: string, cid: string) => {
      workspaceConvs.set(wsId, (workspaceConvs.get(wsId) ?? []).filter((x) => x.id !== cid));
      return Promise.resolve({ ok: true });
    },
    appendWorkspaceMessage: (wsId: string, cid: string, msg: { role: 'user' | 'assistant'; content: string }) => {
      appendedWorkspace.push({ wsId, cid, msg });
      const c = (workspaceConvs.get(wsId) ?? []).find((x) => x.id === cid);
      c?.messages.push({ id: `m${c.messages.length + 1}`, role: msg.role, content: msg.content, at: new Date().toISOString() });
      return Promise.resolve({ id: `m${c?.messages.length ?? 1}`, role: msg.role, content: msg.content, at: new Date().toISOString() });
    },
    removeLastWorkspaceAssistantMessage: () => Promise.resolve({ ok: true }),

    createHandoff: (projectId: string, input: { sourceConversationId: string; sourceMessageIds: string[]; title: string; targetWorkspaceId: string }) => {
      createdHandoffs.push({ projectId, input });
      return Promise.resolve({
        id: 'hnd_new', projectId, ...input, status: 'created',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    },
    listHandoffs: () => Promise.resolve({ handoffs: [] }),
    listWorkspaceHandoffs: () => Promise.resolve({ handoffs: [] }),
    acceptHandoff: (projectId: string, hid: string, input: { workspaceId: string; conversationId?: string }) => {
      acceptedHandoffs.push({ projectId, hid, ...input });
      return Promise.resolve({
        id: hid, projectId, sourceConversationId: 'conv_x', sourceMessageIds: ['m1'],
        title: 't', targetWorkspaceId: input.workspaceId, status: 'accepted',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    },
    cancelHandoff: () => Promise.reject(new Error('unused in tests')),
    completeHandoff: () => Promise.reject(new Error('unused in tests')),
  },
}));

/* The Central Agent client: turns are held in flight until the test
   resolves them, and frames are emitted through the captured sink. */
let emit: ((frame: unknown) => void) | null = null;
const cancels: { sid: string; reason: string }[] = [];
let resolveSubmit: ((r: unknown) => void) | null = null;

vi.mock('./centralAgentClient', () => ({
  newClientSessionId: () => 'agt-test',
  centralAgentClient: {
    health: () => Promise.resolve({ ok: true }),
    events: (_sid: string, cb: (frame: unknown) => void) => {
      emit = cb;
      return () => { emit = null; };
    },
    submit: () => new Promise((resolve) => { resolveSubmit = resolve; }),
    message: () => new Promise(() => { /* unused */ }),
    cancel: (sid: string, reason: string) => { cancels.push({ sid, reason }); return Promise.resolve(); },
    planReview: () => Promise.resolve(null),
  },
}));

const { useAgentConversations } = await import('./useAgentConversations');

const state = () => useAgentConversations.getState();
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

const DONE_RESULT = {
  sessionId: 'agt-test',
  requestId: 'req-1',
  result: { outcome: 'completed', summary: 'Work is done.', performed: [], verified: [], evidenceSummary: null },
};

beforeEach(() => {
  projectConvs.clear();
  workspaceConvs.clear();
  appendedProject.length = 0;
  appendedWorkspace.length = 0;
  createdHandoffs.length = 0;
  acceptedHandoffs.length = 0;
  cancels.length = 0;
  emit = null;
  resolveSubmit = null;
});

/* ── scope identity ──────────────────────────────────────────────── */

describe('scope identity', () => {
  it('loadForProject puts the store in project/ask_aura scope with its own threads', async () => {
    projectConvs.set('p1', [mkConv('conv', { scope: 'project', kind: 'ask_aura', projectId: 'p1', title: 'Design notes' })]);
    await state().loadForProject('p1');
    await settle();

    expect(state().scope).toBe('project');
    expect(state().workspaceId).toBeNull();
    expect(state().conversations.map((c) => c.title)).toEqual(['Design notes']);
    expect(state().activeId).toBe('conv_c1');
  });

  it('loadForWorkspace puts the store in workspace/execution scope and auto-creates the first execution chat', async () => {
    await state().loadForWorkspace('workspace:p1');
    await settle();

    expect(state().scope).toBe('workspace');
    expect(state().workspaceId).toBe('workspace:p1');
    expect(state().projectId).toBe('p1');
    expect(workspaceConvs.has('workspace:p1')).toBe(true);
    const first = workspaceConvs.get('workspace:p1')![0];
    expect(first.kind).toBe('execution');
    expect(first.id.startsWith('wconv_')).toBe(true);
    expect(state().activeId).toBe(first.id);
  });
});

/* ── transcript isolation ────────────────────────────────────────── */

describe('transcript isolation', () => {
  it('the project discussion never appears in the workspace chat', async () => {
    projectConvs.set('p1', [mkConv('conv', {
      projectId: 'p1',
      messages: [{ id: 'm1', role: 'user', content: 'Discuss the retry policy', at: new Date().toISOString() }],
    })]);
    await state().loadForProject('p1');
    await settle();
    expect(state().messages.map((m) => m.content)).toContain('Discuss the retry policy');

    await state().loadForWorkspace('workspace:p1');
    await settle();
    // A different conversation family, a different id space, no shared text.
    expect(state().activeId?.startsWith('wconv_')).toBe(true);
    expect(state().messages.map((m) => m.content)).not.toContain('Discuss the retry policy');
    expect(state().messages).toHaveLength(0);
  });

  it('a workspace turn persists through the workspace routes only', async () => {
    await state().loadForWorkspace('workspace:p1');
    await settle();
    void state().send('run the test suite');
    await settle();
    resolveSubmit?.(DONE_RESULT);
    await settle();

    expect(appendedWorkspace.map((a) => a.msg.content)).toContain('run the test suite');
    expect(appendedWorkspace.map((a) => a.msg.content)).toContain('Work is done.');
    expect(appendedProject).toHaveLength(0);
  });

  it('a project turn persists through the project routes only', async () => {
    await state().loadForProject('p2');
    await settle();
    void state().send('explain the retry policy');
    await settle();
    resolveSubmit?.(DONE_RESULT);
    await settle();

    expect(appendedProject.map((a) => a.msg.content)).toContain('explain the retry policy');
    expect(appendedProject.map((a) => a.msg.content)).toContain('Work is done.');
    expect(appendedWorkspace).toHaveLength(0);
  });
});

/* ── streaming isolation ─────────────────────────────────────────── */

describe('streaming isolation', () => {
  it('a turn still in flight when the surface changes never leaks into the new scope', async () => {
    await state().loadForProject('p3');
    await settle();
    void state().send('long running thing');
    await settle();
    expect(state().phase).toBe('working');

    // The user walks to the workspace mid-stream.
    await state().loadForWorkspace('workspace:p3');
    await settle();
    expect(state().phase).toBe('idle');
    expect(state().messages).toHaveLength(0);

    // The old turn completes afterwards: its result must land in the
    // PROJECT family (if anywhere), never the workspace transcript.
    resolveSubmit?.(DONE_RESULT);
    await settle();
    expect(appendedWorkspace).toHaveLength(0);
    expect(state().messages).toHaveLength(0);
  });

  it('a late stream token from the abandoned subscription is dropped', async () => {
    await state().loadForProject('p4');
    await settle();
    void state().send('stream me');
    await settle();
    const lateEmit = emit;
    expect(lateEmit).toBeTruthy();

    await state().loadForWorkspace('workspace:p4');
    await settle();
    lateEmit?.({ type: 'answer.token', sessionId: 'agt-test', payload: { text: 'LEAKED TOKEN' } });
    await settle();

    expect(JSON.stringify(state().messages)).not.toContain('LEAKED TOKEN');
    expect(appendedWorkspace).toHaveLength(0);
  });

  it('stop() inside the workspace scope cancels with the workspace label', async () => {
    await state().loadForWorkspace('workspace:p5');
    await settle();
    void state().send('halt me');
    await settle();
    state().stop();
    await settle();

    expect(cancels).toHaveLength(1);
    expect(cancels[0].reason).toBe('cancelled from Execution Chat');
    expect(state().phase).toBe('idle');
    expect(state().messages[0].status).toBe('done'); // the user turn
    expect(state().messages[1].status).toBe('cancelled');
  });
});

/* ── handoffs ────────────────────────────────────────────────────── */

describe('handoffs', () => {
  it('a project conversation can be handed to its workspace', async () => {
    await state().loadForProject('p6');
    await settle();
    const cid = state().activeId as string;

    const h = await state().handoffToWorkspace(cid, ['m1', 'm2'], 'Build the retry path', 'tests pass');
    expect(createdHandoffs).toHaveLength(1);
    expect(createdHandoffs[0].projectId).toBe('p6');
    expect(createdHandoffs[0].input.targetWorkspaceId).toBe('workspace:p6');
    expect(createdHandoffs[0].input.sourceConversationId).toBe(cid);
    expect(h.status).toBe('created');
  });

  it('the workspace scope cannot hand off — execution is a destination, never a source', async () => {
    await state().loadForWorkspace('workspace:p7');
    await settle();
    await expect(state().handoffToWorkspace(state().activeId ?? 'x', ['m1'], 'nope'))
      .rejects.toThrow('only be sent from a project');
    expect(createdHandoffs).toHaveLength(0);
  });

  it('accepting a handoff in the workspace targets the active execution chat', async () => {
    await state().loadForWorkspace('workspace:p8');
    await settle();
    const active = state().activeId as string;

    await state().acceptHandoff({
      id: 'hnd_9', projectId: 'p8', sourceConversationId: 'conv_9', sourceMessageIds: ['m1'],
      title: 'Do it', targetWorkspaceId: 'workspace:p8', status: 'created',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await settle();

    expect(acceptedHandoffs).toHaveLength(1);
    expect(acceptedHandoffs[0]).toMatchObject({ projectId: 'p8', hid: 'hnd_9', workspaceId: 'workspace:p8', conversationId: active });
  });
});
