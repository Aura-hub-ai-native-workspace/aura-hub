import fs from 'node:fs';
import path from 'node:path';
import { homePath } from './persist';

/**
 * Housekeeping for the AURA home.
 *
 * A project's search index (`index/<id>`) is a cache: it is rebuilt the next
 * time the project is opened. It used to outlive the project, so every folder
 * ever added (and every test project) kept tens or hundreds of megabytes in
 * the AURA home forever. Only rebuildable caches are removed here. A
 * project's conversations, memory and history are never touched.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A child of `dir` named `name`, or null when the name could escape it. */
function inside(dir: string, name: string): string | null {
  if (!ID.test(name) || name.includes('..')) return null;
  const p = path.join(dir, name);
  return path.dirname(p) === dir ? p : null;
}

function sizeOf(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      try { for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e)); } catch { /* unreadable */ }
    } else {
      total += st.size;
    }
  }
  return total;
}

function newestChange(p: string): number {
  let newest = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (st.isDirectory()) {
      try { for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e)); } catch { /* unreadable */ }
    }
  }
  return newest;
}

/** Remove the rebuildable caches of one project. Returns the bytes freed. */
export function dropProjectCaches(id: string): number {
  let freed = 0;
  const indexDir = inside(homePath('index'), id);
  if (indexDir && fs.existsSync(indexDir)) {
    freed += sizeOf(indexDir);
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
  const state = inside(homePath('index-state'), `${id}.json`);
  if (state && fs.existsSync(state)) {
    freed += sizeOf(state);
    fs.rmSync(state, { force: true });
  }
  return freed;
}

export interface PruneResult {
  removed: string[];
  freedBytes: number;
}

/**
 * Remove indexes that belong to no registered project and have not been
 * used for `olderThanDays`. The age check keeps an index that something
 * other than a project (an ad-hoc scope) is still using.
 */
export function pruneOrphanIndexes(
  knownIds: Iterable<string>,
  opts: { olderThanDays?: number; now?: number } = {},
): PruneResult {
  const known = new Set(knownIds);
  const cutoff = (opts.now ?? Date.now()) - (opts.olderThanDays ?? 14) * 86_400_000;
  const root = homePath('index');
  const result: PruneResult = { removed: [], freedBytes: 0 };
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return result; }
  for (const name of names) {
    if (known.has(name)) continue;
    const dir = inside(root, name);
    if (!dir) continue;
    try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
    if (newestChange(dir) > cutoff) continue;
    result.freedBytes += dropProjectCaches(name);
    result.removed.push(name);
  }
  return result;
}

/** What the AURA home holds, largest first, for a storage view. */
export function storageUsage(): { total: number; entries: { name: string; bytes: number }[] } {
  const root = homePath();
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { /* empty home */ }
  const entries = names.map((name) => ({ name, bytes: sizeOf(path.join(root, name)) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { total: entries.reduce((n, e) => n + e.bytes, 0), entries };
}
