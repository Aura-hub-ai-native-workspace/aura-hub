/**
 * engineeringMemory — the renderer's VIEW of the engineering log.
 * ==================================================================
 * Replaces `ops/memoryStore.ts`, which was a second, incompatible
 * engineering-memory model that never left the browser: its own schema,
 * its own `localStorage` persistence, invisible to the mission engine,
 * the Learning Engine and the agent — all of which run in the service —
 * and gone the moment the profile was cleared.
 *
 * The model now lives in `packages/ai-service/src/engineering/events.ts`
 * and is stored once, on disk, through `@aura/engineering-memory`. What
 * is left here is a **cache and a client**:
 *
 *   • `record()` posts to the service and applies what the service
 *     returns. The service owns dedupe, so a duplicate is refused there
 *     and this store never invents an id.
 *   • The cache is refreshed from `GET /engineering-log` and kept live by
 *     the Event Spine — a `workspace.engineering-event` arrives whether
 *     this window recorded it or another surface did.
 *   • Nothing is persisted here. There is nothing to persist: the events
 *     are already durable somewhere better.
 *
 * The type names (`EngineeringMemory`, `MemoryInput`, `useMemoryStore`)
 * are kept so the surfaces that read them are unchanged. The wire types
 * are restated rather than imported, exactly as `aiClient.ts` does: the
 * renderer talks HTTP and deliberately does not depend on the service
 * package.
 */

import { create } from 'zustand';
import { subscribeToSpine, type AuraEvent } from '../events/spineClient';

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';

export type MemoryCategory =
  | 'architecture' | 'code' | 'mission' | 'diagnosis'
  | 'documentation' | 'review' | 'decision' | 'learning';

export type MemoryImportance = 'critical' | 'high' | 'medium' | 'low';

/** The acting principal — memories record *who* did the thing. */
export type MemoryUser = 'human' | 'ai' | 'system';

export type MemoryView = 'timeline' | 'history' | 'graph';

/** Where a memory came from — provenance for trust + filtering. */
export type MemorySource =
  | 'editor' | 'ai-action' | 'mission' | 'diagnosis' | 'bug-bot'
  | 'conversation' | 'memory-item' | 'provider' | 'system';

export interface EngineeringMemory {
  id: string;
  /** Null = workspace-global (e.g. provider decisions). */
  projectId: string | null;
  at: string;
  category: MemoryCategory;
  importance: MemoryImportance;
  title: string;
  summary: string;
  /** Why this happened / the reasoning behind it. */
  reason: string;
  user: MemoryUser;
  files: string[];
  symbols: string[];
  layer: string | null;
  dependencies: string[];
  missionId: string | null;
  diagnosisId: string | null;
  source: MemorySource;
  /** Stable dedupe key — the same real event always maps to one key. */
  dedupe: string;
}

export interface MemoryInput {
  projectId: string | null;
  at?: string;
  category: MemoryCategory;
  importance: MemoryImportance;
  title: string;
  summary: string;
  reason?: string;
  user?: MemoryUser;
  files?: string[];
  symbols?: string[];
  layer?: string | null;
  dependencies?: string[];
  missionId?: string | null;
  diagnosisId?: string | null;
  source: MemorySource;
  dedupe: string;
}

export interface MemoryFilter {
  categories: MemoryCategory[] | null;
  importances: MemoryImportance[] | null;
  projectId: string | null;
  query: string;
}

/* ── deterministic importance assignment (real signals, never random) ── */
export function importanceOf(
  category: MemoryCategory,
  opts: { event?: string; critical?: boolean; user?: MemoryUser } = {},
): MemoryImportance {
  if (opts.critical) return 'critical';
  switch (category) {
    case 'review': return 'high';
    case 'decision': return 'high';
    case 'diagnosis': return opts.event === 'accepted' || opts.event === 'rejected' ? 'high' : 'medium';
    case 'mission': return opts.event === 'failed' ? 'critical' : opts.event === 'completed' ? 'high' : 'medium';
    case 'code': return opts.user === 'ai' ? 'high' : 'low';
    case 'documentation': return 'medium';
    case 'architecture': return 'high';
    case 'learning': return 'medium';
    default: return 'medium';
  }
}

function sortNewest(memories: EngineeringMemory[]): EngineeringMemory[] {
  return [...memories].sort((a, b) => b.at.localeCompare(a.at));
}

interface MemoryState {
  memories: EngineeringMemory[];
  selectedId: string | null;
  view: MemoryView;
  filter: MemoryFilter;
  /** True once the cache has been loaded from the service at least once. */
  hydrated: boolean;
  /** Set when the service could not be reached; the UI can say so. */
  error: string | null;

  /** Pull the log from the service. Safe to call repeatedly. */
  hydrate: (projectId?: string | null) => Promise<void>;
  /** Record an event. The SERVICE decides whether the dedupe key is new. */
  record: (input: MemoryInput) => Promise<EngineeringMemory | null>;
  clear: () => Promise<void>;
  purgeProject: (projectId: string) => Promise<void>;
  select: (id: string | null) => void;
  setView: (view: MemoryView) => void;
  setFilter: (partial: Partial<MemoryFilter>) => void;
  /** Apply an event that arrived on the spine (recorded by any surface). */
  apply: (memory: EngineeringMemory) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  selectedId: null,
  view: 'timeline',
  filter: { categories: null, importances: null, projectId: null, query: '' },
  hydrated: false,
  error: null,

  async hydrate(projectId) {
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const res = await fetch(`${BASE}/engineering-log${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { items: EngineeringMemory[] };
      set({ memories: sortNewest(body.items ?? []), hydrated: true, error: null });
    } catch (e) {
      // The cache keeps whatever it had. An unreachable service is a
      // reachability problem, not an empty history, and reporting it as
      // an empty history is how a UI ends up claiming the user never
      // did anything.
      set({ error: (e as Error).message });
    }
  },

  async record(input) {
    try {
      const res = await fetch(`${BASE}/engineering-log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;
      const body = await res.json() as { recorded: boolean; event: EngineeringMemory | null };
      if (!body.recorded || !body.event) return null;
      get().apply(body.event);
      return body.event;
    } catch {
      return null;
    }
  },

  async clear() {
    try {
      await fetch(`${BASE}/engineering-log?all=1`, { method: 'DELETE' });
      set({ memories: [], selectedId: null });
    } catch { /* the service is the authority; a failed clear clears nothing */ }
  },

  async purgeProject(projectId) {
    try {
      await fetch(`${BASE}/engineering-log?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      set((s) => ({ memories: s.memories.filter((m) => m.projectId !== projectId) }));
    } catch { /* as above */ }
  },

  select: (id) => set({ selectedId: id }),
  setView: (view) => set({ view }),
  setFilter: (partial) => set((s) => ({ filter: { ...s.filter, ...partial } })),

  apply: (memory) => set((s) => (
    s.memories.some((m) => m.id === memory.id)
      ? s
      : { memories: sortNewest([memory, ...s.memories]) }
  )),
}));

/**
 * Keep the cache live from the Event Spine.
 *
 * Started once by `App.tsx`. Without it a window would only see events it
 * recorded itself — and the events that matter most (the agent's, the
 * mission engine's) are recorded by neither window.
 */
export function startEngineeringMemorySync(): () => void {
  void useMemoryStore.getState().hydrate();
  return subscribeToSpine(['workspace'], (e: AuraEvent) => {
    if (e.type === 'workspace.engineering-event') {
      useMemoryStore.getState().apply(e.payload as EngineeringMemory);
      return;
    }
    if (e.type === 'workspace.engineering-purged') void useMemoryStore.getState().hydrate();
  });
}

/* ── pure query helpers (used by the UI, not tied to the store shape) ── */

/** Memory meta — labels, icons and tones for every category. */
export const MEMORY_CATEGORY_META: Record<
  MemoryCategory,
  { label: string; icon: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }
> = {
  architecture: { label: 'Architecture', icon: 'architecture', tone: 'info' },
  code: { label: 'Code', icon: 'code', tone: 'info' },
  mission: { label: 'Mission', icon: 'deploy', tone: 'attention' },
  diagnosis: { label: 'Diagnosis', icon: 'bug', tone: 'attention' },
  documentation: { label: 'Documentation', icon: 'doc', tone: 'info' },
  review: { label: 'Review', icon: 'eye', tone: 'attention' },
  decision: { label: 'Decision', icon: 'clipboard', tone: 'positive' },
  learning: { label: 'Learning', icon: 'memory', tone: 'neutral' },
};

export const MEMORY_IMPORTANCE_META: Record<
  MemoryImportance,
  { label: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }
> = {
  critical: { label: 'Critical', tone: 'critical' },
  high: { label: 'High', tone: 'attention' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'neutral' },
};

/** A short, human-safe project label for list rows. */
export function projectLabel(projectId: string | null, projects: { id: string; name: string }[]): string {
  if (!projectId) return 'Workspace';
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

/** Apply the store's filter to a memory list. */
export function applyFilter(memories: EngineeringMemory[], filter: MemoryFilter): EngineeringMemory[] {
  const q = filter.query.trim().toLowerCase();
  return memories.filter((m) => {
    if (filter.categories && !filter.categories.includes(m.category)) return false;
    if (filter.importances && !filter.importances.includes(m.importance)) return false;
    if (filter.projectId && m.projectId !== filter.projectId) return false;
    if (!q) return true;
    const hay = [
      m.title,
      m.summary,
      m.reason,
      ...m.files,
      ...m.symbols,
      m.layer ?? '',
      ...m.dependencies,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Related-memory ranking: shared mission/diagnosis, files, symbols, layer, deps. */
export function relatedMemories(memories: EngineeringMemory[], id: string, limit = 12): EngineeringMemory[] {
  const target = memories.find((m) => m.id === id);
  if (!target) return [];
  const targetFiles = new Set(target.files);
  const targetSymbols = new Set(target.symbols);
  const targetDeps = new Set(target.dependencies);
  const scored = memories
    .filter((m) => m.id !== id)
    .map((m) => {
      let score = 0;
      if (target.missionId && m.missionId === target.missionId) score += 4;
      if (target.diagnosisId && m.diagnosisId === target.diagnosisId) score += 4;
      if (target.layer && m.layer === target.layer) score += 1;
      for (const f of m.files) if (targetFiles.has(f)) score += 2;
      for (const s of m.symbols) if (targetSymbols.has(s)) score += 2;
      for (const d of m.dependencies) if (targetDeps.has(d)) score += 1;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.at.localeCompare(a.m.at))
    .slice(0, limit)
    .map((s) => s.m);
  return scored;
}

export interface MemoryGraphNode {
  id: string;
  label: string;
  category: MemoryCategory;
  importance: MemoryImportance;
  x: number;
  y: number;
}
export interface MemoryGraphEdge { source: string; target: string }

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/**
 * Build a small, laid-out graph of the most significant memories.
 * Edges connect memories that share a mission, diagnosis, file, symbol
 * or layer. Layout is a lightweight deterministic force pass (repulsion
 * + spring on edges) inside a unit box; positions are stable for the
 * same input so the view doesn't jitter between renders.
 */
export function layoutMemoryGraph(memories: EngineeringMemory[], cap = 60): MemoryGraph {
  const order = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const nodes = sortNewest(memories)
    .slice()
    .sort((a, b) => order[a.importance] - order[b.importance])
    .slice(0, cap);

  const nodeSet = new Set(nodes.map((n) => n.id));
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edges = new Map<string, MemoryGraphEdge>();

  const byMission = new Map<string, string[]>();
  const byDiagnosis = new Map<string, string[]>();
  const byFile = new Map<string, string[]>();
  const bySymbol = new Map<string, string[]>();
  const byLayer = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, id: string) => {
    if (!key) return;
    const arr = map.get(key) ?? [];
    arr.push(id);
    map.set(key, arr);
  };

  for (const n of nodes) {
    if (n.missionId) push(byMission, n.missionId, n.id);
    if (n.diagnosisId) push(byDiagnosis, n.diagnosisId, n.id);
    if (n.layer) push(byLayer, n.layer, n.id);
    for (const f of n.files) push(byFile, f, n.id);
    for (const s of n.symbols) push(bySymbol, s, n.id);
  }

  const connect = (groups: Map<string, string[]>) => {
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (a === b || !nodeSet.has(a) || !nodeSet.has(b)) continue;
          const k = edgeKey(a, b);
          if (!edges.has(k)) edges.set(k, { source: a, target: b });
        }
      }
    }
  };
  connect(byMission);
  connect(byDiagnosis);
  connect(byFile);
  connect(bySymbol);
  connect(byLayer);

  // Deterministic force layout in a unit box.
  const pos = new Map<string, { x: number; y: number }>();
  const count = nodes.length;
  nodes.forEach((nd, i) => {
    const angle = (i / Math.max(1, count)) * Math.PI * 2;
    pos.set(nd.id, { x: 0.5 + 0.34 * Math.cos(angle), y: 0.5 + 0.34 * Math.sin(angle) });
  });

  const edgeList = [...edges.values()];
  const spring = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
    const f = (d - 0.16) * 0.02;
    return { fx: (dx / d) * f, fy: (dy / d) * f };
  };

  for (let iter = 0; iter < 90; iter++) {
    const forces = new Map<string, { fx: number; fy: number }>();
    for (const nd of nodes) forces.set(nd.id, { fx: 0, fy: 0 });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)!;
        const b = pos.get(nodes[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const rep = (0.04 / (d * d)) || 4;
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        forces.get(nodes[i].id)!.fx -= fx;
        forces.get(nodes[i].id)!.fy -= fy;
        forces.get(nodes[j].id)!.fx += fx;
        forces.get(nodes[j].id)!.fy += fy;
      }
    }
    for (const e of edgeList) {
      const a = pos.get(e.source)!;
      const b = pos.get(e.target)!;
      const f = spring(a, b);
      forces.get(e.source)!.fx += f.fx;
      forces.get(e.source)!.fy += f.fy;
      forces.get(e.target)!.fx -= f.fx;
      forces.get(e.target)!.fy -= f.fy;
    }
    // Center pull so the layout stays in the box.
    for (const nd of nodes) {
      const p = pos.get(nd.id)!;
      const f = forces.get(nd.id)!;
      p.x += Math.max(-0.1, Math.min(0.1, f.fx * 0.12));
      p.y += Math.max(-0.1, Math.min(0.1, f.fy * 0.12));
      p.x += (0.5 - p.x) * 0.01;
      p.y += (0.5 - p.y) * 0.01;
      p.x = Math.max(0.06, Math.min(0.94, p.x));
      p.y = Math.max(0.08, Math.min(0.92, p.y));
    }
  }

  return {
    nodes: nodes.map((nd) => {
      const p = pos.get(nd.id)!;
      return {
        id: nd.id,
        label: nd.title.length > 22 ? `${nd.title.slice(0, 22)}…` : nd.title,
        category: nd.category,
        importance: nd.importance,
        x: p.x,
        y: p.y,
      };
    }),
    edges: edgeList,
  };
}
