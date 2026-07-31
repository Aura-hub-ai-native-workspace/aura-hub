/**
 * Editor Store — the Code Workspace's single source of truth.
 * ------------------------------------------------------------------
 * One Zustand store beside its module (matches @aura/core's own
 * "feature state lives with its feature" rule — see
 * packages/core/src/store/appStore.ts). Owns: open files + their
 * cursor/selection/dirty state, the explorer's lazy directory cache,
 * recent files, and workspace layout (panel widths, bottom panel).
 *
 * Nothing here is fabricated: a folder's children are only fetched when
 * the user expands it, and a file's content is only fetched when a tab
 * for it is opened.
 */
import { create } from 'zustand';
import type {
  BottomPanelTab,
  CursorPosition,
  EditorSelection,
  ExplorerView,
  FileTreeNode,
  OpenFile,
} from './editorTypes';
import { fsCreateFile, fsReadDir, fsReadFile, fsWriteFile, isDesktopFsAvailable } from './fsClient';
import { languageFromPath } from './fileIcons';

const RECENT_LIMIT = 10;
const ROOT_KEY = '';

export interface DirState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  children: FileTreeNode[];
  error?: string;
}

interface EditorState {
  projectId: string | null;
  root: string | null;
  desktopAvailable: boolean | null;

  // Explorer
  sidebarView: ExplorerView;
  expanded: Record<string, boolean>;
  dirs: Record<string, DirState>;
  bookmarks: string[];

  // Tabs
  openOrder: string[];
  openFiles: Record<string, OpenFile>;
  activePath: string | null;
  recentFiles: string[];

  // Layout
  explorerOpen: boolean;
  explorerWidth: number;
  aiPanelOpen: boolean;
  aiPanelWidth: number;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  bottomPanelTab: BottomPanelTab;

  init: (projectId: string, root: string) => Promise<void>;
  setSidebarView: (v: ExplorerView) => void;
  toggleExplorer: () => void;
  toggleBookmark: (path: string) => void;
  toggleExpanded: (path: string) => void;
  loadDir: (path: string) => Promise<void>;
  refreshDir: (path: string) => Promise<void>;
  searchFiles: (query: string) => Promise<FileTreeNode[]>;
  openFile: (node: { path: string; name: string }) => Promise<void>;
  createFile: (path: string, content: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActivePath: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  updateCursor: (path: string, cursor: CursorPosition) => void;
  updateSelection: (path: string, selection: EditorSelection | null) => void;
  saveFile: (path: string) => Promise<void>;
  setExplorerWidth: (w: number) => void;
  setAiPanelWidth: (w: number) => void;
  toggleAiPanel: () => void;
  toggleBottomPanel: () => void;
  setBottomPanelHeight: (h: number) => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
}

function pushRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  root: null,
  desktopAvailable: null,

  sidebarView: 'explorer',
  expanded: {},
  dirs: {},
  bookmarks: [],

  openOrder: [],
  openFiles: {},
  activePath: null,
  recentFiles: [],

  explorerOpen: true,
  explorerWidth: 260,
  aiPanelOpen: true,
  aiPanelWidth: 300,
  bottomPanelOpen: false,
  bottomPanelHeight: 220,
  bottomPanelTab: 'terminal',

  async init(projectId, root) {
    // Switching projects resets everything — stale tabs from a
    // different folder would be actively misleading, not just unused.
    if (get().projectId === projectId && get().root === root) return;
    set({
      projectId,
      root,
      desktopAvailable: null,
      expanded: {},
      dirs: {},
      bookmarks: [],
      openOrder: [],
      openFiles: {},
      activePath: null,
      recentFiles: [],
    });
    const available = await isDesktopFsAvailable();
    set({ desktopAvailable: available });
    if (available) await get().loadDir(ROOT_KEY);
  },

  setSidebarView: (sidebarView) => set({ sidebarView }),
  toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),

  toggleBookmark: (path) =>
    set((s) => ({
      bookmarks: s.bookmarks.includes(path) ? s.bookmarks.filter((p) => p !== path) : [...s.bookmarks, path],
    })),

  toggleExpanded: (path) => {
    const willExpand = !get().expanded[path];
    set((s) => ({ expanded: { ...s.expanded, [path]: willExpand } }));
    if (willExpand && !get().dirs[path]) void get().loadDir(path);
  },

  async loadDir(path) {
    const { root, dirs } = get();
    if (!root) return;
    if (dirs[path]?.status === 'loading' || dirs[path]?.status === 'loaded') return;
    set((s) => ({ dirs: { ...s.dirs, [path]: { status: 'loading', children: [] } } }));
    try {
      const children = await fsReadDir(root, path);
      set((s) => ({ dirs: { ...s.dirs, [path]: { status: 'loaded', children } } }));
    } catch (e) {
      set((s) => ({ dirs: { ...s.dirs, [path]: { status: 'error', children: [], error: (e as Error).message } } }));
    }
  },

  async refreshDir(path) {
    set((s) => ({ dirs: { ...s.dirs, [path]: { status: 'idle', children: [] } } }));
    await get().loadDir(path);
  },

  /**
   * Filename search across the project. Walks directories breadth-first,
   * reusing (and populating) the same lazy `dirs` cache the tree uses,
   * capped so a huge monorepo can't turn a search into a hang.
   */
  async searchFiles(query) {
    const { root } = get();
    const q = query.trim().toLowerCase();
    if (!root || !q) return [];
    const results: FileTreeNode[] = [];
    const queue: string[] = [ROOT_KEY];
    let visited = 0;
    while (queue.length && results.length < 150 && visited < 3000) {
      const dirPath = queue.shift() as string;
      let entry = get().dirs[dirPath];
      if (!entry || entry.status !== 'loaded') {
        try {
          const children = await fsReadDir(root, dirPath);
          entry = { status: 'loaded', children };
          set((s) => ({ dirs: { ...s.dirs, [dirPath]: entry as DirState } }));
        } catch {
          continue;
        }
      }
      visited += 1;
      for (const child of entry.children) {
        if (child.isDir) queue.push(child.path);
        else if (child.name.toLowerCase().includes(q)) results.push(child);
      }
    }
    return results;
  },

  async openFile(node) {
    const { root, openFiles } = get();
    if (!root) return;
    set((s) => ({
      activePath: node.path,
      openOrder: s.openOrder.includes(node.path) ? s.openOrder : [...s.openOrder, node.path],
      recentFiles: pushRecent(s.recentFiles, node.path),
    }));
    if (openFiles[node.path]) return; // already loaded — just focused the tab

    const language = languageFromPath(node.path);
    set((s) => ({
      openFiles: {
        ...s.openFiles,
        [node.path]: {
          path: node.path,
          name: node.name,
          language,
          content: '',
          originalContent: '',
          dirty: false,
          loading: true,
          error: null,
          cursor: { line: 1, column: 1 },
          selection: null,
        },
      },
    }));
    try {
      const content = await fsReadFile(root, node.path);
      set((s) => {
        const existing = s.openFiles[node.path];
        if (!existing) return s; // tab was closed while the read was in flight
        return {
          openFiles: {
            ...s.openFiles,
            [node.path]: { ...existing, content, originalContent: content, loading: false },
          },
        };
      });
    } catch (e) {
      set((s) => {
        const existing = s.openFiles[node.path];
        if (!existing) return s;
        return {
          openFiles: { ...s.openFiles, [node.path]: { ...existing, loading: false, error: (e as Error).message } },
        };
      });
    }
  },

  /** Writes a brand-new file to disk (refuses to clobber) and opens it as a tab. */
  async createFile(path, content) {
    const { root } = get();
    if (!root) return;
    await fsCreateFile(root, path, content);
    const name = path.split('/').pop() ?? path;
    const language = languageFromPath(path);
    set((s) => ({
      activePath: path,
      openOrder: s.openOrder.includes(path) ? s.openOrder : [...s.openOrder, path],
      recentFiles: pushRecent(s.recentFiles, path),
      openFiles: {
        ...s.openFiles,
        [path]: {
          path,
          name,
          language,
          content,
          originalContent: content,
          dirty: false,
          loading: false,
          error: null,
          cursor: { line: 1, column: 1 },
          selection: null,
        },
      },
    }));
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_KEY;
    void get().refreshDir(parent);
  },

  closeFile(path) {
    set((s) => {
      const openOrder = s.openOrder.filter((p) => p !== path);
      const openFiles = { ...s.openFiles };
      delete openFiles[path];
      let activePath = s.activePath;
      if (activePath === path) {
        const idx = s.openOrder.indexOf(path);
        activePath = openOrder[idx] ?? openOrder[idx - 1] ?? null;
      }
      return { openOrder, openFiles, activePath };
    });
  },

  setActivePath: (activePath) => set({ activePath }),

  updateContent: (path, content) =>
    set((s) => {
      const file = s.openFiles[path];
      if (!file) return s;
      return {
        openFiles: {
          ...s.openFiles,
          [path]: { ...file, content, dirty: content !== file.originalContent },
        },
      };
    }),

  updateCursor: (path, cursor) =>
    set((s) => {
      const file = s.openFiles[path];
      if (!file) return s;
      return { openFiles: { ...s.openFiles, [path]: { ...file, cursor } } };
    }),

  updateSelection: (path, selection) =>
    set((s) => {
      const file = s.openFiles[path];
      if (!file) return s;
      return { openFiles: { ...s.openFiles, [path]: { ...file, selection } } };
    }),

  async saveFile(path) {
    const { root, openFiles } = get();
    const file = openFiles[path];
    if (!root || !file || !file.dirty) return;
    try {
      await fsWriteFile(root, path, file.content);
      set((s) => {
        const current = s.openFiles[path];
        if (!current) return s;
        return {
          openFiles: { ...s.openFiles, [path]: { ...current, originalContent: current.content, dirty: false } },
        };
      });
    } catch (e) {
      set((s) => {
        const current = s.openFiles[path];
        if (!current) return s;
        return { openFiles: { ...s.openFiles, [path]: { ...current, error: (e as Error).message } } };
      });
    }
  },

  setExplorerWidth: (w) => set({ explorerWidth: Math.min(480, Math.max(180, w)) }),
  setAiPanelWidth: (w) => set({ aiPanelWidth: Math.min(480, Math.max(220, w)) }),
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setBottomPanelHeight: (h) => set({ bottomPanelHeight: Math.min(560, Math.max(120, h)) }),
  setBottomPanelTab: (bottomPanelTab) => set({ bottomPanelTab, bottomPanelOpen: true }),
}));
