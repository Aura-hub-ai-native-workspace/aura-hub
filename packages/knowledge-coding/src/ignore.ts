/**
 * Ignore rules — configurable, with sane production defaults.
 * ==================================================================
 * Skips hidden folders, dependency/build/cache directories, and known
 * binary/asset extensions. Fully configurable (extend or replace).
 */

import type { IgnoreConfig } from './types';

/** Directories never worth indexing for code knowledge. */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'coverage', '.nyc_output', '.pytest_cache', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', '.vscode', 'vendor', '.terraform', '.aura-index',
];

/** Extensions we treat as non-text assets (skip content). */
export const DEFAULT_IGNORE_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.node', '.exe', '.dll', '.so', '.dylib', '.class', '.o', '.a',
  '.lock', '.min.js', '.min.css', '.map',
  '.db', '.sqlite', '.sqlite3',
];

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

export class IgnoreRules {
  private readonly dirs: Set<string>;
  private readonly exts: Set<string>;
  private readonly patterns: string[];
  readonly maxFileBytes: number;
  readonly includeHidden: boolean;

  constructor(config: IgnoreConfig = {}) {
    const base = config.replaceDefaults ? [] : DEFAULT_IGNORE_DIRS;
    const baseExt = config.replaceDefaults ? [] : DEFAULT_IGNORE_EXTS;
    this.dirs = new Set([...base, ...(config.directories ?? [])].map((d) => d.toLowerCase()));
    this.exts = new Set([...baseExt, ...(config.extensions ?? [])].map((e) => e.toLowerCase()));
    this.patterns = (config.patterns ?? []).map((p) => p.toLowerCase());
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.includeHidden = config.includeHidden ?? false;
  }

  /** Should this directory be descended into? */
  allowDir(name: string): boolean {
    const lower = name.toLowerCase();
    if (!this.includeHidden && name.startsWith('.')) return false;
    if (this.dirs.has(lower)) return false;
    return true;
  }

  /** Should this file be considered at all (by name/path, pre-read)? */
  allowFile(name: string, relPath: string): boolean {
    const lower = name.toLowerCase();
    if (!this.includeHidden && name.startsWith('.') && !ALLOWED_DOTFILES.has(lower)) return false;
    const relLower = relPath.toLowerCase();
    for (const p of this.patterns) if (relLower.includes(p)) return false;
    for (const ext of this.exts) if (lower.endsWith(ext)) return false;
    return true;
  }
}

/** Dotfiles that ARE meaningful code-knowledge even though hidden. */
const ALLOWED_DOTFILES = new Set([
  '.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore',
  '.env.example', '.editorconfig', '.nvmrc', '.node-version',
]);
