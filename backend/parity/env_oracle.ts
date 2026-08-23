/**
 * Environment oracle — the REAL TypeScript catalogue and scanner.
 *
 * Dumps the catalogue as data, and runs the real `scanEnvironment` against
 * THIS machine, so the Python port can be diffed against what the
 * reference actually reports about the same tools.
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <mode>
 *   mode = catalog | scan | probe:<id> | connectable
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.argv[2];
const mode = process.argv[3] ?? 'catalog';
if (!repoRoot) {
  console.error('usage: run-ts.mjs env_oracle.ts <repo-root> <mode>');
  process.exit(1);
}

const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { CATALOG, CATEGORY_LABELS, catalogEntry, isConnectable, entriesProviding } =
  await load('packages/connected-environment/src/catalog.ts');
const { CAPABILITIES } = await load('packages/connected-environment/src/capabilities.ts');
const { AGENTS } = await load('packages/connected-environment/src/agents.ts');

if (mode === 'catalog') {
  process.stdout.write(JSON.stringify({ CATALOG, CATEGORY_LABELS, CAPABILITIES, AGENTS }, null, 2));
} else if (mode === 'connectable') {
  // Every catalogue answer that is a pure function of the entry.
  const out = CATALOG.map((e) => ({
    id: e.id,
    connectable: isConnectable(e),
    providing: e.capabilities.map((c) => entriesProviding(c).map((x) => x.id)),
    lookedUp: catalogEntry(e.id)?.id ?? null,
  }));
  process.stdout.write(JSON.stringify(out, null, 2));
} else if (mode === 'scan') {
  const { scanEnvironment } = await load('packages/ai-service/src/environment.ts');
  const scan = await scanEnvironment(undefined, true);
  // `latencyMs` is wall-clock and cannot match; everything else must.
  const results = {};
  for (const [id, r] of Object.entries(scan.results)) {
    results[id] = { present: r.present, version: r.version ?? null, detail: r.detail };
  }
  process.stdout.write(JSON.stringify({ results, found: scan.found }, null, 2));
} else if (mode.startsWith('probe:')) {
  const { probeNode } = await load('packages/ai-service/src/environment.ts');
  const r = await probeNode(mode.slice('probe:'.length), true);
  process.stdout.write(JSON.stringify({ present: r.present, version: r.version ?? null, detail: r.detail }, null, 2));
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(1);
}
