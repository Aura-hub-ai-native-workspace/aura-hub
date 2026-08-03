/**
 * Trigger adapters — turn REAL project state into AutomationEvents.
 * ==================================================================
 * The engine is pushed events by the host; these adapters are how the
 * host DETECTS the moments. Each detector reads real, current state
 * (git porcelain, git log --merges, the package manifest) and returns
 * an AutomationEvent payload — or null when the moment hasn't happened.
 * Nothing is scheduled or timed here (no cron); the host calls a
 * detector at the platform moments it already knows about (after a
 * reindex, after a mission batch, before/after a PR review).
 *
 * Mirrors `mission/gitSignals.ts`'s safety rules: execFile with an
 * allow-listed binary, no shell strings, bounded timeout, never throws.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath } from './persist';
import type { AutomationEvent } from './types';

function git(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ out: '', code: -1 });
      const code = (err as { code?: number } | null)?.code;
      resolve({ out: (stdout + (stderr ? `\n${stderr}` : '')).trim(), code: typeof code === 'number' ? code : 0 });
    });
  });
}

/** Real changed files from `git status --porcelain` (empty when not a repo). */
export async function detectChangedFiles(projectPath: string): Promise<{ files: string[]; readmeChanged: boolean }> {
  const { out, code } = await git(projectPath, ['status', '--porcelain']);
  if (code !== 0) return { files: [], readmeChanged: false };
  const files = out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const readmeChanged = files.some((f) => /(^|\/)(readme|changelog|docs?)(\.|$)/i.test(f));
  return { files, readmeChanged };
}

/** Recent merge commits (real PR-merged evidence). */
export async function detectMergedPrs(projectPath: string, limit = 3): Promise<{ hash: string; date: string; subject: string }[]> {
  const { out, code } = await git(projectPath, ['log', `-n`, String(limit), '--merges', '--pretty=format:%H%x1f%aI%x1f%s']);
  if (code !== 0 || !out.trim()) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split('\x1f');
    return { hash: (hash ?? '').slice(0, 10), date: date ?? '', subject: subject ?? '' };
  });
}

/* ── dependency manifest diffing ──────────────────────────────────── */

interface ManifestSummary {
  name: string;
  version: string;
  deps: Record<string, string>;
}

function readManifest(projectPath: string): ManifestSummary | null {
  for (const name of ['package.json', 'cargo.toml', 'pyproject.toml', 'go.mod']) {
    const p = path.join(projectPath, name);
    if (!existsSync(p)) continue;
    try {
      if (name === 'package.json') {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        return { name: j.name ?? 'package', version: j.version ?? '', deps: { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) } };
      }
      const raw = readFileSync(p, 'utf8');
      const deps: Record<string, string> = {};
      const re = /^([A-Za-z0-9_.-]+)\s*[=:]?\s*([^#\s][^\n]*)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) deps[m[1]] = m[2].trim();
      return { name, version: 'unknown', deps };
    } catch {
      return null;
    }
  }
  return null;
}

/** Dependency snapshot, persisted so the next call can diff against it. */
export function readDependencySnapshot(projectPath: string): { projectPath: string; at: string; manifest: ManifestSummary | null } {
  return { projectPath, at: new Date().toISOString(), manifest: readManifest(projectPath) };
}

function diffDeps(before: ManifestSummary | null, after: ManifestSummary | null): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const beforeDeps = before?.deps ?? {};
  const afterDeps = after?.deps ?? {};
  for (const [name, ver] of Object.entries(afterDeps)) {
    if (!(name in beforeDeps)) added.push(name);
    else if (beforeDeps[name] !== ver) changed.push(name);
  }
  for (const name of Object.keys(beforeDeps)) if (!(name in afterDeps)) removed.push(name);
  return { added, removed, changed };
}

/** Persist the snapshot for `projectPath`, returning the diff vs the previous one. */
export function persistDependencySnapshot(projectPath: string): { diff: { added: string[]; removed: string[]; changed: string[] }; first: boolean; at: string } {
  const dir = homePath('automation', 'manifest-snapshots');
  mkdirSync(dir, { recursive: true });
  const id = projectPath.replace(/[\\/:*?"<>|]+/g, '_');
  const file = path.join(dir, `${id}.json`);
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ManifestSummary | null) : null;
  const cur = readManifest(projectPath);
  const diff = diffDeps(prev, cur);
  writeFileSync(file, JSON.stringify(cur, null, 2));
  return { diff, first: prev === null, at: new Date().toISOString() };
}

/* ── event construction helpers (called by the host) ──────────────── */

export function buildEvent(
  type: AutomationEvent['type'],
  projectId: string,
  projectPath: string,
  payload: Record<string, unknown>,
): AutomationEvent {
  return { type, projectId, projectPath, at: new Date().toISOString(), payload };
}

export function fileChangeEvent(projectId: string, projectPath: string, files: string[], readmeChanged: boolean): AutomationEvent {
  return buildEvent(readmeChanged ? 'readme-changed' : 'file-changed', projectId, projectPath, { files, readmeChanged });
}

export function dependencyChangeEvent(projectId: string, projectPath: string, diff: { added: string[]; removed: string[]; changed: string[] }): AutomationEvent {
  return buildEvent('dependency-changed', projectId, projectPath, { diff });
}

export function prMergedEvent(projectId: string, projectPath: string, pr: { hash: string; date: string; subject: string }): AutomationEvent {
  return buildEvent('pr-merged', projectId, projectPath, { pr });
}

/* ── one-shot watcher helpers (host convenience, not polling loops) ─ */

/**
 * Register a set of project roots. `onEvent` is invoked synchronously for
 * every real event detected in that project. Returns an object the host
 * uses to trigger a re-scan at platform moments. Never runs in the
 * background — the host decides when to scan.
 */
export function createTriggerScanner(roots: { projectId: string; projectPath: string }[]) {
  const byPath = new Map(roots.map((r) => [path.resolve(r.projectPath), r]));

  async function scanProject(projectId: string, projectPath: string): Promise<AutomationEvent[]> {
    const events: AutomationEvent[] = [];
    const { files, readmeChanged } = await detectChangedFiles(projectPath);
    if (files.length) events.push(fileChangeEvent(projectId, projectPath, files, readmeChanged));
    const prs = await detectMergedPrs(projectPath);
    for (const pr of prs) events.push(prMergedEvent(projectId, projectPath, pr));
    const snap = persistDependencySnapshot(projectPath);
    if (!snap.first && (snap.diff.added.length || snap.diff.removed.length || snap.diff.changed.length)) {
      events.push(dependencyChangeEvent(projectId, projectPath, snap.diff));
    }
    return events;
  }

  return {
    roots: byPath,
    scan: async (projectPath: string): Promise<AutomationEvent[]> => {
      const abs = path.resolve(projectPath);
      const root = byPath.get(abs);
      if (!root) return [];
      return scanProject(root.projectId, root.projectPath);
    },
    scanAll: async (): Promise<AutomationEvent[]> => {
      const out: AutomationEvent[] = [];
      for (const r of roots) out.push(...await scanProject(r.projectId, r.projectPath));
      return out;
    },
  };
}
