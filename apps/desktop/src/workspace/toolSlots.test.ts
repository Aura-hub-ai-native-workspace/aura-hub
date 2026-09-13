/**
 * The Workspace's three active tool slots — derivation and persistence.
 *
 * These pin the two halves of the fixed-slot contract that do not need a
 * DOM: WHICH tools occupy the slots (the saved layout, never a catalogue
 * listing), and what survives a reload. The rendered half is pinned in
 * `screens/workspace/neon/OrchestrationGraph.test.tsx`.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentNode, NodeStatus } from '@aura/connected-environment';

import { ACTIVE_TOOL_SLOTS, type PlacedNode } from './hubStore';
import { deriveToolSlots, slotState } from './toolSlots';

const LAYOUT_KEY = 'aura.workspace.layout';

function node(id: string, status: NodeStatus, connected = false): EnvironmentNode {
  return {
    id,
    entry: {
      id,
      name: id.toUpperCase(),
      category: 'development',
      capabilities: [],
      transport: 'local-process',
      auth: 'none',
      license: 'open-source',
      crossPlatform: true,
      maintained: true,
      summary: '',
      homepage: '',
    },
    health: { status, detail: '', checkedAt: '2026-09-11T00:00:00.000Z' },
    permissions: { read: true, write: false, execute: false, autonomous: false },
    activity: [],
    log: [],
    connected,
  };
}

const at = (nodeId: string): PlacedNode => ({ nodeId, x: 0.5, y: 0.5 });

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

describe('slotState', () => {
  it('is EMPTY only when the slot holds no tool', () => {
    expect(slotState(null, null)).toBe('EMPTY');
  });

  it('reports ACTIVE from the node’s own connected flag', () => {
    expect(slotState('git', node('git', 'connected', true))).toBe('ACTIVE');
  });

  it('reports UNAVAILABLE for a probe verdict of absence', () => {
    expect(slotState('git', node('git', 'not-installed'))).toBe('UNAVAILABLE');
    expect(slotState('git', node('git', 'no-connector'))).toBe('UNAVAILABLE');
  });

  it('reports UNAVAILABLE when the placed id resolves to nothing', () => {
    expect(slotState('gone', null)).toBe('UNAVAILABLE');
  });

  it('claims nothing beyond SELECTED for a tool the machine has not answered for', () => {
    expect(slotState('git', node('git', 'unknown'))).toBe('SELECTED');
    expect(slotState('git', node('git', 'available'))).toBe('SELECTED');
    expect(slotState('git', node('git', 'needs-auth'))).toBe('SELECTED');
  });
});

describe('deriveToolSlots', () => {
  const nodes = [node('git', 'connected', true), node('docker', 'not-installed')];

  it('always returns exactly three slots', () => {
    expect(deriveToolSlots([], nodes)).toHaveLength(ACTIVE_TOOL_SLOTS);
    expect(deriveToolSlots([at('git')], nodes)).toHaveLength(ACTIVE_TOOL_SLOTS);
    expect(deriveToolSlots([at('git'), at('docker'), at('node')], nodes)).toHaveLength(
      ACTIVE_TOOL_SLOTS,
    );
  });

  it('never yields a fourth slot, however many tools are placed', () => {
    const slots = deriveToolSlots(
      [at('git'), at('docker'), at('node'), at('rust'), at('go')],
      nodes,
    );
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.nodeId)).toEqual(['git', 'docker', 'node']);
  });

  it('keeps empty slots rather than collapsing the row', () => {
    const slots = deriveToolSlots([at('git')], nodes);
    expect(slots.map((s) => s.state)).toEqual(['ACTIVE', 'EMPTY', 'EMPTY']);
    expect(slots.filter((s) => s.nodeId === null)).toHaveLength(2);
  });

  it('preserves the order tools were placed in', () => {
    expect(deriveToolSlots([at('docker'), at('git')], nodes).map((s) => s.nodeId)).toEqual([
      'docker',
      'git',
      null,
    ]);
  });

  it('holds the slot for an id the catalogue no longer knows', () => {
    const slots = deriveToolSlots([at('retired-tool')], nodes);
    expect(slots[0]).toMatchObject({ nodeId: 'retired-tool', node: null, state: 'UNAVAILABLE' });
  });
});

describe('hubStore — active workspace tool persistence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Loads a fresh copy of the store against the given storage. */
  async function loadStore(storage: ReturnType<typeof memoryStorage>) {
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
    return (await import('./hubStore')).useHubStore;
  }

  it('writes the active selection to the existing layout key', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);

    expect(store.getState().add('git')).toBe(true);
    expect(store.getState().add('docker')).toBe(true);

    const saved: PlacedNode[] = JSON.parse(storage.getItem(LAYOUT_KEY)!);
    expect(saved.map((p) => p.nodeId)).toEqual(['git', 'docker']);
  });

  it('restores the same slots, in order, with the empty slot intact', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const first = await loadStore(storage);
    first.getState().add('docker');
    first.getState().add('git');

    // A reload: same storage, a brand-new module instance.
    const reloaded = await loadStore(storage);
    const slots = deriveToolSlots(reloaded.getState().placed, []);
    expect(slots.map((s) => s.nodeId)).toEqual(['docker', 'git', null]);
    expect(slots[2].state).toBe('EMPTY');
  });

  it('restores an empty workspace as three empty slots', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);
    expect(store.getState().placed).toEqual([]);
    expect(deriveToolSlots(store.getState().placed, []).map((s) => s.state)).toEqual([
      'EMPTY',
      'EMPTY',
      'EMPTY',
    ]);
  });

  it('refuses a fourth tool instead of persisting one that can never be shown', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().add('node');

    expect(store.getState().hasFreeSlot()).toBe(false);
    expect(store.getState().add('rust')).toBe(false);
    expect(store.getState().placed).toHaveLength(3);
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!)).toHaveLength(3);
  });

  it('ignores extra entries left by an older layout', async () => {
    const over = JSON.stringify(
      ['a', 'b', 'c', 'd'].map((nodeId) => ({ nodeId, x: 0.5, y: 0.5 })),
    );
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: over }));
    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('removing a tool frees its slot and touches nothing else', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);
    store.getState().add('git');
    store.getState().add('docker');

    store.getState().remove('git');

    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['docker']);
    // Only the layout key was ever written: no install record, no
    // inventory, no second store.
    expect([...storage.store.keys()]).toEqual([LAYOUT_KEY]);
    expect(store.getState().hasFreeSlot()).toBe(true);
  });

  it('replaces a slot’s occupant in place, keeping its position', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().add('node');

    expect(store.getState().replaceAt(1, 'rust')).toBe(true);

    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['git', 'rust', 'node']);
    expect(deriveToolSlots(store.getState().placed, []).map((s) => s.nodeId)).toEqual([
      'git',
      'rust',
      'node',
    ]);
  });

  it('leaves the other two slots untouched, ids and positions alike', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().add('node');
    const before = store.getState().placed.map((p) => ({ ...p }));

    store.getState().replaceAt(1, 'rust');
    const after = store.getState().placed;

    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    // Same position, new occupant.
    expect(after[1].x).toBe(before[1].x);
    expect(after[1].y).toBe(before[1].y);
    expect(after[1].nodeId).toBe('rust');
  });

  it('creates no fourth slot by replacing', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().add('node');

    store.getState().replaceAt(0, 'rust');

    expect(store.getState().placed).toHaveLength(3);
    expect(store.getState().hasFreeSlot()).toBe(false);
  });

  it('persists the replacement to the existing layout key, and reloads it', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '[]' });
    const store = await loadStore(storage);
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().replaceAt(0, 'rust');

    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).map((p: PlacedNode) => p.nodeId)).toEqual([
      'rust',
      'docker',
    ]);
    // Only the layout key was ever written.
    expect([...storage.store.keys()]).toEqual([LAYOUT_KEY]);

    const reloaded = await loadStore(storage);
    expect(deriveToolSlots(reloaded.getState().placed, []).map((s) => s.nodeId)).toEqual([
      'rust',
      'docker',
      null,
    ]);
  });

  it('refuses a replacement that would put one tool in two slots', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');
    store.getState().add('docker');

    expect(store.getState().replaceAt(0, 'docker')).toBe(false);
    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['git', 'docker']);
  });

  it('treats replacing a tool with itself as a no-op that succeeds', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');

    expect(store.getState().replaceAt(0, 'git')).toBe(true);
    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['git']);
  });

  it('refuses to replace a slot that holds nothing', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');

    expect(store.getState().replaceAt(1, 'rust')).toBe(false);
    expect(store.getState().replaceAt(-1, 'rust')).toBe(false);
    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['git']);
  });

  it('gives a replaced-in tool no status of its own', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');
    store.getState().replaceAt(0, 'rust');

    // The environment knows nothing about `rust`, so the slot says so
    // rather than inheriting the connected state of what it replaced.
    const known = [node('git', 'connected', true)];
    expect(deriveToolSlots(store.getState().placed, known)[0]).toMatchObject({
      nodeId: 'rust',
      node: null,
      state: 'UNAVAILABLE',
    });

    // And once the environment does answer, the slot restates that answer.
    const probed = [node('rust', 'not-installed')];
    expect(deriveToolSlots(store.getState().placed, probed)[0].state).toBe('UNAVAILABLE');
    const connected = [node('rust', 'connected', true)];
    expect(deriveToolSlots(store.getState().placed, connected)[0].state).toBe('ACTIVE');
  });

  it('re-adding after a removal reuses the freed slot', async () => {
    const store = await loadStore(memoryStorage({ [LAYOUT_KEY]: '[]' }));
    store.getState().add('git');
    store.getState().add('docker');
    store.getState().add('node');
    store.getState().remove('docker');

    expect(store.getState().add('rust')).toBe(true);
    expect(store.getState().placed.map((p) => p.nodeId)).toEqual(['git', 'node', 'rust']);
  });
});

describe('removal is a layout edit, never an uninstall', () => {
  it('the layout store reaches no install, uninstall or inventory path', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('./hubStore.ts', import.meta.url), 'utf8');
    // Prose about the split belongs in the header comment; what matters
    // here is that no CODE in the store reaches the machine.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const forbidden of [
      'install',
      'uninstall',
      'environmentClient',
      'environmentStore',
      'inventory',
      'connect',
      'fetch(',
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The one thing it does write is the existing layout key.
    expect(code).toContain(LAYOUT_KEY);
  });
});
