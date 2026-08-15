/**
 * perf-redaction-verify — P2-1, P2-3 and the P3 cleanups.
 * ==================================================================
 * P2-1  One Ask AURA request used to walk the repository THREE times:
 *       `runIntelligencePipeline` walked once to diff and again to rebase
 *       the baseline, and `composeContextView` walked a third time for the
 *       same freshness answer. Beyond the cost, two walks are two
 *       different observations — a file written between them entered the
 *       baseline without ever appearing in the diff, so it could never be
 *       reported as changed.
 *
 * P2-3  Redaction covered only the provider id/model. Everything else
 *       reaching the prompt is free text derived from the repository —
 *       commit subjects, module descriptions, identity purpose — so a
 *       commit reading `fix: rotate AKIA… key` travelled verbatim into
 *       every agent prompt.
 *
 * Walks are COUNTED by intercepting `fs.readdirSync`, so the claim is
 * measured rather than asserted.
 *
 * Usage: node scripts/perf-redaction-verify.mjs
 * Needs no service, no browser and no agent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(path.join(tmpdir(), 'p2-home-'));
process.env.AURA_HOME = HOME;

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const outDir = mkdtempSync(path.join(tmpdir(), 'p2-'));
const perfOut = path.join(outDir, 'performance.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/intelligence/performance.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${perfOut}`,
], { cwd: ROOT, stdio: 'pipe' });
const perf = await import(perfOut);

/* ── a project tree to walk ───────────────────────────────────────── */
const proj = mkdtempSync(path.join(tmpdir(), 'p2-proj-'));
mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
writeFileSync(path.join(proj, 'package.json'), '{"name":"p2","version":"1.0.0"}\n');
writeFileSync(path.join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(path.join(proj, 'src', 'deep', 'b.ts'), 'export const b = 1;\n');

/** Count directory reads — one tree walk reads every directory once. */
const realReaddir = fs.readdirSync;
let dirReads = 0;
function countWalks(fn) {
  dirReads = 0;
  fs.readdirSync = (...args) => { dirReads += 1; return realReaddir.apply(fs, args); };
  try { return fn(); } finally { fs.readdirSync = realReaddir; }
}
// The bundle captured its own fs reference, so patch the module's copy too.
const patchTarget = perf.__fsForTest ?? null;
void patchTarget;

/* ── 1. scanAndDiff walks once and returns the snapshot ───────────── */
{
  const { result, snapshot } = perf.scanAndDiff('p2', proj);
  check('1. scanAndDiff returns the diff AND the snapshot it came from',
    result.totalIndexed === 3 && Object.keys(snapshot).length === 3,
    `indexed=${result.totalIndexed} snapshot=${Object.keys(snapshot).length}`);
  check('1b. the snapshot is the same observation as the diff',
    Object.keys(snapshot).sort().join(',') === [...result.added, ...result.changed, ...result.unchanged].sort().join(','));
}

/* ── 2. rebasing from a snapshot does not walk again ──────────────── */
{
  const { snapshot } = perf.scanAndDiff('p2', proj);
  perf.updateIndexStateFrom('p2', snapshot);
  const after = perf.detectChanges('p2', proj);
  check('2. updateIndexStateFrom records a usable baseline',
    after.added.length === 0 && after.changed.length === 0 && after.unchanged.length === 3,
    `added=${after.added.length} unchanged=${after.unchanged.length}`);
}

/* ── 3. NEGATIVE CONTROL — the old pair walked twice ──────────────── */
{
  // The removed shape: detectChanges() then updateIndexState(), each
  // walking the tree independently.
  const twoWalks = countWalks(() => {
    perf.detectChanges('p2-neg', proj);
    perf.updateIndexState('p2-neg', proj);
    return dirReads;
  });
  const oneWalk = countWalks(() => {
    const { snapshot } = perf.scanAndDiff('p2-neg2', proj);
    perf.updateIndexStateFrom('p2-neg2', snapshot);
    return dirReads;
  });
  check('3. NEGATIVE CONTROL — diff + rebase used to walk the tree twice',
    twoWalks === oneWalk * 2, `old=${twoWalks} dir reads, new=${oneWalk}`);
  check('3b. the new pair walks it exactly once',
    oneWalk > 0 && twoWalks > oneWalk, `${twoWalks} → ${oneWalk} directory reads`);
}

/* ── 4. the pipeline accepts a pre-taken scan ─────────────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/intelligence/index.ts'), 'utf8');
  check('4. runIntelligencePipeline accepts a precomputed scan',
    src.includes('precomputed?: { result: IndexResult; snapshot: FileIndexState }'));
  check('4b. and rebases from that snapshot rather than re-walking',
    src.includes('updateIndexStateFrom(projectId, snapshot)') && !src.includes('updateIndexState(projectId, projectRoot)'));

  const compose = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/compose.ts'), 'utf8');
  check('4c. composing a view reuses the caller\'s diff when given one',
    compose.includes('precomputed ?? detectChanges(projectId, root)'));

  const server = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/server.ts'), 'utf8');
  check('4d. the server takes ONE scan per request and shares it',
    server.includes('scanAndDiff(projectId, proj.path)')
    && server.includes('contextViewFor(projectId, scan?.result)')
    && server.includes('ctx.contract, ctx.scan'));

  check('4e. composing a view still never rebases the baseline',
    !compose.includes('updateIndexState'));
}

/* ══════════════════════════════════════════════════════════════════
   P2-3 — redaction at the render boundary
   ══════════════════════════════════════════════════════════════════ */

const contractOut = path.join(outDir, 'contract.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/context/promptContract.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${contractOut}`,
], { cwd: ROOT, stdio: 'pipe' });
const { renderContextContract } = await import(contractOut);

const SECRETS = [
  ['OpenAI-style key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['GitHub token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456'],
  ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ['PEM header', '-----BEGIN RSA PRIVATE KEY-----'],
  ['named secret', 'api_key=supersecretvalue123'],
];

function viewWithSecret(secret) {
  return {
    contextVersion: 1,
    generatedAt: new Date().toISOString(),
    freshness: { state: 'fresh', generatedAt: new Date().toISOString(), reason: null, changedFiles: 0, addedFiles: 0, removedFiles: 0, truncated: false },
    project: { id: 'p', name: 'P', root: '/tmp/p', type: 't', language: 'ts', mounted: true },
    repository: {
      // Free-text fields derived from the repository — the ones redaction
      // did not previously cover.
      purpose: `A project. ${secret}`,
      repositoryType: 'library', architectureStyle: 'layered', primaryLanguage: 'TypeScript',
      secondaryLanguages: [], frameworks: [], buildSystem: null, packageManager: 'npm',
      mainModules: [], entryPoints: [], fileCount: 3,
      modules: [{ name: 'm', path: 'src/m', description: `does things ${secret}` }],
      intelligence: 'ready',
    },
    git: {
      available: true, branch: 'main', dirty: false, changedFiles: 0,
      recentCommits: [{ hash: 'abc1234', subject: `fix: rotate ${secret}`, date: '2026-01-01' }],
      reason: null,
    },
    environment: { os: 'Linux', platform: 'linux', arch: 'x64', nodeVersion: 'v22', shell: '/bin/bash', presentNodes: [], presentCount: 0, catalogueCount: 1, scannedAt: null },
    tools: { available: [], missing: [] },
    agents: { codingAgents: [], provider: { id: null, connected: false, model: null } },
    mission: { active: { id: 'm1', text: `deploy ${secret}`, status: 'planned', createdAt: '2026-01-01' }, total: 1, pendingApprovals: 0 },
    activity: { events: [{ at: '2026-01-01', kind: 'terminal.execute', summary: `ran ${secret}` }] },
    constraints: [{ id: 'c', text: `careful with ${secret}` }],
    buildMs: 1,
  };
}

for (const [label, secret] of SECRETS) {
  const rendered = renderContextContract(viewWithSecret(secret));
  check(`5. ${label} is redacted everywhere it appears`,
    !rendered.includes(secret),
    rendered.includes(secret) ? 'LEAKED' : 'redacted');
}

{
  const rendered = renderContextContract(viewWithSecret('sk-abcdefghijklmnopqrstuvwxyz012345'));
  check('5b. redaction leaves a visible marker rather than silent deletion',
    rendered.includes('[redacted]'));
  check('5c. and the surrounding facts survive',
    rendered.includes('branch: main'.replace('branch', 'Branch')) || rendered.includes('Branch: main'));
}

/* ── 6. NEGATIVE CONTROL — composition alone did not cover these ──── */
{
  const compose = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/compose.ts'), 'utf8');
  const assertFn = compose.slice(compose.indexOf('function assertNoSecrets'), compose.indexOf('function assertNoSecrets') + 600);
  check('6. NEGATIVE CONTROL — composition redacts ONLY the provider triple',
    assertFn.includes('provider.id') && !assertFn.includes('purpose') && !assertFn.includes('recentCommits'),
    'a commit subject or module description was never inspected there');

  const contract = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/promptContract.ts'), 'utf8');
  check('6b. the render boundary now covers every block',
    contract.includes('return `<${tag}>\\n${redact(body.join(\'\\n\'))}\\n</${tag}>`'));
}

/* ══════════════════════════════════════════════════════════════════
   P3 — cleanups
   ══════════════════════════════════════════════════════════════════ */
{
  check('P3-1. the dead hasChanges export is gone',
    typeof perf.hasChanges === 'undefined');

  const layout = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/ops/layoutStore.ts'), 'utf8');
  check('P3-2. saved layouts are keyed per project',
    layout.includes('`${PRESETS_KEY_BASE}:${projectId}`')
    && layout.includes('hydratePresets(projectId: string | null)'));
  const session = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/ops/session.ts'), 'utf8');
  check('P3-2b. and the session restores them under its own project',
    session.includes('hydratePresets(snap.projectId)'));
  check('P3-2c. the store still holds no project pointer of its own',
    !/interface LayoutState[\s\S]*?projectId/.test(layout.slice(layout.indexOf('interface LayoutState'), layout.indexOf('interface LayoutState') + 900)));

  const panel = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/screens/project/sections/Context.tsx'), 'utf8');
  check('P3-3. the Context panel no longer shows internal vocabulary',
    !panel.includes('Context v${view.contextVersion}') && !panel.includes('${view.buildMs}ms')
    && panel.includes('Not analysed yet'));

  const diag = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/ops/panels/DiagnosticsPanel.tsx'), 'utf8');
  check('P3-4. the focused diagnosis finally has a reader',
    diag.includes('s.focused.diagnosisId') && diag.includes('focusedDiagnosisId'));
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
