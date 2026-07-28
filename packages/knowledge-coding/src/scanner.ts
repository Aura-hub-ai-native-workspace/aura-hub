/**
 * WorkspaceScanner — real recursive filesystem traversal.
 * ==================================================================
 * Walks a workspace depth-first, applying ignore rules, skipping hidden
 * folders, dependency/build/cache dirs, and non-text assets. Guards
 * against symlink loops, tolerates permission errors per-entry, reports
 * progress, and supports cooperative cancellation via AbortSignal.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { IgnoreRules } from './ignore';
import { abortError } from './abort';
import type { FileError, ProgressCallback, ScanEntry } from './types';

export interface ScanResult {
  entries: ScanEntry[];
  scannedDirs: number;
  skipped: number;
  errors: FileError[];
}

export class WorkspaceScanner {
  constructor(private readonly rules: IgnoreRules) {}

  async scan(
    root: string,
    opts: { onProgress?: ProgressCallback; signal?: AbortSignal } = {},
  ): Promise<ScanResult> {
    const absRoot = path.resolve(root);
    const entries: ScanEntry[] = [];
    const errors: FileError[] = [];
    let scannedDirs = 0;
    let skipped = 0;
    const visited = new Set<string>(); // real paths, to break symlink loops

    const walk = async (dir: string): Promise<void> => {
      if (opts.signal?.aborted) throw abortError('Scan cancelled');

      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        errors.push({ relPath: path.relative(absRoot, dir) || '.', code: e.code ?? 'EDIR', message: e.message });
        return;
      }
      scannedDirs++;

      for (const dirent of dirents) {
        if (opts.signal?.aborted) throw abortError('Scan cancelled');
        const abs = path.join(dir, dirent.name);
        const rel = path.relative(absRoot, abs);

        if (dirent.isSymbolicLink()) {
          // Resolve once; skip if it escapes into an already-visited real dir.
          try {
            const real = await stat(abs);
            if (real.isDirectory()) {
              const realPath = await realpathSafe(abs);
              if (realPath && !visited.has(realPath) && this.rules.allowDir(dirent.name)) {
                visited.add(realPath);
                await walk(abs);
              }
            } else if (real.isFile() && this.rules.allowFile(dirent.name, rel)) {
              entries.push({ absPath: abs, relPath: rel, size: real.size, modifiedMs: real.mtimeMs });
            }
          } catch {
            skipped++;
          }
          continue;
        }

        if (dirent.isDirectory()) {
          if (!this.rules.allowDir(dirent.name)) {
            skipped++;
            continue;
          }
          await walk(abs);
        } else if (dirent.isFile()) {
          if (!this.rules.allowFile(dirent.name, rel)) {
            skipped++;
            continue;
          }
          try {
            const st = await stat(abs);
            entries.push({ absPath: abs, relPath: rel, size: st.size, modifiedMs: st.mtimeMs });
            opts.onProgress?.({ phase: 'scan', processed: entries.length, path: rel });
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            errors.push({ relPath: rel, code: e.code ?? 'ESTAT', message: e.message });
          }
        }
      }
    };

    await walk(absRoot);
    return { entries, scannedDirs, skipped, errors };
  }
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    const { realpath } = await import('node:fs/promises');
    return await realpath(p);
  } catch {
    return null;
  }
}
