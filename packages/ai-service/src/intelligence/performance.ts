/**
 * Performance Engine
 * ==================================================================
 * Optimizes intelligence pipeline execution:
 * - Incremental indexing (only re-index changed files)
 * - Lazy loading for large repositories
 * - File mtime tracking for change detection
 *
 * ── Why the index state is keyed by project ──────────────────────────
 * This state used to live in ONE global file, `index-state/file-mtimes.json`,
 * shared by every project. Opening a second project overwrote the first
 * one's baseline, so the next scan of the first project reported its entire
 * tree as newly added. Incremental indexing across more than one project
 * was therefore never sound. The baseline is now per project.
 *
 * ── Why change detection walks the whole tree ────────────────────────
 * A directory's mtime only moves when its OWN entries change, so editing
 * `packages/ai-service/src/server.ts` leaves the repository root's mtime
 * untouched. Any staleness check built on the root's mtime is blind to
 * nested edits — which is exactly the bug this module now exists to close.
 * There is no shortcut: detecting a nested change means statting the files.
 * The walk skips IGNORE_DIRS, so it costs milliseconds on a normal repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';

/** Upper bound on files walked in one scan. See `IndexResult.truncated`. */
const MAX_SCAN_FILES = 10000;

/**
 * Project ids come from `slug()` in projects.ts and are already
 * `[a-z0-9-]+`. This is defence in depth: the id becomes a filename, so
 * anything that could escape the directory is neutralised before it is
 * joined onto a path. An id that sanitises to nothing is rejected rather
 * than silently written to a shared file — a shared file is the bug above.
 */
function indexStateFile(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe) throw new Error(`invalid project id for index state: ${JSON.stringify(projectId)}`);
  return homePath('index-state', `${safe}.json`);
}

export interface FileIndexState {
  [filePath: string]: number; // mtime in ms
}

export interface IndexResult {
  changed: string[];
  unchanged: string[];
  added: string[];
  removed: string[];
  totalIndexed: number;
  durationMs: number;
  /**
   * Highest mtime seen anywhere in the tree, in ms since the epoch, or 0 for
   * an empty tree.
   *
   * This is what makes an artifact's freshness answerable WITHOUT a stored
   * baseline: an artifact generated before this timestamp cannot describe
   * the tree as it stands. Modifications are caught by this alone; additions
   * and removals still need the baseline, because a new or deleted file does
   * not necessarily carry the newest mtime.
   */
  maxMtimeMs: number;
  /**
   * True when the walk hit `MAX_SCAN_FILES`. The counts then describe a
   * prefix of the tree, not the tree — reported rather than hidden, because
   * a silently truncated scan reads as "nothing changed".
   */
  truncated: boolean;
}

/**
 * Load the stored file mtime baseline for one project.
 */
export function loadIndexState(projectId: string): FileIndexState {
  return readJsonFile<FileIndexState>(indexStateFile(projectId), {});
}

/**
 * Save the file mtime baseline for one project.
 */
export function saveIndexState(projectId: string, state: FileIndexState): void {
  writeJsonFile(indexStateFile(projectId), state);
}

/**
 * Get all source files in a directory with their mtimes.
 * Respects IGNORE_DIRS for performance.
 *
 * `truncated` reports whether the cap was reached, so a caller can tell a
 * complete answer from a partial one.
 */
function scanFilesWithMtime(
  root: string,
  maxFiles: number = MAX_SCAN_FILES,
): { files: Map<string, number>; truncated: boolean } {
  const files = new Map<string, number>();
  const stack: string[] = [root];

  while (stack.length && files.size < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (files.size >= maxFiles) break;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;

      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }

      // Only index source files
      const ext = path.extname(e.name).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.md', '.json'].includes(ext)) {
        continue;
      }

      try {
        const stat = fs.statSync(full);
        files.set(path.relative(root, full), stat.mtimeMs);
      } catch {
        // Skip files we can't stat
      }
    }
  }

  return { files, truncated: files.size >= maxFiles && stack.length > 0 };
}

/**
 * Detect which files changed since this project's last recorded baseline.
 *
 * With no baseline yet (first run for a project) every file reports as
 * `added`, which is the honest answer: nothing is known about this tree yet,
 * so every artifact derived from it must be regenerated.
 */
/**
 * One tree walk, returning both the diff and the snapshot it was computed
 * from.
 *
 * `detectChanges` and `updateIndexState` each used to walk the tree
 * independently, so a single pipeline run scanned the same repository
 * twice — once to ask what changed, once to record the new baseline from
 * an identical observation. Callers that do both should use this and pass
 * the snapshot to `updateIndexStateFrom`, which writes without re-walking.
 *
 * It also removes a subtle inconsistency: two walks are two different
 * observations, so a file written between them was recorded in the
 * baseline without ever appearing in the diff — and would never be
 * reported as changed.
 */
export function scanAndDiff(projectId: string, root: string): { result: IndexResult; snapshot: FileIndexState } {
  const startTime = performance.now();
  const storedState = loadIndexState(projectId);
  const { files: currentState, truncated } = scanFilesWithMtime(root);

  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  const snapshot: FileIndexState = {};
  let maxMtimeMs = 0;

  for (const [file, mtime] of currentState) {
    snapshot[file] = mtime;
    if (mtime > maxMtimeMs) maxMtimeMs = mtime;
    const storedMtime = storedState[file];
    if (storedMtime === undefined) added.push(file);
    else if (storedMtime < mtime) changed.push(file);
    else unchanged.push(file);
  }

  for (const file of Object.keys(storedState)) {
    if (!currentState.has(file)) removed.push(file);
  }

  return {
    snapshot,
    result: {
      changed,
      unchanged,
      added,
      removed,
      totalIndexed: currentState.size,
      durationMs: Math.round(performance.now() - startTime),
      maxMtimeMs,
      truncated,
    },
  };
}

/** Record a snapshot already produced by `scanAndDiff`, without re-walking. */
export function updateIndexStateFrom(projectId: string, snapshot: FileIndexState): void {
  saveIndexState(projectId, snapshot);
}

export function detectChanges(projectId: string, root: string): IndexResult {
  const startTime = performance.now();
  const storedState = loadIndexState(projectId);
  const { files: currentState, truncated } = scanFilesWithMtime(root);

  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  let maxMtimeMs = 0;

  // Check for changed and added files
  for (const [file, mtime] of currentState) {
    if (mtime > maxMtimeMs) maxMtimeMs = mtime;
    const storedMtime = storedState[file];
    if (storedMtime === undefined) {
      added.push(file);
    } else if (storedMtime < mtime) {
      changed.push(file);
    } else {
      unchanged.push(file);
    }
  }

  // Check for removed files
  for (const file of Object.keys(storedState)) {
    if (!currentState.has(file)) {
      removed.push(file);
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    changed,
    unchanged,
    added,
    removed,
    totalIndexed: currentState.size,
    durationMs,
    maxMtimeMs,
    truncated,
  };
}

/**
 * Record the current tree as this project's baseline.
 *
 * Call this AFTER regenerating the artifacts derived from the tree, so the
 * next run compares against the state the artifacts actually describe.
 * Calling it before would rebase away the very changes that should have
 * triggered a regeneration.
 */
export function updateIndexState(projectId: string, root: string): void {
  const { files: currentState } = scanFilesWithMtime(root);
  const state: FileIndexState = {};
  for (const [file, mtime] of currentState) {
    state[file] = mtime;
  }
  saveIndexState(projectId, state);
}

/**
 * Whether an artifact generated at `generatedAt` still describes this tree.
 *
 * Two independent signals, because neither alone is sufficient:
 *   • `maxMtimeMs` catches modifications, and needs no baseline — a file
 *     touched after the artifact was written is proof the artifact is behind.
 *   • `added`/`removed` catch files appearing or disappearing, which can
 *     happen without any file carrying a newer mtime (a restored backup, a
 *     checkout of an older branch).
 *
 * A missing or unparseable timestamp is treated as stale. Freshness is a
 * claim; absent evidence, AURA does not make it.
 */
export function isArtifactStale(generatedAt: string | undefined | null, changes: IndexResult): boolean {
  if (!generatedAt) return true;
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return true;
  if (changes.maxMtimeMs > generated) return true;
  if (changes.added.length > 0 || changes.removed.length > 0) return true;
  return false;
}

/**
 * Check if any source files have changed since last index.
 * Quick check without full diff.
 */
export function hasChanges(projectId: string, root: string): boolean {
  const storedState = loadIndexState(projectId);
  const { files: currentState } = scanFilesWithMtime(root);
  // Quick size check
  if (Object.keys(storedState).length !== currentState.size) return true;
  // Check a sample of files
  let checked = 0;
  for (const [file, mtime] of currentState) {
    if (checked++ > 100) break; // Only check first 100 files
    if (storedState[file] !== mtime) return true;
  }
  return false;
}

/**
 * Lazy loader for large repositories.
 * Only loads files on demand, caching results.
 */
export class LazyFileLoader {
  private cache = new Map<string, string>();
  private root: string;
  private maxCacheSize: number;

  constructor(root: string, maxCacheSize: number = 1000) {
    this.root = root;
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Load a file's content, using cache if available.
   */
  load(relativePath: string): string | null {
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) return cached;

    const fullPath = path.join(this.root, relativePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      this.cache.set(relativePath, content);

      // Evict oldest if cache full
      if (this.cache.size > this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value!;
        this.cache.delete(firstKey);
      }

      return content;
    } catch {
      return null;
    }
  }

  /**
   * Load multiple files in parallel.
   */
  loadMany(relativePaths: string[]): Map<string, string | null> {
    const results = new Map<string, string | null>();
    for (const p of relativePaths) {
      results.set(p, this.load(p));
    }
    return results;
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats.
   */
  stats(): { size: number; max_size: number } {
    return { size: this.cache.size, max_size: this.maxCacheSize };
  }
}
