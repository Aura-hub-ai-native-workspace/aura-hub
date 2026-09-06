/**
 * supervision — deterministic worker boundaries, no planning.
 * ==================================================================
 * Mirrors `backend/aura/fabric/supervision.py`. The supervisor enforces
 * what can be decided WITHOUT model judgment: scope paths must be
 * well-formed before anything spawns, and changed files must fall inside
 * the declared scope afterwards. Interpretation belongs to the Central
 * Agent behind an approval; enforcement belongs here.
 */
import nodePath from 'node:path';
import { existsSync } from 'node:fs';
import { git } from '../exec/process';

export const MAX_SCOPE_PATHS = 32;
export const MAX_SCOPE_PATH_CHARS = 256;

function normalizeScopePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/\\/g, '/');
  if (text.startsWith('/')) text = text.slice(1);
  if (!text || text.length > MAX_SCOPE_PATH_CHARS) return null;
  if (text.endsWith('/**')) text = text.slice(0, -3);
  else if (text.endsWith('/*')) text = text.slice(0, -2);
  text = text.replace(/^\/+|\/+$/g, '');
  if (!text) return null;
  const parts = text.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return text;
}

export function validateScopePaths(raw: unknown): { ok: true; paths: string[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'scopePaths must be a list of repo-relative paths.' };
  }
  if (raw.length > MAX_SCOPE_PATHS) {
    return { ok: false, reason: `scopePaths lists ${raw.length} paths; at most ${MAX_SCOPE_PATHS} are allowed.` };
  }
  const paths: string[] = [];
  for (const entry of raw) {
    const norm = normalizeScopePath(entry);
    if (norm === null) {
      return {
        ok: false,
        reason: `scopePaths must be repo-relative paths without '.', '..', backslashes or empties; rejected ${JSON.stringify(String(entry)).slice(0, 80)}.`,
      };
    }
    if (!paths.includes(norm)) paths.push(norm);
  }
  if (paths.length === 0) {
    return { ok: false, reason: 'scopePaths is empty; omit it instead.' };
  }
  return { ok: true, paths };
}

export function inScope(path: string, scope: string[]): boolean {
  return scope.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Split `git status --porcelain` output into repo-relative paths. */
export function parsePorcelainStatus(output: string): string[] {
  const chunks = output.includes('\0') ? output.split('\0') : output.split('\n');
  const paths: string[] = [];
  for (const chunk of chunks) {
    const line = chunk.trim();
    if (line.length < 4) continue;
    let entry = line.slice(3).trim();
    if (!entry) continue;
    const arrow = entry.indexOf(' -> ');
    if (arrow >= 0) entry = entry.slice(arrow + 4).trim();
    entry = entry.replace(/^"|"$/g, '');
    if (entry && !paths.includes(entry)) paths.push(entry);
  }
  return paths;
}

export function checkScopePaths(
  changed: string[],
  scope: string[],
): { allowed: boolean; outside: string[]; detail: string } {
  const outside = changed.filter((p) => !inScope(p, scope));
  if (outside.length > 0) {
    const shown = outside.slice(0, 8).join(', ');
    const more = outside.length > 8 ? ` (+${outside.length - 8} more)` : '';
    return {
      allowed: false,
      outside,
      detail: `${outside.length} changed file(s) fall outside the declared scope: ${shown}${more}.`,
    };
  }
  return { allowed: true, outside: [], detail: `All ${changed.length} changed file(s) fall inside the declared scope.` };
}

export const SNAPSHOT_PATH_CAP = 1000;

export interface WorktreeSnapshot {
  hashes: Map<string, string>;
  capped: boolean;
}

function safeJoin(cwd: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null;
  const joined = nodePath.resolve(cwd, rel);
  const root = nodePath.resolve(cwd);
  if (joined !== root && !joined.startsWith(root + nodePath.sep)) return null;
  return joined;
}

export async function snapshotWorktree(cwd: string): Promise<WorktreeSnapshot | null> {
  let status: { out: string; code: number };
  try {
    status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, timeoutMs: 30_000 });
  } catch {
    return null;
  }
  if (status.code !== 0) return null;
  const paths = parsePorcelainStatus(status.out).filter((p) => !p.includes('\n'));
  const snapshot: WorktreeSnapshot = { hashes: new Map(), capped: false };
  if (paths.length > SNAPSHOT_PATH_CAP) {
    snapshot.capped = true;
    return snapshot;
  }
  const existing = paths.filter((p) => {
    const full = safeJoin(cwd, p);
    return full !== null && existsSync(full);
  });
  if (existing.length === 0) return snapshot;
  try {
    const hashed = await git(['hash-object', '--', ...existing], { cwd, timeoutMs: 30_000 });
    if (hashed.code !== 0) return snapshot;
    const digests = hashed.out.split(/\s+/).filter(Boolean);
    existing.forEach((p, i) => {
      if (digests[i]) snapshot.hashes.set(p, digests[i]);
    });
  } catch {
    /* absent hashes count as changed in the delta (fail-closed) */
  }
  return snapshot;
}

export async function hashPaths(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const clean = paths.filter((p) => {
    if (p.includes('\n')) return false;
    const full = safeJoin(cwd, p);
    return full !== null && existsSync(full);
  });
  const out = new Map<string, string>();
  if (clean.length === 0) return out;
  try {
    const hashed = await git(['hash-object', '--', ...clean], { cwd, timeoutMs: 30_000 });
    if (hashed.code !== 0) return out;
    const digests = hashed.out.split(/\s+/).filter(Boolean);
    clean.forEach((p, i) => {
      if (digests[i]) out.set(p, digests[i]);
    });
  } catch {
    /* missing hashes count as changed in the delta (fail-closed) */
  }
  return out;
}

export function deltaSince(
  before: WorktreeSnapshot,
  afterChanged: string[],
  afterHashes: Map<string, string>,
): string[] {
  const delta: string[] = [];
  for (const path of afterChanged) {
    if (path.includes('\n')) {
      delta.push(path);
      continue;
    }
    if (!before.hashes.has(path)) {
      if (!before.capped) delta.push(path);
      continue;
    }
    if (afterHashes.get(path) !== before.hashes.get(path)) delta.push(path);
  }
  return delta;
}
