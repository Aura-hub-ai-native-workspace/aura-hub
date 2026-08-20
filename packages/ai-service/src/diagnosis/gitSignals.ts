/**
 * gitSignals — real `git log`/`git blame` for Stage 1 evidence.
 * ==================================================================
 * Spawns through the one process primitive (`exec/process`), which is
 * where the hardening lives: an argument array only — never a shell
 * string — a pinned `cwd`, a bounded timeout, and a kill that reaches
 * the whole process group. Never throws:
 * any failure (not a repo, git missing, path never committed) reports
 * back as an honest `{unavailable, reason}` rather than blowing up the
 * whole diagnosis.
 */
import { git as runGit } from '../exec/process';
import type { GitBlameLine, GitLogEntry, Unavailable } from './types';

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

export async function gitHistory(projectPath: string, relPath: string, limit = 5): Promise<GitLogEntry[] | Unavailable> {
  try {
    const { out, code } = await git(projectPath, ['log', '--follow', `-n`, String(limit), '--pretty=format:%H%x1f%aI%x1f%s', '--', relPath]);
    if (code !== 0) return { unavailable: true, reason: 'not tracked by git or no history' };
    if (!out.trim()) return { unavailable: true, reason: 'no commits touch this file' };
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, date, subject] = line.split('\x1f');
      return { hash: (hash ?? '').slice(0, 10), date: date ?? '', subject: subject ?? '' };
    });
  } catch (e) {
    return { unavailable: true, reason: (e as Error).message };
  }
}

export async function gitBlame(projectPath: string, relPath: string, startLine: number, endLine: number): Promise<GitBlameLine[] | Unavailable> {
  if (startLine < 1 || endLine < startLine) return { unavailable: true, reason: 'invalid line range' };
  try {
    const { out, code } = await git(projectPath, ['blame', '-L', `${startLine},${endLine}`, '--line-porcelain', '--', relPath]);
    if (code !== 0) return { unavailable: true, reason: 'not tracked by git or line range out of bounds' };
    const lines: GitBlameLine[] = [];
    let hash = '', author = '', date = '';
    let lineNo = startLine;
    for (const raw of out.split('\n')) {
      if (/^[0-9a-f]{40}\s/.test(raw)) { hash = raw.slice(0, 10); continue; }
      if (raw.startsWith('author ')) { author = raw.slice(7); continue; }
      if (raw.startsWith('author-time ')) { date = new Date(Number(raw.slice(12)) * 1000).toISOString(); continue; }
      if (raw.startsWith('\t')) { lines.push({ line: lineNo++, hash, author, date }); continue; }
    }
    return lines.length ? lines : { unavailable: true, reason: 'no blame lines produced' };
  } catch (e) {
    return { unavailable: true, reason: (e as Error).message };
  }
}
