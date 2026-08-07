/**
 * useWorkspace — the real project state for the whole UI.
 * ==================================================================
 * Single source of truth for the project library and the currently open
 * project's real profile, indexing status, system graph and memory. All
 * data comes from the local backend (@aura/ai-service). Nothing here is
 * fabricated: an empty store means the user has not added a project yet.
 */

import { create } from 'zustand';
import {
  aiClient,
  type GraphView,
  type IndexStatus,
  type KnowledgeGraph,
  type MemoryItem,
  type MemoryKind,
  type ProjectProfile,
  type ProjectRecord,
} from '../ai/aiClient';
import { useMemoryStore } from '../ops/memoryStore';

interface WorkspaceState {
  reachable: boolean | null;
  loading: boolean;
  projects: ProjectRecord[];

  // Currently open project
  openId: string | null;
  profile: ProjectProfile | null;
  status: IndexStatus | null;
  graph: GraphView | null;
  kg: KnowledgeGraph | null;
  memory: MemoryItem[];

  refresh: () => Promise<void>;
  addProject: (path: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
  open: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  favorite: (id: string, fav: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reindex: () => Promise<void>;

  loadMemory: (id: string) => Promise<void>;
  addMemory: (id: string, item: { kind: MemoryKind; title: string; body: string; pinned?: boolean }) => Promise<void>;
  pinMemory: (id: string, memId: string, pinned: boolean) => Promise<void>;
  removeMemory: (id: string, memId: string) => Promise<void>;
}

let poll: ReturnType<typeof setInterval> | null = null;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  reachable: null,
  loading: false,
  projects: [],
  openId: null,
  profile: null,
  status: null,
  graph: null,
  kg: null,
  memory: [],

  async refresh() {
    set({ loading: true });
    try {
      const { projects } = await aiClient.listProjects();
      set({ projects, reachable: true, loading: false });
    } catch {
      set({ reachable: false, loading: false });
    }
  },

  async addProject(path, name) {
    try {
      const res = await aiClient.addProject(path, name);
      if ('error' in res) return { ok: false, error: res.error };
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async open(id) {
    set({ openId: id, profile: null, status: null, graph: null, kg: null, memory: [] });
    if (poll) { clearInterval(poll); poll = null; }
    const loadGraphs = async () => {
      try {
        const [graph, kg] = await Promise.all([aiClient.graph(), aiClient.knowledgeGraph(id).catch(() => null)]);
        if (get().openId === id) set({ graph, kg });
      } catch { /* keep */ }
    };
    try {
      const res = await aiClient.openProject(id);
      if ('error' in res) { set({ reachable: false }); return; }
      set({ profile: res.profile, status: res.status, reachable: true });
      await get().loadMemory(id);
      // Poll indexing until ready, then pull the freshly built graphs.
      const tick = async () => {
        try {
          const status = await aiClient.indexStatus();
          if (get().openId === id) set({ status });
          if (status.phase === 'ready' || status.phase === 'error') {
            if (poll) { clearInterval(poll); poll = null; }
            if (status.phase === 'ready') await loadGraphs();
          }
        } catch {
          if (poll) { clearInterval(poll); poll = null; }
        }
      };
      if (res.status.phase === 'ready') await loadGraphs();
      else poll = setInterval(tick, 600);
    } catch {
      set({ reachable: false });
    }
  },

  async rename(id, name) {
    await aiClient.renameProject(id, name);
    await get().refresh();
  },
  async favorite(id, fav) {
    await aiClient.favoriteProject(id, fav);
    await get().refresh();
  },
  async remove(id) {
    await aiClient.removeProject(id);
    if (get().openId === id) set({ openId: null, profile: null, status: null, graph: null, kg: null, memory: [] });
    useMemoryStore.getState().purgeProject(id);
    await get().refresh();
  },
  async reindex() {
    const status = await aiClient.reindex();
    set({ status });
    if (status.phase === 'ready') {
      const id = get().openId;
      const [graph, kg] = await Promise.all([aiClient.graph(), id ? aiClient.knowledgeGraph(id).catch(() => null) : Promise.resolve(null)]);
      set({ graph, kg });
    }
  },

  async loadMemory(id) {
    try {
      const { items } = await aiClient.listMemory(id);
      set({ memory: items });
    } catch {
      /* leave existing */
    }
  },
  async addMemory(id, item) {
    await aiClient.addMemory(id, item);
    await get().loadMemory(id);
  },
  async pinMemory(id, memId, pinned) {
    await aiClient.pinMemory(id, memId, pinned);
    await get().loadMemory(id);
  },
  async removeMemory(id, memId) {
    await aiClient.removeMemory(id, memId);
    await get().loadMemory(id);
  },
}));
