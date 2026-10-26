/**
 * resolveActiveProject — the active project is the authority, and a stale id
 * never resolves to some other project.
 */
import { describe, expect, it } from 'vitest';
import { resolveActiveProject } from './useActiveProject';

const registry = [{ id: 'aura-alpha-e2e', name: 'aura-alpha-e2e' }];
const local = [{ id: 'local-abc', name: 'scratch' }];

describe('resolveActiveProject', () => {
  it('select: a registered id resolves to its record', () => {
    expect(resolveActiveProject('aura-alpha-e2e', registry, local).record?.name).toBe('aura-alpha-e2e');
  });

  it('select: a frontend-only local project resolves too', () => {
    expect(resolveActiveProject('local-abc', registry, local).record?.name).toBe('scratch');
  });

  it('clear: no id means no project, so the status bar shows none', () => {
    expect(resolveActiveProject(null, registry, local)).toEqual({ id: null, record: null, resolving: false });
  });

  it('stale id: an unknown id resolves to no project, never to another one', () => {
    const r = resolveActiveProject('aura-hub-2', registry, local);
    expect(r.record).toBeNull();
    expect(r.resolving).toBe(true);
  });

  it('stale id while the list is still empty does not borrow another project', () => {
    expect(resolveActiveProject('aura-alpha-e2e', [], []).record).toBeNull();
  });
});
