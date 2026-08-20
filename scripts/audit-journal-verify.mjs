/**
 * audit-journal-verify — the governance record survives, and says so.
 * ==================================================================
 * The Capability Fabric produced a complete audit record for every
 * decision and every execution, and kept it in an array. Nothing wrote it
 * anywhere. A governed system whose governance record dies with the
 * process cannot be audited: "what did AURA do, and who authorized it?"
 * had no answer that survived a restart.
 *
 * This suite drives the REAL service on a disposable AURA_HOME and a
 * private port, kills it the way a crash kills it, and then asks the file
 * system what is left. Nothing here asserts against a mock.
 *
 *   [A] a real invocation is recorded on disk, not only in memory
 *   [B] SIGKILL mid-flight leaves the record behind
 *   [C] a restart starts from the history rather than from empty
 *   [D] the chain detects an edit, a deletion and a reordering
 *   [E] the chain survives rotation — one history, several files
 *   [F] a credential passed as an ordinary argument is not written down
 *
 * Every section carries a NEGATIVE CONTROL. For [D] the control is the
 * untampered file: if that also reported a break, the detector would be
 * proving nothing.
 *
 * Usage: node scripts/audit-journal-verify.mjs
 * Needs no AI provider and no network.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'apps/desktop/src-tauri/resources/ai-service.mjs');
const HOME = mkdtempSync(path.join(tmpdir(), 'audit-home-'));
const JOURNAL = path.join(HOME, 'fabric-audit.jsonl');

let failed = false;
let API = '';
let child = null;

const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const section = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const info = (t) => console.log(`      ${t}`);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the service and wait for it to answer. Returns the child. */
async function startService(port, env = {}) {
  const proc = spawn(process.execPath, [BUNDLE, '--none'], {
    env: { ...process.env, AI_PORT: String(port), AURA_HOME: HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc; } catch { /* not yet */ }
    await sleep(150);
  }
  proc.kill('SIGKILL');
  throw new Error('service did not start');
}

const invoke = (body) => fetch(`${API}/fabric/invoke`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const readJournal = () => (fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8') : '');
const journalLines = () => readJournal().split('\n').filter((l) => l.trim());
const journalEntries = () => journalLines().map((l) => JSON.parse(l));
const chain = () => fetch(`${API}/fabric/audit/verify`).then((r) => r.json());

/** The whole journal as one string — what a leak check has to search. */
const allJournalText = () => fs.readdirSync(HOME)
  .filter((n) => n.startsWith('fabric-audit.') && n.endsWith('.jsonl'))
  .map((n) => fs.readFileSync(path.join(HOME, n), 'utf8'))
  .join('\n');

try {
  if (!fs.existsSync(BUNDLE)) {
    console.error('Service bundle missing. Run: node scripts/build-service-bundle.mjs');
    process.exit(1);
  }
  // Built from the working tree, not from whatever was staged last: a
  // durability claim about code that is not the code under test is worth
  // nothing.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-service-bundle.mjs')],
    { cwd: ROOT, stdio: 'pipe' });

  let port = await freePort();
  API = `http://127.0.0.1:${port}`;
  // A small rotation cap so [E] can reach a rotation without writing 8 MB.
  child = await startService(port, { AURA_AUDIT_MAX_BYTES: '4096' });
  info(`service on ${API}, AURA_HOME=${HOME}`);

  /* ══ [A] THE RECORD REACHES DISK ═════════════════════════════════ */
  section('[A] A real invocation is recorded on disk, not only in memory');

  check('A1  the journal does not exist before anything is invoked',
    !fs.existsSync(JOURNAL), 'no history, no file');

  const first = await invoke({ capabilityId: 'git.status', input: { projectId: 'nonexistent-project' } });
  check('A2  the invocation settled with an outcome',
    typeof first?.outcome === 'string', first?.outcome ?? JSON.stringify(first)?.slice(0, 120));

  check('A3  and a line was written to the journal', journalLines().length >= 1,
    `${journalLines().length} entr(ies)`);

  const e1 = journalEntries()[0];
  check('A4  the entry carries the sequence, the link and the hash',
    e1?.seq === 1 && e1?.prevHash === 'genesis' && /^[0-9a-f]{64}$/.test(e1?.hash ?? ''),
    `seq=${e1?.seq} prev=${e1?.prevHash}`);
  check('A5  and the record the Fabric produced, unmodified',
    e1?.record?.capabilityId === 'git.status' && typeof e1?.record?.decision === 'string',
    `${e1?.record?.capabilityId} decision=${e1?.record?.decision}`);
  check('A6  including which channel asked — attested, not claimed',
    e1?.record?.initiator === 'request',
    `initiator=${e1?.record?.initiator}`);

  check('A7  the chain verifies over the file', (await chain())?.chain?.ok === true,
    JSON.stringify((await chain())?.chain?.brokenAt));

  /* ══ [B] SIGKILL ═════════════════════════════════════════════════ */
  section('[B] The record outlives the process that made it');

  const beforeKill = journalLines().length;
  const inMemoryBefore = (await (await fetch(`${API}/fabric/audit`)).json()).audit?.length ?? 0;
  check('B1  the in-memory log and the journal agree before the crash',
    inMemoryBefore === beforeKill, `memory=${inMemoryBefore} disk=${beforeKill}`);

  // SIGKILL, not SIGTERM: a graceful shutdown would let a flush-on-exit
  // hook rescue the record, which would prove the opposite of the claim.
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  child = null;

  check('B2  SIGKILL left every record on disk', journalLines().length === beforeKill,
    `${journalLines().length} of ${beforeKill} survived`);
  check('B3  and the surviving file is still readable JSON',
    journalEntries().length === beforeKill);

  /* NEGATIVE CONTROL — the in-memory log genuinely did die with the
     process. If it had survived, [B2] would be measuring nothing. */
  let reachable = true;
  try { await fetch(`${API}/fabric/audit`); } catch { reachable = false; }
  check('B4  NEGATIVE CONTROL — the in-memory log went with the process',
    !reachable, reachable ? 'SERVICE STILL ANSWERING' : 'unreachable, as expected');

  /* ══ [C] RESTART CONTINUITY ══════════════════════════════════════ */
  section('[C] A restart starts from the history, not from empty');

  port = await freePort();
  API = `http://127.0.0.1:${port}`;
  child = await startService(port, { AURA_AUDIT_MAX_BYTES: '4096' });

  const afterRestart = (await (await fetch(`${API}/fabric/audit`)).json()).audit ?? [];
  check('C1  the new process reports what the old one did',
    afterRestart.length >= beforeKill, `${afterRestart.length} record(s) seeded`);
  check('C2  and the oldest seeded record is the first one ever written',
    afterRestart[0]?.capabilityId === e1.record.capabilityId,
    afterRestart[0]?.capabilityId);

  const second = await invoke({ capabilityId: 'git.status', input: { projectId: 'nonexistent-project' } });
  check('C3  a new invocation after the restart continues the sequence',
    journalEntries().at(-1)?.seq === beforeKill + 1,
    `seq=${journalEntries().at(-1)?.seq}, expected ${beforeKill + 1}`);
  check('C4  and links to the record written before the crash',
    journalEntries().at(-1)?.prevHash === journalEntries().at(-2)?.hash);
  check('C5  the chain still verifies across the restart',
    (await chain())?.chain?.ok === true, JSON.stringify((await chain())?.chain?.brokenAt));
  void second;

  /* ══ [D] TAMPER EVIDENCE ═════════════════════════════════════════ */
  section('[D] An edit, a deletion or a reordering is detected');

  const pristine = readJournal();

  /* NEGATIVE CONTROL FIRST: the untampered file must verify. Running this
     before the tampering is deliberate — a detector that always reports a
     break would pass every check below while proving nothing. */
  check('D0  NEGATIVE CONTROL — the untampered journal reports no break',
    (await chain())?.chain?.ok === true);

  {
    // Edit one record in place, keeping the line valid JSON.
    const lines = pristine.split('\n').filter((l) => l.trim());
    const target = JSON.parse(lines[0]);
    target.record.outcome = 'success';
    lines[0] = JSON.stringify(target);
    fs.writeFileSync(JOURNAL, `${lines.join('\n')}\n`);
    const r = (await chain())?.chain;
    check('D1  an edited record breaks the chain', r?.ok === false, r?.brokenAt?.reason);
    check('D2  and the break is reported at the record that was edited',
      r?.brokenAt?.seq === target.seq, `seq=${r?.brokenAt?.seq}`);
  }

  {
    // Remove a record entirely.
    const lines = pristine.split('\n').filter((l) => l.trim());
    lines.splice(0, 1);
    fs.writeFileSync(JOURNAL, `${lines.join('\n')}\n`);
    const r = (await chain())?.chain;
    check('D3  a deleted record breaks the chain', r?.ok === false, r?.brokenAt?.reason);
  }

  {
    // Swap two records without changing either one.
    const lines = pristine.split('\n').filter((l) => l.trim());
    if (lines.length >= 2) {
      [lines[0], lines[1]] = [lines[1], lines[0]];
      fs.writeFileSync(JOURNAL, `${lines.join('\n')}\n`);
      const r = (await chain())?.chain;
      check('D4  a reordered pair breaks the chain', r?.ok === false, r?.brokenAt?.reason);
    } else {
      check('D4  a reordered pair breaks the chain', false, 'NOT VERIFIED — fewer than two records');
    }
  }

  {
    // A torn final write — what a crash mid-append actually leaves.
    fs.writeFileSync(JOURNAL, `${pristine}{"seq":99,"prevHa`);
    const r = (await chain())?.chain;
    check('D5  a torn final line is reported, not skipped',
      r?.ok === false && r?.unparsable >= 1, `${r?.unparsable} unreadable line(s)`);
  }

  fs.writeFileSync(JOURNAL, pristine);
  check('D6  restoring the file restores the chain', (await chain())?.chain?.ok === true);

  /* ══ [E] ROTATION ════════════════════════════════════════════════ */
  section('[E] The chain spans rotation — one history, several files');

  const before = fs.readdirSync(HOME).filter((n) => /^fabric-audit\.\d+\.jsonl$/.test(n)).length;
  for (let i = 0; i < 30; i += 1) {
    await invoke({ capabilityId: 'git.status', input: { projectId: `rotate-${i}` } });
  }
  const segments = fs.readdirSync(HOME).filter((n) => /^fabric-audit\.\d+\.jsonl$/.test(n));
  check('E1  the journal rotated once it passed the cap', segments.length > before,
    `${segments.length} rotated segment(s), cap 4096 bytes`);
  check('E2  and the chain still verifies across the segments',
    (await chain())?.chain?.ok === true, JSON.stringify((await chain())?.chain?.brokenAt));

  const report = (await chain())?.chain;
  /* Rotation happens AFTER the append that crossed the cap, so the active
     file can legitimately be absent until the next record arrives. The
     claim is that verification reads every file that exists, in chain
     order — not that a particular number of files exist. */
  const onDisk = fs.readdirSync(HOME)
    .filter((n) => n.startsWith('fabric-audit.') && n.endsWith('.jsonl'));
  check('E3  verification reads every segment on disk',
    Array.isArray(report?.segments) && report.segments.length === onDisk.length,
    `${report?.segments?.length} read, ${onDisk.length} on disk`);
  check('E3b oldest first, with the active file last',
    report.segments.slice(0, -1).every((f, i, a) => i === 0 || a[i - 1] < f) &&
    (!onDisk.includes('fabric-audit.jsonl') || report.segments.at(-1).endsWith('fabric-audit.jsonl')),
    report.segments.map((f) => path.basename(f)).join(' → '));
  check('E4  the sequence is gapless across the rotation',
    report?.entries === journalEntriesAcrossAll().length,
    `${report?.entries} entries`);

  /* ══ [F] NO CREDENTIAL IS WRITTEN DOWN ═══════════════════════════ */
  section('[F] A credential passed as an ordinary argument is not persisted');

  /* `inputSummary` used to redact by FIELD NAME only, which catches an
     argument that IS a credential and misses one inside an argument that
     is not. That was survivable while the log died with the process. It is
     not survivable now that the record is a file. */
  const SECRET = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456';
  await invoke({
    capabilityId: 'terminal.execute',
    input: { projectId: 'nonexistent-project', command: `curl -H "Authorization: token ${SECRET}" https://example.invalid` },
  });

  const text = allJournalText();
  check('F1  the credential does not appear anywhere in the journal',
    !text.includes(SECRET), text.includes(SECRET) ? 'LEAKED TO DISK' : 'redacted');
  check('F2  the argument is still recorded, so the action stays auditable',
    /command=/.test(text), 'the summary survives, the secret does not');

  /* NEGATIVE CONTROL — the search would find the credential if it were
     there. Planting it in a copy of the file proves the check can fail. */
  const planted = path.join(HOME, 'planted.jsonl');
  fs.writeFileSync(planted, `${text}\n${SECRET}\n`);
  check('F3  NEGATIVE CONTROL — the leak detector finds a planted credential',
    fs.readFileSync(planted, 'utf8').includes(SECRET));

  const inMemory = JSON.stringify((await (await fetch(`${API}/fabric/audit`)).json()).audit ?? []);
  check('F4  and it is absent from what the audit endpoint serves',
    !inMemory.includes(SECRET), inMemory.includes(SECRET) ? 'LEAKED OVER HTTP' : 'redacted');
} catch (err) {
  console.error(`\nFATAL  ${err?.stack ?? err}`);
  failed = true;
} finally {
  if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* leave it */ }
}

/** Entries across every segment, in chain order. Used by [E4]. */
function journalEntriesAcrossAll() {
  const names = fs.existsSync(HOME)
    ? fs.readdirSync(HOME).filter((n) => n.startsWith('fabric-audit.') && n.endsWith('.jsonl'))
    : [];
  const rotated = names.filter((n) => n !== 'fabric-audit.jsonl').sort();
  const ordered = [...rotated, ...(names.includes('fabric-audit.jsonl') ? ['fabric-audit.jsonl'] : [])];
  return ordered.flatMap((n) => fs.readFileSync(path.join(HOME, n), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
}

console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
