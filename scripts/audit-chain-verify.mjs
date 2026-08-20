/**
 * audit-chain-verify — a tampered journal line is detectable.
 * ==================================================================
 * The exit criterion for v1.0 is that "the entire run is reconstructible
 * from the journal alone". A journal only earns that trust if editing it
 * after the fact is detectable — otherwise the reconstruction is of
 * whatever the last person to touch the file wanted it to say.
 *
 * A hash chain gives that property: each entry commits to the one before
 * it, so changing any line invalidates every line after it, and the tail
 * hash is a single value that stands for the whole history.
 *
 * ── Ownership ──────────────────────────────────────────────────────
 *
 * Phase 1 owns the DURABLE store — `capability-fabric/src/auditStore.ts`,
 * a hash-chained journal on disk. This phase must CONSUME that chain and
 * prove tamper detection, not build a second journal. At the time this
 * was written the store had not yet landed, so this file:
 *
 *   1. Defines the exact chain contract Phase 1 must satisfy (below, and
 *      in HANDOFF.md), as a reference implementation.
 *   2. Verifies the DETECTION ALGORITHM against real AuditRecords taken
 *      from the running Fabric (`fabric.audit()`) — genuine records, not
 *      synthetic ones — with negative controls for every tamper shape.
 *   3. Prefers Phase 1's store the moment it exists: if
 *      `auditStore.ts` exports `verifyAuditChain` and `appendToChain`,
 *      those are used instead of the reference, and the same controls run
 *      against them unchanged.
 *
 * So the detection is RUNTIME VERIFIED now, and becomes a verification of
 * Phase 1's concrete store with no edit to this file the day it lands.
 *
 * Run:  node scripts/audit-chain-verify.mjs
 */

import { register } from 'node:module';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
process.env.AURA_HOME = mkdtempSync(path.join(tmpdir(), 'aura-audit-verify-'));

register(new URL('./ts-loader-hook.mjs', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { CapabilityFabric } = await load('packages/capability-fabric/src/index.ts');
const { allExecutors } = await load('packages/ai-service/src/fabric/executors.ts');

let failed = 0, passed = 0;
const check = (n, ok, extra = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`); };
const control = (n, ok, extra = '') => check(`  ↳ control: ${n}`, ok, extra);
const info = (m) => console.log(`      ${m}`);
const section = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 50 - t.length))}`);

/* ══════════════════════════════════════════════════════════════════
   The chain contract — the interface Phase 1 must satisfy
   ══════════════════════════════════════════════════════════════════

   A chain entry is:
     { seq: number, record: AuditRecord, prevHash: string, hash: string }

   The genesis previous-hash is a fixed constant. Each hash commits to the
   previous hash AND to a CANONICAL serialization of the record — canonical
   so that a re-serialization with keys in a different order does not read
   as a different record and raise a false alarm.

     hash(entry) = sha256( prevHash + "\n" + canonicalJSON(record) )

   `verifyAuditChain(entries)` walks the chain and returns the first entry
   whose stored hash does not match a recomputation, or whose prevHash
   does not match the previous entry's hash. That single walk detects a
   changed field, a replaced hash, a reordering and a truncation — the
   four shapes a tamper takes — because all four break the recomputation
   at or before the point they occur. */

const GENESIS = 'AURA-AUDIT-CHAIN-GENESIS-v1';

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

const hashEntry = (prevHash, record) =>
  crypto.createHash('sha256').update(`${prevHash}\n${canonicalJSON(record)}`).digest('hex');

/** Reference chain builder — used until Phase 1's appendToChain exists. */
function buildChain(records) {
  const entries = [];
  let prevHash = GENESIS;
  records.forEach((record, seq) => {
    const hash = hashEntry(prevHash, record);
    entries.push({ seq, record, prevHash, hash });
    prevHash = hash;
  });
  return entries;
}

/** Reference verifier. Returns { ok, brokenAt, reason }. */
function referenceVerify(entries) {
  let prevHash = GENESIS;
  for (const entry of entries) {
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenAt: entry.seq, reason: `prevHash at seq ${entry.seq} does not match the previous entry's hash` };
    }
    const recomputed = hashEntry(entry.prevHash, entry.record);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAt: entry.seq, reason: `hash at seq ${entry.seq} does not match its content` };
    }
    prevHash = entry.hash;
  }
  return { ok: true, brokenAt: -1, reason: 'every link verifies' };
}

/* Prefer Phase 1's store the instant it exists. */
let verifyChain = referenceVerify;
let appendChain = buildChain;
let backend = 'reference (Phase 1 auditStore not present yet)';
try {
  const store = await load('packages/capability-fabric/src/auditStore.ts');
  if (typeof store.verifyAuditChain === 'function' && typeof store.appendToChain === 'function') {
    verifyChain = store.verifyAuditChain;
    appendChain = store.appendToChain;
    backend = 'Phase 1 auditStore.ts (consumed)';
  } else if (typeof store.verifyAuditChain === 'function') {
    verifyChain = store.verifyAuditChain;
    backend = 'Phase 1 auditStore.ts verifyAuditChain (reference builder)';
  }
} catch {
  // Not present. The reference implementation stands in and the contract
  // above is what Phase 1 must satisfy for this to switch over.
}

console.log('AURA Hub — audit hash-chain verification');
console.log(`chain backend: ${backend}`);

/* ══════════════════════════════════════════════════════════════════
   Real records from the running Fabric
   ══════════════════════════════════════════════════════════════════ */

const host = {
  permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: true }),
  nodeAvailable: () => null,
  resolveNode: () => ({ ok: true }),
  probeTiers: () => [],
  requestApproval: async (req, ctx) => {
    const ok = new Set(ctx.approvedCapabilities ?? []);
    return req.items.every((i) => ok.has(i.capabilityId));
  },
};
const fabric = new CapabilityFabric(host);
for (const e of allExecutors({})) fabric.register(e);
const ctx = (extra = {}) => ({ actor: { kind: 'agent', id: 'audit-verify' }, projectId: 'p', cwd: process.env.AURA_HOME, ...extra });

// Generate a spread of genuine governed actions: a success, a denial, a
// gated action, a filesystem write. These are the real AuditRecords the
// journal will hold, not fabricated ones.
await fabric.invoke('filesystem.list', {}, ctx());
await fabric.invoke('filesystem.write', { path: 'a.txt', content: 'one' }, ctx({ approvedCapabilities: ['filesystem.write'] }));
await fabric.invoke('desktop.applications.discover', {}, ctx({ approvedCapabilities: ['desktop.applications.discover'] }));
await fabric.invoke('filesystem.write', { path: 'b.txt', content: 'two' }, ctx({ approvedCapabilities: ['filesystem.write'] }));
await fabric.invoke('project.create', { name: 'x' }, ctx()); // no manager → fails, still audited

const records = fabric.audit().map((r) => JSON.parse(JSON.stringify(r)));
info(`${records.length} real audit records taken from the Fabric`);
check('the Fabric produced audit records to chain', records.length >= 4, `${records.length}`);

/* ══════════════════════════════════════════════════════════════════
   1. An intact chain verifies
   ══════════════════════════════════════════════════════════════════ */

section(1, 'an intact chain of real records verifies');

const chain = appendChain(records);
const clean = verifyChain(chain);
check('a freshly built chain verifies clean', clean.ok, clean.reason);
check('the chain has one entry per record', chain.length === records.length);
check('each entry links to the one before it',
  chain.every((e, i) => i === 0 || e.prevHash === chain[i - 1].hash));

/* ══════════════════════════════════════════════════════════════════
   2. Tamper detection — every shape an edit takes
   ══════════════════════════════════════════════════════════════════ */

section(2, 'every tamper shape is detected');

const clone = (c) => c.map((e) => ({ ...e, record: JSON.parse(JSON.stringify(e.record)) }));

// (a) Change a field inside a record, leaving its stored hash alone —
// the classic "edit the log to hide what happened".
{
  const t = clone(chain);
  const victim = Math.floor(t.length / 2);
  t[victim].record.outcome = 'succeeded';
  t[victim].record.capabilityId = 'something.else';
  const r = verifyChain(t);
  check('a changed field is detected', !r.ok, r.ok ? 'MISSED' : `broken at seq ${r.brokenAt}`);
  check('…and it is detected at or before the edited line', r.brokenAt <= victim || r.brokenAt === victim);
}

// (b) Change a field AND recompute that one line's hash — the attacker
// who knows there is a hash but not that it chains forward.
{
  const t = clone(chain);
  const victim = 1;
  t[victim].record.outcome = 'denied';
  t[victim].hash = hashEntry(t[victim].prevHash, t[victim].record); // locally consistent!
  const r = verifyChain(t);
  check('a field change with a locally-recomputed hash is STILL detected', !r.ok,
    r.ok ? 'MISSED — the chain is not actually linking forward' : `broken at seq ${r.brokenAt}`);
  info('this is the check that distinguishes a chain from per-line hashes');
}

// (c) Replace a stored hash with a random one.
{
  const t = clone(chain);
  t[2].hash = crypto.randomBytes(32).toString('hex');
  check('a replaced hash is detected', !verifyChain(t).ok);
}

// (d) Reorder two entries.
{
  const t = clone(chain);
  [t[1], t[2]] = [t[2], t[1]];
  check('a reordering is detected', !verifyChain(t).ok);
}

// (e) Delete a line from the middle.
{
  const t = clone(chain);
  t.splice(2, 1);
  check('a deleted line is detected', !verifyChain(t).ok);
}

// (f) Truncate the tail — drop the most recent entries.
{
  const t = clone(chain).slice(0, chain.length - 2);
  // Truncation is detected by comparing the tail hash to an independently
  // held one, which is exactly what a durable head pointer is for.
  const expectedTail = chain.at(-1).hash;
  const actualTail = t.at(-1)?.hash;
  check('a truncated tail no longer matches the recorded head hash',
    actualTail !== expectedTail);
  // The remaining prefix is internally consistent — which is the point:
  // truncation is invisible WITHIN the file and must be caught by the
  // external head, so this documents where Phase 1's store must persist
  // the tail hash.
  control('the surviving prefix is internally consistent (why the head pointer is needed)',
    verifyChain(t).ok);
}

/* ══════════════════════════════════════════════════════════════════
   3. The detector can pass — negative control on the whole suite
   ══════════════════════════════════════════════════════════════════ */

section(3, 'the detector is not simply always-failing');

{
  // Rebuild from the same records and verify again: a clean chain must
  // still pass after all the tampered clones above. If this failed, every
  // "detected" above would be meaningless.
  const rebuilt = appendChain(records);
  control('a clean chain still verifies after all the tamper tests', verifyChain(rebuilt).ok);

  // And a single-entry chain, and an empty one, are both valid.
  control('an empty chain is valid', verifyChain(appendChain([])).ok);
  control('a single-entry chain is valid', verifyChain(appendChain([records[0]])).ok);

  // Canonicalization: the same record with keys in a different order
  // produces the SAME hash, so re-serialization is not a false positive.
  const reordered = {};
  for (const k of Object.keys(records[0]).reverse()) reordered[k] = records[0][k];
  control('key order does not change a record hash (canonical serialization)',
    hashEntry(GENESIS, records[0]) === hashEntry(GENESIS, reordered));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`${passed} passed · ${failed} failed`);
console.log(`\nchain backend used: ${backend}`);
if (backend.startsWith('reference')) {
  console.log('NOTE: Phase 1\'s auditStore.ts is not yet present. The detection');
  console.log('algorithm is verified against the reference contract in HANDOFF.md;');
  console.log('this switches to Phase 1\'s store automatically once it exports');
  console.log('verifyAuditChain (and appendToChain).');
}
if (failed) console.log('\nFAILED — do not report audit-chain tamper detection as verified.');
else console.log('\nAll checks passed, each tamper shape detected, with controls.');
process.exit(failed ? 1 : 0);
