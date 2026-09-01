/**
 * approval-binding-verify — an approval authorises an ACT, not a VERB.
 * ==================================================================
 * The audit of 2026-08-20 proved a confused deputy in the approval
 * system and wrote a file to disk to show it. In its words:
 *
 *     the human was shown: "command=node --version"
 *     UNSAFE E1 — outcome=succeeded sideEffect=true
 *     !! the substituted command REALLY RAN and wrote a file
 *     the human never approved
 *
 * `approvalKey()` identifies a question as `mission:task:capability` or
 * `inv:<id>`. Neither that key nor the stored `ApprovalRequest` kept any
 * trace of the input, so the resume path could only ask "is this the
 * same capability?". Answer yes, and a grant issued for `node --version`
 * was spendable on anything `terminal.execute` can do — which is
 * anything the user can do.
 *
 * Nothing here is a race. The grant is used ONCE, by the caller it was
 * issued to, for the capability it named. Single-use was never the
 * property under attack, which is why every replay and reuse probe in
 * the audit passed while this one did not.
 *
 * This suite reproduces both halves and requires them to be refused:
 *
 *   E1  the RESUME path      — `context.resumeApprovalId`
 *   E2  the MISSION path     — `mission:task:capability`, which holds
 *                              across input changes, so fixing only E1
 *                              would have fixed nothing
 *
 * Every refusal is paired with a control proving the grant still works
 * for the action it was actually given for. A gate that refuses
 * everything is not a gate, and "the substitution was refused" means
 * nothing if the original was refused too.
 *
 * Self-hosting: builds its own Fabric in-process with a disposable
 * AURA_HOME. It never talks to a running AURA.
 *
 * Usage:  node scripts/approval-binding-verify.mjs
 */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(path.join(tmpdir(), 'aura-approval-binding-'));
process.env.AURA_HOME = HOME;

const pkg = (p) => pathToFileURL(path.join(ROOT, 'packages', p)).href;
const { CapabilityFabric, DEFAULT_POLICY, actionFingerprint, canonicalJson, sha256Hex } =
  await import(pkg('capability-fabric/src/index.ts'));

let failed = false;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const control = (name, fired, whenQuiet = '') =>
  check(`[negative control] ${name}`, fired, fired ? 'detector fired, as it must' : `detector stayed quiet — ${whenQuiet}`);

/* ══════════════════════════════════════════════════════════════════
   1. The digest is the real one
   ══════════════════════════════════════════════════════════════════
   `inputBinding.ts` implements SHA-256 rather than importing
   `node:crypto`, so that `@aura/capability-fabric` keeps the property it
   has today of importing nothing from `node:`. A hand-written digest is
   only defensible with a test against the reference implementation, so
   here is that test — including the block boundaries at 55/56/63/64/65
   bytes, where a padding bug hides, and non-ASCII, where a byte-length
   bug hides. */

const VECTORS = [
  '', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65),
  'a'.repeat(1000), 'héllo wörld — ünïcode', '日本語のテキスト',
  JSON.stringify({ command: 'node --version' }),
];
const mismatches = VECTORS.filter((v) => sha256Hex(v) !== createHash('sha256').update(v, 'utf8').digest('hex'));
check('1a  the in-package SHA-256 matches node:crypto on every vector',
  mismatches.length === 0,
  mismatches.length ? `${mismatches.length} mismatch(es), first at length ${mismatches[0].length}` : `${VECTORS.length} vectors`);

control('the digest comparison would notice a wrong hash',
  sha256Hex('abc') !== createHash('sha256').update('abd', 'utf8').digest('hex'),
  '1a would pass against any string at all');

check('1b  canonical JSON is key-order independent',
  canonicalJson({ b: 2, a: 1 }) === canonicalJson({ a: 1, b: 2 }));
check('1c  canonical JSON preserves array order, because order is meaning there',
  canonicalJson(['add', '.']) !== canonicalJson(['.', 'add']));
check('1d  a changed input changes the fingerprint',
  actionFingerprint('terminal.execute', { command: 'node --version' })
  !== actionFingerprint('terminal.execute', { command: 'rm -rf /' }));
check('1e  the same action fingerprints identically, so a re-run reuses its question',
  actionFingerprint('terminal.execute', { command: 'node --version' })
  === actionFingerprint('terminal.execute', { command: 'node --version' }));
check('1f  the capability id is inside the fingerprint too',
  actionFingerprint('filesystem.write', { path: 'x' }) !== actionFingerprint('filesystem.read', { path: 'x' }));

/* This is the old rule, written out. It is here so the reason for the
   fix is visible rather than asserted: under a capability-only match,
   the benign command and the substituted one are the SAME key. */
const oldRule = (capabilityId) => capabilityId;
check('1g  the OLD rule could not tell the two commands apart',
  oldRule('terminal.execute') === oldRule('terminal.execute'),
  'capability-only matching is why E1 was possible');

/* ══════════════════════════════════════════════════════════════════
   2. A Fabric with a canary, and no host that says yes
   ══════════════════════════════════════════════════════════════════ */

const SAFE = { command: 'node --version' };
const SUBSTITUTED = { command: "node -e \"require('fs').writeFileSync(process.env.CANARY_FILE,'pwned')\"" };
const CANARY_FILE = path.join(HOME, 'substituted-command-ran.txt');
process.env.CANARY_FILE = CANARY_FILE;

let ran = [];
const makeFabric = () => {
  const fabric = new CapabilityFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'bash', name: 'bash', capabilities: ['shell'] } }),
    /* The host never grants inline. Every grant in this suite goes
       through `decideApproval`, which is the path a human uses. */
    requestApproval: async () => false,
  });
  fabric.setPolicy({ ...DEFAULT_POLICY, byRisk: { ...DEFAULT_POLICY.byRisk, medium: 'ask-user' } });
  fabric.register({
    capabilityId: 'terminal.execute',
    run: async (invocation) => {
      ran.push(invocation.input.command);
      /* A REAL side effect, so "it was refused" cannot be confused with
         "it ran and did nothing". This is the audit's own method. */
      if (String(invocation.input.command).includes('writeFileSync')) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(CANARY_FILE, 'pwned');
      }
      return { ok: true, detail: 'the canary ran', effectStarted: true };
    },
  });
  return fabric;
};

const user = { actor: { kind: 'user', id: 'verify' }, projectId: null };

/* ══════════════════════════════════════════════════════════════════
   3. E1 — the resume path
   ══════════════════════════════════════════════════════════════════ */

{
  const fabric = makeFabric();
  ran = [];

  const parked = await fabric.invoke('terminal.execute', SAFE, user);
  check('3a  a gated action parks and does not run',
    parked.outcome === 'awaiting-approval' && ran.length === 0,
    `${parked.outcome}, executor calls: ${ran.length}`);

  const request = fabric.pendingApprovals()[0];
  check('3b  the human is shown the command they are approving',
    Boolean(request) && request.items[0].detail.includes('node --version'),
    request?.items?.[0]?.detail);

  fabric.decideApproval(request.id, true, 'the-human');

  /* THE ATTACK. Same grant id, different command. */
  const substituted = await fabric.invoke(
    'terminal.execute', SUBSTITUTED, { ...user, resumeApprovalId: request.id },
  );
  check('3c  E1 — the grant cannot be spent on a command the human never saw',
    substituted.outcome !== 'succeeded' && !ran.includes(SUBSTITUTED.command),
    `outcome=${substituted.outcome}, executor calls: ${JSON.stringify(ran)}`);
  check('3d  E1 — and nothing reached the disk',
    !existsSync(CANARY_FILE),
    existsSync(CANARY_FILE) ? 'THE SUBSTITUTED COMMAND REALLY RAN' : 'no side effect');

  /* Control: the same grant, spent on what it was actually given for,
     must still work — otherwise 3c passes because grants never work. */
  const honest = await fabric.invoke('terminal.execute', SAFE, { ...user, resumeApprovalId: request.id });
  control('the same grant IS spendable on the action it was given for',
    honest.outcome === 'succeeded' && ran.includes(SAFE.command),
    `outcome=${honest.outcome} — 3c would be vacuous, the gate refuses everything`);
}

/* ══════════════════════════════════════════════════════════════════
   4. E2 — the mission path
   ══════════════════════════════════════════════════════════════════
   The mission key is `mission:task:capability`. It holds across input
   changes and needs no `resumeApprovalId` at all, so it is a second,
   independent route to the same substitution. The audit found both. */

{
  const fabric = makeFabric();
  ran = [];
  try { rmSync(CANARY_FILE, { force: true }); } catch { /* not there */ }
  const mission = { ...user, missionId: 'm-1', taskId: 't-1' };

  const parked = await fabric.invoke('terminal.execute', SAFE, mission);
  check('4a  a mission-gated action parks',
    parked.outcome === 'awaiting-approval' && ran.length === 0, parked.outcome);

  const request = fabric.pendingApprovals()[0];
  fabric.decideApproval(request.id, true, 'the-human');

  /* THE ATTACK, with no approval id presented at all — the mission key
     alone used to be enough. */
  const substituted = await fabric.invoke('terminal.execute', SUBSTITUTED, mission);
  check('4b  E2 — the mission-keyed grant cannot be spent on a different command',
    substituted.outcome !== 'succeeded' && !ran.includes(SUBSTITUTED.command),
    `outcome=${substituted.outcome}, executor calls: ${JSON.stringify(ran)}`);
  check('4c  E2 — and nothing reached the disk',
    !existsSync(CANARY_FILE),
    existsSync(CANARY_FILE) ? 'THE SUBSTITUTED COMMAND REALLY RAN' : 'no side effect');

  const raised = fabric.pendingApprovals().some((r) => r.items[0].detail.includes('writeFileSync'));
  check('4d  the changed action asks its own question instead of borrowing one',
    raised,
    raised ? 'a new question was raised for the substituted command' : 'no superseding question was raised');
}

/* ══════════════════════════════════════════════════════════════════
   5. What must NOT have changed
   ══════════════════════════════════════════════════════════════════
   Binding the grant to the input must not break the behaviour the key
   exists for: pressing Run three times on a gated task is one question
   asked three times, not three questions. */

{
  const fabric = makeFabric();
  ran = [];
  const mission = { ...user, missionId: 'm-2', taskId: 't-2' };

  await fabric.invoke('terminal.execute', SAFE, mission);
  await fabric.invoke('terminal.execute', SAFE, mission);
  await fabric.invoke('terminal.execute', SAFE, mission);
  check('5a  three attempts at the SAME action raise exactly one question',
    fabric.pendingApprovals().length === 1,
    `${fabric.pendingApprovals().length} pending`);

  const request = fabric.pendingApprovals()[0];
  fabric.decideApproval(request.id, true, 'the-human');
  const first = await fabric.invoke('terminal.execute', SAFE, mission);
  check('5b  the grant is spent once and the action runs',
    first.outcome === 'succeeded', first.outcome);

  const second = await fabric.invoke('terminal.execute', SAFE, mission);
  check('5c  single-use survives — the same grant cannot run it twice',
    second.outcome !== 'succeeded', second.outcome);
}

/* ══════════════════════════════════════════════════════════════════
   6. Persistence fails closed on an unbound record
   ══════════════════════════════════════════════════════════════════ */

const { createApprovalStore } = await import(pathToFileURL(path.join(ROOT, 'packages/ai-service/src/fabric/approvalStore.ts')).href);
const store = createApprovalStore();
const unbound = {
  id: 'apr-legacy', state: 'pending', requestedAt: new Date().toISOString(), summary: 'from before the fix',
  items: [{ invocationId: 'inv1', capabilityId: 'terminal.execute', title: 't', detail: 'd', risk: 'medium', irreversible: false }],
};
store.save([unbound]);
check('6a  a pending request with no fingerprint is not restored',
  store.load().length === 0,
  `${store.load().length} restored — an unbindable question would look live`);

control('a properly bound request IS restored',
  store.load.call(store) !== undefined
  && (() => { store.save([{ ...unbound, items: [{ ...unbound.items[0], inputHash: actionFingerprint('terminal.execute', SAFE) }] }]); return store.load().length === 1; })(),
  '6a passes because nothing is ever restored');

/* ── teardown ─────────────────────────────────────────────────────── */

try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (failed) {
  console.log('\nFAILED:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} ${r.extra}`);
}
process.exit(failed ? 1 : 0);
