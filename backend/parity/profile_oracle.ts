/**
 * Profile oracle — the REAL TypeScript project profiler.
 *
 * Runs `buildProfile` against a directory on THIS machine so the Python
 * port can be diffed against what the reference actually derives from the
 * same folder.
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <project-root> <id>
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repoRoot, projectRoot, id] = process.argv;
if (!repoRoot || !projectRoot || !id) {
  console.error('usage: run-ts.mjs profile_oracle.ts <repo-root> <project-root> <id>');
  process.exit(1);
}
const { buildProfile } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/ai-service/src/profile.ts')).href
);
const p = buildProfile(id, projectRoot);
// `generatedAt` is wall-clock. `fingerprint` is NOT excluded: it embeds
// manifest mtimes stringified as JavaScript stringifies numbers, it is
// compared for EQUALITY to decide whether the cached profile stands, and
// a profile written by one backend has to read as current under the
// other. Excluding it once hid a real defect.
delete p.generatedAt;
process.stdout.write(JSON.stringify(p, null, 2));
