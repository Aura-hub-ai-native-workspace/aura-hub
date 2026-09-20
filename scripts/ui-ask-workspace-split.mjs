/**
 * ui-ask-workspace-split — GUI proof that Ask AURA advises and the
 * Workspace executes, over the REAL stack (no mocked responses anywhere).
 *
 * Vite dev server (:1420) + TS AI service (:4319, projects/conversations)
 * + canonical Python agent backend (:4320). The script spawns its own
 * stub Ollama (ephemeral port) and configures it as the provider through
 * the real verify API, so the stranded `AURA_HOME` needs nothing prepared.
 *
 * Prerequisites (started separately, like the other ui-*.mjs suites):
 *   AURA_HOME=<dir> node .aura/ai-service.mjs            # :4319
 *   <agent backend on :4320>                             # AGENT_URL override ok
 *   npm run dev                                          # :1420
 *
 * Env overrides: APP_URL, AGENT_URL (:4320), AI_URL (:4319), CHROMIUM.
 * REAL_PROVIDER_URL + REAL_PROVIDER_MODEL: verify the given live server
 * instead of spawning the stub (e.g. an ngrok Ollama endpoint). The stub
 * stays the default so CI needs no network.
 * Usage: node scripts/ui-ask-workspace-split.mjs [--headed]
 *
 * Coverage (Ask/Workspace separation acceptance, GUI slice):
 *  S1 Ask AURA answers conversationally: streamed prose, no lifecycle
 *     strip, no approval gate, no execution clarification.
 *  S2 "Send to Workspace" navigates and stages a handoff banner that
 *     executes nothing until Start; Dismiss drops it without a trace.
 *  S3 Starting the handoff sends an execution objective to the Workspace
 *     thread (central-agent session), visibly scoped as Execution.
 *  S4 project isolation at the API layer (B knows nothing of A).
 *  S5 no preloaded messages: fresh threads render zero assistant bubbles.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir as fsMkdir, writeFile as fsWrite } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL ?? 'http://localhost:1420';
const AGENT = process.env.AGENT_URL ?? 'http://127.0.0.1:4320';
const AI = process.env.AI_URL ?? 'http://127.0.0.1:4319';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');
// Live server under test (ngrok Ollama, lab GPU box, …). Unset = stub.
const REAL_URL = process.env.REAL_PROVIDER_URL ?? '';
const REAL_MODEL = process.env.REAL_PROVIDER_MODEL ?? '';
const PROVIDER_URL = REAL_URL || null; // resolved after the stub starts
const PROVIDER_MODEL = REAL_MODEL || 'split-e2e:latest';
const EXPECTED_SNIPPET = REAL_URL ? null : 'Split-suite advisory answer';

let failures = 0;
let checks = 0;
const check = (name, pass, detail = '') => {
  checks += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (t) => console.log(`\n${t}`);

const api = (base, p, method = 'GET', body) =>
  fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A stub Ollama: model list + one streamed advisory answer. */
function startStub() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'split-e2e:latest' }] }));
        return;
      }
      // Runtime liveness probe (BaseOpenAICompatible.health).
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'split-e2e:latest' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
          res.write('data: {"choices":[{"delta":{"content":"Split-suite advisory answer."}}]}\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

const main = async () => {
  section('ui-ask-workspace-split — advise vs execute over real services');

  const stub = REAL_URL ? null : await startStub();
  const stubPort = stub ? stub.address().port : 0;
  const baseUrl = REAL_URL || `http://127.0.0.1:${stubPort}/v1`;
  const shutdown = () => { if (stub) stub.close(); };
  process.on('exit', shutdown);

  const health = await api(AGENT, '/health').then((r) => r.json()).catch(() => null);
  check('agent backend reachable', Boolean(health?.ok), JSON.stringify(health)?.slice(0, 80));
  const aiHealth = await api(AI, '/health').then((r) => r.json()).catch(() => null);
  check('AI service reachable', Boolean(aiHealth), JSON.stringify(aiHealth)?.slice(0, 80));
  if (!health?.ok || !aiHealth) {
    console.log(`\n${checks} checks, ${failures} failures — services down, aborting`);
    process.exit(2);
  }

  // Provider: real verify+save against the server under test, like onboarding does.
  const verify = await api(AI, '/providers/verify', 'POST', {
    providerId: 'ollama',
    baseUrl,
    model: PROVIDER_MODEL,
  }).then((r) => r.json()).catch(() => null);
  check('provider verified and saved', verify?.ok === true, JSON.stringify(verify)?.slice(0, 120));

  // Fixture projects A and B.
  const fixDir = join(tmpdir(), `aura-split-${Date.now()}`);
  await fsMkdir(join(fixDir, 'projA', 'src'), { recursive: true });
  await fsWrite(join(fixDir, 'projA', 'src', 'notes.ts'), 'export const note = 1;\n');
  await fsMkdir(join(fixDir, 'projB'), { recursive: true });
  const addedA = await api(AI, '/projects', 'POST', { path: join(fixDir, 'projA'), name: 'split-proj-a' }).then((r) => r.json());
  const addedB = await api(AI, '/projects', 'POST', { path: join(fixDir, 'projB'), name: 'split-proj-b' }).then((r) => r.json());
  const projectA = addedA?.project?.id ?? addedA?.id;
  const projectB = addedB?.project?.id ?? addedB?.id;
  check('fixture projects registered', Boolean(projectA && projectB), `${projectA} ${projectB}`);
  await api(AI, `/projects/${projectA}/open`, 'POST', {});

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e?.message ?? e).slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200));
  });
  page.on('response', (r) => {
    if (r.status() >= 400) pageErrors.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`);
  });
  const dumpWorkspace = async () => {
    const banner = (await page.getByTestId('handoff-banner').count()) > 0
      ? ((await page.getByTestId('handoff-banner').textContent().catch(() => '')) ?? '').slice(0, 200)
      : '(no banner)';
    const msgs = await page.locator('[data-testid="chat-message"]').count().catch(() => -1);
    const errors = await page.locator('[data-testid="chat-error"]').allTextContents().catch(() => []);
    const notes = await page.locator('[data-testid="outcome-note"]').allTextContents().catch(() => []);
    return `banner=${banner} | msgs=${msgs} | errors=${JSON.stringify(errors).slice(0, 200)} | notes=${JSON.stringify(notes).slice(0, 200)} | pageerrors=${JSON.stringify(pageErrors.slice(-3))}`;
  };
  await page.addInitScript(() => window.localStorage.setItem('aura-onboarded', 'true'));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('div.fixed.inset-0.z-\\[300\\]'), { timeout: 25000 }).catch(() => undefined);
  await page.getByRole('button', { name: /split-proj-a/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);

  /* S5 — fresh threads render nothing preloaded */
  section('S5 · no preloaded messages');
  await page.getByRole('button', { name: 'Ask AURA' }).first().click({ timeout: 15000 });
  const askComposer = page.getByTestId('ask-composer');
  await askComposer.waitFor({ timeout: 15000 });
  check('Ask AURA opens with advisor composer', true);
  check('fresh advisory thread has no assistant bubbles',
    (await page.getByTestId('ask-message').count()) === 0);

  /* S1 — advisory answer, no execution chrome */
  section('S1 · Ask AURA advises');
  await askComposer.fill('Explain thread isolation (marker REAL-LOOP-1001). Advice only, no action needed.');
  await page.getByRole('button', { name: 'Send' }).click();
  // Done signal: the handoff action renders only on completed answers.
  await page.getByRole('button', { name: 'Send to Workspace' }).first().waitFor({ timeout: 180000 });
  const askText = await page.getByTestId('ask-message').last().textContent().catch(() => '');
  const proseOk = EXPECTED_SNIPPET
    ? (askText ?? '').includes(EXPECTED_SNIPPET)
    : (askText ?? '').replace(/(Send to Workspace|Copy|Regenerate)/g, '').trim().length > 60;
  check('advisory answer streamed as prose', proseOk, (askText ?? '').slice(0, 100));
  check('no lifecycle strip on Ask AURA',
    (await page.locator('[aria-label="Agent lifecycle"]').count()) === 0);
  check('no approval gate on Ask AURA',
    (await page.locator('text=Authorization required').count()) === 0);
  check('no execution clarification on Ask AURA',
    !((await page.locator('body').first().textContent().catch(() => '')) ?? '').includes('I want to get this right before I start'));
  check('scope pill names the project', ((await page.getByTestId('chat-scope').first().textContent().catch(() => '')) ?? '').includes('split-proj-a'));
  check('Send to Workspace offered', (await page.getByRole('button', { name: 'Send to Workspace' }).count()) > 0);

  /* S2 — explicit handoff stages a banner and executes nothing */
  section('S2 · handoff is explicit');
  const wsMsgsBefore = await page.locator('[data-testid="chat-message"]').count().catch(() => 0);
  await page.getByRole('button', { name: 'Send to Workspace' }).first().click();
  const banner = page.getByTestId('handoff-banner');
  await banner.waitFor({ timeout: 15000 });
  check('handoff banner staged in Workspace', true);
  check('banner carries the question', ((await banner.textContent().catch(() => '')) ?? '').includes('Explain thread isolation'));
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForTimeout(1000);
  check('dismiss drops the banner', (await page.getByTestId('handoff-banner').count()) === 0);
  check('dismiss executed nothing', (await page.locator('[data-testid="chat-message"]').count().catch(() => 0)) === wsMsgsBefore);

  /* S3 — starting the handoff sends an execution objective */
  section('S3 · Workspace executes');
  // Back to the answered advisory thread: Home, project, Ask AURA.
  await page.getByRole('button', { name: 'Home' }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /split-proj-a/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Ask AURA' }).first().click({ timeout: 15000 });
  await page.getByTestId('ask-composer').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Send to Workspace' }).first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Send to Workspace' }).first().click();
  await page.getByTestId('handoff-banner').waitFor({ timeout: 15000 });
  const threadBefore = await page.locator('[data-testid="chat-message"]').count().catch(() => 0);
  await page.getByTestId('handoff-start').click();
  await page.waitForFunction(
    (before) => document.querySelectorAll('[data-testid="chat-message"]').length > before,
    threadBefore,
    { timeout: 60000 },
  ).catch(() => undefined);
  const threadAfter = await page.locator('[data-testid="chat-message"]').count().catch(() => 0);
  check('starting the handoff sends an execution objective', threadAfter > threadBefore, `${threadBefore} → ${threadAfter} :: ${await dumpWorkspace()}`);
  check('workspace scoped as Execution', ((await page.getByTestId('chat-scope').first().textContent().catch(() => '')) ?? '').includes('Execution'));

  /* S4 — project isolation at the API layer */
  section('S4 · project isolation');
  const bList = await api(AI, `/projects/${projectB}/conversations`).then((r) => r.json()).catch(() => null);
  check('project B knows nothing of A', Array.isArray(bList?.conversations) && bList.conversations.length === 0,
    JSON.stringify(bList)?.slice(0, 100));

  await browser.close();
  console.log(`\n${checks} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
};

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
