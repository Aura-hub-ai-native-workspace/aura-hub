/**
 * windowManager — a content-agnostic floating window model.
 * ==================================================================
 * The Workspace's existing window manager (`ops/layoutStore.ts`) is bound
 * to `PanelKind` — its windows can only ever contain one of a fixed set
 * of panels. The Connected Environment needs windows over *nodes*, which
 * are catalog data rather than a closed union, so it needs a manager that
 * does not know what it is holding.
 *
 * This one keys windows by an opaque `contentId` string and leaves
 * rendering entirely to the caller. It is deliberately generic: the
 * Workspace's manager should eventually be rebuilt on top of it so the
 * app has one windowing model rather than two. Until that migration
 * happens the two coexist — an honest cost, recorded here rather than
 * hidden.
 *
 * Nothing persists. Windows are a working surface, not saved state.
 */

import { create } from 'zustand';

export interface SurfaceWindow {
  id: string;
  /** Opaque key the caller resolves into content. */
  contentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  z: number;
}

export const MIN_W = 300;
export const MIN_H = 220;
const DEFAULT_W = 460;
const DEFAULT_H = 380;

let idSeq = 0;
let zSeq = 10;

interface Rect { x: number; y: number; width: number; height: number }

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * First free slot on a coarse grid, falling back to a bounded cascade
 * when the canvas is too full for a clean fit. Same approach the
 * Workspace uses — a new window should never land exactly on top of an
 * existing one, and should never land off-canvas either.
 */
function place(existing: SurfaceWindow[], canvas: { width: number; height: number }): Rect {
  const cw = canvas.width || 1100;
  const ch = canvas.height || 720;
  const width = Math.min(DEFAULT_W, Math.max(MIN_W, cw - 48));
  const height = Math.min(DEFAULT_H, Math.max(MIN_H, ch - 48));
  const visible = existing.filter((w) => !w.minimized);

  const maxX = Math.max(0, cw - width);
  const maxY = Math.max(0, ch - height);
  for (let y = 20; y <= maxY; y += 34) {
    for (let x = 20; x <= maxX; x += 34) {
      const candidate = { x, y, width, height };
      if (!visible.some((w) => overlaps(candidate, w))) return candidate;
    }
  }
  const step = existing.length % 7;
  return { x: Math.min(64 + step * 26, maxX), y: Math.min(48 + step * 26, maxY), width, height };
}

interface WindowManagerState {
  windows: SurfaceWindow[];
  focusedId: string | null;
  canvas: { width: number; height: number };

  /** Opens `contentId`, or focuses it if a window already holds it. */
  open: (contentId: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  setRect: (id: string, rect: Rect) => void;
  move: (id: string, x: number, y: number) => void;
  setCanvas: (width: number, height: number) => void;
}

export const useWindowManager = create<WindowManagerState>((set, get) => ({
  windows: [],
  focusedId: null,
  canvas: { width: 0, height: 0 },

  open: (contentId) => {
    const { windows, canvas } = get();
    const existing = windows.find((w) => w.contentId === contentId);
    if (existing) {
      get().focus(existing.id);
      return;
    }
    idSeq += 1;
    zSeq += 1;
    const entry: SurfaceWindow = {
      id: `nw${idSeq}`,
      contentId,
      ...place(windows, canvas),
      minimized: false,
      maximized: false,
      z: zSeq,
    };
    set({ windows: [...windows, entry], focusedId: entry.id });
  },

  close: (id) => {
    const { windows, focusedId } = get();
    const rest = windows.filter((w) => w.id !== id);
    set({ windows: rest, focusedId: focusedId === id ? topOf(rest) : focusedId });
  },

  closeAll: () => set({ windows: [], focusedId: null }),

  focus: (id) => {
    const { windows } = get();
    if (!windows.some((w) => w.id === id)) return;
    zSeq += 1;
    const z = zSeq;
    set({
      windows: windows.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)),
      focusedId: id,
    });
  },

  minimize: (id) => {
    const { windows, focusedId } = get();
    const next = windows.map((w) => (w.id === id ? { ...w, minimized: true } : w));
    set({ windows: next, focusedId: focusedId === id ? topOf(next) : focusedId });
  },

  toggleMaximize: (id) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)) })),

  setRect: (id, rect) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id
          ? { ...w, x: rect.x, y: rect.y, width: Math.max(MIN_W, rect.width), height: Math.max(MIN_H, rect.height), maximized: false }
          : w),
    })),

  move: (id, x, y) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, x: Math.max(0, x), y: Math.max(0, y), maximized: false } : w)),
    })),

  setCanvas: (width, height) => set({ canvas: { width, height } }),
}));

function topOf(windows: SurfaceWindow[]): string | null {
  let top: SurfaceWindow | null = null;
  for (const w of windows) {
    if (w.minimized) continue;
    if (!top || w.z > top.z) top = w;
  }
  return top?.id ?? null;
}
