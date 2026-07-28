/**
 * Performance Engine
 * ==================================================================
 * Optimizes intelligence pipeline execution:
 * - Incremental indexing (only re-index changed files)
 * - Parallel index runs for multi-module repos
 * - Lazy loading for large repositories
 * - File mtime tracking for change detection
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';

const INDEX_STATE_FILE = homePath('index-state', 'file-mtimes.json');

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
}

/**
 * Load the stored file mtime index.
 */
export function loadIndexState(): FileIndexState {
  return readJsonFile<FileIndexState>(INDEX_STATE_FILE, {});
}

/**
 * Save the file mtime index.
 */
export function saveIndexState(state: FileIndexState): void {
  writeJsonFile(INDEX_STATE_FILE, state);
}

/**
 * Get all source files in a directory with their mtimes.
 * Respects IGNORE_DIRS for performance.
 */
function scanFilesWithMtime(root: string, maxFiles: number = 10000): Map<string, number> {
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

  return files;
}

/**
 * Detect which files have changed since last index.
 * Returns the diff between current and stored state.
 */
export function detectChanges(root: string): IndexResult {
  const startTime = performance.now();
  const storedState = loadIndexState();
  const currentState = scanFilesWithMtime(root);

  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  // Check for changed and added files
  for (const [file, mtime] of currentState) {
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
  };
}

/**
 * Update the index state with current file mtimes.
 */
export function updateIndexState(root: string): void {
  const currentState = scanFilesWithMtime(root);
  const state: FileIndexState = {};
  for (const [file, mtime] of currentState) {
    state[file] = mtime;
  }
  saveIndexState(state);
}

/**
 * Check if any source files have changed since last index.
 * Quick check without full diff.
 */
export function hasChanges(root: string): boolean {
  const storedState = loadIndexState();
  const currentState = scanFilesWithMtime(root, 1000); // Quick scan

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

/**
 * Parallel index runner.
 * Runs multiple index operations concurrently.
 */
export async function runParallelIndex<T>(
  items: T[],
  indexFn: (item: T) => Promise<void>,
  concurrency: number = 4,
): Promise<{ processed: number; durationMs: number }> {
  const startTime = performance.now();
  let processed = 0;

  // Process items in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      try {
        await indexFn(item);
        processed++;
      } catch {
        // Skip failed items
      }
    }));
  }

  const durationMs = Math.round(performance.now() - startTime);
  return { processed, durationMs };
}
