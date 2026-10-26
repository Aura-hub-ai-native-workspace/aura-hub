/**
 * resolveWorkspaceProjectPath — delegated work must land in the open project.
 */
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceProjectPath } from './workspaceProject';

const projects = [
  { id: 'p-alpha', path: '/tmp/aura-alpha-e2e' },
  { id: 'p-other', path: '/home/someone/other' },
];

describe('resolveWorkspaceProjectPath', () => {
  it('uses the workspace project when its id matches a project', () => {
    expect(resolveWorkspaceProjectPath(projects, 'p-other', 'p-alpha')).toBe('/home/someone/other');
  });

  it('falls back to the open project when the workspace is not a project', () => {
    expect(resolveWorkspaceProjectPath(projects, 'home', 'p-alpha')).toBe('/tmp/aura-alpha-e2e');
  });

  it('returns null when neither identifies a project, rather than guessing', () => {
    expect(resolveWorkspaceProjectPath(projects, 'home', null)).toBeNull();
    expect(resolveWorkspaceProjectPath(projects, null, 'missing')).toBeNull();
  });

  it('returns null with no projects at all', () => {
    expect(resolveWorkspaceProjectPath([], null, 'p-alpha')).toBeNull();
  });
});
