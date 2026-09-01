/**
 * ui-agent-noprovider-test — the Agent UI when there is no model behind it.
 *
 * AURA is BYOAK: it ships no model. So an agent node on a service with no
 * provider connected reaches the real agent runtime, records its opening
 * beat, and stops on the provider's refusal. That is not a malfunction and
 * it is not a UI edge case to be papered over — it is the honest behaviour
 * of the product before a key is added, and it is the first thing a new
 * user sees.
 *
 * WHY THIS SUITE STARTS ITS OWN SERVICE
 * ------------------------------------------------------------------
 * The other agent suite runs against the developer's service, which may
 * well have a provider connected — as it did when this was written. The
 * no-provider path cannot be observed there without editing the user's
 * own configuration, and it must never be *simulated*: a fabricated
 * `no_provider` error would prove nothing about the real runtime.
 *
 * So this suite starts a second, fully isolated instance of the REAL
 * service with its own empty `AURA_HOME` and no API key, plus a dev
 * server pointed at it. Real service, real engine, real agent runtime,
 * real provider refusal. Nothing is mocked and no trace is injected.
 *
 * Prerequisite: `npm run ai` has been run at least once, so the service
 * bundle exists at `.aura/ai-service.mjs`.
 *
 * Usage: node scripts/ui-agent-noprovider-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const BUNDLE = path.join(REPO, '.aura/ai-service.mjs');
const SCRATCH = process.env.NOPROV_SCRATCH
  ?? '/tmp/claude-1000/-mnt-storage-aura-hub/731e8910-7b83-4e46-b772-c35a1e6cd715/scratchpad';
const HOME_DIR = path.join(SCRATCH, 'noprov-home');
const SANDBOX = path.join(SCRATCH, 'noprov-sandbox');
const PORT = Number(process.env.NOPROV_PORT ?? 4320);
const UI_PORT = Number(process.env.NOPROV_UI_PORT ?? 1421);
const AI = `http://127.0.0.1:${PORT}`;
const APP = `http://localhost:${UI_PORT}`;
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');

let failures = 0;
let checks = 0;
const check = (name, pass, detail = '') => {
  checks += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (t) => console.log(`\n${t}`);
const api = (p) => fetch(`${AI}${p}`).then((r) => r.json());
const post = (p, b) =>
  fetch(`${AI}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })
    .then((r) => r.json());
const put = (p, b) =>
  fetch(`${AI}${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const waitFor = async (fn, ms = 60_000, every = 300) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
};

/** Read a run stream to the end, keeping every event. */
async function stream(url, body) {
  const res = await fetch(`${AI}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      for (const line of p.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        events.push(JSON.parse(raw));
      }
    }
  }
  const last = events.find((e) => e.type === 'done');
  return { events, runId: last?.runId ?? events.find((e) => e.runId)?.runId ?? null, done: last };
}

const children = [];
function launch(cmd, args, opts) {
  const c = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
  c.unref();
  children.push(c);
  return c;
}
function teardown() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(HOME_DIR, { recursive: true, force: true });
}

async function main() {
  if (!existsSync(BUNDLE)) {
    console.error(`\nService bundle missing at ${BUNDLE}. Run \`npm run ai\` once first.\n`);
    process.exit(2);
  }

  /* A throwaway repo, so the agent's project is real without any of the
     user's own work being a target. */
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(HOME_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(path.join(SANDBOX, 'README.md'), 'no-provider sandbox\n');
  const git = (...a) => execFileSync('git', a, { cwd: SANDBOX, stdio: 'ignore' });
  git('init', '-q', '.');
  git('config', 'user.email', 'noprov@local');
  git('config', 'user.name', 'noprov');
  git('add', '-A');
  git('commit', '-qm', 'init');

  section('A real service with no provider connected');
  launch(process.execPath, [BUNDLE, '--none'], {
    cwd: REPO,
    // An empty home is what makes this instance keyless: no settings, no
    // stored key, nothing carried over from the developer's own service.
    env: { ...process.env, AURA_HOME: HOME_DIR, AI_PORT: String(PORT) },
  });
  const serviceUp = await waitFor(() => fetch(`${AI}/health`).then((r) => r.ok));
  check('the isolated service started', serviceUp, AI);
  if (!serviceUp) { teardown(); process.exit(1); }

  const health = await api('/health');
  check('it reports no provider configured', health.key?.configured === false, JSON.stringify(health.key));

  launch('npx', ['vite', '--port', String(UI_PORT), '--strictPort'], {
    cwd: path.join(REPO, 'apps/desktop'),
    env: { ...process.env, VITE_AI_URL: AI },
  });
  const uiUp = await waitFor(() => fetch(APP).then((r) => r.ok), 90_000);
  check('a dev server is serving against it', uiUp, APP);
  if (!uiUp) { teardown(); process.exit(1); }

  /* ── the node is still fully available ───────────────────────────
     A missing provider is a configuration gap, not a capability gap.
     The service must still serve the agent's contract. */
  section('The agent node is still enabled and its contract still served');
  const specs = await api('/workflows/specs');
  const agentSpec = specs.specs.find((s) => s.type === 'agent');
  check('the agent spec is served', Boolean(agentSpec), agentSpec?.label);
  check('and is not marked disabled', !agentSpec?.disabled, `disabled = ${JSON.stringify(agentSpec?.disabled)}`);
  const boundsContract = await api('/agent/bounds');
  check('bounds ceilings are still served', boundsContract.ceilings?.maxIterations > 0, JSON.stringify(boundsContract.ceilings?.maxIterations));

  /* ── the real run ────────────────────────────────────────────────── */
  section('A real agent run with nothing to reason with');
  const proj = await post('/projects', { path: SANDBOX, name: 'noprov-sandbox' });
  const projectId = proj.id ?? proj.project?.id;
  const wf = await post('/workflows', { name: 'NOPROV agent' });
  await put(`/workflows/${wf.id}`, {
    ...wf,
    projectId,
    nodes: [{ id: 'ag', type: 'agent', x: 0, y: 0, config: {
      task: 'Summarise this repository in one sentence.',
      maxIterations: 3, timeoutMs: 30_000, maxTokens: 2000, tools: '',
    } }],
    edges: [],
  });

  const run = await stream(`/workflows/${wf.id}/run`, { inputs: {}, projectId });
  const beats = run.events.filter((e) => e.type === 'agent');

  check('the runtime was really reached', beats.length > 0, `${beats.length} live agent beats`);
  check('the opening beat is an intent', beats[0]?.beat?.kind === 'intent', beats[0]?.beat?.kind);
  check('it carries the task as given', beats[0]?.beat?.text?.includes('Summarise this repository'));
  check('the run ends on a result beat', beats[beats.length - 1]?.beat?.kind === 'result', beats[beats.length - 1]?.beat?.kind);
  check(
    'the result names the provider refusal',
    /no_provider/.test(beats[beats.length - 1]?.beat?.text ?? ''),
    beats[beats.length - 1]?.beat?.text?.slice(0, 80),
  );
  check('every beat is a real typed beat', beats.every((e) =>
    typeof e.beat.seq === 'number' && typeof e.beat.iteration === 'number'
    && Boolean(e.beat.at) && ['ai', 'fabric', 'human', 'system'].includes(e.beat.actor)));
  check('sequence numbers ascend', beats.every((e, i) => i === 0 || e.beat.seq > beats[i - 1].beat.seq),
    beats.map((e) => e.beat.seq).join(','));
  check('the run reports failure', run.done?.status === 'failed', run.done?.runState);

  section('What the service persisted');
  const rec = await api(`/workflows/${wf.id}/runs/${run.runId}`);
  const trace = rec.nodes.ag?.agentTrace;
  check('a real trace was persisted', Boolean(trace), `${trace?.beats?.length} beats`);
  check('it is a finished ledger, not a snapshot', trace?.partial === false, JSON.stringify(trace?.partial));
  check('its stop reason is `failed`', trace?.stopReason === 'failed', trace?.stopReason);
  check('it left by the failed port', trace?.port === 'failed', trace?.port);
  check('the effective bounds are still recorded', Boolean(trace?.effectiveBounds), JSON.stringify(trace?.effectiveBounds));
  check('nothing was executed', (trace?.evidence?.length ?? -1) === 0, `${trace?.evidence?.length} evidence`);
  check('no tools were refused (none were asked for)', (trace?.refusedTools?.length ?? -1) === 0);
  check('the node error names the provider', /No AI provider connected/.test(rec.nodes.ag?.error ?? ''), rec.nodes.ag?.error?.slice(0, 60));
  check('the run is not resumable', rec.resumable === false);
  check('and says why in plain words', Boolean(rec.notResumableReason), rec.notResumableReason);

  /* ── the UI ──────────────────────────────────────────────────────── */
  section('What the UI shows for it');
  const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  for (const n of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name: n }).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(1200); }
  }
  const expand = page.getByRole('button', { name: /Expand sidebar/i }).first();
  if (await expand.count()) { await expand.click().catch(() => {}); await page.waitForTimeout(700); }
  await page.getByRole('button', { name: /^Automation$/ }).first().click({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await page.getByText('NOPROV agent', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: /^Runs/ }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('tbody tr').first().click();
  await page.waitForTimeout(2500);

  const runText = await page.textContent('body');
  check('the run reads as failed', runText.includes('This run failed'));
  check('the provider refusal is shown verbatim', runText.includes('No AI provider connected'));
  check('and it says where to fix it', runText.includes('Settings'));
  check('the agent step still offers its reasoning', runText.includes('Agent reasoning'));

  await page.getByRole('button', { name: /Agent reasoning/ }).first().click();
  await page.waitForTimeout(1500);
  const traceText = await page.textContent('body');
  check('the ledger renders the real beats', traceText.includes('Intent') && traceText.includes('Result'));
  check('the intent shows the task as given', traceText.includes('Summarise this repository'));
  check('the stop reason is stated, not hidden', traceText.includes('terminal failure'));
  check('the port it left by is named', traceText.includes('failed'));
  check(
    'the bounds it ran under are shown',
    traceText.includes(`/${trace.effectiveBounds.maxIterations}`),
    `maxIterations ${trace.effectiveBounds.maxIterations}`,
  );
  check('the token count says it is an estimate', traceText.includes('estimated'));
  check('no evidence section claims an effect', !traceText.includes('audit '), 'nothing ran, so nothing is cited');

  /* The node panel warns BEFORE a run is wasted — read from /health,
     never inferred from a failure. */
  section('The node panel says so before you run it');
  // Back to the graph, then summon the agent panel — it is not docked, so
  // it is opened by its own control rather than by the Design tab.
  await page.getByRole('tab', { name: /^Design/ }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Agent node/ }).first().click();
  await page.waitForTimeout(1800);
  const panelText = await page.textContent('body');
  check('the agent panel opens', panelText.includes('Agentic AI Node'));
  check(
    'and it reports the node as enabled',
    panelText.includes('enabled'),
    'a missing provider is a configuration gap, not a capability gap',
  );
  check(
    'the panel warns that no provider is connected',
    panelText.includes('No AI provider is connected'),
    'read from GET /health key.configured, not inferred from a failed run',
  );
  check(
    'and says the contract below is still correct',
    panelText.includes('read from the service'),
  );


  section('Console and network health');
  check('no page errors during the whole flow', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  teardown();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); teardown(); process.exit(1); });
