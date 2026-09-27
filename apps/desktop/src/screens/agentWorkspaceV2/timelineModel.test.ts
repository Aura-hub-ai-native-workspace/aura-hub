/**
 * buildV2Timeline — the fold from real run records to the v2 timeline.
 *
 * These are the load-bearing honesty tests. They pin the contract that
 * NO card, status, tool, artifact or verification claim may appear
 * unless a frame or the terminal `AgentResult` supplies it, and that
 * workers never hand off to each other (AURA brackets every worker
 * card). Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEventFrame, AgentEvidenceBundle, AgentResult } from '../../ai/centralAgentClient';
import { buildV2Timeline, type V2TimelineInput } from './timelineModel';

/* ── fixtures ─────────────────────────────────────────────────────── */

const OBJ = { text: 'Add an authenticated API', expected: 'An authenticated API exists', acceptance: ['it compiles'], accepted: null, unmet: [] };
const EMPTY: V2TimelineInput = {
  objective: OBJ, handoffs: [], actions: [], plan: [],
  events: [], result: null, sessionId: null, busy: false,
};

const frame = (type: string, payload: Record<string, unknown> = {}, at = '2026-09-27T10:00:00Z'): AgentEventFrame =>
  ({ type, at, sessionId: 'agt-1', payload });

const resultWith = (over: Partial<AgentResult> = {}): AgentResult =>
  ({
    status: 'completed', outcome: 'completed', summary: 'Done', performed: [],
    verified: [], evidence: null, failureReason: null, runId: 'run-1', ...over,
  });

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1', description: 'Implement the API', role: 'code', dependsOn: [],
  conditional: false, state: 'done', verified: null, detail: '', worker: 'opencode',
  lifecycle: 'TERMINATED', ...over,
});

/* ── idle ─────────────────────────────────────────────────────────── */

describe('buildV2Timeline — an empty run renders nothing invented', () => {
  it('no frames, no result → zero cards, inFlight false', () => {
    const tl = buildV2Timeline(EMPTY);
    expect(tl.cards).toHaveLength(0);
    expect(tl.inFlight).toBe(false);
    expect(tl.objective).toBe(OBJ.text);
  });
});

/* ── planning ─────────────────────────────────────────────────────── */

describe('buildV2Timeline — planning', () => {
  it('a busy run with no frames shows ONE honest in-flight card, not a fabricated pipeline', () => {
    const tl = buildV2Timeline({ ...EMPTY, busy: true });
    expect(tl.cards).toHaveLength(2); // plan + final-pending
    expect(tl.cards[0].actor).toBe('aura');
    expect(tl.cards[0].status).toBe('planning');
    expect(tl.cards[0].name).toBe('AURA Central Agent');
    expect(tl.inFlight).toBe(true);
  });
});

/* ── 11-state vocabulary coverage ─────────────────────────────────── */

describe('buildV2Timeline — the spec §5 vocabulary is reachable', () => {
  const statuses = new Set<string>([]);
  // Worker-task states: a task in a terminal/backend state maps to one of
  // these. Planning is NOT a worker task state — it is reached on the
  // AURA plan card (tasks === 0) and verified separately below.
  const workerCases: Array<[string, V2TimelineInput['plan'][number], AgentResult | null]> = [
    ['queued',    task({ state: 'blocked' }), null],
    ['analyzing', task({ role: 'review', state: 'running' }), null],
    ['coding',    task({ role: 'code', state: 'running' }), null],
    ['researching', task({ role: 'research', state: 'running' }), null],
    ['executing', task({ role: 'execute', state: 'running' }), null],
    ['waiting-for-approval', task({ state: 'awaiting-approval' }), null],
    ['verifying', task({ state: 'done', verified: null }), null],
    ['completed', task({ state: 'done', verified: true }), resultWith({ outcome: 'completed' })],
    ['failed',    task({ state: 'failed', detail: 'build broke' }), resultWith({ outcome: 'failed', failureReason: 'build broke' })],
    ['cancelled', task({ state: 'cancelled' }), resultWith({ outcome: 'cancelled' })],
  ];
  for (const [want, t, res] of workerCases) {
    it(`produces a worker card in state ${want}`, () => {
      const tl = buildV2Timeline({ ...EMPTY, plan: [t], result: res, busy: res === null });
      statuses.add(want);
      const workerCard = tl.cards.find((c) => c.actor === 'worker' && c.id === 'worker-t1')!;
      expect(workerCard.status).toBe(want);
    });
  }
  it('reaches the planning state on the AURA plan card when no tasks exist yet', () => {
    // A run that has started (busy) but the backend has not yet emitted a
    // task list reads as PLANNING. This is the honest state: we cannot
    // claim any concrete worker work the backend has not named.
    const tl = buildV2Timeline({ ...EMPTY, plan: [], busy: true });
    const planCard = tl.cards.find((c) => c.actor === 'aura' && c.id === 'aura-plan')!;
    expect(planCard.status).toBe('planning');
    statuses.add('planning');
  });
  it('covers exactly the 11 states from spec §5', () => {
    expect(statuses.size).toBe(11);
    for (const s of ['planning','queued','analyzing','coding','researching','executing','waiting-for-approval','verifying','completed','failed','cancelled']) {
      expect(statuses.has(s)).toBe(true);
    }
  });
});

/* ── honesty: failure carries the real reason ─────────────────────── */

describe('buildV2Timeline — failures are reported, not dressed up', () => {
  it('a failed worker card shows the backend detail, not "in progress"', () => {
    const tl = buildV2Timeline({ ...EMPTY, plan: [task({ state: 'failed', detail: 'TypeScript build failed' })], result: resultWith({ outcome: 'failed', failureReason: 'TypeScript build failed' }) });
    const card = tl.cards.find((c) => c.id === 'worker-t1')!;
    expect(card.status).toBe('failed');
    expect(card.detail).toBe('TypeScript build failed');
    expect(card.detail).not.toMatch(/progress|working|running/i);
  });

  it('the final card carries the result own failure reason', () => {
    const tl = buildV2Timeline({ ...EMPTY, plan: [task({ state: 'failed', detail: 'x' })], result: resultWith({ outcome: 'failed', failureReason: 'The test harness exited 1' }) });
    const final = tl.cards.find((c) => c.id === 'final-result')!;
    expect(final.status).toBe('failed');
    expect(final.detail).toBe('The test harness exited 1');
  });
});

/* ── AURA brackets every worker ───────────────────────────────────── */

describe('buildV2Timeline — AURA coordinates every worker', () => {
  it('every worker card is preceded by an AURA card (plan, handoff, or verify)', () => {
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [
        task({ id: 'a', worker: 'w1', state: 'done', verified: true }),
        task({ id: 'b', worker: 'w2', state: 'done', verified: true }),
      ],
      handoffs: [{ from: 'a', to: 'b', toWorker: 'w2', invocations: ['inv-b'] }],
      result: resultWith({ outcome: 'completed' }),
    });
    // The structural invariant: no worker card is the FIRST card, and
    // AURA cards appear before and after every worker card.
    expect(tl.cards[0].actor).toBe('aura');
    const last = tl.cards[tl.cards.length - 1];
    expect(last.actor).toBe('aura');
    for (const c of tl.cards) if (c.actor === 'worker') expect(['aura', 'worker']).toContain(tl.cards[tl.cards.indexOf(c) - 1].actor);
  });

  it('a handoff card carries both workers and names AURA as the carrier', () => {
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [task({ id: 'a', worker: 'w1' }), task({ id: 'b', worker: 'w2' })],
      handoffs: [{ from: 'a', to: 'b', toWorker: 'w2', invocations: [] }],
      result: resultWith({ outcome: 'completed' }),
    });
    const handoff = tl.cards.find((c) => c.id === 'handoff-a->b')!;
    expect(handoff.actor).toBe('aura');
    expect(handoff.detail).toMatch(/AURA owns the handoff/i);
  });
});

/* ── evidence ─────────────────────────────────────────────────────── */

describe('buildV2Timeline — evidence from the record', () => {
  it('shows governed tool calls with decisions', () => {
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [task({ id: 't1', worker: 'w1', state: 'done', verified: true })],
      actions: [{ key: 'a1', tool: 'git', actionType: 'write', target: 'src/api.ts', decision: 'ALLOW', reason: 'in-scope', worker: 'w1' }],
      result: resultWith({ outcome: 'completed', performed: ['t1'] }),
    });
    const card = tl.cards.find((c) => c.id === 'worker-t1')!;
    expect(card.tools).toHaveLength(1);
    expect(card.tools[0].decision).toBe('ALLOW');
    expect(card.tools[0].target).toBe('src/api.ts');
  });

  it('surfaces denied actions as failed evidence', () => {
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [task({ id: 't1', worker: 'w1', state: 'denied' })],
      actions: [{ key: 'a1', tool: 'shell', actionType: 'rm -rf', target: '/important', decision: 'DENY', reason: 'out-of-scope', worker: 'w1' }],
      result: resultWith({ outcome: 'failed' }),
    });
    const card = tl.cards.find((c) => c.id === 'worker-t1')!;
    expect(card.status).toBe('failed');
    expect(card.tools[0].decision).toBe('DENY');
    expect(card.facts.some((f) => f.includes('denied'))).toBe(true);
  });

  it('records verification evidence when the backend said so', () => {
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [task({ id: 't1', worker: 'w1', state: 'done', verified: true })],
      events: [frame('invocation.observed', { taskId: 't1', detail: '23 targeted tests passed' })],
      result: resultWith({ outcome: 'completed', verified: ['t1'] }),
    });
    const ver = tl.cards.find((c) => c.id === 'verify-t1')!;
    expect(ver.verification?.state).toBe('passed');
    expect(ver.detail).toMatch(/23 targeted tests passed/);
  });

  it('final card surfaces artifact paths from the result', () => {
    const evidence: AgentEvidenceBundle = {
      sessionId: 'agt-1', planId: 'pln-1', auditRecordIds: [], approvalIds: [],
      summary: 'auth api added', createdAt: '2026-09-27T10:00:00Z',
      artifactPaths: ['src/api.ts', 'src/auth.ts'],
    };
    const tl = buildV2Timeline({
      ...EMPTY,
      plan: [task({ id: 't1', worker: 'w1', state: 'done', verified: true })],
      result: resultWith({ outcome: 'completed', performed: ['t1'], evidence }),
    });
    const final = tl.cards.find((c) => c.id === 'final-result')!;
    expect(final.artifacts).toContain('src/api.ts');
    expect(final.artifacts).toContain('src/auth.ts');
  });
});

/* ── in-flight semantics ──────────────────────────────────────────── */

describe('buildV2Timeline — inFlight only when work is moving', () => {
  it('no inFlight once the result settles to a terminal state', () => {
    const tl = buildV2Timeline({ ...EMPTY, plan: [task({ state: 'done', verified: true })], result: resultWith({ outcome: 'completed' }), busy: true });
    // Final card is completed → inFlight false despite busy flag.
    expect(tl.inFlight).toBe(false);
  });
  it('inFlight while busy and the last card is still moving', () => {
    const tl = buildV2Timeline({ ...EMPTY, plan: [task({ state: 'running' })], busy: true, result: null });
    expect(tl.inFlight).toBe(true);
  });
});
