/**
 * Local persistence for the Automation Engine — the AURA config home.
 * ==================================================================
 * Rules, run history and manifest snapshots live under a single config
 * directory (default `~/.aura`, override with AURA_HOME) so they survive
 * restarts. This is the same home the rest of AURA uses — kept here as a
 * tiny self-contained copy so the automation package never depends on
 * another package's internals.
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

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
