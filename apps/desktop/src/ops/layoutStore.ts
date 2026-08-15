/**
 * layoutStore — the Workspace window manager.
 * ------------------------------------------------------------------
 * The Workspace is a canvas of independent floating windows, not a
 * VS Code-style dock tree: every open tool is a flat `WindowState` with
 * its own position/size/z-order, draggable, resizable, minimizable,
 * maximizable and closable on its own. There is no split tree, no tab
 * stack, no dock target — "docking" as a concept doesn't exist here.
 *
 * Nothing here persists to localStorage on its own. A brand-new launch
 * is always an empty canvas; the only things that can ever populate it
 * are the user launching a tool (`openPanel`) or explicitly loading a
 * named, previously-saved layout (`presets`/`loadPreset`) — both actions
 * taken in the moment, never ambient restored state (see ops/session.ts).
 */
import { create } from 'zustand';
import { relatedKinds, WORKSPACE_TEMPLATES } from './workspaceIntelligence';

/** The tool types the workspace can host. Rendering lives in panels.tsx. */
export type PanelKind =
  | 'missions'
  | 'mission-detail'
  | 'search'
  | 'knowledge'
  | 'architecture'
  | 'diagnostics'
  | 'files'
  | 'docs'
  | 'engineering-memory'
  | 'engineering-learning'
  | 'engineering-agent'
  | 'ai-chat'
  | 'dashboard'
  | 'twin'
  | 'governance';

export interface WindowState {
  id: string;
  kind: PanelKind;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  /** Stacking order — higher draws on top. Bumped by focusWindow/openPanel. */
  z: number;
  /**
   * Whether this window has activity the user hasn't seen. No window kind's
   * underlying screen produces this signal today — it exists as tray
   * capability only (see the Workspace V3 plan's honest-gap note) and is
   * never set to true in this pass.
   */
  hasUnread?: boolean;
}

export interface WindowSuggestion {
  forKind: PanelKind;
  suggestKinds: PanelKind[];
}

export type SearchScope =
  | 'all' | 'files' | 'symbols' | 'knowledge' | 'missions'
  | 'diagnoses' | 'documentation' | 'memory' | 'architecture';

/**
 * Which ENTITY a detail panel is showing, inside the one active project.
 *
 * There is deliberately no `projectId` here. It used to carry one, and
 * consumers resolved `focused.projectId ?? openId` — so a focus set from a
 * notification, a memory record or a search hit belonging to another
 * project silently became the panel's scope, while the rest of the shell
 * still showed the active project. It was also persisted across relaunches
 * by ops/session.ts, making it a second, durable project pointer.
 *
 * Every writer was examined and none of them needed it: search already
 * switched the active project, the panel's own re-focus was passing its own
 * scope back to itself, and the notification/memory writers were the leak
 * itself. A detail focus is now `activeProjectId + entityId`, which is what
 * they all actually meant.
 *
 * A detail belonging to another project is reached by switching to that
 * project first — deliberately, through the one authority. See
 * `ops/openDetail.ts`.
 */
export interface DetailFocus {
  missionId: string | null;
  diagnosisId: string | null;
}

/**
 * Saved layouts are stored PER PROJECT.
 *
 * One global key meant a layout saved while working on project A would be
 * offered — and restored — under project B. The project id is supplied by
 * the caller rather than held here: this store deliberately owns no
 * project pointer (see `DetailFocus`).
 */
const PRESETS_KEY_BASE = 'aura.ops.layouts';
const presetsKey = (projectId: string | null) =>
  (projectId ? `${PRESETS_KEY_BASE}:${projectId}` : PRESETS_KEY_BASE);
const DEFAULT_W = 560;
const DEFAULT_H = 420;
const MIN_W = 280;
const MIN_H = 200;

let idSeq = 0;
function windowId(): string {
  idSeq += 1;
  return `w${Date.now().toString(36)}${idSeq}`;
}

let zSeq = 1;
function nextZ(): number {
  zSeq += 1;
  return zSeq;
}

type Rect = { x: number; y: number; width: number; height: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Chooses where a newly-opened window should land: next to an already-open
 * related tool if one was passed, else the first spot on a coarse grid that
 * doesn't overlap any visible window, else a clamped cascade if the canvas
 * is too crowded for a clean fit. A one-off cost on window-open, not a
 * per-frame operation — a few thousand rect checks at worst for realistic
 * window counts.
 */
function computePlacement(existing: WindowState[], canvas: { width: number; height: number }, opts?: { near?: WindowState }): Rect {
  const visible = existing.filter((w) => !w.minimized);
  const cw = canvas.width || 1200;
  const ch = canvas.height || 800;
  const width = Math.min(DEFAULT_W, Math.max(MIN_W, cw * 0.9));
  const height = Math.min(DEFAULT_H, Math.max(MIN_H, ch * 0.9));

  const fits = (x: number, y: number) =>
    x >= 0 && y >= 0 && x + width <= cw && y + height <= ch &&
    !visible.some((w) => overlaps({ x, y, width, height }, w));

  if (opts?.near) {
    const n = opts.near;
    const rightOf = { x: n.x + n.width + 24, y: n.y };
    if (fits(rightOf.x, rightOf.y)) return { ...rightOf, width, height };
    const below = { x: n.x, y: n.y + n.height + 24 };
    if (fits(below.x, below.y)) return { ...below, width, height };
  }

  const step = 32;
  const maxX = Math.max(0, cw - width);
  const maxY = Math.max(0, ch - height);
  for (let y = 24; y <= maxY; y += step) {
    for (let x = 24; x <= maxX; x += step) {
      if (fits(x, y)) return { x, y, width, height };
    }
  }

  const cascade = existing.length % 8;
  return { x: Math.min(96 + cascade * 28, maxX), y: Math.min(64 + cascade * 28, maxY), width, height };
}

/** A clean split layout for a template's window count — halves for 2, a wide pane + stacked pair for 3, quadrants for 4 (templates are curated to 2–3 kinds today; 4 is supported for headroom). */
function templateSlots(count: number, w: number, h: number): Rect[] {
  const pad = 16;
  const clampW = (v: number) => Math.max(MIN_W, v);
  const clampH = (v: number) => Math.max(MIN_H, v);
  if (count <= 1) return [{ x: pad, y: pad, width: clampW(w - pad * 2), height: clampH(h - pad * 2) }];

  const halfW = clampW((w - pad * 3) / 2);
  const halfH = clampH((h - pad * 3) / 2);
  const fullH = clampH(h - pad * 2);

  if (count === 2) {
    return [
      { x: pad, y: pad, width: halfW, height: fullH },
      { x: pad * 2 + halfW, y: pad, width: halfW, height: fullH },
    ];
  }
  if (count === 3) {
    return [
      { x: pad, y: pad, width: halfW, height: fullH },
      { x: pad * 2 + halfW, y: pad, width: halfW, height: halfH },
      { x: pad * 2 + halfW, y: pad * 2 + halfH, width: halfW, height: halfH },
    ];
  }
  const quad: Rect[] = [
    { x: pad, y: pad, width: halfW, height: halfH },
    { x: pad * 2 + halfW, y: pad, width: halfW, height: halfH },
    { x: pad, y: pad * 2 + halfH, width: halfW, height: halfH },
    { x: pad * 2 + halfW, y: pad * 2 + halfH, width: halfW, height: halfH },
  ];
  return Array.from({ length: count }, (_, i) => quad[i % 4]);
}

interface LayoutState {
  windows: WindowState[];
  focusedWindowId: string | null;
  focused: DetailFocus;
  searchScope: SearchScope | null;
  searchOpen: boolean;
  presets: Record<string, WindowState[]>;
  /** Current pixel size of the canvas, kept live by a ResizeObserver in WorkspaceCanvas.tsx. Used only to place/size new windows sensibly — {0,0} before the Workspace has ever mounted falls back to a reasonable default inside computePlacement. */
  canvasSize: { width: number; height: number };
  /** A deterministic, dismissible nudge to open a related tool — never applied automatically. See workspaceIntelligence.ts. */
  suggestion: WindowSuggestion | null;

  /** Opens `kind`, or focuses its existing window if the kind is a singleton (the default — see PANEL_META.allowMultiple) and one is already open. Tools only ever launch windows this way; nothing else creates one. Places the new window intelligently: biased next to an already-open related tool, else the first non-overlapping spot, else a clamped cascade. */
  openPanel: (kind: PanelKind) => void;
  closeWindow: (id: string) => void;
  closeAll: () => void;
  focusWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  toggleMaximize: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  resizeWindow: (id: string, width: number, height: number) => void;
  setRect: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
  setCanvasSize: (width: number, height: number) => void;
  /** Reorders the tray's display order only — independent of `z`, never touches focus/stacking. */
  reorderWindows: (fromId: string, toId: string) => void;
  /** Opens (or repositions, if already open) every window in a named template into a clean split layout. */
  applyTemplate: (id: string) => void;
  dismissSuggestion: () => void;

  setFocused: (partial: Partial<DetailFocus>) => void;
  setSearchScope: (scope: SearchScope | null, open?: boolean) => void;

  savePreset: (name: string) => void;
  loadPreset: (name: string) => void;
  removePreset: (name: string) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  windows: [],
  focusedWindowId: null,
  focused: { missionId: null, diagnosisId: null },
  searchScope: null,
  searchOpen: false,
  presets: {},
  canvasSize: { width: 0, height: 0 },
  suggestion: null,

  openPanel: (kind) => {
    const { windows, canvasSize } = get();
    if (!allowsMultiple(kind)) {
      const existing = windows.find((w) => w.kind === kind);
      if (existing) {
        get().focusWindow(existing.id);
        return;
      }
    }
    const related = relatedKinds(kind);
    const near = related.length ? windows.find((w) => !w.minimized && related.includes(w.kind)) : undefined;
    const rect = computePlacement(windows, canvasSize, { near });
    const entry: WindowState = {
      id: windowId(),
      kind,
      ...rect,
      minimized: false,
      maximized: false,
      z: nextZ(),
    };
    const missingRelated = related.filter((k) => k !== kind && !windows.some((w) => w.kind === k));
    set({
      windows: [...windows, entry],
      focusedWindowId: entry.id,
      suggestion: missingRelated.length ? { forKind: kind, suggestKinds: missingRelated } : null,
    });
  },

  applyTemplate: (id) => {
    const template = WORKSPACE_TEMPLATES.find((t) => t.id === id);
    if (!template || !template.kinds.length) return;
    const { windows, canvasSize } = get();
    const w = canvasSize.width || 1200;
    const h = canvasSize.height || 800;
    const slots = templateSlots(template.kinds.length, w, h);
    const next = [...windows];
    let focusId: string | null = null;
    template.kinds.forEach((kind, i) => {
      const rect = slots[i];
      const z = nextZ();
      const existingIdx = next.findIndex((win) => win.kind === kind);
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...rect, minimized: false, maximized: false, z };
        if (i === 0) focusId = next[existingIdx].id;
      } else {
        const entry: WindowState = { id: windowId(), kind, ...rect, minimized: false, maximized: false, z };
        next.push(entry);
        if (i === 0) focusId = entry.id;
      }
    });
    set({ windows: next, focusedWindowId: focusId, suggestion: null });
  },

  reorderWindows: (fromId, toId) => {
    const { windows } = get();
    const fromIdx = windows.findIndex((w) => w.id === fromId);
    const toIdx = windows.findIndex((w) => w.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const next = [...windows];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    set({ windows: next });
  },

  setCanvasSize: (width, height) => set({ canvasSize: { width, height } }),

  dismissSuggestion: () => set({ suggestion: null }),

  closeWindow: (id) => {
    const { windows, focusedWindowId } = get();
    const rest = windows.filter((w) => w.id !== id);
    const nextFocused = focusedWindowId === id ? topWindowId(rest) : focusedWindowId;
    set({ windows: rest, focusedWindowId: nextFocused });
  },

  closeAll: () => set({ windows: [], focusedWindowId: null }),

  focusWindow: (id) => {
    const { windows } = get();
    if (!windows.some((w) => w.id === id)) return;
    const z = nextZ();
    set({
      windows: windows.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)),
      focusedWindowId: id,
    });
  },

  minimizeWindow: (id) => {
    const { windows, focusedWindowId } = get();
    const rest = windows.map((w) => (w.id === id ? { ...w, minimized: true } : w));
    const nextFocused = focusedWindowId === id ? topWindowId(rest) : focusedWindowId;
    set({ windows: rest, focusedWindowId: nextFocused });
  },

  toggleMaximize: (id) => {
    const { windows } = get();
    set({ windows: windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)) });
  },

  moveWindow: (id, x, y) => {
    const { windows } = get();
    set({
      windows: windows.map((w) => (w.id === id ? { ...w, x: Math.max(0, x), y: Math.max(0, y), maximized: false } : w)),
    });
  },

  resizeWindow: (id, width, height) => {
    const { windows } = get();
    set({
      windows: windows.map((w) =>
        w.id === id ? { ...w, width: Math.max(MIN_W, width), height: Math.max(MIN_H, height) } : w),
    });
  },

  setRect: (id, rect) => {
    const { windows } = get();
    set({
      windows: windows.map((w) =>
        w.id === id
          ? { ...w, x: rect.x, y: rect.y, width: Math.max(MIN_W, rect.width), height: Math.max(MIN_H, rect.height), maximized: false }
          : w),
    });
  },

  /**
   * Built field-by-field rather than spread, so the focus can only ever
   * hold entity ids.
   *
   * `{ ...s.focused, ...partial }` copied whatever the caller passed —
   * TypeScript rejects a stray `projectId`, but the store is also reached
   * from plain JS and from restored session snapshots, and at runtime the
   * spread would have carried it straight through. Since the whole point
   * of this shape is that it CANNOT hold a project, the guarantee has to
   * be structural, not just typed.
   */
  setFocused: (partial) => set((s) => ({
    focused: {
      missionId: partial.missionId !== undefined ? partial.missionId : s.focused.missionId,
      diagnosisId: partial.diagnosisId !== undefined ? partial.diagnosisId : s.focused.diagnosisId,
    },
  })),

  setSearchScope: (scope, open = true) => set({ searchScope: scope, searchOpen: open }),

  savePreset: (name) => {
    const { windows, presets } = get();
    if (!windows.length) return;
    set({ presets: { ...presets, [name]: windows.map((w) => ({ ...w })) } });
  },

  loadPreset: (name) => {
    const { presets } = get();
    const preset = presets[name];
    if (!preset) return;
    // Fresh ids on load — a loaded preset should never collide with an id
    // already in use, even if the same preset is loaded twice in a row.
    const windows = preset.map((w) => ({ ...w, id: windowId(), z: nextZ() }));
    set({ windows, focusedWindowId: topWindowId(windows) });
  },

  removePreset: (name) => {
    const { presets } = get();
    const next = { ...presets };
    delete next[name];
    set({ presets: next });
  },
}));

function topWindowId(windows: WindowState[]): string | null {
  let top: WindowState | null = null;
  for (const w of windows) {
    if (w.minimized) continue;
    if (!top || w.z > top.z) top = w;
  }
  return top?.id ?? null;
}

/* ── panel metadata (pure data — labels/icons for the Tools shelf & window chrome) ── */

export interface PanelMeta {
  label: string;
  icon: string;
  /** Short caption used in the Tools shelf / New Window picker. */
  hint: string;
  /**
   * Whether more than one window of this kind may be open at once. Every
   * kind's underlying screen currently reads from a single global/
   * project-scoped store (see e.g. `useConversations()`, `useProjectData()`)
   * rather than anything keyed per window instance, so opening a second
   * window of the same kind today would just mirror the first, not give
   * it independent state. Left unset (singleton) everywhere until a
   * screen's data layer is made instance-aware — flip this once it is.
   */
  allowMultiple?: boolean;
}

export const PANEL_META: Record<PanelKind, PanelMeta> = {
  missions: { label: 'Mission Control', icon: 'deploy', hint: 'Create and manage missions' },
  'mission-detail': { label: 'Mission Detail', icon: 'clipboard', hint: 'The focused mission' },
  search: { label: 'Universal Search', icon: 'search', hint: 'Files, symbols, knowledge, more' },
  knowledge: { label: 'Knowledge', icon: 'knowledge', hint: 'Knowledge fabric browser' },
  architecture: { label: 'Architecture', icon: 'architecture', hint: 'Layered structure and dependency explorer' },
  diagnostics: { label: 'Diagnostics', icon: 'bug', hint: 'Diagnosis results and patches' },
  files: { label: 'Files', icon: 'folder', hint: 'File explorer and search' },
  docs: { label: 'Documentation', icon: 'doc', hint: 'Project documentation browser' },
  'engineering-memory': { label: 'Engineering Memory', icon: 'memory', hint: 'Timeline, history, search and graph' },
  'engineering-learning': { label: 'Engineering Learning', icon: 'research', hint: 'Patterns, predictions, trends and health' },
  'engineering-agent': { label: 'Engineering Agent', icon: 'spark', hint: 'Autonomous improvement proposals, approval and verification' },
  'ai-chat': { label: 'Help Chat Assistant', icon: 'spark', hint: 'Chat grounded in the open project' },
  dashboard: { label: 'Engineering Dashboard', icon: 'activity', hint: 'Global mission execution control plane' },
  twin: { label: 'Engineering Twin', icon: 'cpu', hint: 'Live digital twin of the repository' },
  governance: { label: 'Engineering Governance', icon: 'shield', hint: 'Health scorecard, risks, audits and council reviews' },
};

function allowsMultiple(kind: PanelKind): boolean {
  return Boolean(PANEL_META[kind]?.allowMultiple);
}

/* ── persistence helpers (called by ops/session.ts) ─────────────────── */

const VALID_KINDS = new Set<string>(Object.keys(PANEL_META));

function isWindowStateShape(v: unknown): v is WindowState {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.kind === 'string' && VALID_KINDS.has(w.kind) &&
    typeof w.x === 'number' && typeof w.y === 'number' &&
    typeof w.width === 'number' && typeof w.height === 'number'
  );
}

/**
 * Reads named layout presets from disk. Anything that isn't a real array of
 * window-shaped entries is dropped rather than crashing — this is also how
 * a preset saved under the old split-tree model (a completely different
 * shape) degrades safely: it's silently discarded, not migrated, since
 * that concept no longer exists.
 */
export function hydratePresets(projectId: string | null): Record<string, WindowState[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(presetsKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, WindowState[]> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const windows = value.filter(isWindowStateShape).map((w) => ({
        ...w,
        minimized: Boolean(w.minimized),
        maximized: Boolean(w.maximized),
      }));
      if (windows.length) out[name] = windows;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistPresets(projectId: string | null, presets: Record<string, WindowState[]>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(presetsKey(projectId), JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}

/**
 * Removes the ambient layout cache the previous (split-tree) Workspace
 * wrote under this key, so it can never be read back or confused with
 * anything in the new model. That old mechanism no longer exists at all —
 * this is one-time hygiene for machines that ran an earlier build.
 */
const STALE_LAYOUT_KEY = 'aura.ops.layout';
export function clearStaleLayoutCache(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STALE_LAYOUT_KEY);
  } catch {
    /* ignore */
  }
}
