/**
 * runs — helpers over the service's own run records.
 * ==================================================================
 * The Workflow Engine persists runs (`GET /workflows/:id/runs`), so the
 * renderer keeps no run history of its own. Everything here is a pure
 * projection of `WorkflowRun` for display.
 *
 * While a run is streaming there is no persisted record to read yet, so
 * `liveRun()` builds the same shape from the live `RunEvent`s — the same
 * events the service is writing into the record it will return. When the
 * stream ends the persisted record replaces it, and `RunView` never knows
 * the difference. One component, one shape, live and historical.
 */

import type {
  NodeRunState,
  NodeState,
  RunState,
  Workflow,
  WorkflowRun,
  WorkflowRunSummary,
} from '../../ai/aiClient';
import type { RunState as LiveRunState } from '../../data/useWorkflows';

/* ── vocabulary ────────────────────────────────────────────────────── */

export const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: 'Queued',
  running: 'Running',
  'awaiting-approval': 'Waiting for you',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
};

export const RUN_STATE_TONE: Record<RunState, 'positive' | 'critical' | 'attention' | 'info' | 'neutral'> = {
  queued: 'neutral',
  running: 'info',
  'awaiting-approval': 'attention',
  succeeded: 'positive',
  failed: 'critical',
  cancelled: 'attention',
  'timed-out': 'critical',
};

/* ── resume chains ─────────────────────────────────────────────────
   A resume is a NEW run linked to the one it continues, deliberately: a
   run executes one version, has one wall clock, and owns one partition of
   the audit trail. So one logical execution is one or more records.

   The consequence the UI has to get right is that a superseded run KEEPS
   its `awaiting-approval` state — that is still the honest description of
   how that leg ended, and rewriting it would lose the reason the chain
   exists. What changes is that it is no longer *actionable*. Anything
   asking "is someone waiting on me?" must therefore ask this, not the
   state. See `docs/AGENT_RESUME_SEMANTICS.md`. */

/** True when this run is genuinely parked on a person, right now. */
export const isPending = (r: { state: RunState; supersededBy?: string }): boolean =>
  r.state === 'awaiting-approval' && !r.supersededBy;

/**
 * How a run's state should read, given the chain it sits in.
 *
 * A superseded leg says what became of it rather than repeating a question
 * that has already been answered.
 */
export const runStateLabel = (r: { state: RunState; supersededBy?: string }): string =>
  r.supersededBy && r.state === 'awaiting-approval' ? 'Continued' : RUN_STATE_LABEL[r.state];

export const runStateTone = (
  r: { state: RunState; supersededBy?: string },
): 'positive' | 'critical' | 'attention' | 'info' | 'neutral' =>
  r.supersededBy && r.state === 'awaiting-approval' ? 'neutral' : RUN_STATE_TONE[r.state];

export const NODE_STATE_LABEL: Record<NodeState, string> = {

  queued: 'queued',
  running: 'running',
  'awaiting-approval': 'waiting for you',
  succeeded: 'succeeded',
  failed: 'failed',
  denied: 'denied by policy',
  skipped: 'skipped',
  cancelled: 'cancelled',
  'timed-out': 'timed out',
};

export const NODE_STATE_TONE: Record<NodeState, 'positive' | 'critical' | 'attention' | 'info' | 'neutral'> = {
  queued: 'neutral',
  running: 'info',
  'awaiting-approval': 'attention',
  succeeded: 'positive',
  failed: 'critical',
  // Denial is the policy engine working, not the workflow breaking. It is
  // toned as attention so it can never be read as a bug in the graph.
  denied: 'attention',
  skipped: 'neutral',
  cancelled: 'attention',
  'timed-out': 'critical',
};

export const TERMINAL_RUN_STATES: RunState[] = ['succeeded', 'failed', 'cancelled', 'timed-out'];
export const isTerminal = (s: RunState): boolean => TERMINAL_RUN_STATES.includes(s);

/** The live stream's node vocabulary mapped onto the durable one. */
const NODE_STATE_FROM_EVENT: Record<NodeRunState, NodeState> = {
  queued: 'queued',
  running: 'running',
  waiting: 'running',
  completed: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  'awaiting-approval': 'awaiting-approval',
  denied: 'denied',
  cancelled: 'cancelled',
  'timed-out': 'timed-out',
};

/* ── formatting ────────────────────────────────────────────────────── */

export function fmtDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function elapsedMs(run: WorkflowRun, now: number): number {
  if (run.ms) return run.ms;
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  return Math.max(0, end - start);
}

export function relTime(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Started by you',
  webhook: 'Inbound webhook',
  automation: 'Automation rule',
  mission: 'Mission task',
  resume: 'Resumed',
};

/* ── projection ────────────────────────────────────────────────────── */

export interface RunProgress {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  skipped: number;
  running: number;
  awaiting: number;
  /** The node the run is on right now, if any. */
  current: { nodeId: string; type: string; state: NodeState } | null;
}

export function progressOf(run: WorkflowRun): RunProgress {
  const nodes = Object.values(run.nodes);
  const by = (s: NodeState) => nodes.filter((n) => n.state === s);
  const running = by('running');
  const awaiting = by('awaiting-approval');
  const head = running[0] ?? awaiting[0] ?? null;
  return {
    total: nodes.length,
    succeeded: by('succeeded').length,
    failed: by('failed').length,
    denied: by('denied').length,
    skipped: by('skipped').length,
    running: running.length,
    awaiting: awaiting.length,
    current: head ? { nodeId: head.nodeId, type: head.type, state: head.state } : null,
  };
}

/**
 * Steps in the order the run moved through them: everything that has
 * started, by start time, then the rest in graph order. Stable, because
 * the list is read while it is still moving.
 */
export function orderedNodes(run: WorkflowRun, graphOrder: string[]): WorkflowRun['nodes'][string][] {
  const all = graphOrder.map((id) => run.nodes[id]).filter(Boolean);
  const started = all.filter((n) => n.startedAt).sort((a, b) => (a.startedAt! < b.startedAt! ? -1 : 1));
  const rest = all.filter((n) => !n.startedAt);
  return [...started, ...rest];
}

/**
 * Build a `WorkflowRun` from the live event stream.
 *
 * This is not a second run record: it is the same run the service is
 * persisting, projected from the same events, so the view has something
 * to render before the stream ends. Fields the events do not carry —
 * evidence, attempts, resumability — are left honestly empty rather than
 * guessed, and the persisted record replaces this the moment it is
 * available.
 */
export function liveRun(
  def: Workflow,
  live: LiveRunState,
  ids: { runId: string | null; versionId: string | null },
  project: { id: string; path: string } | null,
  startedAt: string,
): WorkflowRun {
  const nodes: WorkflowRun['nodes'] = {};
  for (const n of def.nodes) {
    const s = live.states[n.id];
    nodes[n.id] = {
      nodeId: n.id,
      type: n.type,
      state: s ? NODE_STATE_FROM_EVENT[s.status] ?? 'queued' : 'queued',
      iteration: 0,
      ms: s?.ms ?? 0,
      summary: s?.summary,
      error: s?.error,
      attempts: s ? 1 : 0,
      evidence: [],
      /* The live stream carries node STATUS, not the state history — only
         the persisted record has that. An empty list is the honest
         projection: the run view renders a history when one exists and
         says nothing when it does not, rather than inventing one from the
         single status this projection knows about. */
      transitions: [],

      startedAt: s && s.status !== 'queued' ? startedAt : undefined,
      /* Beats that have arrived on the stream, as a partial ledger.
       *
       * Marked `partial` rather than dressed up as a trace, because that
       * is what it is: reasoning so far, with no stop reason, no measured
       * cost and no evidence — the service only knows those when the node
       * resolves. Attaching it here means the run view shows an agent
       * thinking through the same component that later shows what it did,
       * instead of a blank space until the run settles. */
      agentTrace: live.beats[n.id]?.length ? { partial: true, beats: live.beats[n.id] } : undefined,
    };
  }


  const state: RunState = live.active
    ? Object.values(nodes).some((n) => n.state === 'awaiting-approval')
      ? 'awaiting-approval'
      : 'running'
    : live.status === 'completed'
      ? 'succeeded'
      : live.error === 'cancelled'
        ? 'cancelled'
        : 'failed';

  return {
    id: ids.runId ?? 'live',
    workflowId: def.id,
    versionId: ids.versionId ?? '',
    workflowName: def.name,
    projectId: project?.id ?? '',
    projectPath: project?.path ?? '',
    state,
    trigger: { kind: 'manual' },
    createdAt: startedAt,
    startedAt,
    finishedAt: live.active ? undefined : new Date().toISOString(),
    ms: live.ms,
    error: live.error,
    nodes,
    vars: {},
    inputs: {},
    outputs: live.outputs,
    evidence: [],
    // Only the service can answer this. Until it does, the header says so
    // rather than promising a resume that may not exist.
    resumable: false,
    log: live.logs.map((l) => ({ at: l.at, nodeId: l.nodeId, level: l.level, text: l.text })),
  };
}

/**
 * Where the earlier leg's reasoning ends, per node.
 *
 * A resumed agent carries the previous leg's beats forward so its ledger
 * reads as one train of thought. That is right, but it means a resumed
 * run's trace contains beats that happened in a *different* run — and
 * presenting those as this run's work would misdescribe both. The
 * boundary is the highest `seq` the earlier leg reached, which is a fact
 * on its record rather than something to infer.
 *
 * Returns an empty map when handed nothing, so a caller that could not
 * fetch the earlier leg simply gets no marker instead of a wrong one.
 */
export function carriedThroughFor(previousLeg: WorkflowRun | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!previousLeg) return out;
  for (const [nodeId, rec] of Object.entries(previousLeg.nodes)) {
    const beats = (rec.agentTrace as { beats?: { seq: number }[] } | undefined)?.beats;
    if (!Array.isArray(beats) || !beats.length) continue;
    out[nodeId] = beats.reduce((max, b) => Math.max(max, b.seq), 0);
  }
  return out;
}

/** Newest first. The service returns them in its own order. */

export function sortRuns(runs: WorkflowRunSummary[]): WorkflowRunSummary[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
