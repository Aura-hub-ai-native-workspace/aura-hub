/**
 * environment-inventory-check — drives the REAL desktop inventory merge.
 *
 * The desktop has no unit-test runner, and the merge that turns a scan into
 * cards is where duplicate tools, lost paths and inflated counts would
 * appear. This runs `normalizeInventory` — the same pure function the UI
 * calls — over a real backend payload and asserts the properties the screen
 * depends on.
 *
 * Usage:
 *   cd backend && uv run python -c "import json;from aura.environment import \
 *     scan_environment, scan_result_to_dict; \
 *     print(json.dumps(scan_result_to_dict(scan_environment(refresh=True))))" > /tmp/scan.json
 *   SCAN_JSON=/tmp/scan.json npm run check:environment
 */
import { readFileSync } from 'node:fs';
import { applyProbe, createEnvironment } from '@aura/connected-environment';
import { normalizeInventory, useEnvironmentStore } from '../apps/desktop/src/environment/environmentStore';

const payload = JSON.parse(readFileSync(process.env.SCAN_JSON!, 'utf8'));
let nodes = createEnvironment();
nodes = nodes.map((n) => (payload.results[n.id] ? applyProbe(n, payload.results[n.id]) : n));

const inv = normalizeInventory({
  nodes,
  discovered: payload.discovered ?? [],
  packages: payload.packages ?? [],
  notInstalled: payload.notInstalled ?? [],
  osPackages: payload.osPackages ?? [],
  discoveryMeta: payload.discovery ?? null,
  packageSources: payload.packageSources ?? [],
  osInventory: payload.osInventory ?? null,
});

console.log('counts:', JSON.stringify(inv.counts));
console.log('meta.discovery:', JSON.stringify(inv.meta.discovery && {
  total: inv.meta.discovery.totalCandidates, scanned: inv.meta.discovery.scannedCandidates,
  truncated: inv.meta.discovery.truncated }));
console.log('\nVERIFIED (' + inv.verified.length + '):');
for (const i of inv.verified)
  console.log(`  ${i.name.padEnd(24)} ${String(i.version).padEnd(14)} ${(i.origin ?? '-').padEnd(11)} aliases=[${i.aliases}] ${i.executable ?? '(no path)'}`);
console.log('\nUNVERIFIED (' + inv.unverified.length + '), first 8:');
for (const i of inv.unverified.slice(0, 8))
  console.log(`  ${i.name.padEnd(24)} unexecuted=${i.unexecuted} ${i.executable ?? ''}`);
console.log('\npackageOnly (' + inv.packageOnly.length + '):', inv.packageOnly.map((p) => p.name).join(', '));

// ---- assertions the UI depends on ----
let bad = 0;
const fail = (m: string) => { console.log('  FAIL ' + m); bad++; };
const ok = (m: string) => console.log('  ok   ' + m);

const paths = new Map<string, string>();
const pkgs = new Map<string, string>();
for (const i of [...inv.verified, ...inv.unverified]) {
  if (i.realPath) {
    if (paths.has(i.realPath)) fail(`duplicate card for ${i.realPath}: ${paths.get(i.realPath)} & ${i.name}`);
    paths.set(i.realPath, i.name);
  }
  if (i.manager && i.packageId) {
    const k = `${i.manager}/${i.packageId}`;
    if (pkgs.has(k)) fail(`duplicate card for package ${k}: ${pkgs.get(k)} & ${i.name}`);
    pkgs.set(k, i.name);
  }
}
if (!bad) ok('no duplicate logical tools');

const hub = inv.verified.filter((i) => i.category === 'hub');
hub.length ? fail(`hub nodes leaked into inventory: ${hub.map((h) => h.name)}`) : ok('AURA internal nodes excluded');

const noPath = inv.verified.filter((i) => !i.executable && i.catalogId);
noPath.length ? fail(`catalog tools with no path evidence: ${noPath.map((n) => n.name)}`) : ok('every catalog tool carries its resolved path');

const ranWithoutProvenance = inv.unverified.filter((i) => !i.unexecuted && i.origin === 'unknown');
ranWithoutProvenance.length ? fail(`ran without provenance: ${ranWithoutProvenance.map((i) => i.name)}`) : ok('nothing unowned was executed');

// A package/executable disagreement must reach the card, not be resolved away.
const conflicts = [...inv.verified, ...inv.unverified].filter((i) => i.versionConflict);
for (const item of conflicts) {
  if (!item.packageVersion) fail(`${item.name} claims a version conflict with nothing to compare`);
  if (item.packageVersion === item.version) fail(`${item.name} flags a conflict with identical versions`);
}
ok(`version disagreements surfaced (${conflicts.length}: ${conflicts.map((c) => c.name).join(', ') || 'none'})`);

// One command name, one card: a shadowed copy is evidence, never a rival.
const byName = new Map<string, string>();
for (const item of [...inv.verified, ...inv.unverified]) {
  const seen = byName.get(item.name);
  if (seen) fail(`two cards share the command name ${item.name} (${seen}, ${item.executable})`);
  byName.set(item.name, item.executable ?? '(no path)');
}
ok(`no two cards share a command name (${byName.size} names)`);

// Nothing the backend refused to run may look usable.
const wronglyVerified = inv.verified.filter((i) => i.unexecuted && i.origin === 'unknown');
wronglyVerified.length
  ? fail(`unexecuted tools shown as verified: ${wronglyVerified.map((i) => i.name)}`)
  : ok('nothing unrun is presented as verified');

// ---- a failed scan must not restamp the clock (ENV-022) ----
const store = useEnvironmentStore;
store.setState({ lastScanAt: '2020-01-01T00:00:00.000Z', discovered: payload.discovered ?? [] });
const before = store.getState().lastScanAt;
const discoveredBefore = store.getState().discovered.length;

globalThis.fetch = (async () => {
  throw new Error('the local service is not answering');
}) as typeof fetch;
await store.getState().scan(true);

const after = store.getState();
after.lastScanAt === before
  ? ok('a failed scan leaves "last measured" untouched')
  : fail(`a failed scan restamped lastScanAt: ${before} -> ${after.lastScanAt}`);
after.scanError
  ? ok('a failed scan reports why nothing was measured')
  : fail('a failed scan reported no error');
after.discovered.length === discoveredBefore
  ? ok('the last known inventory is kept rather than blanked')
  : fail('a failed scan discarded the last known inventory');

console.log(bad ? `\n${bad} FAILURES` : '\nall frontend inventory assertions passed');
process.exit(bad ? 1 : 0);
