/**
 * Local persistence for AURA Workflow — the AURA config home.
 * ==================================================================
 * Workflow definitions and run history live under the single config
 * directory the rest of AURA uses (default `~/.aura`, override with
 * AURA_HOME) so they survive restarts and are never written into a
 * user's repository. This is the same contract as `ai-service/persist.ts`
 * and `automation/persist.ts` — kept here as a tiny self-contained copy
 * so the workflow package never depends on another package's internals.
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

/** Atomic write — temp file then rename, so a crash never leaves a half-written store. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}