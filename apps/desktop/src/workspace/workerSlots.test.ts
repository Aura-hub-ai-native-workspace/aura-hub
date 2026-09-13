/**
 * The Workspace's six worker slots — derivation and persistence.
 *
 * The counterpart to `toolSlots.test.ts`, holding the same contract one
 * row up. Six worker tiles used to be `workers.slice(0, 6)`: whatever
 * the backend listed first, in the backend's order, with no way to
 * choose and nothing to persist. They are now slots the user owns.
 *
 * These pin the half that needs no DOM — WHICH workers occupy the slots,
 * what a slot may honestly claim about the machine, and what survives a
 * reload. The rendered half is pinned in
 * `screens/workspace/neon/OrchestrationGraph.test.tsx`.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerDescriptor } from '../ai/workerClient';
import { WORKER_SLOTS } from './hubStore';
import {
  deriveWorkerSlots,
  workerSlotCaption,
  workerSlotName,
  workerSlotState,
} from './workerSlots';

const WORKERS_KEY = 'aura.workspace.workers';
const LAYOUT_KEY = 'aura.workspace.layout';

/** The six the backend's adapter roster reports, in its own order. */
const DEFAULTS = ['opencode', 'claude-code', 'kilo-code', 'codex-cli', 'gemini-cli', 'qwen-cli'];

function worker(id: string, over: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    id,
    name: id,
    binary: id,
    kind: 'worker',
    runtime: 'local-process',
    installed: true,
    version: '1.0.0',
    installDetail: '',
    invocable: true,
    connected: false,
    lifecycle: 'NOT_CONNECTED',
    reason: '',
    detail: '',
    governance: 'NOT_CONNECTED',
    governanceSupports: {},
    capabilities: [],
    roles: [],
    proof: null,
    notes: '',
    ...over,
  };
}

const ROSTER = [
  worker('opencode', { connected: true, lifecycle: 'CONNECTED', governance: 'FULLY_GOVERNED' }),
  worker('claude-code'),
  worker('kilo-code', { installed: false, reason: 'NOT_INSTALLED' }),
  worker('codex-cli'),
  worker('gemini-cli'),
  worker('qwen-cli'),
];

/** A localStorage good enough for the store, and inspectable by the test. */
function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    store: data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

/* ── what a slot may claim ───────────────────────────────────────── */

describe('workerSlotState', () => {
  it('is EMPTY only when the slot holds no worker', () => {
    expect(workerSlotState(null, null, true)).toBe('EMPTY');
  });

  it('reports ACTIVE from the backend’s own connected verdict', () => {
    expect(workerSlotState('opencode', ROSTER[0], true)).toBe('ACTIVE');
  });

  it('reports UNAVAILABLE for a worker the machine does not have', () => {
    expect(workerSlotState('kilo-code', ROSTER[2], true)).toBe('UNAVAILABLE');
  });

  it('reports UNAVAILABLE when AURA has no verified way to drive it', () => {
    expect(workerSlotState('x', worker('x', { reason: 'ADAPTER_UNKNOWN' }), true)).toBe(
      'UNAVAILABLE',
    );
    expect(workerSlotState('x', worker('x', { lifecycle: 'UNSUPPORTED' }), true)).toBe(
      'UNAVAILABLE',
    );
  });

  it('reports UNAVAILABLE for an id the answered roster does not contain', () => {
    expect(workerSlotState('ghost', null, true)).toBe('UNAVAILABLE');
  });

  it('keeps "not asked yet" apart from "not there"', () => {
    // The roster has not answered. Saying "not installed" here would be
    // reporting a measurement that was never taken.
    expect(workerSlotState('opencode', null, false)).toBe('UNKNOWN');
  });

  it('claims nothing beyond SELECTED for an installed, unconnected worker', () => {
    expect(workerSlotState('claude-code', ROSTER[1], true)).toBe('SELECTED');
  });
});

describe('workerSlotCaption', () => {
  const captionOf = (ids: (string | null)[], roster = ROSTER, known = true) =>
    deriveWorkerSlots(ids, roster, known).map(workerSlotCaption);

  it('restates the backend’s verdict and never upgrades it', () => {
    expect(captionOf(['opencode', 'claude-code', 'kilo-code', 'ghost', null])).toEqual([
      'Connected',
      'Not connected',
      'Not installed',
      'Not in worker catalogue',
      '',
      '',
    ]);
  });

  it('says Unknown while the roster has not answered', () => {
    expect(captionOf(['opencode'], [], false)[0]).toBe('Unknown');
  });

  it('names a slot by the roster, falling back to the stable id', () => {
    const [known, unknown] = deriveWorkerSlots(['opencode', 'ghost'], ROSTER);
    expect(workerSlotName(known)).toBe('opencode');
    expect(workerSlotName(unknown)).toBe('ghost');
  });
});

/* ── the fixed six ───────────────────────────────────────────────── */

describe('deriveWorkerSlots', () => {
  it('always returns exactly six slots', () => {
    expect(deriveWorkerSlots([], ROSTER)).toHaveLength(WORKER_SLOTS);
    expect(deriveWorkerSlots(['opencode'], ROSTER)).toHaveLength(WORKER_SLOTS);
    expect(deriveWorkerSlots(DEFAULTS, ROSTER)).toHaveLength(WORKER_SLOTS);
  });

  it('never yields a seventh slot, however many ids are saved', () => {
    const slots = deriveWorkerSlots([...DEFAULTS, 'extra-one', 'extra-two'], ROSTER);
    expect(slots).toHaveLength(WORKER_SLOTS);
    expect(slots.map((s) => s.workerId)).toEqual(DEFAULTS);
  });

  it('keeps an emptied slot in place rather than closing the gap', () => {
    const slots = deriveWorkerSlots(['opencode', null, 'codex-cli'], ROSTER);
    expect(slots.map((s) => s.workerId)).toEqual([
      'opencode', null, 'codex-cli', null, null, null,
    ]);
    expect(slots[1].state).toBe('EMPTY');
    expect(slots[2].state).toBe('SELECTED');
  });

  it('preserves the saved order', () => {
    expect(
      deriveWorkerSlots(['codex-cli', 'opencode'], ROSTER).map((s) => s.workerId),
    ).toEqual(['codex-cli', 'opencode', null, null, null, null]);
  });

  it('holds the slot for an id the roster no longer knows', () => {
    const [slot] = deriveWorkerSlots(['ghost'], ROSTER);
    expect(slot).toMatchObject({ workerId: 'ghost', worker: null, state: 'UNAVAILABLE' });
  });
});

/* ── persistence, in the existing layout store ───────────────────── */

describe('the six worker slots persist in the hub store', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function loadStore(storage: ReturnType<typeof memoryStorage>) {
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
    return (await import('./hubStore')).useHubStore;
  }

  it('starts a new workspace on the current default arrangement', async () => {
    const store = await loadStore(memoryStorage());
    expect(store.getState().workerIds).toEqual(DEFAULTS);
  });

  it('writes nothing until the user actually chooses', async () => {
    const storage = memoryStorage();
    await loadStore(storage);
    // A default nobody picked is not a decision, so it is not recorded.
    expect(storage.getItem(WORKERS_KEY)).toBeNull();
  });

  it('respects a saved arrangement over the defaults', async () => {
    const saved = JSON.stringify(['codex-cli', null, 'opencode', null, null, null]);
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: saved }));
    expect(store.getState().workerIds).toEqual([
      'codex-cli', null, 'opencode', null, null, null,
    ]);
  });

  it('fills the clicked slot and leaves the other five alone', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify([]) }));

    expect(store.getState().placeWorkerAt(2, 'opencode')).toBe(true);

    expect(store.getState().workerIds).toEqual([null, null, 'opencode', null, null, null]);
  });

  it('replaces only the slot it is given', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) }));
    const before = [...store.getState().workerIds];

    expect(store.getState().placeWorkerAt(3, 'aider')).toBe(true);

    const after = store.getState().workerIds;
    expect(after[3]).toBe('aider');
    expect(after.filter((_, i) => i !== 3)).toEqual(before.filter((_, i) => i !== 3));
    expect(after).toHaveLength(WORKER_SLOTS);
  });

  it('clears only the slot it is given, and leaves an empty slot behind', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) }));

    store.getState().clearWorkerAt(1);

    expect(store.getState().workerIds).toEqual([
      'opencode', null, 'kilo-code', 'codex-cli', 'gemini-cli', 'qwen-cli',
    ]);
    expect(store.getState().workerIds).toHaveLength(WORKER_SLOTS);
    expect(store.getState().firstFreeWorkerSlot()).toBe(1);
  });

  it('lets all six be filled independently', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify([]) }));

    DEFAULTS.forEach((id, i) => expect(store.getState().placeWorkerAt(i, id)).toBe(true));

    expect(store.getState().workerIds).toEqual(DEFAULTS);
    expect(store.getState().firstFreeWorkerSlot()).toBeNull();
  });

  it('creates no seventh slot, by placing or by replacing', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) }));

    expect(store.getState().placeWorkerAt(6, 'aider')).toBe(false);
    expect(store.getState().placeWorkerAt(-1, 'aider')).toBe(false);
    expect(store.getState().workerIds).toHaveLength(WORKER_SLOTS);
    expect(store.getState().workerIds).toEqual(DEFAULTS);
  });

  it('refuses to put one worker in two slots', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) }));

    expect(store.getState().placeWorkerAt(4, 'opencode')).toBe(false);
    expect(store.getState().workerIds).toEqual(DEFAULTS);
  });

  it('treats replacing a worker with itself as a no-op that succeeds', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) }));
    expect(store.getState().placeWorkerAt(0, 'opencode')).toBe(true);
    expect(store.getState().workerIds).toEqual(DEFAULTS);
  });

  it('survives a reload, empty slots and all', async () => {
    const storage = memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) });
    const first = await loadStore(storage);
    first.getState().placeWorkerAt(0, 'aider');
    first.getState().clearWorkerAt(2);

    // A reload: same storage, a brand-new module instance.
    const reloaded = await loadStore(storage);
    expect(reloaded.getState().workerIds).toEqual([
      'aider', 'claude-code', null, 'codex-cli', 'gemini-cli', 'qwen-cli',
    ]);
    expect(deriveWorkerSlots(reloaded.getState().workerIds, ROSTER)[2].state).toBe('EMPTY');
  });

  it('remembers a workspace emptied on purpose', async () => {
    const storage = memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) });
    const first = await loadStore(storage);
    for (let i = 0; i < WORKER_SLOTS; i += 1) first.getState().clearWorkerAt(i);

    const reloaded = await loadStore(storage);
    // Not re-seeded: clearing all six is a decision, and it is kept.
    expect(reloaded.getState().workerIds).toEqual([null, null, null, null, null, null]);
  });

  it('repairs a malformed or short saved arrangement without losing the row', async () => {
    const storage = memoryStorage({
      [WORKERS_KEY]: JSON.stringify(['opencode', 42, null, { id: 'x' }]),
    });
    const store = await loadStore(storage);
    expect(store.getState().workerIds).toEqual(['opencode', null, null, null, null, null]);
  });

  it('gives a newly placed worker no status of its own', async () => {
    const store = await loadStore(memoryStorage({ [WORKERS_KEY]: JSON.stringify([]) }));
    store.getState().placeWorkerAt(0, 'aider');

    // The roster knows nothing about `aider`, so the slot says so rather
    // than inheriting anything from what it replaced.
    expect(deriveWorkerSlots(store.getState().workerIds, ROSTER)[0]).toMatchObject({
      workerId: 'aider',
      worker: null,
      state: 'UNAVAILABLE',
    });

    // And once the roster does answer, the slot restates that answer.
    const answered = [...ROSTER, worker('aider', { connected: true })];
    expect(deriveWorkerSlots(store.getState().workerIds, answered)[0].state).toBe('ACTIVE');
  });

  it('keeps the tool row out of it: the two layouts are independent', async () => {
    const storage = memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) });
    const store = await loadStore(storage);
    const toolsBefore = store.getState().placed.map((p) => p.nodeId);

    store.getState().clearWorkerAt(0);
    store.getState().placeWorkerAt(0, 'aider');

    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(toolsBefore);
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).map((p: { nodeId: string }) => p.nodeId))
      .toEqual(toolsBefore);
  });
});

/* ── a slot edit is a layout edit ────────────────────────────────── */

describe('worker slot edits reach nothing but the layout', () => {
  it('the layout store has no path to connect, disconnect or uninstall', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('./hubStore.ts', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const forbidden of [
      'workerClient',
      'useWorkerStore',
      'connect',
      'disconnect',
      'install',
      'uninstall',
      'catalog',
      'fetch(',
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The one thing the worker half writes is its own key.
    expect(code).toContain(WORKERS_KEY);
  });

  it('the derivation reads the roster and writes nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('./workerSlots.ts', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // `worker.installed` is a field this module READS; what must be
    // absent is any path that installs, connects or persists.
    for (const forbidden of [
      'localStorage',
      'fetch(',
      'workerClient.',
      'connect(',
      'disconnect(',
      'install(',
      'installNode',
      'onInstall',
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('removing a worker changes no roster entry and no connection', async () => {
    const storage = memoryStorage({ [WORKERS_KEY]: JSON.stringify(DEFAULTS) });
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
    const store = (await import('./hubStore')).useHubStore;

    const rosterBefore = JSON.parse(JSON.stringify(ROSTER));
    store.getState().clearWorkerAt(0);

    // The catalogue entry, the install state and the proven connection
    // are all untouched: the only thing that changed is which slot the
    // workspace shows.
    expect(ROSTER).toEqual(rosterBefore);
    expect(ROSTER.find((w) => w.id === 'opencode')?.connected).toBe(true);
    expect(ROSTER).toHaveLength(6);
    vi.unstubAllGlobals();
  });
});
