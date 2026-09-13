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
import { ENVIRONMENT_BASE, environmentClient } from '../apps/desktop/src/environment/environmentClient';

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

// ---- one origin for every /environment route ----
//
// The client used to split these: inventory went to the Python backend and
// scan/probe/install/connect to the Node AI service, which has no install
// route, no connect route and — once its duplicate was removed — no
// inventory either. Anything that quietly reintroduces the split is caught
// here rather than in a user's empty Machine Inventory panel.
{
  const aiBase = (await import('../apps/desktop/src/ai/aiClient')).aiClient.base;
  ENVIRONMENT_BASE !== aiBase
    ? ok(`environment routes target ${ENVIRONMENT_BASE}, not the AI service on ${aiBase}`)
    : fail(`environment routes point at the AI service (${aiBase}), which does not collect machine state`);
  typeof environmentClient.inventory === 'function'
    ? ok('the desktop client exposes the inventory call the panel makes')
    : fail('environmentClient has no inventory()');
}

// ---- the machine inventory, through the real client and store ----
//
// This is the acceptance check for the bug that produced "Machine
// Inventory · 0 installed" on a machine with thousands of packages on it.
// Reading a captured payload from a file cannot catch it: the failure was
// never in the payload, it was that the desktop asked a backend which does
// not collect one. So this drives `environmentClient.inventory()` — the
// same call the panel makes, at the same origin — and then asserts on what
// the store actually holds afterwards.
//
// It is deliberately not skipped when the backend is absent. A machine
// inventory check that passes without a machine inventory is exactly the
// kind of test this repository treats as worse than none.
const store = useEnvironmentStore;
{
  const base = process.env.AURA_ENVIRONMENT_URL ?? 'http://127.0.0.1:4320';
  let reachable = false;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    reachable = health.ok && /"backend"\s*:\s*"python"/.test(await health.text());
  } catch { /* reported below */ }

  if (!reachable) {
    fail(
      `the Python environment backend is not answering on ${base}, so the machine inventory `
      + 'could not be checked. Start it with `npm run environment:api`.',
    );
  } else {
    await store.getState().loadInventory(true);
    const state = store.getState();

    state.inventoryError
      ? fail(`loadInventory reported: ${state.inventoryError}`)
      : ok('the desktop client reached the Python environment backend');

    state.inventoryTotal > 0
      ? ok(`Machine Inventory shows ${state.inventoryTotal} installed`)
      : fail('Machine Inventory would render "0 installed" — the panel\'s original failure');

    state.inventory.length > 0
      ? ok(`${state.inventory.length} records loaded on the first page`)
      : fail('the inventory total is non-zero but no records reached the store');

    const seen = new Set<string>();
    for (const item of state.inventory) {
      if (seen.has(item.id)) fail(`duplicate inventory card ${item.id}`);
      seen.add(item.id);
      if (!item.evidence?.length) fail(`${item.name} reached the UI with no evidence`);
      if (item.verified && !item.executionPerformed) fail(`${item.name} is verified without having been run`);
      if (item.executionPerformed && !item.executionAllowed) fail(`${item.name} was run without being allowed`);
    }
    ok(`no duplicate cards among the loaded records (${seen.size})`);

    // Package managers the machine actually has must reach the UI. Which
    // ones those are is the machine's business, not this script's — the
    // assertion is that SOME package source contributed, not that a
    // particular tool is installed.
    const contributing = state.inventorySources.filter((s) => s.available && s.items > 0);
    contributing.length > 0
      ? ok(`sources contributing: ${contributing.map((s) => `${s.name}(${s.items})`).join(', ')}`)
      : fail('every inventory source reported nothing');

    const unavailable = state.inventorySources.filter((s) => !s.available);
    unavailable.every((s) => s.detail || s.error)
      ? ok(`every unavailable source explains itself (${unavailable.length} of ${state.inventorySources.length})`)
      : fail('an unavailable source gave no reason');

    // Refresh must genuinely re-read, and must not empty the panel.
    const firstReadAt = state.inventoryCollectedAt;
    await store.getState().loadInventory(true);
    const refreshed = store.getState();
    refreshed.inventoryTotal > 0
      ? ok(`refresh kept the inventory populated (${refreshed.inventoryTotal})`)
      : fail('refresh emptied the machine inventory');
    refreshed.inventoryCollectedAt !== firstReadAt
      ? ok('refresh re-read the machine rather than replaying a cache')
      : fail(`refresh returned the same collectedAt (${firstReadAt}) — it did not re-read`);
  }
}

// ---- a failed scan must not restamp the clock (ENV-022) ----
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

// ---- the complete machine inventory ----
const invPath = process.env.MACHINE_INVENTORY_JSON;
if (invPath) {
  const machine = JSON.parse(readFileSync(invPath, 'utf8'));
  console.log(`\nMACHINE INVENTORY: ${machine.total} installed, ${machine.returned} on this page`);
  console.log(`  counts: ${JSON.stringify(machine.counts)}`);

  machine.total >= machine.returned
    ? ok('total is the whole inventory, returned is the page')
    : fail(`returned ${machine.returned} exceeds total ${machine.total}`);

  const ids = new Set<string>();
  for (const item of machine.items) {
    if (ids.has(item.id)) fail(`duplicate inventory id ${item.id}`);
    ids.add(item.id);
    if (!item.installed) fail(`${item.name} is listed but not installed`);
    if (!item.evidence?.length) fail(`${item.name} has no evidence`);
    if (item.verified && !item.executionPerformed) {
      fail(`${item.name} is verified without having been run`);
    }
    if (item.executionPerformed && !item.executionAllowed) {
      fail(`${item.name} was run without being allowed`);
    }
  }
  if (!bad) ok(`every item is installed, evidenced and honestly stated (${ids.size} shown)`);

  const unavailable = machine.sources.filter((s: any) => !s.available);
  unavailable.every((s: any) => s.detail || s.error)
    ? ok(`every unavailable source explains itself (${unavailable.length} of ${machine.sources.length})`)
    : fail('an unavailable source gave no reason');
}

console.log(bad ? `\n${bad} FAILURES` : '\nall frontend inventory assertions passed');
process.exit(bad ? 1 : 0);
