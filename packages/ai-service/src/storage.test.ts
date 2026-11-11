import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropProjectCaches, pruneOrphanIndexes, storageUsage } from './storage';

const realHome = process.env.AURA_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-storage-'));
  process.env.AURA_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = realHome;
});

function index(id: string, ageDays = 0) {
  const dir = path.join(home, 'index', id, 'coding');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'chunks.json');
  fs.writeFileSync(f, 'x'.repeat(1000));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  for (const p of [f, dir, path.dirname(dir)]) fs.utimesSync(p, t, t);
}

describe('project caches', () => {
  it('removing a project drops its index and index state', () => {
    index('gone');
    fs.mkdirSync(path.join(home, 'index-state'));
    fs.writeFileSync(path.join(home, 'index-state', 'gone.json'), '{}');
    expect(dropProjectCaches('gone')).toBeGreaterThan(1000);
    expect(fs.existsSync(path.join(home, 'index', 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'index-state', 'gone.json'))).toBe(false);
  });

  it('never leaves the index folder', () => {
    fs.mkdirSync(path.join(home, 'keep'));
    expect(dropProjectCaches('..')).toBe(0);
    expect(dropProjectCaches('../keep')).toBe(0);
    expect(fs.existsSync(path.join(home, 'keep'))).toBe(true);
  });

  it('prunes only old indexes of unregistered projects', () => {
    index('registered', 60);
    index('orphan-old', 60);
    index('orphan-recent', 1);
    const r = pruneOrphanIndexes(['registered']);
    expect(r.removed).toEqual(['orphan-old']);
    expect(fs.existsSync(path.join(home, 'index', 'registered'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'index', 'orphan-recent'))).toBe(true);
    expect(r.freedBytes).toBeGreaterThan(0);
  });

  it('reports what the home holds, largest first', () => {
    index('a');
    fs.writeFileSync(path.join(home, 'small.json'), '{}');
    const u = storageUsage();
    expect(u.entries[0].name).toBe('index');
    expect(u.total).toBeGreaterThan(1000);
  });
});
