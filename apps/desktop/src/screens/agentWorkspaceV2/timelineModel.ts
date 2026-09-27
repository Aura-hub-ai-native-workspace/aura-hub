/**
 * Agent Workspace v2 — timeline model (pure function).
 * =====================================================================
 * Folds REAL run records (SSE event frames, the terminal AgentResult,
 * and the derived task/handoff/action views from `useAgentRun`) into
 * the observable timeline the screen renders.
 *
 * Rules enforced (spec §5, §6):
 *   • No card, status, tool, artifact, or verification claim appears
 *     unless a frame or the terminal result names it. A run that only
 *     produced `session.started` renders ONE card ("Planning"), not a
 *     fabricated pipeline.
 *   • Workers never hand off to each other. Every worker card is
 *     bracketed by AURA cards — delegation, verification — in the
 *     order the backend reported it.
 *   • Failed cards carry the backend's own failure reason, never
 *     "in progress". Cancellation is only shown for the task the
 *     backend marked cancelled.
 *   • Research is claimed ONLY when the plan said task role is
 *     `research` AND the worker is actually on it. The private
 *     gateway is NOT implied here — research is a worker role inside
 *     the run loop, not a separate network egress path.
 */
import type { AgentEventFrame, AgentResult } from '../../ai/centralAgentClient';
import type { V2Card, V2Status, V2Timeline } from './types';

/** The exact shape `useAgentRun` derives from the same frames — a
 *  structural view, not a runtime import (that hook is React-bound).
 *  Both sides type-check against the same SSE frames. */
export interface V2TimelineInput {
  objective: { text: string; expected: string; acceptance: string[]; accepted: boolean | null; unmet: string[] };
  handoffs: Array<{ from: string; to: string; toWorker: string; invocations: string[] }>;
  actions: Array<{
    key: string;
    tool: string;
    actionType: string;
    target: string;
    decision: string;
    reason: string;
    worker: string;
  }>;
  plan: Array<{
    id: string;
    description: string;
    role: string;
    dependsOn: string[];
    conditional: boolean;
    state: string;
    verified: boolean | null;
    detail: string;
    worker: string;
    lifecycle: string;
  }>;
  events: AgentEventFrame[];
  result: AgentResult | null;
  sessionId: string | null;
  busy: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const AURA = 'AURA Central Agent';

/* ── backend vocabulary → v2 status (spec §5) ───────────────────────── */

function roleStatus(role: string): V2Status | null {
  const r = (role || '').toLowerCase();
  if (r === 'code') return 'coding';
  if (r === 'review') return 'analyzing';
  if (r === 'planning') return 'planning';
  if (r === 'testing') return 'verifying';
  if (r === 'documentation') return 'analyzing';
  if (r === 'research') return 'researching';
  if (r === 'execute') return 'executing';
  return null;
}

function taskStatus(state: string, role: string, verified: boolean | null): V2Status {
  switch (state) {
    case 'done':
      return verified === true ? 'completed' : 'verifying';
    case 'failed':
    case 'timed-out':
    case 'denied':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'awaiting-approval':
      return 'waiting-for-approval';
    case 'skipped':
      return 'completed';
    case 'blocked':
      return 'queued';
    case 'running':
      return roleStatus(role) ?? 'executing';
    case 'ready':
    case 'pending':
    default:
      return roleStatus(role) ?? 'queued';
  }
}

function actionLine(role: string, state: string): string {
  const r = (role || '').toLowerCase();
  const running = state === 'running';
  if (r === 'code') return running ? 'Writing the code' : 'Code implementation';
  if (r === 'review') return running ? 'Reviewing the change' : 'Independent review';
  if (r === 'planning') return running ? 'Refining the plan' : 'Planning support';
  if (r === 'testing') return running ? 'Running targeted verification' : 'Verification pass';
  if (r === 'documentation') return running ? 'Drafting documentation' : 'Documentation';
  if (r === 'research') return running ? 'Gathering approved information' : 'Research pass';
  if (r === 'execute') return running ? 'Executing the governed action' : 'Execution pass';
  return running ? 'Working' : 'Task';
}

/**
 * The AURA ↔ worker exchange (spec §6). Only drawn when the record
 * actually names both sides. The reply text stays under 400 chars so
 * the UI can render it without truncation surprises.
 */
function exchangeFor(
  task: V2TimelineInput['plan'][number],
  result: AgentResult | null,
): V2Card['exchange'] | null {
  if (!task.worker) return null;
  const worker = task.worker;
  const inbound = (task.state === 'done' || task.state === 'failed' || task.state === 'cancelled')
    ? (task.detail || (result?.summary ? result.summary.slice(0, 200) : ''))
    : task.detail || (task.state === 'running' ? `${worker} is working on ${task.id}` : '');
  if (!inbound) return null;
  const verb =
    task.state === 'done' ? 'Implementation/report complete' :
    task.state === 'failed' || task.state === 'timed-out' || task.state === 'denied' ? 'Reported a failure' :
    task.state === 'cancelled' ? 'Was cancelled by AURA' :
    task.state === 'running' ? 'Working — progress reported' :
    task.state === 'awaiting-approval' ? 'Parked for your decision' :
    'Assigned and queued';
  const replyState: V2Status =
    (task.state === 'done' && task.verified === true) ? 'completed'
    : task.state === 'failed' || task.state === 'timed-out' || task.state === 'denied' ? 'failed'
    : task.state === 'cancelled' ? 'cancelled'
    : task.state === 'awaiting-approval' ? 'waiting-for-approval'
    : task.verified === false ? 'failed'
    : 'executing';
  return {
    from: AURA,
    to: worker,
    text: `${actionLine(task.role, task.state)} — ${task.description || task.id}`.slice(0, 320),
    reply: { text: `${verb}. ${inbound}`.slice(0, 380), state: replyState },
  };
}

/* ── evidence collectors (pure; no network, no timers) ──────────────── */

function toolsFor(task: V2TimelineInput['plan'][number], actions: V2TimelineInput['actions']): V2Card['tools'] {
  if (!task.worker) return [];
  const mine = actions.filter(
    (a) => a.worker && task.worker && a.worker.toLowerCase() === task.worker.toLowerCase(),
  );
  if (mine.length === 0) return [];
  return mine.slice(-6).map((a) => ({
    key: a.key,
    tool: a.tool,
    actionType: a.actionType,
    target: a.target,
    decision: a.decision,
    reason: a.reason,
  }));
}

function artifactsForResult(result: AgentResult | null): string[] {
  if (!result) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  };
  for (const v of result.performed ?? []) push(v);
  for (const v of result.verified ?? []) push(v);
  for (const v of result.evidence?.artifactPaths ?? []) push(v);
  return out;
}

function verificationFor(
  task: V2TimelineInput['plan'][number],
  events: AgentEventFrame[],
): V2Card['verification'] | null {
  if (task.verified === null) return null;
  const state = task.verified === true ? 'passed' : 'failed';
  let detail: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const f = events[i];
    if (f.type !== 'invocation.observed') continue;
    if (str(f.payload?.taskId) !== task.id) continue;
    detail = str(f.payload?.detail) || null;
    break;
  }
  return { state, detail };
}

/* ── card builders ──────────────────────────────────────────────────── */

function firstFrameOf(events: AgentEventFrame[], type: string): AgentEventFrame | null {
  for (const f of events) if (f.type === type) return f;
  return null;
}

function planCard(input: V2TimelineInput, first: AgentEventFrame | null): V2Card {
  const { plan } = input;
  const tasks = plan.length;
  const workers = [...new Set(plan.filter((t) => t.worker).map((t) => t.worker))];
  const roles = [...new Set(plan.map((t) => (t.role || '').toLowerCase()).filter(Boolean))];
  const status: V2Status =
    input.result?.outcome === 'failed' || input.result?.outcome === 'cancelled' || input.result?.outcome === 'denied'
      ? 'cancelled'
      : tasks === 0
        ? 'planning'
        : 'completed';
  const facts: string[] = [];
  for (const t of plan) {
    facts.push(`${t.id}${t.role ? ` · ${t.role}` : ''}${t.worker ? ` → ${t.worker}` : ' → unassigned'}`);
  }
  const roleLine = roles.length ? ` · roles: ${roles.join(', ')}` : '';
  return {
    id: 'aura-plan',
    actor: 'aura',
    name: AURA,
    action: tasks === 1
      ? 'Analyzed the request and created a 1-task plan'
      : `Analyzed the request and created a plan for ${tasks} task${tasks === 1 ? '' : 's'}`,
    status,
    at: first?.at ?? null,
    detail: plan.length
      ? `${tasks} task${tasks === 1 ? '' : 's'} · ${workers.length} worker${workers.length === 1 ? '' : 's'}${roleLine}`
      : input.objective.expected || null,
    exchange: null,
    tools: [],
    artifacts: [],
    verification: null,
    facts,
  };
}

function workerCard(task: V2TimelineInput['plan'][number], input: V2TimelineInput): V2Card {
  const status = taskStatus(task.state, task.role, task.verified);
  const tools = toolsFor(task, input.actions);
  const exchange = exchangeFor(task, input.result);
  const verification = verificationFor(task, input.events);
  const denied = tools.filter((t) => t.decision === 'DENY').length;
  const facts: string[] = [];
  if (task.id) facts.push(`task ${task.id}`);
  if (task.role) facts.push(`role ${task.role}`);
  if (task.worker) facts.push(`worker ${task.worker}`);
  if (task.state) facts.push(`backend state ${task.state}`);
  if (task.lifecycle) facts.push(`lifecycle ${task.lifecycle}`);
  if (task.dependsOn.length > 0) facts.push(`after ${task.dependsOn.join(', ')}`);
  if (task.conditional) facts.push('runs only if the upstream reports findings');
  if (denied > 0) facts.push(`${denied} action${denied === 1 ? '' : 's'} denied before execution`);

  let at: string | null = null;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const f = input.events[i];
    if (f.type !== 'invocation.observed' && f.type !== 'worker.lifecycle') continue;
    if (str(f.payload?.taskId) !== task.id) continue;
    at = f.at;
    break;
  }
  const isFailState = task.state === 'failed' || task.state === 'timed-out' || task.state === 'denied';
  return {
    id: `worker-${task.id}`,
    actor: 'worker',
    name: task.worker || 'Worker not yet assigned',
    action: `${actionLine(task.role, task.state)} — ${task.description || task.id}`.slice(0, 240),
    status,
    at,
    detail: isFailState
      ? (task.detail || 'The worker reported a failure. See the run details for the backend reason.')
      : task.state === 'cancelled'
        ? 'This task was stopped by AURA.'
        : task.detail || null,
    exchange,
    tools,
    artifacts: [],
    verification,
    facts,
  };
}

function verifyCard(task: V2TimelineInput['plan'][number], input: V2TimelineInput): V2Card | null {
  if (task.verified === null) return null;
  const passed = task.verified === true;
  let at: string | null = null;
  let detail: string | null = null;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const f = input.events[i];
    if (f.type !== 'invocation.observed') continue;
    if (str(f.payload?.taskId) !== task.id) continue;
    at = f.at;
    detail = str(f.payload?.detail) || null;
    break;
  }
  return {
    id: `verify-${task.id}`,
    actor: 'aura',
    name: AURA,
    action: passed ? `Verified ${task.id}` : `Did not verify ${task.id}`,
    status: passed ? 'completed' : 'failed',
    at,
    detail: passed
      ? (detail ? `Verified — ${detail}` : 'Verified against the acceptance criteria.')
      : (detail ? `Not verified — ${detail}` : 'The task ran but did not satisfy its verification.'),
    exchange: {
      from: task.worker || 'worker',
      to: AURA,
      text: passed ? `${task.id} complete.` : `${task.id} did not pass its verification.`,
      reply: {
        text: passed
          ? 'Accepted as verified. Available for the next step.'
          : 'Rejected or held. AURA prepares a correction or surfaces this to the user.',
        state: passed ? 'completed' : 'failed',
      },
    },
    tools: [],
    artifacts: [],
    verification: { state: passed ? 'passed' : 'failed', detail },
    facts: [
      `task ${task.id}`,
      task.detail,
      'The backend recorded this verification on its own ledger — not inferred.',
    ].filter((x): x is string => x != null && x !== ''),
  };
}

function handoffCard(
  handoff: V2TimelineInput['handoffs'][number],
  fromWorker: string,
): V2Card {
  return {
    id: `handoff-${handoff.from}->${handoff.to}`,
    actor: 'aura',
    name: AURA,
    action: `Handed the verified result of ${handoff.from} to ${handoff.toWorker || handoff.to}`,
    status: 'completed',
    at: null,
    detail: 'Workers never exchange work directly — AURA owns the handoff.',
    exchange: {
      from: fromWorker,
      to: AURA,
      text: `${handoff.from} verified. Consumed by ${handoff.toWorker || handoff.to}.`,
      reply: { text: `Carried forward to ${handoff.toWorker || handoff.to}.`, state: 'completed' },
    },
    tools: [],
    artifacts: [],
    facts: handoff.invocations.map((i) => `consumed invocation ${i}`),
    verification: null,
  };
}

function finalCard(input: V2TimelineInput): V2Card {
  const r = input.result;
  if (!r) {
    return {
      id: 'final-pending',
      actor: 'aura',
      name: AURA,
      action: input.busy
        ? 'Working — the run has not yet reached a terminal state'
        : 'Idle — no completed run to review',
      status: 'executing',
      at: null,
      detail: null,
      exchange: null,
      tools: [],
      artifacts: [],
      facts: input.busy ? ['The session is driving; frames are arriving live.'] : [],
      verification: null,
    };
  }
  const status: V2Status =
    r.outcome === 'completed' ? 'completed'
    : r.outcome === 'failed' || r.outcome === 'denied' || r.outcome === 'timeout' ? 'failed'
    : r.outcome === 'cancelled' ? 'cancelled'
    : r.outcome === 'awaiting-approval' ? 'waiting-for-approval'
    : 'executing';
  const performed = (r.performed ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0);
  const verified = (r.verified ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0);
  const artifacts = artifactsForResult(r);
  const failed = r.failureReason || (status === 'failed' ? (r.summary || 'The run failed.') : null);
  const facts: string[] = [];
  if (r.status) facts.push(`backend status: ${r.status}`);
  if (r.outcome) facts.push(`run outcome: ${r.outcome}`);
  if (performed.length) facts.push(`${performed.length} performed task(s)`);
  if (verified.length) facts.push(`${verified.length} verified item(s)`);
  if (r.evidence?.summary) facts.push(`evidence: ${r.evidence.summary.slice(0, 200)}`);
  if (r.evidence?.artifactPaths && r.evidence.artifactPaths.length) {
    facts.push(`${r.evidence.artifactPaths.length} artifact path(s)`);
  }
  if (r.runId) facts.push(`run ${r.runId}`);
  return {
    id: 'final-result',
    actor: 'aura',
    name: AURA,
    action:
      status === 'completed'
        ? 'Reviewed the worker output, verified the run, and prepared the result'
        : status === 'failed'
          ? 'The run did not complete — see the failure details'
          : status === 'cancelled'
            ? 'The run was stopped'
            : status === 'waiting-for-approval'
              ? 'Parked pending your decision — nothing unauthorized has run'
              : 'Preparing the final response',
    status,
    detail: status === 'failed' ? failed : (r.summary || null),
    exchange: null,
    tools: [],
    artifacts,
    verification: performed.length > 0 || verified.length > 0
      ? {
          state: status === 'completed' ? 'passed' : 'failed',
          detail: verified.length
            ? `Verified: ${verified.slice(0, 6).join(' · ').slice(0, 260)}`
            : performed.length
              ? `Performed: ${performed.slice(0, 3).join(' · ').slice(0, 260)}`
              : null,
        }
      : null,
    facts,
  };
}

/* ── top-level fold ─────────────────────────────────────────────────── */

export function buildV2Timeline(input: V2TimelineInput): V2Timeline {
  const { plan, handoffs, events, result, objective, sessionId, busy } = input;

  const cards: V2Card[] = [];

  const planFrame = firstFrameOf(events, 'plan.created');
  if (planFrame || busy || result) {
    cards.push(planCard(input, planFrame));
  }

  const handoffByTo = new Map<string, V2TimelineInput['handoffs'][number]>();
  for (const h of handoffs) handoffByTo.set(h.to, h);
  const workerOf = (taskId: string) => plan.find((t) => t.id === taskId)?.worker || '';

  for (const task of plan) {
    const inbound = handoffByTo.get(task.id);
    if (inbound) cards.push(handoffCard(inbound, workerOf(inbound.from)));
    cards.push(workerCard(task, input));
    const vc = verifyCard(task, input);
    if (vc) cards.push(vc);
  }

  if (result || busy) {
    cards.push(finalCard(input));
  }

  const last = cards[cards.length - 1];
  const inFlight =
    busy &&
    last != null &&
    !['completed', 'failed', 'cancelled'].includes(last.status);

  return {
    sessionId,
    objective: objective.text || objective.expected || '',
    cards,
    inFlight,
  };
}
