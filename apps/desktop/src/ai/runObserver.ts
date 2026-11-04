/**
 * runObserver — what a Workspace run looks like, derived only from what the
 * backend reported.
 * ------------------------------------------------------------------
 * A pure reducer over the agent's event frames. Nothing here guesses: a row
 * exists because an event said so, a checklist state is the backend's own
 * `task.state`, a file is listed because the change observer saw it change.
 *
 * - Every timeline entry has a stable id (the bus sequence, else `type@at`),
 *   so a replayed frame after a reconnect never shows twice.
 * - `seed` rebuilds the same view from a stored session (`lastResult.report`),
 *   so a reload or a restart shows the recorded outcome instead of an empty
 *   panel; live events then continue on top of it.
 * - The completion summary comes from the report. Partial success is never
 *   reported as complete: anything not verified is listed as unfinished.
 */
import type { AgentEventFrame, ExecutionReport, ToolRecord } from './centralAgentClient';

export type CheckState = 'pending' | 'running' | 'verification' | 'verified' | 'failed' | 'blocked' | 'cancelled';

export interface TimelineEntry { id: string; at: string; type: string; text: string; tone: 'info' | 'ok' | 'warn' | 'bad'; taskId?: string }
export interface CheckItem { taskId: string; title: string; dependsOn: string[]; state: CheckState; worker: string | null; detail: string }
export interface FileChange { path: string; op: 'created' | 'modified' | 'deleted'; taskId: string; worker: string | null }
export interface ToolEvent { nodeId: string; name: string; stage: string; reason?: string; detail?: string }
export interface Handoff { taskId: string | null; from: string | null; to: string | null; reason: string }
export interface RunError { id: string; status: string; summary?: string; taskId: string | null; path?: string }

export interface RunView {
  sessionId: string | null;
  goal: string | null;
  phase: string | null;
  currentTask: string | null;
  currentWorker: string | null;
  waitingFor: string | null;
  timeline: TimelineEntry[];
  checklist: CheckItem[];
  files: FileChange[];
  toolsInstalled: ToolEvent[];
  toolsReused: ToolEvent[];
  toolsBlocked: ToolEvent[];
  workers: string[];
  handoffs: Handoff[];
  errors: RunError[];
  finished: boolean;
  summary: ExecutionReport | null;
  seen: string[];
}

export const EMPTY_RUN: RunView = {
  sessionId: null, goal: null, phase: null, currentTask: null, currentWorker: null, waitingFor: null,
  timeline: [], checklist: [], files: [], toolsInstalled: [], toolsReused: [], toolsBlocked: [], workers: [],
  handoffs: [], errors: [], finished: false, summary: null, seen: [],
};

const MAX_TIMELINE = 400;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const CHECK_STATES: CheckState[] = ['pending', 'running', 'verification', 'verified', 'failed', 'blocked', 'cancelled'];
const asState = (v: unknown): CheckState => (CHECK_STATES.includes(v as CheckState) ? (v as CheckState) : 'pending');

export function frameId(f: Pick<AgentEventFrame, 'seq' | 'type' | 'at'>): string {
  return typeof f.seq === 'number' ? `s${f.seq}` : `${f.type}@${f.at}`;
}

function setCheck(list: CheckItem[], taskId: string, patch: Partial<CheckItem>): CheckItem[] {
  const i = list.findIndex((c) => c.taskId === taskId);
  if (i < 0) return [...list, { taskId, title: taskId, dependsOn: [], state: 'pending', worker: null, detail: '', ...patch }];
  const next = [...list];
  next[i] = { ...next[i], ...patch };
  return next;
}

/** Fold one frame into the view. Returns the same object for a frame already seen. */
export function foldRunEvent(view: RunView, f: AgentEventFrame): RunView {
  const id = frameId(f);
  if (view.seen.includes(id)) return view;
  const p = (f.payload ?? {}) as Record<string, any>;
  let v: RunView = { ...view, sessionId: view.sessionId ?? f.sessionId, seen: [...view.seen.slice(-999), id] };
  const say = (text: string, tone: TimelineEntry['tone'] = 'info', taskId?: string) => {
    v = { ...v, timeline: [...v.timeline, { id, at: f.at, type: f.type, text, tone, taskId }].slice(-MAX_TIMELINE) };
  };

  switch (f.type) {
    case 'plan.received': {
      const tasks = Array.isArray(p.tasks) ? p.tasks : [];
      v = { ...v, goal: str(p.goal) || v.goal, phase: 'Plan received' };
      for (const t of tasks) v = { ...v, checklist: setCheck(v.checklist, str(t.id), { title: str(t.title) || str(t.id), dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [], state: 'pending' }) };
      say(`Plan received from the Planner: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
      break;
    }
    case 'worker.selected': {
      // Laya chose a connected coding agent for this task (who, and why).
      const taskId = str(p.taskId);
      const worker = str(p.worker);
      v = { ...v, checklist: v.checklist.map((c) => (c.taskId === taskId ? { ...c, worker, detail: c.detail || `Agent selected: ${str(p.name) || worker}` } : c)) };
      const out = Array.isArray(p.unavailable) ? (p.unavailable as { id?: unknown; reason?: unknown }[]).map((u) => `${str(u.id)} (${str(u.reason)})`) : [];
      say(`Laya selected ${str(p.name) || worker} for ${v.checklist.find((c) => c.taskId === taskId)?.title ?? taskId}: ${str(p.reason)}${out.length ? `. Not used: ${out.join('; ')}` : ''}`, 'info', taskId);
      break;
    }
    case 'plan.created': {
      v = { ...v, goal: str(p.objective) || v.goal, phase: 'Planned' };
      // Events about a task carry AURA's canonical id; the Planner's own id
      // (sourceId) is only how the plan named it. Re-key the Planner's row to
      // the canonical id so later task.state events land on the same row.
      for (const t of Array.isArray(p.plan) ? p.plan : []) {
        const canonical = str(t.id);
        const src = str(t.sourceId);
        const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [];
        const fromPlanner = src ? v.checklist.find((c) => c.taskId === src) : undefined;
        if (fromPlanner && src !== canonical) {
          v = { ...v, checklist: v.checklist.map((c) => (c === fromPlanner ? { ...c, taskId: canonical, dependsOn } : c)) };
        } else {
          v = { ...v, checklist: setCheck(v.checklist, canonical, { title: v.checklist.find((c) => c.taskId === canonical)?.title ?? str(t.description), dependsOn }) };
        }
      }
      // dependencies named by Planner ids now point at canonical ids
      const rekey = new Map((Array.isArray(p.plan) ? p.plan : []).filter((t: any) => t.sourceId).map((t: any) => [str(t.sourceId), str(t.id)]));
      v = { ...v, checklist: v.checklist.map((c) => ({ ...c, dependsOn: c.dependsOn.map((d) => rekey.get(d) ?? d) })) };
      say('Plan ready');
      break;
    }
    case 'task.state': {
      const taskId = str(p.taskId);
      const state = asState(p.state);
      const worker = str(p.worker) || null;
      v = { ...v, checklist: setCheck(v.checklist, taskId, { state, detail: str(p.detail), ...(worker ? { worker } : {}) }) };
      if (state === 'running') v = { ...v, phase: 'Working', currentTask: taskId, currentWorker: worker ?? v.currentWorker, waitingFor: null };
      if (worker && !v.workers.includes(worker)) v = { ...v, workers: [...v.workers, worker] };
      say(`${v.checklist.find((c) => c.taskId === taskId)?.title ?? taskId}: ${state}${p.detail ? ` — ${str(p.detail)}` : ''}`,
        state === 'verified' ? 'ok' : state === 'failed' ? 'bad' : state === 'blocked' || state === 'cancelled' ? 'warn' : 'info', taskId);
      break;
    }
    case 'files.changed': {
      const changes = Array.isArray(p.changes) ? p.changes : [];
      const add: FileChange[] = changes.map((c: any) => ({ path: str(c.path), op: c.op, taskId: str(p.taskId), worker: str(p.worker) || null }));
      const keys = new Set(v.files.map((x) => `${x.taskId}:${x.path}`));
      v = { ...v, files: [...v.files, ...add.filter((x) => !keys.has(`${x.taskId}:${x.path}`))] };
      say(`${changes.length || 'No'} file change${changes.length === 1 ? '' : 's'} observed${p.complete === false ? ' (observation incomplete)' : ''}`, p.complete === false ? 'warn' : 'info', str(p.taskId));
      break;
    }
    case 'worker.queued':
      v = { ...v, waitingFor: str(p.waitingFor?.worker) || 'another worker', phase: 'Waiting' };
      say(`Waiting: ${str(p.reason)}`, 'warn', str(p.taskId));
      break;
    case 'worker.handoff': {
      v = { ...v, handoffs: [...v.handoffs, { taskId: p.taskId ?? null, from: p.fromWorker ?? null, to: p.toWorker ?? null, reason: str(p.reason) }] };
      say(`Handed over from ${p.fromWorker ?? 'a worker'} to ${p.toWorker ?? 'another worker'}: ${str(p.reason)}`, 'warn', str(p.taskId));
      break;
    }
    case 'tool.provisioning': {
      const ev: ToolEvent = { nodeId: str(p.nodeId), name: str(p.name) || str(p.nodeId), stage: str(p.stage), reason: str(p.reason), detail: str(p.detail) };
      const drop = (l: ToolEvent[]) => l.filter((t) => t.nodeId !== ev.nodeId);
      if (ev.stage === 'installed') v = { ...v, toolsInstalled: [...drop(v.toolsInstalled), ev] };
      else if (ev.stage === 'present') v = { ...v, toolsReused: [...drop(v.toolsReused), ev] };
      else if (ev.stage === 'blocked' || ev.stage === 'failed') v = { ...v, toolsBlocked: [...drop(v.toolsBlocked), ev] };
      if (['installing', 'retrying'].includes(ev.stage)) v = { ...v, phase: `Setting up ${ev.name}` };
      say(`${ev.name}: ${ev.stage}${ev.detail ? ` — ${ev.detail}` : ''}`, ev.stage === 'failed' || ev.stage === 'blocked' ? 'bad' : ev.stage === 'installed' || ev.stage === 'present' ? 'ok' : 'info');
      break;
    }
    case 'error.recorded': {
      const e: RunError = { id: str(p.errorId), status: str(p.status), taskId: p.taskId ?? null, path: str(p.path) };
      v = { ...v, errors: [...v.errors.filter((x) => x.id !== e.id), e] };
      say(`Error recorded (${e.status})`, e.status === 'resolved' ? 'ok' : 'warn', e.taskId ?? undefined);
      break;
    }
    case 'verification.started':
      v = { ...v, phase: 'Verifying' };
      say('Checking the results');
      break;
    case 'verification.completed':
      say(p.passed === false ? 'Checks did not all pass' : 'Checks passed', p.passed === false ? 'bad' : 'ok');
      break;
    case 'stream.reconnecting':
      say('Live connection interrupted — reconnecting', 'warn');
      break;
    default:
      if (f.type.startsWith('session.') || f.type.startsWith('intent.')) say(f.type.replace('.', ' '));
  }
  return v;
}

const toolEv = (t: ToolRecord, stage: string): ToolEvent => ({ nodeId: t.nodeId, name: t.name, stage, reason: t.reason, detail: t.detail });

/**
 * The checklist state of a task the report lists as unfinished.
 *
 * Only a task that actually failed is "failed". A task that never started, or
 * is still waiting, is "pending": presenting it as failed was the bug where
 * work that had not begun read as broken. Denied and timed-out work is shown
 * as blocked, with the report's own detail, so the cause stays visible.
 */
export function unfinishedCheckState(state: string | null | undefined): CheckState {
  switch (state) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
    case 'denied':
      return 'blocked';
    case 'timed-out':
      return 'failed';
    case 'running':
      return 'running';
    default:
      // pending, ready, queued, or a state this build does not know: not started.
      return 'pending';
  }
}

/** Rebuild a view from the stored report (reload, restart, late open). */
export function seedFromReport(sessionId: string, report: ExecutionReport | null | undefined, base: RunView = EMPTY_RUN): RunView {
  if (!report) return { ...base, sessionId };
  const checklist: CheckItem[] = [
    ...report.workCompleted.map((w) => ({ taskId: w.taskId, title: w.description, dependsOn: [], state: 'verified' as CheckState, worker: w.worker, detail: '' })),
    ...report.unfinished.map((u) => ({ taskId: u.taskId, title: u.description, dependsOn: [], state: unfinishedCheckState(u.state), worker: null, detail: u.detail })),
  ];
  return {
    ...base, sessionId, finished: true, phase: 'Finished', summary: report, checklist,
    files: report.filesChanged.map((f) => ({ path: f.path, op: f.op, taskId: f.taskId, worker: f.worker })),
    toolsInstalled: report.toolsInstalled.map((t) => toolEv(t, 'installed')),
    toolsReused: report.toolsReused.map((t) => toolEv(t, 'present')),
    handoffs: report.handoffs.map((h) => ({ taskId: h.taskId, from: h.fromNode, to: h.toNode, reason: h.reason })),
    errors: report.errors.map((e) => ({ id: e.id, status: e.status, summary: e.summary, taskId: e.taskId, path: e.path })),
    workers: [...new Set(report.workCompleted.map((w) => w.worker).filter((w): w is string => !!w))],
  };
}

/** The honest one-line verdict. Anything not verified means "not complete". */
export function completionLine(view: RunView): { tone: 'ok' | 'warn' | 'bad'; text: string } | null {
  const r = view.summary;
  if (!r) return null;
  const done = r.workCompleted.length;
  const open = r.unfinished.length;
  if (open === 0 && r.outcome === 'completed') return { tone: 'ok', text: `Complete: ${done} task${done === 1 ? '' : 's'} verified.` };
  if (done > 0) return { tone: 'warn', text: `Partly done, not complete: ${done} verified, ${open} unfinished.` };
  return { tone: 'bad', text: `Not completed: ${open || 'the'} task${open === 1 ? '' : 's'} did not finish${r.outcome ? ` (${r.outcome})` : ''}.` };
}
