/**
 * layoutStore — the multi-panel workspace layout engine.
 * ------------------------------------------------------------------
 * A dockable workspace is modelled as a recursive binary split tree:
 * every node is either a *leaf* (a tab stack of open panels) or a
 * *split* (two child nodes side by side / stacked, separated by a
 * user-draggable divider). This keeps docking, splitting, resizing,
 * save/restore and persistence all data-driven and serialisable.
 *
 * The tree is persisted to localStorage so a relaunch restores the
 * exact arrangement the user left (see ops/session.ts). Nothing here
 * talks to an engine — it is pure shell state.
 */
import { create } from 'zustand';

/** The panel types the workspace can host. Rendering lives in panels.tsx. */
export type PanelKind =
  | 'overview'
  | 'missions'
  | 'mission-detail'
  | 'search'
  | 'notifications'
  | 'feed'
  | 'knowledge'
  | 'memory'
  | 'diagnostics'
  | 'files'
  | 'docs';

export interface LayoutLeaf {
  id: string;
  kind: 'leaf';
  active: PanelKind;
  tabs: PanelKind[];
}

export interface LayoutSplit {
  id: string;
  kind: 'split';
  /** row = side-by-side, col = stacked. */
  dir: 'row' | 'col';
  first: LayoutNode;
  second: LayoutNode;
  /** first's share of the axis, 0.15–0.85. */
  ratio: number;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export type SearchScope =
  | 'all' | 'files' | 'symbols' | 'knowledge' | 'missions'
  | 'diagnoses' | 'documentation' | 'memory' | 'architecture';

export interface DetailFocus {
  projectId: string | null;
  missionId: string | null;
  diagnosisId: string | null;
}

const LAYOUT_KEY = 'aura.ops.layout';
const PRESETS_KEY = 'aura.ops.layouts';

let idSeq = 0;
function nodeId(): string {
  idSeq += 1;
  return `n${Date.now().toString(36)}${idSeq}`;
}

export function makeLeaf(active: PanelKind, tabs?: PanelKind[]): LayoutLeaf {
  const all = tabs && tabs.length ? tabs : [active];
  return { id: nodeId(), kind: 'leaf', active: all.includes(active) ? active : all[0], tabs: all };
}

/** The default three-pane arrangement every new user starts from. */
export function defaultLayout(): LayoutSplit {
  return {
    id: nodeId(),
    kind: 'split',
    dir: 'row',
    ratio: 0.38,
    first: {
      id: nodeId(),
      kind: 'split',
      dir: 'col',
      ratio: 0.55,
      first: makeLeaf('overview', ['overview', 'feed']),
      second: makeLeaf('missions', ['missions', 'mission-detail']),
    },
    second: makeLeaf('search', ['search', 'notifications', 'diagnostics', 'knowledge']),
  };
}

/** Drop a leaf that lost its last tab; collapse splits that lost a child. */
export function prune(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') return node.tabs.length === 0 ? null : node;
  const first = prune(node.first);
  const second = prune(node.second);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function findLeaf(node: LayoutNode | null, leafId: string): LayoutLeaf | null {
  if (!node) return null;
  if (node.kind === 'leaf') return node.id === leafId ? node : null;
  return findLeaf(node.first, leafId) ?? findLeaf(node.second, leafId);
}

function leafOf(node: LayoutNode | null, kind: PanelKind): LayoutLeaf | null {
  if (!node) return null;
  if (node.kind === 'leaf') return node.tabs.includes(kind) ? node : null;
  return leafOf(node.first, kind) ?? leafOf(node.second, kind);
}

function firstLeaf(node: LayoutNode | null): LayoutLeaf | null {
  if (!node) return null;
  if (node.kind === 'leaf') return node;
  return firstLeaf(node.first) ?? firstLeaf(node.second);
}

function mapNode(node: LayoutNode | null, fn: (n: LayoutNode) => LayoutNode): LayoutNode | null {
  if (!node) return null;
  const updated = fn(node);
  if (updated.kind === 'leaf') return updated;
  return {
    ...updated,
    first: mapNode(updated.first, fn) ?? updated.first,
    second: mapNode(updated.second, fn) ?? updated.second,
  };
}

interface LayoutState {
  root: LayoutNode | null;
  focused: DetailFocus;
  searchScope: SearchScope | null;
  searchOpen: boolean;
  presets: Record<string, LayoutNode>;

  setRoot: (root: LayoutNode | null) => void;
  resetLayout: () => void;
  openPanel: (kind: PanelKind, opts?: { leafId?: string }) => void;
  closeTab: (leafId: string, kind: PanelKind) => void;
  setActive: (leafId: string, kind: PanelKind) => void;
  moveTab: (kind: PanelKind, fromLeafId: string, toLeafId: string) => void;
  splitLeaf: (leafId: string, dir: 'row' | 'col', kind: PanelKind) => void;
  setRatio: (nodeId: string, ratio: number) => void;
  removeLeaf: (leafId: string) => void;

  setFocused: (partial: Partial<DetailFocus>) => void;
  setSearchScope: (scope: SearchScope | null, open?: boolean) => void;

  savePreset: (name: string) => void;
  loadPreset: (name: string) => void;
  removePreset: (name: string) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  root: null,
  focused: { projectId: null, missionId: null, diagnosisId: null },
  searchScope: null,
  searchOpen: false,
  presets: {},

  setRoot: (root) => set({ root }),

  resetLayout: () => set({ root: defaultLayout(), searchScope: null }),

  openPanel: (kind, opts) => {
    const { root } = get();
    if (!root) {
      set({ root: makeLeaf(kind) });
      return;
    }
    const target = (opts?.leafId && findLeaf(root, opts.leafId)) ?? leafOf(root, kind) ?? firstLeaf(root);
    if (!target) {
      set({ root: makeLeaf(kind) });
      return;
    }
    const update = (node: LayoutNode): LayoutNode => {
      if (node.kind !== 'leaf' || node.id !== target.id) return node;
      const tabs = node.tabs.includes(kind) ? node.tabs : [...node.tabs, kind];
      return { ...node, tabs, active: kind };
    };
    set({ root: mapNode(root, update) });
  },

  closeTab: (leafId, kind) => {
    const { root } = get();
    if (!root) return;
    const update = (node: LayoutNode): LayoutNode => {
      if (node.kind !== 'leaf' || node.id !== leafId) return node;
      const tabs = node.tabs.filter((t) => t !== kind);
      if (tabs.length === 0) return node;
      const active = node.active === kind ? tabs[tabs.length - 1] : node.active;
      return { ...node, tabs, active };
    };
    set({ root: prune(mapNode(root, update)) });
  },

  setActive: (leafId, kind) => {
    const { root } = get();
    if (!root) return;
    set({
      root: mapNode(root, (n) =>
        n.kind === 'leaf' && n.id === leafId && n.tabs.includes(kind)
          ? { ...n, active: kind }
          : n),
    });
  },

  moveTab: (kind, fromLeafId, toLeafId) => {
    const { root } = get();
    if (!root || fromLeafId === toLeafId) return;
    let removed = false;
    const update = (node: LayoutNode): LayoutNode => {
      if (node.kind !== 'leaf') return node;
      if (node.id === fromLeafId && node.tabs.includes(kind)) {
        removed = true;
        const tabs = node.tabs.filter((t) => t !== kind);
        if (tabs.length === 0) return node;
        const active = node.active === kind ? tabs[tabs.length - 1] : node.active;
        return { ...node, tabs, active };
      }
      return node;
    };
    let root2 = prune(mapNode(root, update));
    if (!removed) return;
    const target = root2 ? findLeaf(root2, toLeafId) ?? firstLeaf(root2) : null;
    if (!target) {
      set({ root: root2 });
      return;
    }
    root2 = mapNode(root2, (n) =>
      n.kind === 'leaf' && n.id === target.id && !n.tabs.includes(kind)
        ? { ...n, tabs: [...n.tabs, kind], active: kind }
        : n);
    set({ root: root2 });
  },

  splitLeaf: (leafId, dir, kind) => {
    const { root } = get();
    if (!root) return;
    const existing = leafOf(root, kind);
    if (existing) {
      const update = (node: LayoutNode): LayoutNode =>
        node.kind === 'leaf' && node.id === existing.id ? { ...node, active: kind } : node;
      set({ root: mapNode(root, update) });
      return;
    }
    const update = (node: LayoutNode): LayoutNode => {
      if (node.kind !== 'leaf' || node.id !== leafId) return node;
      const split: LayoutSplit = { id: nodeId(), kind: 'split', dir, ratio: 0.5, first: node, second: makeLeaf(kind) };
      return split;
    };
    set({ root: prune(mapNode(root, update)) });
  },

  setRatio: (nodeId, ratio) => {
    const { root } = get();
    if (!root) return;
    const clamped = Math.min(0.85, Math.max(0.15, ratio));
    set({
      root: mapNode(root, (n) =>
        n.kind === 'split' && n.id === nodeId ? { ...n, ratio: clamped } : n),
    });
  },

  removeLeaf: (leafId) => {
    const { root } = get();
    if (!root) return;
    const update = (node: LayoutNode): LayoutNode | null => {
      if (node.kind === 'leaf') return node.id === leafId ? null : node;
      const first = prune(update(node.first));
      const second = prune(update(node.second));
      if (!first) return second;
      if (!second) return first;
      return { ...node, first, second };
    };
    set({ root: prune(update(root)) });
  },

  setFocused: (partial) => set((s) => ({ focused: { ...s.focused, ...partial } })),

  setSearchScope: (scope, open = true) => set({ searchScope: scope, searchOpen: open }),

  savePreset: (name) => {
    const { root, presets } = get();
    if (!root) return;
    set({ presets: { ...presets, [name]: root } });
  },

  loadPreset: (name) => {
    const { presets } = get();
    const preset = presets[name];
    if (preset) set({ root: preset });
  },

  removePreset: (name) => {
    const { presets } = get();
    const next = { ...presets };
    delete next[name];
    set({ presets: next });
  },
}));

/* ── panel metadata (pure data — labels/icons for tab bars & menus) ── */

export interface PanelMeta {
  label: string;
  icon: string;
  /** Short caption used in the add-panel menu. */
  hint: string;
}

export const PANEL_META: Record<PanelKind, PanelMeta> = {
  overview: { label: 'Engineering Overview', icon: 'activity', hint: 'Health, missions, reviews, feed' },
  missions: { label: 'Mission Control', icon: 'deploy', hint: 'Create and manage missions' },
  'mission-detail': { label: 'Mission Detail', icon: 'clipboard', hint: 'The focused mission' },
  search: { label: 'Universal Search', icon: 'search', hint: 'Files, symbols, knowledge, more' },
  notifications: { label: 'Notifications', icon: 'bell', hint: 'Engineering notification center' },
  feed: { label: 'Engineering Feed', icon: 'activity', hint: 'Live activity across the workspace' },
  knowledge: { label: 'Knowledge', icon: 'knowledge', hint: 'Knowledge fabric browser' },
  memory: { label: 'Memory', icon: 'memory', hint: 'Engineering memory items' },
  diagnostics: { label: 'Diagnostics', icon: 'bug', hint: 'Diagnosis results and patches' },
  files: { label: 'Files', icon: 'folder', hint: 'File explorer and search' },
  docs: { label: 'Documentation', icon: 'doc', hint: 'Project documentation browser' },
};

/* ── persistence helpers (called by ops/session.ts) ─────────────────── */

export function hydrateLayouts(): LayoutNode | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as LayoutNode) : defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export function persistLayout(root: LayoutNode | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (root) localStorage.setItem(LAYOUT_KEY, JSON.stringify(root));
    else localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* storage full / blocked — layout just won't persist */
  }
}

export function hydratePresets(): Record<string, LayoutNode> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, LayoutNode>) : {};
  } catch {
    return {};
  }
}

export function persistPresets(presets: Record<string, LayoutNode>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}
