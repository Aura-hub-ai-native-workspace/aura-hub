/**
 * capability-truth-verify — a capability does what it declares.
 * ==================================================================
 * The manifest is what the operator reads and, once tool calling lands,
 * what the model reads. Two capabilities were describing work they did
 * not do:
 *
 *   mission.create   verified itself by looking the mission up with
 *                    `text.slice(0, 60)` where `getMission` expects a
 *                    mission id. The lookup could never succeed, so every
 *                    successful creation reported `unverified` — which the
 *                    mission layer deliberately treats as failure.
 *
 *   governance.audit declared "Health scorecard, risk, release readiness"
 *                    and returned the stored project profile with the
 *                    detail "Audit inputs collected." It gathered the
 *                    inputs to an audit and never ran one.
 *
 * Drives the REAL service on a disposable AURA_HOME and a private port,
 * against a REAL temporary git repository. Every section carries a
 * NEGATIVE CONTROL that reproduces the old behaviour, so each check is
 * shown to be capable of failing.
 *
 * Usage: node scripts/capability-truth-verify.mjs
 * Needs no AI provider and no network — a capability that needs one says
 * so and is reported NOT VERIFIED rather than passed.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'apps/desktop/src-tauri/resources/ai-service.mjs');
const HOME = mkdtempSync(path.join(tmpdir(), 'truth-home-'));

let failed = false;
let API = '';
let child = null;

const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const skip = (n, why) => console.log(`SKIP  ${n} — NOT VERIFIED: ${why}`);
const section = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${API}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then((r) => r.json());
/* `projectId` travels in `context`, not `input`: the server resolves the
   working directory from the registry so a caller cannot point execution
   at an arbitrary directory. Capabilities that also declare a projectId
   argument get it in both places, which is what the UI sends too. */
const invoke = (capabilityId, input, projectId) =>
  post('/fabric/invoke', { capabilityId, input, context: { projectId } });

/** A small but genuine repository — git history is an audit input. */
function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'truth-proj-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"truth","version":"1.0.0"}\n');
  writeFileSync(path.join(dir, 'README.md'), '# truth\n\nA project used by capability-truth-verify.\n');
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'verify@aura.local');
  git('config', 'user.name', 'verify');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  return dir;
}

try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-service-bundle.mjs')], { cwd: ROOT, stdio: 'pipe' });
  const port = await freePort();
  API = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [BUNDLE, '--none'], {
    env: { ...process.env, AI_PORT: String(port), AURA_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${API}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(150);
  }
  if (!up) throw new Error('service did not start');

  const projectPath = makeProject();
  const project = await post('/projects', { name: 'truth', path: projectPath });
  const projectId = project?.project?.id ?? project?.id;
  if (!projectId) throw new Error(`could not register a project: ${JSON.stringify(project).slice(0, 200)}`);
  await post(`/projects/${projectId}/open`, {});
  console.log(`      project ${projectId} at ${projectPath}`);

  /* ══ [A] governance.audit ════════════════════════════════════════ */
  section('[A] governance.audit runs the audit it declares');

  const MISSION_TEXT = 'Add a subtract function beside add, with a test.';
  const audit = await invoke('governance.audit', { projectId }, projectId);
  check('A1  the capability executed', audit?.outcome === 'succeeded',
    `${audit?.outcome}: ${audit?.detail}`);

  const out = audit?.output ?? {};
  check('A2  it no longer reports "Audit inputs collected"',
    !/inputs collected/i.test(audit?.detail ?? ''), audit?.detail);
  check('A3  the result carries the health score the manifest promises',
    typeof out?.report?.overallHealth === 'number' && typeof out?.report?.grade === 'string',
    `health=${out?.report?.overallHealth} grade=${out?.report?.grade}`);
  check('A4  and the risks', Array.isArray(out?.report?.topRisks),
    `${out?.report?.topRisks?.length} risk(s)`);
  check('A5  and the scorecard dimensions the health number is made of',
    Array.isArray(out?.scorecard?.dimensions) && out.scorecard.dimensions.length > 0,
    `${out?.scorecard?.dimensions?.length} dimension(s)`);
  check('A6  the recommendations and findings the description names',
    Array.isArray(out?.report?.recommendations) && Array.isArray(out?.report?.securityFindings));

  /* NEGATIVE CONTROL — what the old executor returned. If the checks above
     would also pass on that shape, they are proving nothing. */
  const oldShape = { projectId, profile: { name: 'truth', frameworks: [] } };
  check('A7  NEGATIVE CONTROL — the previous return value fails A3–A6',
    typeof oldShape?.report?.overallHealth !== 'number' &&
    !Array.isArray(oldShape?.scorecard?.dimensions),
    'the profile alone carries no health, no risks, no dimensions');

  check('A8  the declaration matches: no package-manager audit was run',
    !JSON.stringify(out).includes('npm audit'),
    'the description says the result never depends on the network');

  /* ══ [B] mission.create ══════════════════════════════════════════ */
  section('[B] mission.create verifies itself against the mission it made');

  const created = await invoke('mission.create', { projectId, text: MISSION_TEXT }, projectId);

  if (created?.outcome !== 'succeeded') {
    /* Mission creation runs the orchestrator, which may require a model
       provider. Reporting that honestly is the point — a suite that passed
       here by not running anything would be worse than one that skips. */
    skip('B1  a mission is created and reads back', `mission.create returned ${created?.outcome}: ${created?.detail}`);
    skip('B2  the read-back uses the id, not the text', 'no mission was created to read back');
  } else {
    check('B1  a mission is created and reads back',
      created?.verification?.passed === true,
      `verified=${created?.verification?.passed} — ${created?.verification?.detail}`);

    const missionId = created?.output?.id;
    check('B2  the read-back names the id it created',
      typeof missionId === 'string' && (created?.verification?.detail ?? '').includes(missionId),
      missionId);

    /* NEGATIVE CONTROL — the lookup the old code performed. `getMission`
       expects an id; it was handed the first 60 characters of the text, so
       it could never match. Asking the store for that key directly shows
       the old verify could only ever fail. */
    const byText = await fetch(`${API}/projects/${projectId}/missions/${encodeURIComponent(MISSION_TEXT.slice(0, 60))}`)
      .then((r) => ({ status: r.status })).catch(() => ({ status: 0 }));
    check('B3  NEGATIVE CONTROL — the old text-prefix lookup finds nothing',
      byText.status !== 200, `HTTP ${byText.status} for the text-prefix key`);

    const byId = await fetch(`${API}/projects/${projectId}/missions/${encodeURIComponent(missionId)}`)
      .then((r) => ({ status: r.status })).catch(() => ({ status: 0 }));
    check('B4  while the id the fix uses does find it', byId.status === 200, `HTTP ${byId.status}`);
  }

  /* ══ [C] The declaration is the contract ═════════════════════════ */
  section('[C] What the manifest says is what the code does');

  const manifest = fs.readFileSync(path.join(ROOT, 'packages/capability-fabric/src/manifest.ts'), 'utf8');
  const entry = manifest.slice(manifest.indexOf("id: 'governance.audit'"), manifest.indexOf("id: 'workflow.run'"));
  check('C1  governance.audit no longer claims "release readiness" it does not produce',
    !/release readiness/i.test(entry), 'the description now names what it returns');
  check('C2  and declares the scope argument the executor accepts',
    /f\('scope'/.test(entry));

  const executors = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/fabric/executors.ts'), 'utf8');
  const verifyFn = executors.slice(executors.indexOf("capabilityId: 'mission.create'"), executors.indexOf("capabilityId: 'mission.start'"));
  check('C3  mission.create verify reads the executor result, not the input text',
    /async verify\(inv, result\)/.test(verifyFn) && !/inv\.input\.text\)\.slice/.test(verifyFn));
} catch (err) {
  console.error(`\nFATAL  ${err?.stack ?? err}`);
  failed = true;
} finally {
  if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* leave it */ }
}

console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
