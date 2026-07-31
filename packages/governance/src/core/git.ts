/**
 * Git helpers — real repository history access.
 * ==================================================================
 * All insights about change frequency, churn and PR diffs come from
 * actual `git` output. If git is unavailable (not a repo, no binary)
 * the caller is told explicitly — nothing is invented.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export function runGit(args: string[], cwd: string, timeoutMs = 30000): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout, stderr, error: (err as Error).message });
      } else {
        resolve({ ok: true, stdout, stderr });
      }
    });
  });
}

export interface ChangeRecord {
  file: string;
  added: number;
  deleted: number;
}

export interface GitChurn {
  available: boolean;
  since: string;
  totalCommits: number;
  byFile: Map<string, number>;
  byModule: Map<string, { changes: number; added: number; deleted: number }>;
  recentChanges: ChangeRecord[];
}

const MODULE_RE = /^(?:packages|apps)\/([^/]+)/;

export async function getGitChurn(root: string, days = 90): Promise<GitChurn> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const log = await runGit(['log', `--since=${since}`, '--date=short', '--pretty=format:%H%x09%ad', '--numstat'], root);
  if (!log.ok) {
    return { available: false, since, totalCommits: 0, byFile: new Map(), byModule: new Map(), recentChanges: [] };
  }

  const commits = new Set<string>();
  const byFile = new Map<string, number>();
  const byModule = new Map<string, { changes: number; added: number; deleted: number }>();
  const recentChanges: ChangeRecord[] = [];

  const lines = log.stdout.split('\n');
  let currentCommit: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.startsWith('\t') && line.includes('\t')) {
      const [hash] = line.split('\t');
      currentCommit = hash.trim();
      commits.add(currentCommit);
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3 || currentCommit === null) continue;
    const added = parseInt(parts[0], 10);
    const deleted = parseInt(parts[1], 10);
    const file = parts[2];
    if (Number.isNaN(added) || Number.isNaN(deleted)) continue;
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
    const mod = file.match(MODULE_RE)?.[1];
    if (mod) {
      const rec = byModule.get(mod) ?? { changes: 0, added: 0, deleted: 0 };
      rec.changes++;
      rec.added += added;
      rec.deleted += deleted;
      byModule.set(mod, rec);
    }
    recentChanges.push({ file, added, deleted });
  }

  recentChanges.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  return { available: true, since, totalCommits: commits.size, byFile, byModule, recentChanges };
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
}

const STATUS_MAP: Record<string, ChangedFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
};

export async function getChangedFiles(root: string, base = 'HEAD~1'): Promise<ChangedFile[]> {
  const diff = await runGit(['diff', '--name-status', base, 'HEAD'], root);
  if (!diff.ok) {
    const staged = await runGit(['diff', '--cached', '--name-status'], root);
    if (!staged.ok) return [];
    return parseNameStatus(staged.stdout);
  }
  return parseNameStatus(diff.stdout);
}

function parseNameStatus(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const code = status[0] ?? 'M';
    const target = rest.length > 1 ? rest[rest.length - 1] : (rest[0] ?? '');
    if (!target) continue;
    out.push({ path: target, status: STATUS_MAP[code] ?? 'unknown' });
  }
  return out;
}

export function isGitRepo(root: string): Promise<boolean> {
  return runGit(['rev-parse', '--is-inside-work-tree'], root).then((r) => r.ok && r.stdout.trim() === 'true');
}

export function repoRoot(root: string): Promise<string> {
  return runGit(['rev-parse', '--show-toplevel'], root).then((r) => (r.ok ? path.resolve(r.stdout.trim()) : root));
}
