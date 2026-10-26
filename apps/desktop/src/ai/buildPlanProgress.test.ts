import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
vi.mock('./missionClient', async (orig) => ({ ...(await orig<object>()), missionClient: { create: (...a: unknown[]) => create(...a) } }));
vi.mock('./centralAgentClient', async (orig) => ({
  ...(await orig<object>()),
  centralAgentClient: { contextPackage: async () => ({ text: 'ctx', records: 3, available: 3, budgetChars: 1, scope: 'p', goal: 'Build GREETING.md' }) },
}));

import { useAgentConversations, type AgentChatMessage } from './useAgentConversations';

const message = (): AgentChatMessage => ({
  id: 'm1', role: 'assistant', content: 'x', status: 'done',
  agent: { sessionId: 's', outcome: 'completed', requestId: null, progress: [], events: [], plan: null, performed: [], verified: [], evidenceSummary: null, runId: null, needsInput: false, cancelled: false, tools: [], nextActions: ['create-plan'] },
});
const draft = () => useAgentConversations.getState().messages[0].agent?.planDraft;

beforeEach(() => {
  create.mockReset();
  useAgentConversations.setState({ projectId: 'p', messages: [message()] } as never);
});

describe('building a plan from chat', () => {
  it('starts one plan however many times the button is hit, and shows only reported progress', async () => {
    let emit!: (e: unknown) => void;
    let finish!: () => void;
    create.mockImplementation((_p, _g, on) => new Promise<void>((res) => {
      emit = on;
      finish = () => { on({ type: 'done', mission: { id: 'mis-1', goalGraph: { tasks: [{}, {}] } } }); res(); };
    }));
    const { buildPlan } = useAgentConversations.getState();
    const first = buildPlan('m1');
    void buildPlan('m1'); void buildPlan('m1');                       // rapid repeat clicks
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(draft()?.status).toBe('building');

    emit({ type: 'stage', stage: 'plan', status: 'start', at: 't' });
    emit({ type: 'progress', stage: 'plan', elapsedMs: 35_000, deadlineMs: 480_000, receivedChars: 910 });
    expect(draft()).toMatchObject({ status: 'building', stage: 'plan', elapsedMs: 35_000, receivedChars: 910 });

    finish(); await first;
    expect(draft()).toMatchObject({ status: 'ready', missionId: 'mis-1', taskCount: 2 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a stop aborts the request, keeps nothing, says so, and allows a fresh attempt', async () => {
    let signal!: AbortSignal;
    create.mockImplementation((_p, _g, _on, sig) => new Promise<void>((res) => { signal = sig; sig.addEventListener('abort', () => res()); }));
    const run = useAgentConversations.getState().buildPlan('m1');
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    useAgentConversations.getState().cancelPlan('m1');
    await run;
    expect(signal.aborted).toBe(true);
    expect(draft()).toMatchObject({ status: 'failed' });
    expect(draft()?.error).toContain('Stopped before the plan was finished');

    create.mockImplementation(async (_p, _g, on) => { on({ type: 'done', mission: { id: 'mis-2', goalGraph: { tasks: [{}] } } }); });
    await useAgentConversations.getState().buildPlan('m1');           // not blocked by the stopped attempt
    expect(draft()).toMatchObject({ status: 'ready', missionId: 'mis-2' });
  });

  it('a stop that arrives after the plan already finished does not disown the plan', async () => {
    let finish!: () => void;
    create.mockImplementation((_p, _g, on) => new Promise<void>((res) => {
      finish = () => { on({ type: 'done', mission: { id: 'mis-9', goalGraph: { tasks: [{}] } } }); res(); };
    }));
    const run = useAgentConversations.getState().buildPlan('m1');
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    finish();
    useAgentConversations.getState().cancelPlan('m1');               // too late: the plan is already back
    await run;
    expect(draft()).toMatchObject({ status: 'ready', missionId: 'mis-9' });
  });

  it('a Planner failure or timeout shows its own measured reason, not a generic one', async () => {
    create.mockImplementation(async (_p, _g, on) => {
      on({ type: 'error', message: 'Planning failed: The request to Ollama (self-hosted) timed out after 480s (limit 480s).' });
      on({ type: 'done', mission: { id: 'mis-3', error: 'Planning failed: The request to Ollama (self-hosted) timed out after 480s (limit 480s).', goalGraph: null } });
    });
    await useAgentConversations.getState().buildPlan('m1');
    expect(draft()?.status).toBe('failed');
    expect(draft()?.error).toContain('timed out after 480s');
  });
});
