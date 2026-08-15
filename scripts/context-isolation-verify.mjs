/**
 * context-isolation-verify — the two P0 correctness invariants.
 * ==================================================================
 * P0-2  Request-scoped context must not live in singleton mutable state.
 *
 *   `PipelineManager` is one instance shared by every request. The
 *   canonical context used to be written to `this.auraContext` just
 *   before `ask`/`streamEvents`, both of which `await this.inspect(...)`
 *   before reading it. Two overlapping requests interleaved: the second
 *   overwrote the first's context while the first was suspended, and the
 *   first answered about the second's project.
 *
 *   Part A below runs the SAME interleaving against two harnesses — the
 *   real implementation and a faithful re-creation of the old shared
 *   field — and asserts the old one is contaminated while the real one is
 *   not. The negative control is inside the test, so this suite proves
 *   the bug existed and is fixed, rather than only that today passes.
 *
 * P0-1  One request, one project.
 *
 *   Canonical context is composed for the REQUESTED project while
 *   retrieval is hard-scoped to the MOUNTED one. A mismatch would put
 *   two projects in one prompt. Part B asserts the request is refused —
 *   and, just as importantly, that refusing does not quietly mount the
 *   requested project, because mounting is a state change and a read
 *   must never cause one.
 *
 * Usage:
 *   AURA_HOME=<isolated> node .aura/ai-service.mjs   # service on :4319
 *   node scripts/context-isolation-verify.mjs
 *
 * Needs no AI provider.
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
   PART A — P0-2, concurrency, against the real pipeline
   ══════════════════════════════════════════════════════════════════ */

const out = path.join(mkdtempSync(path.join(tmpdir(), 'ctx-iso-')), 'pipeline.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/pipeline.ts`,
  '--bundle', '--platform=node', '--format=esm', '--external:typescript', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

const { PipelineManager } = await import(out);

/** A minimal InspectResult — enough for message assembly, nothing more. */
const fakeMeta = () => ({
  intent: 'project_overview', intentConfidence: 1, enhancedPrompt: '', systemHints: [],
  engines: [], coding: { files: [], chunks: 0, tokens: 0 }, fullstack: { hits: [], paths: [] },
  memory: { items: [], tokens: 0 }, contextTokens: 0, projectId: null,
  identity: null, summary: null, repoProfile: null, glossary: null, health: null,
  assembledContext: { systemMessages: [], totalTokens: 0, confidenceMarks: [], retrievedSources: [] },
});

const CTX_A = '<PROJECT_CONTEXT>\nProject: ALPHA\nRoot: /tmp/alpha\n</PROJECT_CONTEXT>';
const CTX_B = '<PROJECT_CONTEXT>\nProject: BRAVO\nRoot: /tmp/bravo\n</PROJECT_CONTEXT>';

/**
 * The interleaving that reproduced the bug:
 *
 *   A resolves its context ─┐
 *                           ├─ A suspends (the `await inspect` boundary)
 *   B resolves its context ─┘
 *   A consumes  ← reads B's context under the old implementation
 *   B consumes
 */
async function interleave(resolveFor, consumeFor) {
  const aCtx = resolveFor('A', CTX_A);
  const yieldPoint = new Promise((r) => setImmediate(r));   // A suspends here
  const bCtx = resolveFor('B', CTX_B);
  await yieldPoint;
  return { a: consumeFor('A', aCtx), b: consumeFor('B', bCtx) };
}

/* ── A1. the REAL implementation: context travels as a parameter ──── */
{
  const mgr = new PipelineManager();
  // `private` is erased at runtime; this drives the real method.
  const build = (ctx) => mgr.buildContextMessages('question', fakeMeta(), undefined, ctx);

  const { a, b } = await interleave(
    (_who, ctx) => ctx,                    // resolve → returns the request's own contract
    (_who, ctx) => build(ctx),             // consume → passes it down
  );

  const aText = a.messages.map((m) => m.content).join('\n');
  const bText = b.messages.map((m) => m.content).join('\n');

  check('A1. request A carries only A\'s context',
    aText.includes('ALPHA') && !aText.includes('BRAVO'));
  check('A2. request B carries only B\'s context',
    bText.includes('BRAVO') && !bText.includes('ALPHA'));
  check('A3. the pipeline holds no request-scoped context field',
    !Object.prototype.hasOwnProperty.call(mgr, 'auraContext'),
    `own keys: ${Object.keys(mgr).join(', ')}`);
  check('A4. and exposes no setter for it',
    typeof mgr.setAuraContext === 'undefined');
}

/* ── A5. NEGATIVE CONTROL — the old shared field, same interleaving ─ */
{
  // A faithful re-creation of the removed implementation: one field on a
  // shared instance, written at resolve time, read at consume time.
  const legacy = {
    auraContext: null,
    set(ctx) { this.auraContext = ctx; },
    build() { return this.auraContext ?? ''; },
  };

  const { a, b } = await interleave(
    (_who, ctx) => { legacy.set(ctx); return ctx; },
    () => legacy.build(),
  );

  check('A5. NEGATIVE CONTROL — the old shared field DOES contaminate',
    a.includes('BRAVO'),
    a.includes('BRAVO') ? 'request A received B\'s context, as it used to' : `A got: ${a.slice(0, 40)}`);
  check('A6. …and the two requests were genuinely indistinguishable',
    a === b);
}

/* ══════════════════════════════════════════════════════════════════
   PART B — P0-1, one request, one project (over HTTP)
   ══════════════════════════════════════════════════════════════════ */

const api = async (p, init) => {
  const r = await fetch(`${API}${p}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

const health = await api('/health');
if (health.status !== 200) { console.error(`FATAL  service not answering on ${API}`); process.exit(1); }

function makeProject(label) {
  const root = mkdtempSync(path.join(tmpdir(), `aura-iso-${label}-`));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `{"name":"${label}","version":"1.0.0"}\n`);
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), `export const marker${label} = 1;\n`);
  return root;
}

const rootA = makeProject('alpha');
const rootB = makeProject('bravo');
const regA = await post('/projects', { path: rootA, name: 'iso-alpha' });
const regB = await post('/projects', { path: rootB, name: 'iso-bravo' });
const idA = regA.body?.project?.id;
const idB = regB.body?.project?.id;
if (!idA || !idB) { console.error('FATAL  could not register fixtures'); process.exit(1); }

const mountedId = async () => (await api('/health')).body?.project?.id ?? null;

/* Mount B, then ask explicitly about A. */
await post(`/projects/${idB}/open`, {});
const beforeMount = await mountedId();
check('B0. project B is the mounted project', beforeMount === idB, `mounted=${beforeMount}`);

/* ── B1. /ask refuses the mismatch ────────────────────────────────── */
{
  const r = await post('/ask', { text: 'explain this project', projectId: idA });
  check('B1. /ask refuses a request scoped to a non-mounted project',
    r.status === 409, `status=${r.status}`);
  check('B1b. the refusal names both projects, in plain language',
    typeof r.body?.error === 'string' && r.body.error.includes(idA) && r.body.error.includes(idB),
    r.body?.error ?? '(no message)');
  check('B1c. it does not answer with a hybrid',
    !r.body?.meta && !r.body?.ok);
}

/* ── B2. THE INVARIANT — refusing must not mount anything ─────────── */
{
  const after = await mountedId();
  check('B2. the requested project was NOT auto-mounted',
    after === idB, `mounted before=${beforeMount} after=${after}`);
}

/* ── B3. /stream refuses too, through its own error channel ───────── */
{
  const res = await fetch(`${API}/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'explain this project', projectId: idA }),
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim()).filter((d) => d && d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);

  const err = events.find((e) => e.type === 'error');
  check('B3. /stream reports the conflict as a stream error',
    !!err && err.error?.type === 'project_conflict', err ? err.error?.type : '(no error event)');
  check('B3b. no tokens were produced for a conflicted request',
    !events.some((e) => e.type === 'token'));
  check('B3c. still nothing mounted as a side effect',
    (await mountedId()) === idB);
}

/* ── B4. the matching case still works ────────────────────────────── */
{
  const r = await post('/ask', { text: 'explain this project', projectId: idB });
  check('B4. asking about the MOUNTED project is accepted',
    r.status === 200, `status=${r.status}`);
  // No provider in this environment, so the honest outcome is a provider
  // error — what matters is that it was not refused as a conflict.
  check('B4b. and reaches the pipeline rather than the conflict guard',
    r.body?.ok === false && r.body?.error?.type === 'no_provider',
    r.body?.error?.type ?? '(none)');
}

/* ── B5. an unscoped request uses the mounted project ─────────────── */
{
  const r = await post('/ask', { text: 'explain this project' });
  check('B5. a request naming no project is not refused',
    r.status === 200, `status=${r.status}`);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
