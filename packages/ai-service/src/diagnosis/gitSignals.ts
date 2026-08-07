/**
 * gitSignals — real `git log`/`git blame` for Stage 1 evidence.
 * ==================================================================
 * `workflow/nodes.ts` already has a `git()` execFile wrapper but does
 * not export it, so this is a small, deliberate, same-shape duplicate
 * (allow-listed `git` binary only, `execFile` with an argument array —
 * never a shell string — pinned `cwd`, bounded timeout). Never throws:
 * any failure (not a repo, git missing, path never committed) reports
 * back as an honest `{unavailable, reason}` rather than blowing up the
 * whole diagnosis.
 */
import { execFile } from 'node:child_process';
import type { GitBlameLine, GitLogEntry, Unavailable } from './types';

function git(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed'));
      const code = (err as { code?: number } | null)?.code;
      resolve({ out: (stdout + (stderr ? `\n${stderr}` : '')).trim(), code: typeof code === 'number' ? code : 0 });
    });
  });
}

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
