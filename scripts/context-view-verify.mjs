/**
 * context-view-verify — the Context Fabric read model.
 * ==================================================================
 * Drives the REAL service over HTTP against REAL temporary projects. The
 * decisive property under test is that a ContextView describes THE PROJECT
 * IT WAS ASKED ABOUT — not the one that happens to be mounted, not the one
 * indexed most recently, and never a blend of two.
 *
 * That is the whole reason the read model exists: before it, each surface
 * answered "which project?" from whichever pointer it had reached for, and
 * two surfaces could disagree. Case 2 is the one that would catch a
 * regression back to that world.
 *
 * Usage:
 *   AURA_HOME=<isolated> node .aura/ai-service.mjs   # service on :4319
 *   node scripts/context-view-verify.mjs
 *
 * Requires no AI provider: nothing here asserts a model response.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const api = async (p, init) => {
  const r = await fetch(`${API}${p}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const contextOf = async (id, q = '') => (await api(`/projects/${id}/context${q}`)).body;

/* ── fixtures: two DISTINCT real projects ─────────────────────────── */

function makeProject(label, marker) {
  const root = mkdtempSync(path.join(tmpdir(), `aura-ctx-${label}-`));
  mkdirSync(path.join(root, 'src', 'deep', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: label, version: '1.0.0', dependencies: { [marker]: '^1.0.0' } }, null, 2));
  writeFileSync(path.join(root, 'README.md'), `# ${label}\n\n${marker} is the distinguishing marker of ${label}.\n`);
  writeFileSync(path.join(root, 'src', 'index.ts'), `export const ${marker} = '${label}';\n`);
  writeFileSync(path.join(root, 'src', 'deep', 'nested', 'buried.ts'), `export const buried = '${label}';\n`);
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', `branch-${label}`]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', `seed ${label}`], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'ctx', GIT_AUTHOR_EMAIL: 'ctx@local', GIT_COMMITTER_NAME: 'ctx', GIT_COMMITTER_EMAIL: 'ctx@local' },
  });
  return root;
}

const health = await api('/health');
if (health.status !== 200) {
  console.error(`FATAL  the AURA service is not answering on ${API}. Start it first.`);
  process.exit(1);
}

const rootA = makeProject('alpha', 'markeralpha');
const rootB = makeProject('bravo', 'markerbravo');

const regA = await post('/projects', { path: rootA, name: 'ctx-alpha' });
const regB = await post('/projects', { path: rootB, name: 'ctx-bravo' });
const idA = regA.body?.project?.id;
const idB = regB.body?.project?.id;
if (!idA || !idB) {
  console.error('FATAL  could not register the fixture projects', JSON.stringify({ regA, regB }).slice(0, 400));
  process.exit(1);
}
console.log(`fixtures: ${idA} @ ${rootA}\n          ${idB} @ ${rootB}\n`);

/* ── 1 + 3. the view describes the project it was asked about ─────── */
{
  const { view } = await contextOf(idA);
  check('1. ContextView is keyed by the requested (canonical) project id',
    view.project.id === idA, `project.id=${view.project.id}`);
  check('3. it represents that project truthfully',
    view.project.root === rootA && view.git.branch === 'branch-alpha',
    `root=${view.project.root} branch=${view.git.branch}`);
  check('3b. git state is real, not assumed',
    view.git.available === true && view.git.dirty === false && view.git.recentCommits.length === 1,
    `dirty=${view.git.dirty} commits=${view.git.recentCommits.length}`);
}

/* ── 2. THE DECISIVE ONE — no competing project pointer ───────────── */
{
  // Mount B, then ask for A. If composition read the MOUNTED project (the
  // pipeline's `currentProjectId`) — or any pointer other than the id it was
  // given — this returns bravo and the read model is not a read model.
  await post(`/projects/${idB}/open`, {});
  const { view } = await contextOf(idA);
  check('2. asking for A while B is MOUNTED still describes A',
    view.project.id === idA && view.project.root === rootA,
    `got ${view.project.id} @ ${view.project.root}`);
  check('2b. and reports honestly that A is not the mounted project',
    view.project.mounted === false, `mounted=${view.project.mounted}`);

  const b = (await contextOf(idB)).view;
  check('2c. asking for B describes B',
    b.project.id === idB && b.project.mounted === true);
}

/* ── 4. no cross-project leakage ──────────────────────────────────── */
{
  // Analyse BOTH, so each has real derived intelligence on disk, then prove
  // neither view carries the other's facts.
  await post(`/projects/${idA}/open`, {});
  await post('/inspect', { text: 'what is this project' });
  await post(`/projects/${idB}/open`, {});
  await post('/inspect', { text: 'what is this project' });

  const a = (await contextOf(idA)).view;
  const b = (await contextOf(idB)).view;

  const blobA = JSON.stringify(a);
  const blobB = JSON.stringify(b);

  check('4. project A\'s view contains no trace of project B',
    !blobA.includes('markerbravo') && !blobA.includes(rootB) && !blobA.includes('branch-bravo'));
  check('4b. project B\'s view contains no trace of project A',
    !blobB.includes('markeralpha') && !blobB.includes(rootA) && !blobB.includes('branch-alpha'));
  check('4c. the two views are genuinely different projects',
    a.project.id !== b.project.id && a.project.root !== b.project.root
    && a.git.branch === 'branch-alpha' && b.git.branch === 'branch-bravo',
    `${a.git.branch} vs ${b.git.branch}`);
}

/* ── 6. fresh intelligence reads as fresh ─────────────────────────── */
{
  await post(`/projects/${idA}/open`, {});
  await post('/inspect', { text: 'describe the architecture' });
  const { view } = await contextOf(idA);
  check('6. freshly analysed intelligence is reported fresh',
    view.freshness.state === 'fresh',
    `state=${view.freshness.state} reason=${view.freshness.reason ?? '—'}`);
  check('6b. fresh means no reason to doubt it', view.freshness.reason === null);
  check('6c. and the repository section is actually populated',
    view.repository.intelligence !== 'absent' && view.repository.fileCount > 0,
    `intelligence=${view.repository.intelligence} files=${view.repository.fileCount}`);
}

/* ── 5. a nested edit makes it stale, and says why ────────────────── */
{
  const buried = path.join(rootA, 'src', 'deep', 'nested', 'buried.ts');
  const future = (Date.now() + 60_000) / 1000;
  writeFileSync(buried, `export const buried = 'alpha edited';\n`);
  fs.utimesSync(buried, future, future);

  const { view } = await contextOf(idA);
  check('5. an edit three directories deep makes the view STALE',
    view.freshness.state === 'stale', `state=${view.freshness.state}`);
  check('5b. it says why, in plain language',
    typeof view.freshness.reason === 'string' && /change|added|removed/i.test(view.freshness.reason),
    view.freshness.reason ?? '(none)');
  check('5c. staleness raises a constraint rather than staying silent',
    view.constraints.some((c) => c.id === 'stale-understanding'),
    view.constraints.map((c) => c.id).join(', '));
  check('5d. the contract TELLS a model the facts may be out of date',
    (await contextOf(idA, '?prompt=1')).contract.includes('STALE'));
}

/* ── 7. composition, not duplication ──────────────────────────────── */
{
  const raw = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/compose.ts'), 'utf8');

  /* Strip comments before scanning. The file DOCUMENTS which authorities it
     defers to ("from `scanEnvironment`, never re-probed here"), so a naive
     substring search over the whole text flags the very prose that promises
     the opposite. The claim under test is about the CODE. */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  // A read model that scanned, registered or probed on its own behalf would
  // be a second authority wearing a read model's name.
  const forbidden = [
    ['scanEnvironment', 'its own environment scan'],
    ['new ProjectRegistry', 'its own project registry'],
    ['probeNode', 'its own node probe'],
    ['createFabric', 'its own execution authority'],
    ['MissionStore', 'its own mission store'],
    ['readdirSync', 'its own repository walk'],
  ];
  for (const [needle, why] of forbidden) {
    check(`7. compose.ts does not build ${why}`, !src.includes(needle));
  }
  check('7b. it reads the existing intelligence artifacts instead',
    src.includes('loadIdentity') && src.includes('loadRepositorySummary')
    && src.includes('detectChanges') && src.includes('gatherGitStatus'));

  /* Stronger than a keyword scan: every value import must come from a module
     that already OWNS the fact being projected. A new import outside this set
     is the first sign the read model is growing an authority of its own. */
  const allowedImports = [
    'node:os',
    '../intelligence/identity',
    '../intelligence/moduleSummarizer',
    '../intelligence/performance',
    '../intelligence/versioning',
    '../mission/gitSignals',
    './types',
  ];
  const valueImports = [...src.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const unexpected = valueImports.filter((i) => !allowedImports.includes(i));
  check('7c. every value import is an existing authority',
    unexpected.length === 0,
    unexpected.length ? `unexpected: ${unexpected.join(', ')}` : valueImports.join(', '));
}

/* ── 8. one call is enough for a consumer ─────────────────────────── */
{
  const res = await contextOf(idA, '?prompt=1');
  check('8. a single request yields BOTH the view and the rendered contract',
    !!res.view && typeof res.contract === 'string' && res.contract.length > 0);
  check('8b. the contract already names the project — no second lookup',
    res.contract.includes(res.view.project.name) && res.contract.includes(rootA));
  check('8c. and already carries the branch Ask AURA would otherwise ask for',
    res.contract.includes('branch-alpha'));
  check('8d. the contract never leaks a credential',
    !/sk-|api[_-]?key|bearer /i.test(res.contract));
}

/* ── 9 + 10. stability across navigation ──────────────────────────── */
{
  // Navigation is UI state and never reaches the service; the service-side
  // proof that it cannot disturb the project is that repeated composition
  // for the same id is stable while OTHER projects are opened in between.
  const before = (await contextOf(idA)).view;
  await post(`/projects/${idB}/open`, {});     // "navigate away" — mount another
  await post(`/projects/${idA}/open`, {});     // "return"
  const after = (await contextOf(idA)).view;

  check('9. the project survives another project being opened and returned to',
    after.project.id === before.project.id && after.project.root === before.project.root);
  check('10. returning reconstructs the same ContextView',
    after.contextVersion === before.contextVersion
    && after.project.name === before.project.name
    && after.repository.intelligence === before.repository.intelligence
    && after.git.branch === before.git.branch,
    `v${before.contextVersion}→v${after.contextVersion} ${before.git.branch}→${after.git.branch}`);
  check('10b. only the composition timestamp differs, as it should',
    after.generatedAt !== before.generatedAt);
}

/* ── 11. cost ─────────────────────────────────────────────────────── */
{
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push((await contextOf(idA)).view.buildMs);
  const worst = Math.max(...samples);
  console.log(`INFO  ContextView build cost: ${samples.join('ms, ')}ms`);
  check('11. composing a view stays well under a second', worst < 1000, `worst=${worst}ms`);
}

/* ── 12. composing context never triggers an index ────────────────── */
{
  const v1 = (await contextOf(idA)).view;
  await contextOf(idA);
  await contextOf(idA);
  const v2 = (await contextOf(idA)).view;
  // If composing had re-analysed the project, the artifacts would have been
  // regenerated and freshness would have flipped back to fresh by itself.
  check('12. repeated composition does not silently re-index',
    v1.freshness.state === v2.freshness.state && v1.contextVersion === v2.contextVersion,
    `${v1.freshness.state}/${v1.contextVersion} → ${v2.freshness.state}/${v2.contextVersion}`);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
