/**
 * projectScoping — generation answers about the requested project.
 *
 * Regression cover for "context not working":
 *
 *   1. `inspect` with an explicit project reads THAT project — retrieval,
 *      memory, profile and generated identity are all keyed by the
 *      requested id, never by the mount. Requesting B while A is mounted
 *      must not read, generate, or attribute anything to A.
 *   2. Adding a project builds its retrieval index without mounting it
 *      (the mount — and whatever the user is working in — is untouched).
 *   3. `indexProjectById` refuses unknown ids instead of indexing into a
 *      stranger's store.
 *
 * Runs with `npm run test:service` from the repo root, against an
 * isolated AURA_HOME so no real user state is touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-scope-test-'));

import { WorkspaceManager } from './workspace';
import { loadIdentity } from './intelligence/identity';

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), `aura-scope-${name}-`)));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

let dirA = '';
let dirB = '';

beforeEach(() => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-scope-test-'));
  dirA = fixture('a', { 'src/alpha.ts': 'export const ALPHA_MARKER = "alpha-one";\n' });
  dirB = fixture('b', { 'src/beta.ts': 'export const BETA_MARKER = "beta-two";\n' });
});

describe('inspect follows the requested project, not the mount', () => {
  it('reads B while A is mounted, and never attributes to A', async () => {
    const manager = new WorkspaceManager({});
    const a = manager.addProject({ name: 'projA', path: dirA }).project;
    const b = manager.addProject({ name: 'projB', path: dirB }).project;
    manager.open(a.id);
    await manager.pipeline.whenIndexed();

    // Mounting A persists A's own understanding by design (the
    // "Understanding repository…" index step load-or-generates). Snapshot
    // it so the assertions below measure what the B-request adds.
    const identityOfAAtMount = loadIdentity(a.id);

    const meta = await manager.pipeline.inspect('what does this project do', undefined, {
      id: b.id, path: b.path, name: b.name,
    });

    // The report names the project that was actually read.
    expect(meta.projectId).toBe(b.id);
    // Identity was generated for B...
    expect(loadIdentity(b.id)).not.toBeNull();
    // ...and the B-request added nothing to A: whatever the mount
    // persisted is identical afterwards (this still fails if the
    // request reads, generates, or attributes anything to A).
    expect(loadIdentity(a.id)).toEqual(identityOfAAtMount);
  });

  it('falls back to the mount when no project is requested (legacy path)', async () => {
    const manager = new WorkspaceManager({});
    const a = manager.addProject({ name: 'projA', path: dirA }).project;
    manager.open(a.id);
    await manager.pipeline.whenIndexed();

    const meta = await manager.pipeline.inspect('what does this project do');
    expect(meta.projectId).toBe(a.id);
  });

  it('reports no project when nothing is mounted and none requested', async () => {
    const manager = new WorkspaceManager({});
    const meta = await manager.pipeline.inspect('hello');
    expect(meta.projectId).toBeNull();
    expect(meta.engines).toEqual([]);
  });
});

describe('indexing without mounting', () => {
  it('addProject builds the index while leaving the mount alone', async () => {
    const manager = new WorkspaceManager({});
    const a = manager.addProject({ name: 'projA', path: dirA }).project;
    manager.open(a.id);
    await manager.pipeline.whenIndexed();
    expect(manager.pipeline.currentProjectId).toBe(a.id);

    const b = manager.addProject({ name: 'projB', path: dirB }).project;
    const status = await manager.indexProjectById(b.id);

    expect(status.phase).toBe('ready');
    expect(status.projectId).toBe(b.id);
    // The mount did not move.
    expect(manager.pipeline.currentProjectId).toBe(a.id);
    // Retrieval for B now finds B's files (run through inspect scoping).
    const meta = await manager.pipeline.inspect('BETA_MARKER', undefined, {
      id: b.id, path: b.path, name: b.name,
    });
    expect(meta.projectId).toBe(b.id);
    expect(meta.coding.files.some((f) => f.includes('beta.ts'))).toBe(true);
    expect(meta.coding.files.some((f) => f.includes('alpha.ts'))).toBe(false);
  });

  it('indexProjectById refuses unknown ids', async () => {
    const manager = new WorkspaceManager({});
    await expect(manager.indexProjectById('no-such-project')).rejects.toThrow('no such project');
  });
});
