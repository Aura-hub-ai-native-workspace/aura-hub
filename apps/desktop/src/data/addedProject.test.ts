/**
 * findAddedProject — the folder just added is the project that becomes active.
 */
import { describe, expect, it } from 'vitest';
import { findAddedProject } from './addedProject';

const registry = [
  { id: 'aura-hub-2', path: '/home/someone/aura-hub' },
  { id: 'aura-alpha-e2e', path: '/tmp/aura-alpha-e2e' },
];

describe('findAddedProject', () => {
  it('finds the project by its folder, not by list position', () => {
    expect(findAddedProject(registry, '/tmp/aura-alpha-e2e')?.id).toBe('aura-alpha-e2e');
  });

  it('ignores a trailing slash and surrounding space the person typed', () => {
    expect(findAddedProject(registry, '  /tmp/aura-alpha-e2e/ ')?.id).toBe('aura-alpha-e2e');
  });

  it('returns null rather than guessing when the folder is not registered', () => {
    expect(findAddedProject(registry, '/tmp/not-added')).toBeNull();
  });

  it('does not match a project whose path only shares a prefix', () => {
    expect(findAddedProject(registry, '/tmp/aura-alpha')).toBeNull();
  });
});
