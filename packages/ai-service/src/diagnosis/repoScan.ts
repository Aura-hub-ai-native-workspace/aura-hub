/**
 * repoScan — bounded, real filesystem walk for Dead Code / Broken API's
 * cross-file importer search. Reuses `@aura/knowledge-coding`'s ignore
 * rules so we never descend into node_modules/.git/dist/etc. Bounded by
 * a hard file cap so a single diagnosis can never turn into a full
 * repo grep on a huge monorepo — the cap is reported back honestly
 * whenever it is hit, never silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { IgnoreRules } from '@aura/knowledge-coding';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface ScannedFile {
  absPath: string;
  relPath: string;
  text: string;
}

export interface ScanResult {
  files: ScannedFile[];
  capHit: boolean;
  scanned: number;
}

/** Walk the project root for real source files, capped at `maxFiles`. */
export function scanSourceFiles(projectRoot: string, maxFiles = 40): ScanResult {
  const ignore = new IgnoreRules();
  const files: ScannedFile[] = [];
  let scanned = 0;
  let capHit = false;

  const walk = (dir: string) => {
    if (capHit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capHit) return;
      if (entry.isDirectory()) {
        if (ignore.allowDir(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTS.has(ext)) continue;
      const abs = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, abs).split(path.sep).join('/');
      if (!ignore.allowFile(entry.name, relPath)) continue;
      scanned++;
      if (files.length >= maxFiles) {
        capHit = true;
        return;
      }
      try {
        files.push({ absPath: abs, relPath, text: fs.readFileSync(abs, 'utf8') });
      } catch {
        /* unreadable file — skip honestly, not a hard failure */
      }
    }
  };
  walk(projectRoot);
  return { files, capHit, scanned };
}

/** Resolve a user-supplied relative path INSIDE the project root; rejects escapes (mirrors workflow/nodes.ts's insideProject). */
export function resolveInsideProject(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes the project: ${rel}`);
  return abs;
}

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolve a relative `import ... from` specifier to a real file's absolute path, or null if it doesn't exist / isn't relative. */
export function resolveRelativeSpecifier(fromAbsFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const baseDir = path.dirname(fromAbsFile);
  const target = path.resolve(baseDir, specifier);
  const candidates = [target, ...RESOLVE_EXTS.map((e) => target + e), ...RESOLVE_EXTS.map((e) => path.join(target, 'index' + e))];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
