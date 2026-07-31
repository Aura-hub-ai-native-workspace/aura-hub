/**
 * gitSignals — real, whole-repo git status + recent commit history for
 * Mission Control's Stage 3 (Project Analysis). Distinct from
 * `diagnosis/gitSignals.ts`, which is per-FILE (history/blame for one
 * path) — this is per-REPO (branch/dirty state, the last N commits
 * across the whole project). Its own small `execFile` wrapper, same
 * shape and same reasoning as the diagnosis version: never a shell
 * string, an allow-listed `git` binary only, bounded timeout. Never
 * throws — any failure (not a repo, git missing) reports back as an
 * honest `{available:false, reason}` rather than blowing up mission
 * creation.
 */
import { execFile } from 'node:child_process';
import type { GitStatusSignal, RecentCommit } from './types';

function git(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed'));
      const code = (err as { code?: number } | null)?.code;
      resolve({ out: (stdout + (stderr ? `\n${stderr}` : '')).trim(), code: typeof code === 'number' ? code : 0 });
    });
  });
}

export async function gatherGitStatus(projectPath: string): Promise<GitStatusSignal> {
  try {
    const [branchRes, statusRes] = await Promise.all([
      git(projectPath, ['branch', '--show-current']),
      git(projectPath, ['status', '--porcelain']),
    ]);
    if (branchRes.code !== 0 && statusRes.code !== 0) return { available: false, reason: 'not a git repository' };
    const changedFiles = statusRes.out ? statusRes.out.split('\n').filter(Boolean).length : 0;
    return { available: true, branch: branchRes.out || '(detached)', dirty: changedFiles > 0, changedFiles };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

export async function gatherRecentCommits(projectPath: string, limit = 8): Promise<RecentCommit[]> {
  try {
    const { out, code } = await git(projectPath, ['log', `-n`, String(limit), '--pretty=format:%H%x1f%aI%x1f%s']);
    if (code !== 0 || !out.trim()) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, date, subject] = line.split('\x1f');
      return { hash: (hash ?? '').slice(0, 10), date: date ?? '', subject: subject ?? '' };
    });
  } catch {
    return [];
  }
}
