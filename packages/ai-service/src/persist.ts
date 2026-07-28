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

export function configHome(): string {
  const home = process.env.AURA_HOME || path.join(os.homedir(), '.aura');
  fs.mkdirSync(home, { recursive: true });
  return home;
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

/** Atomic write — write to a temp file then rename, so a crash mid-write
 *  never leaves a half-written store on disk. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
