import { describe, expect, it } from 'vitest';
import { dedupeInventoryItems, type InventoryItem } from './environmentStore';

function item(overrides: Partial<InventoryItem> & { id: string; name: string }): InventoryItem {
  return {
    logicalId: overrides.id,
    version: null,
    category: 'unknown',
    status: 'unverified',
    verified: false,
    present: false,
    executable: null,
    realPath: null,
    origin: null,
    packageId: null,
    manager: null,
    packageVersion: null,
    versionConflict: false,
    aliases: [],
    shadowed: [],
    sources: [],
    detail: '',
    unexecuted: true,
    connected: false,
    ...overrides,
  };
}

describe('dedupeInventoryItems', () => {
  it('drops inventory entries that duplicate a merged card by path', () => {
    const merged = {
      verified: [item({ id: 'git', name: 'Git', realPath: '/usr/bin/git' })],
      unverified: [],
    };
    const out = dedupeInventoryItems(merged, [
      item({ id: 'pkg:git', name: 'git', realPath: '/usr/bin/git' }),
      item({ id: 'other', name: 'other', realPath: '/usr/bin/other' }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['other']);
  });

  it('deduplicates by owning package identity', () => {
    const merged = {
      verified: [],
      unverified: [item({ id: 'npm', name: 'npm', manager: 'npm', packageId: 'npm' })],
    };
    const out = dedupeInventoryItems(merged, [
      item({ id: 'pkg:npm:npm', name: 'npm', manager: 'npm', packageId: 'npm' }),
    ]);
    expect(out).toEqual([]);
  });

  it('keeps genuinely new entries', () => {
    const merged = { verified: [], unverified: [] };
    const out = dedupeInventoryItems(merged, [item({ id: 'x', name: 'x' })]);
    expect(out.map((i) => i.id)).toEqual(['x']);
  });
});
