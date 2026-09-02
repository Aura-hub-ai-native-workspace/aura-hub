/**
 * lifecycle-isolation-verify — P1-1, P1-2, P1-3.
 * ==================================================================
 * Three defects that share one shape: a late or unreadable answer being
 * applied as if it were the current, readable truth.
 *
 *   P1-1  A stale `open()` response overwrote the newly-opened project.
 *   P1-2  An unreadable projects.json read as "no projects", which pruned
 *         the user's active project and deleted its persisted pointer.
 *   P1-3  "Refresh context" re-indexed whichever project was mounted,
 *         not the one the panel was scoped to.
 *
 * Each part carries a NEGATIVE CONTROL that reproduces the old behaviour
 * beside the new one, so the suite proves the bug rather than only that
 * today passes.
 *
 * Usage:
 *   AURA_HOME=<isolated> node .aura/ai-service.mjs   # service on :4319
 *   node scripts/lifecycle-isolation-verify.mjs
 *
 * Needs no AI provider and no browser.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.HUB_API ?? 'http://127.0.0.1:4319';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/* ══════════════════════════════════════════════════════════════════
   PART A — P1-1  a stale open() response must not win
   ══════════════════════════════════════════════════════════════════
   The REAL `useWorkspace` and the REAL `aiClient` are exercised; only
   `fetch` is stubbed, so the responses land in a controlled order and
   the interleaving is deterministic rather than timing-dependent.
   (esbuild's --alias rejects relative specifiers, so module-level
   stubbing is not available; intercepting fetch is both simpler and a
   truer test, since the client's own parsing runs too.) */

const wsDir = mkdtempSync(path.join(tmpdir(), 'p11-'));
const wsOut = path.join(wsDir, 'useWorkspace.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/apps/desktop/src/data/useWorkspace.ts`,
  '--bundle', '--platform=node', '--format=esm',
  '--define:import.meta.env={}',
  `--outfile=${wsOut}`,
], { cwd: ROOT, stdio: 'pipe' });

/** Deferred promise, so a test decides when a response lands. */
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const openGates = { A: defer(), B: defer(), C: defer() };
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

const openBodyFor = (id) => ({
  project: { id },
  profile: { id, marker: id },
  status: { projectId: id, phase: 'ready' },
});

/* Kept so Part C can talk to the real service again — a stub left
   installed would silently answer its HTTP calls too. */
const realFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
  const u = String(url);
  const openMatch = /\/projects\/([^/]+)\/open/.exec(u);
  if (openMatch) return jsonRes(await openGates[openMatch[1]].promise);
  const memMatch = /\/projects\/([^/]+)\/memory/.exec(u);
  if (memMatch) return jsonRes({ items: [{ id: `m-${memMatch[1]}`, kind: 'note', title: memMatch[1] }] });
  if (u.includes('/index')) return jsonRes({ projectId: null, phase: 'ready' });
  if (u.includes('/graph')) return jsonRes(null);
  return jsonRes({});
};

{
  const { useWorkspace } = await import(wsOut);
  const get = () => useWorkspace.getState();

  /* 1. start open(A)  2. start open(B)  3. resolve B  4. resolve A */
  const pA = get().open('A');
  const pB = get().open('B');
  check('A1. the later open() claims the selection immediately',
    get().openId === 'B', `openId=${get().openId}`);

  openGates.B.resolve(openBodyFor('B'));
  await pB;
  check('A2. B\'s own response is applied',
    get().profile?.marker === 'B', `profile=${get().profile?.marker}`);

  openGates.A.resolve(openBodyFor('A'));
  await pA;

  check('A3. THE DEFECT — A\'s late response does not overwrite B',
    get().openId === 'B' && get().profile?.marker === 'B',
    `openId=${get().openId} profile=${get().profile?.marker}`);
  check('A4. …and A\'s index status does not land either',
    get().status?.projectId === 'B', `status.projectId=${get().status?.projectId}`);
  check('A5. …nor A\'s memory',
    get().memory.length > 0 && get().memory.every((m) => m.title === 'B'),
    JSON.stringify(get().memory));

  /* Normal single-request path still works. */
  const pC = get().open('C');
  openGates.C.resolve(openBodyFor('C'));
  await pC;
  check('A7. the ordinary single-open path still applies its response',
    get().openId === 'C' && get().profile?.marker === 'C',
    `profile=${get().profile?.marker}`);
}

/* NEGATIVE CONTROL — the same interleaving without the guard. */
{
  const state = { openId: null, profile: null };
  const unguardedOpen = async (id, p) => {
    state.openId = id;
    const res = await p;
    state.profile = res.profile;          // no `openId === id` check
  };
  const dA = defer(); const dB = defer();
  const uA = unguardedOpen('A', dA.promise);
  const uB = unguardedOpen('B', dB.promise);
  dB.resolve(openBodyFor('B')); await uB;
  dA.resolve(openBodyFor('A')); await uA;
  check('A6. NEGATIVE CONTROL — without the guard, A DOES overwrite B',
    state.openId === 'B' && state.profile?.marker === 'A',
    `openId=${state.openId} profile=${state.profile?.marker}`);
}

// Part A is done driving the store; everything below talks to the real
// service over the real network.
globalThis.fetch = realFetch;

/* ══════════════════════════════════════════════════════════════════
   PART B — P1-2  corrupt registry ≠ empty registry
   ══════════════════════════════════════════════════════════════════ */

const regOut = path.join(mkdtempSync(path.join(tmpdir(), 'p12-')), 'projects.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/projects.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${regOut}`,
], { cwd: ROOT, stdio: 'pipe' });

/** Load a fresh ProjectRegistry over a given projects.json content. */
async function registryWith(content, tag) {
  const home = mkdtempSync(path.join(tmpdir(), `p12-home-${tag}-`));
  if (content !== null) fs.writeFileSync(path.join(home, 'projects.json'), content);
  process.env.AURA_HOME = home;
  const { ProjectRegistry } = await import(`${regOut}?${tag}`);
  return { reg: new ProjectRegistry(), home };
}

const realProject = JSON.stringify([{
  id: 'kept', name: 'kept', path: '/tmp', type: 'x', language: 'y', icon: 'folder',
  color: '#000', favorite: false, createdAt: new Date().toISOString(), lastOpenedAt: null,
}]);

{
  const { reg } = await registryWith('[]', 'empty');
  check('B1. a VALID EMPTY registry is readable and empty',
    reg.readable === true && reg.list().length === 0);
}
{
  const { reg } = await registryWith(realProject, 'populated');
  check('B2. a VALID POPULATED registry is readable',
    reg.readable === true && reg.list().length === 1, `n=${reg.list().length}`);
}
{
  const { reg } = await registryWith('{ this is not json', 'malformed');
  check('B3. MALFORMED json is reported unreadable, not empty',
    reg.readable === false && typeof reg.readError === 'string', `readError=${reg.readError}`);
  check('B3b. and it reports no projects rather than inventing any',
    reg.list().length === 0);
}
{
  const { reg } = await registryWith(realProject.slice(0, realProject.length - 12), 'truncated');
  check('B4. TRUNCATED json is reported unreadable', reg.readable === false);
}
{
  const { reg } = await registryWith(null, 'missing');
  check('B5. a MISSING file is a first run — readable and empty, not an error',
    reg.readable === true && reg.list().length === 0);
}
{
  const { reg } = await registryWith('{"not":"an array"}', 'wrongshape');
  check('B6. valid json of the wrong shape is unreadable, not empty',
    reg.readable === false, `readError=${reg.readError}`);
}
{
  // Never silently repair or overwrite corrupt data.
  const { reg, home } = await registryWith('{ broken', 'nowrite');
  const before = fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
  let threw = false;
  try { reg.add({ path: home, name: 'x' }); } catch { threw = true; }
  const after = fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
  check('B7. a corrupt registry refuses writes rather than clobbering it', threw === true);
  check('B7b. and the file on disk is untouched', before === after);
}

/* NEGATIVE CONTROL — the old readJsonFile collapse. */
{
  const persistOut = path.join(path.dirname(regOut), 'persist.mjs');
  execFileSync('npx', [
    'esbuild', `${ROOT}/packages/ai-service/src/persist.ts`,
    '--bundle', '--platform=node', '--format=esm', `--outfile=${persistOut}`,
  ], { cwd: ROOT, stdio: 'pipe' });
  const { readJsonFile, readJsonFileResult } = await import(persistOut);

  const home = mkdtempSync(path.join(tmpdir(), 'p12-neg-'));
  const broken = path.join(home, 'projects.json');
  fs.writeFileSync(broken, '{ broken');

  const old = readJsonFile(broken, []);
  const now = readJsonFileResult(broken, []);
  check('B8. NEGATIVE CONTROL — readJsonFile still reports corrupt as EMPTY',
    Array.isArray(old) && old.length === 0,
    'this is the collapse that pruned the active project');
  check('B8b. readJsonFileResult tells them apart', now.status === 'corrupt', `status=${now.status}`);

  const gone = path.join(home, 'absent.json');
  check('B8c. …and still distinguishes a missing file from a corrupt one',
    readJsonFileResult(gone, []).status === 'missing');
}

/* The consumer-side guard: pruning must not run on an unreadable registry. */
{
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/data/useActiveProject.ts'), 'utf8');
  check('B9. the pruning guard respects registry readability',
    src.includes('if (!registryReadable) return;'));
}

/* ══════════════════════════════════════════════════════════════════
   PART C — P1-3  a refresh may only re-index the project it names
   ══════════════════════════════════════════════════════════════════ */

const api = async (p, init) => {
  const r = await fetch(`${API}${p}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

const health = await api('/health');
if (health.status !== 200) {
  console.error(`FATAL  service not answering on ${API}`);
  process.exit(1);
}

function makeProject(label) {
  const root = mkdtempSync(path.join(tmpdir(), `p13-${label}-`));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `{"name":"${label}","version":"1.0.0"}\n`);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), `export const ${label} = 1;\n`);
  return root;
}

const rA = makeProject('alpha');
const rB = makeProject('bravo');
const idA = (await post('/projects', { path: rA, name: 'p13-alpha' })).body?.project?.id;
const idB = (await post('/projects', { path: rB, name: 'p13-bravo' })).body?.project?.id;
if (!idA || !idB) { console.error('FATAL  could not register fixtures'); process.exit(1); }

await post(`/projects/${idB}/open`, {});
const mounted = async () => (await api('/health')).body?.index?.projectId ?? null;

check('C0. project B is mounted and indexed', (await mounted()) === idB, `mounted=${await mounted()}`);

{
  const before = (await api('/health')).body?.index?.finishedAt ?? null;
  const r = await post(`/projects/${idA}/reindex`, {});
  check('C1. THE DEFECT — re-indexing a non-mounted project is refused',
    r.status === 409, `status=${r.status}`);
  check('C1b. the refusal names both projects',
    typeof r.body?.error === 'string' && r.body.error.includes(idA) && r.body.error.includes(idB),
    r.body?.error ?? '');
  const after = (await api('/health')).body?.index?.finishedAt ?? null;
  check('C2. project B was NOT re-indexed as a side effect',
    before === after, `finishedAt ${before} → ${after}`);
  check('C2b. and B is still the mounted project', (await mounted()) === idB);
}

{
  const r = await post(`/projects/${idB}/reindex`, {});
  check('C3. re-indexing the MOUNTED project is allowed',
    r.status === 200 && r.body?.projectId === idB, `status=${r.status} project=${r.body?.projectId}`);
}

{
  const r = await post('/projects/does-not-exist/reindex', {});
  check('C4. an unknown project is a 404, not a silent no-op', r.status === 404, `status=${r.status}`);
}

/* NEGATIVE CONTROL — the generic route still re-indexes whatever is
   mounted, which is exactly why the panel must not use it. */
{
  const before = (await api('/health')).body?.index?.finishedAt ?? null;
  await post('/reindex', {});
  const after = (await api('/health')).body?.index?.finishedAt ?? null;
  check('C5. NEGATIVE CONTROL — the unscoped /reindex acts on the mounted project',
    before !== after,
    'a panel scoped to another project must never call this');

  const panel = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/screens/project/sections/Context.tsx'), 'utf8');
  check('C6. the Context panel uses the project-scoped call',
    panel.includes('aiClient.reindexProject(projectId)') && !panel.includes('await reindex()'));
  check('C6b. and disables refresh when its project is not mounted',
    panel.includes('!view.project.mounted'));
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
