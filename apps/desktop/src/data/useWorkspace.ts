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
  /**
   * Whether the service could actually read the project registry.
   *
   * False means `projects` is empty because the file was unreadable, NOT
   * because the user has none — a distinction anything that prunes state
   * off an empty list has to respect.
   */
  registryReadable: boolean;
  registryError: string | null;
  /** Frontend-only projects created via the "Create Project" flow. They live
   *  in the UI session only — the backend registry (and therefore
   *  persistence/indexing) is intentionally not involved. */
  localProjects: ProjectRecord[];

  // Currently open project
  openId: string | null;
  profile: ProjectProfile | null;
  status: IndexStatus | null;
  graph: GraphView | null;
  kg: KnowledgeGraph | null;
  memory: MemoryItem[];

  refresh: () => Promise<void>;
  addProject: (path: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Frontend-only: prepend a project to the local session list (no backend). */
  createLocalProject: (name: string, path: string) => void;
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
  registryReadable: true,
  registryError: null,
  localProjects: [],
  openId: null,
  profile: null,
  status: null,
  graph: null,
  kg: null,
  memory: [],

  async refresh() {
    set({ loading: true });
    try {
      const res = await aiClient.listProjects();
      // A service that does not report registry health is assumed healthy,
      // so an older build behaves exactly as before.
      set({
        projects: res.projects,
        registryReadable: res.registry ? res.registry.readable : true,
        registryError: res.registry?.error ?? null,
        reachable: true,
        loading: false,
      });
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

  createLocalProject(name, path) {
    const record: ProjectRecord = {
      id: `local-${Date.now().toString(36)}`,
      name: name.trim(),
      path: path.trim(),
      type: 'Application',
      language: '—',
      icon: 'folder',
      color: '#00b3ff',
      favorite: false,
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
    };
    set((s) => ({ localProjects: [record, ...s.localProjects] }));
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
    /* Every response below belongs to project `id`. By the time it lands,
       the user may have opened a different project — `open()` sets
       `openId` synchronously, so a later call has already claimed it.
       Applying a late response would then repaint project B's screen with
       project A's profile, index status and memory.

       `loadGraphs` and the polling `tick` already guarded; the profile,
       status and memory writes did not. The guard is the same one, applied
       to every response-derived field. */
    const superseded = () => get().openId !== id;

    try {
      const res = await aiClient.openProject(id);
      if (superseded()) return;
      if ('error' in res) { set({ reachable: false }); return; }
      set({ profile: res.profile, status: res.status, reachable: true });
      await get().loadMemory(id);
      if (superseded()) return;
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
      // A superseded request's failure says nothing about the service the
      // current one is talking to; reporting it would mark AURA offline
      // while the project the user actually opened loaded fine.
      if (superseded()) return;
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
      // `memory` is state about the OPEN project. A response that arrives
      // after the user opened a different one must be dropped, not applied.
      if (get().openId !== id) return;
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
