/**
 * useWorkflows — the workflow library + editor + execution state.
 * ==================================================================
 * Single source of truth for the Workflows module. The library and node
 * specs come from the local backend; the editor holds the open workflow
 * definition with undo/redo (JSON snapshots of the graph); execution
 * mirrors the live RunEvent stream so the canvas can glow node-by-node.
 */

import { create } from 'zustand';
import {
  aiClient,
  type AuthorityEnvelope,
  type WorkflowRun,
  type WorkflowRunSummary,
  type NodeRunState,
  type NodeSpecInfo,
  type WfEdge,
  type WfNode,
  type WfRunEvent,

  type Workflow,
  type WorkflowSummary,
  type WorkflowTemplateInfo,
} from '../ai/aiClient';
import type { AgentBeat } from '../screens/workflows/agent/types';


export interface RunLogLine { nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string; at: string }
export interface NodeRunInfo { status: NodeRunState; ms?: number; summary?: string; error?: string }
export interface RunState {
  active: boolean;
  states: Record<string, NodeRunInfo>;
  logs: RunLogLine[];
  outputs: { nodeId: string; title: string; text: string }[];
  status: 'running' | 'completed' | 'failed' | null;
  ms: number;
  error?: string;
  /**
   * Agent beats as they arrive, keyed by node.
   *
   * An early view of a ledger, never the ledger itself: once the run
   * settles, the persisted `agentTrace` on the run record replaces this
   * entirely. The service says so plainly — the stream can miss beats
   * (nobody was connected), repeat them (a reconnect replays) or deliver
   * them out of order — so this is only ever what to show *while nothing
   * authoritative exists yet*.
   */
  beats: Record<string, AgentBeat[]>;
}

/**
 * Fold one beat into a node's live ledger.
 *
 * Deduplicates and orders by `seq`, because the stream guarantees neither.
 * `seq` is a safe key here only because the service fixed the collision it
 * used to have across a resume: a resumed leg now continues numbering past
 * the beats it carried forward instead of restarting at 0, so within one
 * logical execution a `seq` identifies exactly one beat.
 */
const foldBeat = (existing: AgentBeat[] | undefined, beat: AgentBeat): AgentBeat[] => {
  const next = (existing ?? []).filter((b) => b.seq !== beat.seq);
  next.push(beat);
  next.sort((a, b) => a.seq - b.seq);
  return next;
};


type Snapshot = { nodes: WfNode[]; edges: WfEdge[] };
const snap = (def: Workflow): string => JSON.stringify({ nodes: def.nodes, edges: def.edges });
const MAX_UNDO = 60;

interface WorkflowsState {
  loaded: boolean;
  reachable: boolean;
  list: WorkflowSummary[];
  templates: WorkflowTemplateInfo[];
  specs: NodeSpecInfo[];

  /** Full definitions, hydrated behind the list so cards can show what a
   *  workflow actually does. `GET /workflows` returns summaries only. */
  defs: Record<string, Workflow>;
  hydrating: boolean;
  /** Authority envelopes, computed by the service. Keyed by workflow id. */
  envelopes: Record<string, AuthorityEnvelope>;
  /** Run summaries, persisted by the service. Keyed by workflow id. */
  runs: Record<string, WorkflowRunSummary[]>;

  editingId: string | null;
  def: Workflow | null;
  dirty: boolean;
  undoStack: string[];
  redoStack: string[];
  run: RunState | null;
  /** Ids the service assigned this run, from its own `start` event. */
  runId: string | null;
  versionId: string | null;
  /** The persisted record, fetched once the stream ends. */
  serverRun: WorkflowRun | null;

  init: () => Promise<void>;
  /** Fetch every definition the list mentions, with bounded concurrency. */
  hydrate: () => Promise<void>;
  /** Read one workflow's envelope and run history from the service. */
  loadMeta: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  create: (input: { name?: string; template?: string }) => Promise<Workflow | null>;
  open: (id: string) => Promise<void>;
  close: () => void;
  patchMeta: (id: string, partial: { name?: string; favorite?: boolean; category?: string; description?: string }) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  importDef: (raw: string) => Promise<{ ok: boolean; error?: string }>;

  /** Graph mutation with an undo snapshot. */
  mutate: (fn: (def: Workflow) => void) => void;
  /** Position-only update during drags (no undo snapshot per move). */
  nudge: (fn: (def: Workflow) => void) => void;
  beginGesture: () => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;

  runFlow: (inputs: Record<string, string>) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  stopRun: () => Promise<void>;
  clearRun: () => void;
}

let abortRun: AbortController | null = null;

type Setter = (partial: Partial<WorkflowsState>) => void;
type Getter = () => WorkflowsState;

/**
 * Mirror the service's run events into the live projection.
 *
 * This is a projection, not a record: the service is writing the durable
 * run at the same time from the same events, and `settleRun` replaces this
 * with that record the moment the stream ends.
 */
const applyRunEvent = (set: Setter, get: Getter) => (e: WfRunEvent) => {
  const run = get().run;
  if (!run) return;
  if (e.type === 'start') {
    set({ runId: e.runId ?? null, versionId: e.versionId ?? null });
  } else if (e.type === 'node') {
    set({ run: { ...run, states: { ...run.states, [e.nodeId]: { status: e.status, ms: e.ms, summary: e.summary, error: e.error } } } });
  } else if (e.type === 'log') {
    set({ run: { ...run, logs: [...run.logs, { nodeId: e.nodeId, level: e.level, text: e.text, at: e.at }] } });
  } else if (e.type === 'output') {
    set({ run: { ...run, outputs: [...run.outputs, { nodeId: e.nodeId, title: e.title, text: e.text }] } });
  } else if (e.type === 'agent') {
    set({ run: { ...run, beats: { ...run.beats, [e.nodeId]: foldBeat(run.beats[e.nodeId], e.beat) } } });
  } else if (e.type === 'done') {

    set({
      run: { ...run, active: false, status: e.status, ms: e.ms, error: e.error },
      runId: e.runId ?? get().runId,
    });
  }
};

/**
 * Once the stream ends, read the record the service persisted.
 *
 * The live projection cannot carry evidence, attempts or resumability —
 * only the service knows those — so the view switches to the real record
 * rather than showing a partial one that looks complete.
 */
async function settleRun(set: Setter, get: Getter, workflowId: string): Promise<void> {
  const run = get().run;
  if (run?.active) {
    set({ run: { ...run, active: false, status: run.status === 'running' ? 'failed' : run.status, error: run.error ?? 'the run stream ended unexpectedly' } });
  }
  const runId = get().runId;
  if (!runId) return;
  const rec = await aiClient.workflowRun(workflowId, runId).catch(() => null);
  if (rec && 'id' in rec) set({ serverRun: rec });
  await get().loadMeta(workflowId);
}

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  loaded: false,
  reachable: true,
  list: [],
  templates: [],
  specs: [],
  defs: {},
  hydrating: false,
  envelopes: {},
  runs: {},
  editingId: null,
  def: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  run: null,
  runId: null,
  versionId: null,
  serverRun: null,

  async init() {
    try {
      const [l, t, sp] = await Promise.all([aiClient.listWorkflows(), aiClient.workflowTemplates(), aiClient.workflowSpecs()]);
      set({ list: l.workflows, templates: t.templates, specs: sp.specs, loaded: true, reachable: true });
      void get().hydrate();
    } catch {
      set({ loaded: true, reachable: false });
    }
  },

  /**
   * Hydrate full definitions behind the summary list.
   *
   * The library needs each graph to show what a workflow does and what it
   * is permitted to do, and `GET /workflows` returns summaries only. These
   * are local requests over loopback, but they are still N of them, so the
   * fan-out is capped and the screen renders from summaries in the
   * meantime — hydration only ever adds detail, never gates the list.
   */
  async hydrate() {
    if (get().hydrating) return;
    const ids = get().list.map((w) => w.id);
    const missing = ids.filter((id) => !get().defs[id]);
    if (!missing.length) return;
    set({ hydrating: true });
    const LIMIT = 6;
    const queue = [...missing];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const def = await aiClient.getWorkflow(id).catch(() => null);
        if (def && 'id' in def) set({ defs: { ...get().defs, [def.id]: def } });
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMIT, queue.length) }, worker));
    set({ hydrating: false });

    // Envelopes and run counts are what make a library card mean something.
    // Fetched behind the list, capped the same way, and never blocking it.
    const metaQueue = ids.slice();
    const metaWorker = async () => {
      for (let id = metaQueue.shift(); id; id = metaQueue.shift()) await get().loadMeta(id);
    };
    await Promise.all(Array.from({ length: Math.min(LIMIT, metaQueue.length) }, metaWorker));
  },

  async loadMeta(id) {
    const [env, runs] = await Promise.all([
      aiClient.workflowEnvelope(id).catch(() => null),
      aiClient.workflowRuns(id).catch(() => null),
    ]);
    const patch: Partial<WorkflowsState> = {};
    if (env && 'envelope' in env) patch.envelopes = { ...get().envelopes, [id]: env.envelope };
    if (runs && Array.isArray(runs.runs)) patch.runs = { ...get().runs, [id]: runs.runs };
    if (Object.keys(patch).length) set(patch);
  },

  async refresh() {
    try {
      const l = await aiClient.listWorkflows();
      set({ list: l.workflows, reachable: true });
      void get().hydrate();
    } catch {
      set({ reachable: false });
    }
  },

  async create(input) {
    try {
      const wf = await aiClient.createWorkflow(input);
      await get().refresh();
      return wf;
    } catch {
      return null;
    }
  },

  async open(id) {
    const def = await aiClient.getWorkflow(id).catch(() => null);
    if (!def || !('id' in def)) return;
    set({ editingId: id, def, dirty: false, undoStack: [], redoStack: [], run: null, runId: null, versionId: null, serverRun: null, defs: { ...get().defs, [def.id]: def } });
  },

  close() {
    abortRun?.abort();
    // Only the live view is dropped. The run itself is persisted by the
    // service, so leaving the editor never loses history.
    set({ editingId: null, def: null, dirty: false, undoStack: [], redoStack: [], run: null, runId: null, versionId: null, serverRun: null });
    void get().refresh();
  },

  async patchMeta(id, partial) {
    await aiClient.patchWorkflow(id, partial).catch(() => null);
    const { def } = get();
    if (def && def.id === id) set({ def: { ...def, ...partial } });
    await get().refresh();
  },

  async duplicate(id) {
    await aiClient.duplicateWorkflow(id).catch(() => null);
    await get().refresh();
  },

  async remove(id) {
    await aiClient.removeWorkflow(id).catch(() => null);
    if (get().editingId === id) get().close();
    await get().refresh();
  },

  async importDef(raw) {
    try {
      const def = JSON.parse(raw) as Workflow;
      if (!Array.isArray(def.nodes)) return { ok: false, error: 'not a workflow export' };
      await aiClient.importWorkflow(def);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  mutate(fn) {
    const { def, undoStack } = get();
    if (!def) return;
    const before = snap(def);
    const next: Workflow = { ...def, nodes: def.nodes.map((n) => ({ ...n, config: { ...n.config } })), edges: [...def.edges] };
    fn(next);
    set({ def: next, dirty: true, undoStack: [...undoStack.slice(-MAX_UNDO), before], redoStack: [] });
  },

  nudge(fn) {
    const { def } = get();
    if (!def) return;
    const next: Workflow = { ...def, nodes: def.nodes.map((n) => ({ ...n })), edges: def.edges };
    fn(next);
    set({ def: next, dirty: true });
  },

  beginGesture() {
    const { def, undoStack } = get();
    if (!def) return;
    set({ undoStack: [...undoStack.slice(-MAX_UNDO), snap(def)], redoStack: [] });
  },

  undo() {
    const { def, undoStack, redoStack } = get();
    if (!def || !undoStack.length) return;
    const prev = JSON.parse(undoStack[undoStack.length - 1]) as Snapshot;
    set({ def: { ...def, ...prev }, dirty: true, undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, snap(def)] });
  },

  redo() {
    const { def, undoStack, redoStack } = get();
    if (!def || !redoStack.length) return;
    const next = JSON.parse(redoStack[redoStack.length - 1]) as Snapshot;
    set({ def: { ...def, ...next }, dirty: true, redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, snap(def)] });
  },

  async save() {
    const { def } = get();
    if (!def) return;
    const saved = await aiClient.saveWorkflow(def.id, def).catch(() => null);
    if (saved && 'id' in saved) {
      const next = { ...def, updatedAt: saved.updatedAt };
      set({ def: next, dirty: false, defs: { ...get().defs, [next.id]: next } });
    }
    await get().refresh();
  },

  async runFlow(inputs) {
    const { def, dirty } = get();
    if (!def || get().run?.active) return;
    if (dirty) await get().save();

    abortRun = new AbortController();
    const base: RunState = { active: true, states: {}, logs: [], outputs: [], status: 'running', ms: 0, beats: {} };
    set({ run: base, runId: null, versionId: null, serverRun: null });

    await aiClient.runWorkflow(def.id, inputs, applyRunEvent(set, get), abortRun.signal);
    await settleRun(set, get, def.id);
    abortRun = null;
  },

  /**
   * Pick a stopped run up where the service left it.
   *
   * The service owns what "where it left off" means — which nodes are
   * checkpointed, whether the version still exists — so this only asks.
   */
  async resumeRun(runId) {
    const { def } = get();
    if (!def || get().run?.active) return;
    abortRun = new AbortController();
    set({ run: { active: true, states: {}, logs: [], outputs: [], status: 'running', ms: 0, beats: {} }, runId, serverRun: null });
    await aiClient.resumeWorkflowRun(def.id, runId, applyRunEvent(set, get), abortRun.signal);
    await settleRun(set, get, def.id);
    abortRun = null;
  },

  /**
   * Cancel through the service, not by hanging up.
   *
   * Aborting the stream only stops this window watching; the run keeps
   * going. Cancelling means telling the engine, and only then dropping the
   * stream — otherwise the UI would say "cancelled" about a run that is
   * still executing.
   */
  async stopRun() {
    const { def, runId } = get();
    if (def && runId) await aiClient.cancelWorkflowRun(def.id, runId).catch(() => null);
    abortRun?.abort();
    const run = get().run;
    if (run) set({ run: { ...run, active: false, status: 'failed', error: 'cancelled' } });
    if (def && runId) {
      const rec = await aiClient.workflowRun(def.id, runId).catch(() => null);
      if (rec && 'id' in rec) set({ serverRun: rec });
    }
  },

  clearRun() {
    set({ run: null });
  },
}));
