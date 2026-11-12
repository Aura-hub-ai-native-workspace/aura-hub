/**
 * Local persistence — the config home for AURA Hub.
 * ==================================================================
 * Everything the user creates (projects, per-project profiles and
 * memory, knowledge indexes) lives under a single config directory so
 * it survives application restarts. Nothing is written into the user's
 * own repositories.
 *
 *   default home: ~/.aura   (override with AURA_HOME)
 *     projects.json          — the project registry
 *     profiles/<id>.json     — per-project profile (real, derived)
 *     memory/<id>.json       — per-project memory (real, user/AI authored)
 *     index/<id>/coding      — Coding Knowledge Engine index
 *     index/<id>/fullstack   — FullStack Knowledge Engine graph
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const protectedHomes = new Set<string>();

/**
 * The data folder holds encrypted keys with the seed that unlocks them,
 * account files and logs, so it is private to its owner (0700). Skipped on
 * Windows (the profile folder is already private) and for a folder that is
 * the user's home itself or a filesystem root.
 */
function protectHome(home: string): void {
  if (process.platform === 'win32' || protectedHomes.has(home)) return;
  protectedHomes.add(home);
  const resolved = path.resolve(home);
  if (resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root) return;
  try {
    if ((fs.statSync(resolved).mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700);
  } catch {
    /* a folder we cannot change is still usable */
  }
}

export function configHome(): string {
  const home = process.env.AURA_HOME || path.join(os.homedir(), '.aura');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  protectHome(home);
  return home;
}

function insideConfigHome(file: string): boolean {
  const rel = path.relative(path.resolve(configHome()), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function homePath(...parts: string[]): string {
  return path.join(configHome(), ...parts);
}

/** Read a JSON file, returning `fallback` when it is missing or corrupt. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * The outcome of reading a JSON store, with "there is nothing here" kept
 * distinct from "I could not read what is here".
 *
 *   missing — the file does not exist. A first run. `fallback` is correct.
 *   ok      — parsed successfully.
 *   corrupt — the file exists but could not be read or parsed.
 *
 * `readJsonFile` collapses all three into `fallback`, which is fine for
 * caches that can be rebuilt. It is NOT fine for the project registry: an
 * unreadable `projects.json` became an empty project list, and an empty
 * list is indistinguishable from "the user removed their projects" — so
 * the active project was pruned and its pointer deleted on the strength of
 * a parse error. Callers that can destroy user state must see the
 * difference.
 */
export type JsonReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing'; value: T }
  | { status: 'corrupt'; value: T; error: string };

export function readJsonFileResult<T>(file: string, fallback: T): JsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', value: fallback };
    return { status: 'corrupt', value: fallback, error: (e as Error).message };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch (e) {
    // Truncated or malformed. Never repaired and never overwritten here —
    // the file is the user's data, and a rewrite would destroy whatever
    // could still be recovered from it by hand.
    return { status: 'corrupt', value: fallback, error: (e as Error).message };
  }
}

/** Atomic write — write to a temp file then rename, so a crash mid-write
 *  never leaves a half-written store on disk. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // Files in the data folder are owner-only (0600); files written
  // elsewhere keep the usual permissions.
  const ownerOnly = process.platform !== 'win32' && insideConfigHome(file);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), ownerOnly ? { mode: 0o600 } : undefined);
  if (ownerOnly) fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
