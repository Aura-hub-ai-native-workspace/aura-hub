/**
 * Persistence Utility
 * ==================================================================
 * Provides local persistence for the Engineering Memory Platform.
 * This is a standalone implementation that doesn't depend on ai-service.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Get the AURA config home directory
 */
export function configHome(): string {
  const home = process.env.AURA_HOME || path.join(os.homedir(), '.aura');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Get a path relative to the AURA home directory
 */
export function homePath(...parts: string[]): string {
  return path.join(configHome(), ...parts);
}

/**
 * Read a JSON file, returning fallback when missing or corrupt
 */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomic write - write to temp file then rename
 */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
