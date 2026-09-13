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
/** The worker arrangement, beside the tool layout and in the same store. */
const WORKERS_KEY = 'aura.workspace.workers';

/**
 * How many tools the Workspace holds at once.
 *
 * The orchestration graph draws a fixed row of three slots, so the store
 * that backs it holds at most three entries. The number lives here rather
 * than in the component because it is a property of the workspace itself:
 * a fourth entry would be a tool the user believes they added and can
 * never see, which is worse than refusing the add.
 */
export const ACTIVE_TOOL_SLOTS = 3;

/**
 * How many AI workers the Workspace holds at once.
 *
 * Same reasoning as the tool row, one row up: the graph draws a fixed
 * six, so the store that backs it holds exactly six entries. A seventh
 * would be a worker the user believes they chose and can never see.
 */
export const WORKER_SLOTS = 6;

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
const DEFAULT_NODE_IDS = ['node', 'git', 'github-cli'];

/**
 * The arrangement a workspace starts with, before the user has made one
 * of their own. These are the six runtime ids the backend's adapter
 * roster reports (`GET /workers`) — stable ids, never display names, so
 * a renamed worker keeps its slot.
 *
 * Unlike the tool seed this is NOT written to disk on first read. A
 * default that has never been chosen is not a decision, and materialising
 * it would make "the user has not touched this" indistinguishable from
 * "the user picked exactly this". The first real edit writes all six.
 */
const DEFAULT_WORKER_IDS = [
  'opencode', 'claude-code', 'kilo-code', 'codex-cli', 'gemini-cli', 'qwen-cli',
];

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
  /**
   * The six worker slots, by position. Always exactly `WORKER_SLOTS`
   * long, and `null` is a real entry: an emptied slot stays where it is
   * rather than shuffling the five beside it.
   */
  workerIds: (string | null)[];
  /**
   * Puts a worker in one slot, filling it or replacing what was there.
   * @returns false when the slot does not exist, or when that worker
   * already occupies a different slot.
   */
  placeWorkerAt: (index: number, workerId: string) => boolean;
  /** Empties one slot. Layout only — nothing is removed from anywhere else. */
  clearWorkerAt: (index: number) => void;
  /** The lowest empty worker slot, or null when all six are taken. */
  firstFreeWorkerSlot: () => number | null;
  /**
   * Places a tool in the first free slot.
   * @returns false when the tool is already placed or all slots are full.
   */
  add: (nodeId: string) => boolean;
  /**
   * Swaps the tool occupying one slot for another, in place.
   * @returns false when the slot does not exist, or when the incoming
   * tool already occupies a different slot.
   */
  replaceAt: (index: number, nodeId: string) => boolean;
  remove: (nodeId: string) => void;
  move: (nodeId: string, x: number, y: number) => void;
  /** Re-arranges every placed node onto the rings. */
  relayout: () => void;
  isPlaced: (nodeId: string) => boolean;
  /** True while fewer than `ACTIVE_TOOL_SLOTS` tools are placed. */
  hasFreeSlot: () => boolean;
}

export const useHubStore = create<HubState>((set, get) => ({
  placed: hydrateLayout(),
  workerIds: hydrateWorkers(),

  placeWorkerAt: (index, workerId) => {
    const current = get().workerIds;
    if (index < 0 || index >= WORKER_SLOTS) return false;
    if (current[index] === workerId) return true;
    // A worker holds one slot at a time, for the same reason a tool
    // does: the same runtime in two places would look like two minds,
    // and freeing one of them would look like freeing both.
    if (current.some((id, i) => i !== index && id === workerId)) return false;
    set((s) => {
      // Position is identity here. Only the occupant of `index` changes,
      // so the other five slots keep both their contents and their order.
      const next = s.workerIds.map((id, i) => (i === index ? workerId : id));
      persistWorkers(next);
      return { workerIds: next };
    });
    return true;
  },

  clearWorkerAt: (index) => {
    if (index < 0 || index >= WORKER_SLOTS) return;
    set((s) => {
      if (s.workerIds[index] === null) return s;
      const next = s.workerIds.map((id, i) => (i === index ? null : id));
      persistWorkers(next);
      return { workerIds: next };
    });
  },

  firstFreeWorkerSlot: () => {
    const i = get().workerIds.indexOf(null);
    return i === -1 ? null : i;
  },

  add: (nodeId) => {
    const current = get().placed;
    // Refusing is the honest answer at capacity: the graph has three
    // slots, so a fourth entry could never be shown or removed again.
    if (current.some((p) => p.nodeId === nodeId)) return false;
    if (current.length >= ACTIVE_TOOL_SLOTS) return false;
    set((s) => {
      const next = [...s.placed, { nodeId, ...radialPlacement(s.placed.length, s.placed.length + 1) }];
      persistLayout(next);
      return { placed: next };
    });
    return true;
  },

  replaceAt: (index, nodeId) => {
    const current = get().placed;
    if (index < 0 || index >= current.length) return false;
    if (current[index].nodeId === nodeId) return true;
    // A tool may hold one slot at a time. Allowing a duplicate would put
    // the same node in two places, and removing it from one would look
    // like removing it from both.
    if (current.some((p, i) => i !== index && p.nodeId === nodeId)) return false;
    set((s) => {
      // The POSITION is kept and only the occupant changes: same index,
      // same x/y. Order is what makes a slot identifiable between
      // renders, so a replace must never reshuffle the row.
      const next = s.placed.map((p, i) => (i === index ? { ...p, nodeId } : p));
      persistLayout(next);
      return { placed: next };
    });
    return true;
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

  hasFreeSlot: () => get().placed.length < ACTIVE_TOOL_SLOTS,
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
    //
    // Capped on READ rather than rewritten here: a layout saved by an
    // older build may hold more than three entries, and the extras are
    // simply never active. They fall away on the next write instead of
    // being deleted behind the user's back at launch.
    return valid.slice(0, ACTIVE_TOOL_SLOTS);
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

/**
 * Reads the saved worker arrangement, or falls back to the default six.
 *
 * Normalised to exactly `WORKER_SLOTS` entries on the way in, because
 * the row is fixed: a shorter saved array gains empty slots, a longer
 * one loses its extras, and a malformed entry becomes an empty slot
 * rather than a name nobody can resolve.
 *
 * An all-empty saved arrangement is a real choice and is kept. Only a
 * missing or corrupt key falls back to the default.
 */
function hydrateWorkers(): (string | null)[] {
  if (typeof localStorage === 'undefined') return normaliseWorkers(DEFAULT_WORKER_IDS);
  try {
    const raw = localStorage.getItem(WORKERS_KEY);
    if (!raw) return normaliseWorkers(DEFAULT_WORKER_IDS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return normaliseWorkers(DEFAULT_WORKER_IDS);
    return normaliseWorkers(parsed);
  } catch {
    return normaliseWorkers(DEFAULT_WORKER_IDS);
  }
}

function normaliseWorkers(source: readonly unknown[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = 0; i < WORKER_SLOTS; i += 1) {
    const value = source[i];
    out.push(typeof value === 'string' && value ? value : null);
  }
  return out;
}

export function persistWorkers(workerIds: (string | null)[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WORKERS_KEY, JSON.stringify(normaliseWorkers(workerIds)));
  } catch {
    /* Quota or private mode — layout is a convenience, never load-bearing. */
  }
}

export function persistLayout(placed: PlacedNode[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(placed));
  } catch {
    /* Quota or private mode — layout is a convenience, never load-bearing. */
  }
}
