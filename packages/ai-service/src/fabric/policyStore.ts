/**
 * policyStore — the Fabric's policy, on disk.
 * ==================================================================
 * Reuses the existing config home (`persist.ts`) rather than inventing a
 * store: same directory as the project registry, same atomic
 * write-then-rename, so a crash mid-save cannot leave a half-written
 * security policy behind.
 *
 *   ~/.aura/fabric-policy.json      (AURA_HOME overrides the directory)
 *
 * There is no second policy model here. The file holds exactly the
 * shipped `PolicyConfig`, and everything read off disk goes through
 * `sanitizePolicy()` before it reaches the engine — a file is untrusted
 * input, and an unrecognised decision string must never survive far
 * enough to be compared against `'require-approval'` and found unequal.
 *
 * The hard floors need no defending here. `evaluatePolicy` checks them
 * *before* it consults any configuration and returns early, so nothing
 * this file can load is capable of reaching them.
 */

import { sanitizePolicy, type PolicyConfig } from '@aura/capability-fabric';
import { homePath, readJsonFile, writeJsonFile } from '../persist';

const FILE = () => homePath('fabric-policy.json');

/** The persisted policy, or the shipped default when absent or corrupt. */
export function loadPolicy(): PolicyConfig {
  return sanitizePolicy(readJsonFile<unknown>(FILE(), null));
}

/**
 * Persist a policy, returning what was actually stored — which is the
 * sanitized form, not the caller's input, so the value the caller sees is
 * the value the engine will use.
 */
export function savePolicy(raw: unknown): PolicyConfig {
  const policy = sanitizePolicy(raw);
  writeJsonFile(FILE(), policy);
  return policy;
}

export function policyFilePath(): string {
  return FILE();
}
