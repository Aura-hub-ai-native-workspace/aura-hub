/**
 * hubStore — which capability nodes are placed in this Workspace, and where.
 * ==================================================================
 * This store holds **layout only**. It deliberately knows nothing about
 * whether a tool is installed, reachable or connected: those are facts
 * about the *machine*, measured by real probes and owned by
 * `environmentStore` (which re-scans on every launch rather than trusting
 * a cached "Docker is connected" that may no longer be true).
 *
 * Keeping the split honest matters. If layout persisted node status, a
 * workspace restored from disk could confidently show a green Docker node
 * on a machine where Docker had since been removed — exactly the class of
 * confident wrong answer this architecture exists to avoid. So a restored
 * workspace shows its nodes in `unknown` until the first scan answers.
 *
 * Positions are stored as **fractions of the canvas** rather than pixels,
 * so a layout arranged on a wide monitor still reads correctly in a narrow
 * window. See docs/WORKSPACE_EXECUTION_ARCHITECTURE.md §11.
 */

import { create } from 'zustand';

const LAYOUT_KEY = 'aura.workspace.layout';

/** A node placed on the canvas. `x`/`y` are 0..1 fractions of canvas size. */
export interface PlacedNode {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * What a brand-new Workspace starts with. Chosen because every one of
 * these is a real catalogue entry with a real probe behind it, so a first
 * launch shows genuinely measured state rather than decoration.
 */
const DEFAULT_NODE_IDS = ['node', 'git', 'github-cli', 'docker'];

/** The Hub sits at the centre; nodes are arranged around it. */
export const HUB_CENTRE = { x: 0.5, y: 0.5 };

/**
 * Places nodes evenly on a ring around the Hub. A second ring starts once
 * the first would crowd — past about eight nodes the labels collide.
 */
export function radialPlacement(index: number, total: number): { x: number; y: number } {
  const perRing = 8;
  const ring = Math.floor(index / perRing);
  const inRing = index % perRing;
  const ringTotal = Math.min(perRing, total - ring * perRing);
  // Start at the top and go clockwise; offset alternate rings so nodes on
  // the outer ring don't hide directly behind inner ones.
  const step = (Math.PI * 2) / Math.max(1, ringTotal);
  const angle = -Math.PI / 2 + inRing * step + (ring % 2 ? step / 2 : 0);
  // The first ring has to clear the Hub itself, which carries a composer,
  // a project picker and its gates — roughly 380×340. Sized against the
  // Hub's half-height rather than eyeballed, so nodes directly above and
  // below it cannot overlap the thing they orbit.
  const radius = 0.36 + ring * 0.15;
  return {
    x: HUB_CENTRE.x + Math.cos(angle) * radius,
    y: HUB_CENTRE.y + Math.sin(angle) * radius * 0.82, // canvases are wider than tall
  };
}

interface HubState {
  placed: PlacedNode[];
  add: (nodeId: string) => void;
  remove: (nodeId: string) => void;
  move: (nodeId: string, x: number, y: number) => void;
  /** Re-arranges every placed node onto the rings. */
  relayout: () => void;
  isPlaced: (nodeId: string) => boolean;
}

export const useHubStore = create<HubState>((set, get) => ({
  placed: hydrateLayout(),

  add: (nodeId) => {
    if (get().placed.some((p) => p.nodeId === nodeId)) return;
    set((s) => {
      const next = [...s.placed, { nodeId, ...radialPlacement(s.placed.length, s.placed.length + 1) }];
      persistLayout(next);
      return { placed: next };
    });
  },

  remove: (nodeId) =>
    set((s) => {
      const next = s.placed.filter((p) => p.nodeId !== nodeId);
      persistLayout(next);
      return { placed: next };
    }),

  move: (nodeId, x, y) =>
    set((s) => {
      // Clamped so a node can never be dragged off the canvas and stranded.
      const next = s.placed.map((p) =>
        p.nodeId === nodeId ? { ...p, x: clamp01(x), y: clamp01(y) } : p,
      );
      persistLayout(next);
      return { placed: next };
    }),

  relayout: () =>
    set((s) => {
      const next = s.placed.map((p, i) => ({ ...p, ...radialPlacement(i, s.placed.length) }));
      persistLayout(next);
      return { placed: next };
    }),

  isPlaced: (nodeId) => get().placed.some((p) => p.nodeId === nodeId),
}));

const clamp01 = (n: number) => Math.min(0.97, Math.max(0.03, n));

/**
 * Reads the saved layout. Anything malformed is discarded rather than
 * partially trusted — a corrupt entry would place a node at NaN and
 * silently vanish from the canvas.
 */
function hydrateLayout(): PlacedNode[] {
  if (typeof localStorage === 'undefined') return seedLayout();
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return seedLayout();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedLayout();
    const valid = parsed.filter(
      (p): p is PlacedNode =>
        !!p &&
        typeof (p as PlacedNode).nodeId === 'string' &&
        Number.isFinite((p as PlacedNode).x) &&
        Number.isFinite((p as PlacedNode).y),
    );
    // An empty saved layout is a real choice (the user removed everything)
    // and is preserved; only a missing/corrupt file re-seeds.
    return valid;
  } catch {
    return seedLayout();
  }
}

/**
 * The first-run layout, written to disk immediately. Materialising it
 * matters: if the seed were recomputed on every launch, a later change to
 * `DEFAULT_NODE_IDS` would silently rearrange a workspace the user had
 * already made their own.
 */
function seedLayout(): PlacedNode[] {
  const seeded = DEFAULT_NODE_IDS.map((nodeId, i) => ({
    nodeId,
    ...radialPlacement(i, DEFAULT_NODE_IDS.length),
  }));
  persistLayout(seeded);
  return seeded;
}

export function persistLayout(placed: PlacedNode[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(placed));
  } catch {
    /* Quota or private mode — layout is a convenience, never load-bearing. */
  }
}
