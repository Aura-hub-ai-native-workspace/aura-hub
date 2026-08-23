/**
 * Policy oracle — runs the TypeScript policy engine over a JSON case file
 * and prints one result per case, so the Python port can be diffed against
 * the reference implementation rather than against someone's reading of it.
 *
 * Usage:
 *   node scripts/run-ts.mjs <this file> <cases.json> <repo-root>
 *
 * Reads:  [{ name, capability, config, granted, nodeAvailable, subject }]
 * Writes: [{ name, decision, rule }]  on stdout
 *
 * `reason` IS compared. It was excluded once, on the argument that it is
 * only wording — and that is exactly how a divergence shipped: this string
 * is the approval prompt's summary, so it is what a person reads when
 * deciding whether to authorize an irreversible action.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const casesPath = process.argv[2];
const repoRoot = process.argv[3];
if (!casesPath || !repoRoot) {
  console.error('usage: run-ts.mjs policy_oracle.ts <cases.json> <repo-root>');
  process.exit(1);
}

// The reference engine is imported from the TypeScript tree by absolute
// path, so this oracle can live outside that repository without a fragile
// chain of parent directories.
const { evaluatePolicy, sanitizePolicy } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/capability-fabric/src/policy.ts')).href
);

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const out = cases.map((c) => {
  const config = c.sanitize ? sanitizePolicy(c.config) : c.config;
  const { decision, rule, reason } = evaluatePolicy({
    capability: c.capability,
    config,
    granted: c.granted,
    nodeAvailable: c.nodeAvailable ?? null,
    subject: c.subject,
  });
  return { name: c.name, decision, rule, reason };
});

process.stdout.write(JSON.stringify(out, null, 2));
