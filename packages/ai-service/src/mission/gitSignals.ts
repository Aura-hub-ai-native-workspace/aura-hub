/**
 * gitSignals — real, whole-repo git status + recent commit history for
 * Mission Control's Stage 3 (Project Analysis). Distinct from
 * `diagnosis/gitSignals.ts`, which is per-FILE (history/blame for one
 * path) — this is per-REPO (branch/dirty state, the last N commits
 * across the whole project). Spawns through the one process primitive
 * (`exec/process`): never a shell string, an argument array only,
 * bounded timeout, and a kill that reaches the whole process group.
 * Never throws — any failure (not a repo, git missing) reports back as an
 * honest `{available:false, reason}` rather than blowing up mission
 * creation.
 */
import { git as runGit } from '../exec/process';
import type { GitStatusSignal, RecentCommit } from './types';

/**
 * Both files used to carry a private copy of this wrapper, and both said
 * in their header that the duplication was deliberate because the
 * hardened one was not exported. It is exported now, so the copies are
 * gone: one call shape, one timeout policy, one exit-status decision.
 *
 * The copies also reported a timed-out git as exit 0 — the precise bug
 * `settle` was written to fix — so "no commits touch this file" and "git
 * ran out of time" were the same answer. They are not any more.
 *
 * Containment comes with it: a git that hangs is now killed as a process
 * group rather than as a single pid.
 */
const git = (cwd: string, args: string[]) => runGit(args, { cwd, timeoutMs: 20_000 });

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
