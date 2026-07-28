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
  type NodeRunState,
  type NodeSpecInfo,
  type WfEdge,
  type WfNode,
  type WfRunEvent,
  type Workflow,
  type WorkflowSummary,
  type WorkflowTemplateInfo,
} from '../ai/aiClient';

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
}

type Snapshot = { nodes: WfNode[]; edges: WfEdge[] };
const snap = (def: Workflow): string => JSON.stringify({ nodes: def.nodes, edges: def.edges });
const MAX_UNDO = 60;

interface WorkflowsState {
  loaded: boolean;
  reachable: boolean;
  list: WorkflowSummary[];
  templates: WorkflowTemplateInfo[];
  specs: NodeSpecInfo[];

  editingId: string | null;
  def: Workflow | null;
  dirty: boolean;
  undoStack: string[];
  redoStack: string[];
  run: RunState | null;

  init: () => Promise<void>;
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
  stopRun: () => void;
  clearRun: () => void;
}

let abortRun: AbortController | null = null;

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  loaded: false,
  reachable: true,
  list: [],
  templates: [],
  specs: [],
  editingId: null,
  def: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  run: null,

  async init() {
    try {
      const [l, t, sp] = await Promise.all([aiClient.listWorkflows(), aiClient.workflowTemplates(), aiClient.workflowSpecs()]);
      set({ list: l.workflows, templates: t.templates, specs: sp.specs, loaded: true, reachable: true });
    } catch {
      set({ loaded: true, reachable: false });
    }
  },

  async refresh() {
    try {
      const l = await aiClient.listWorkflows();
      set({ list: l.workflows, reachable: true });
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
    set({ editingId: id, def, dirty: false, undoStack: [], redoStack: [], run: null });
  },

  close() {
    abortRun?.abort();
    set({ editingId: null, def: null, dirty: false, undoStack: [], redoStack: [], run: null });
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
    if (saved && 'id' in saved) set({ def: { ...def, updatedAt: saved.updatedAt }, dirty: false });
    await get().refresh();
  },

  async runFlow(inputs) {
    const { def, dirty } = get();
    if (!def || get().run?.active) return;
    if (dirty) await get().save();
    abortRun = new AbortController();
    const base: RunState = { active: true, states: {}, logs: [], outputs: [], status: 'running', ms: 0 };
    set({ run: base });
    const apply = (e: WfRunEvent) => {
      const run = get().run;
      if (!run) return;
      if (e.type === 'node') {
        set({ run: { ...run, states: { ...run.states, [e.nodeId]: { status: e.status, ms: e.ms, summary: e.summary, error: e.error } } } });
      } else if (e.type === 'log') {
        set({ run: { ...run, logs: [...run.logs, { nodeId: e.nodeId, level: e.level, text: e.text, at: e.at }] } });
      } else if (e.type === 'output') {
        set({ run: { ...run, outputs: [...run.outputs, { nodeId: e.nodeId, title: e.title, text: e.text }] } });
      } else if (e.type === 'done') {
        set({ run: { ...run, active: false, status: e.status, ms: e.ms, error: e.error } });
      }
    };
    await aiClient.runWorkflow(def.id, inputs, apply, abortRun.signal);
    const run = get().run;
    if (run?.active) set({ run: { ...run, active: false, status: run.status === 'running' ? 'failed' : run.status, error: run.error ?? 'stream ended' } });
    abortRun = null;
  },

  stopRun() {
    abortRun?.abort();
    const run = get().run;
    if (run) set({ run: { ...run, active: false, status: 'failed', error: 'cancelled' } });
  },

  clearRun() {
    set({ run: null });
  },
}));
