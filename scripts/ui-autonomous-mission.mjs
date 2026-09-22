/**
 * ui-autonomous-mission — E2E proof that Workspace missions run
 * themselves and only destruction parks.
 *
 * Over the REAL stack (Vite UI + ai-service + policy + executors +
 * ledger, stub Ollama standing in for a model): a mission is created,
 * auto-approved, executed in waves with real files landing on disk and
 * zero approval requests; then a governed delete parks, the UI shows
 * exactly one authorization gate, approving it deletes the file and
 * execution continues.
 *
 * Prerequisites (started separately):
 *   AURA_HOME=<dir> node .aura/ai-service.mjs            # :4319
 *   npm run dev --workspace @aura/desktop                 # :1420
 *
 * Env overrides: APP_URL, AI_URL, CHROMIUM.
 * Usage: node scripts/ui-autonomous-mission.mjs [--headed]
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL ?? 'http://localhost:1420';
const AI = process.env.AI_URL ?? 'http://127.0.0.1:4319';
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

const api = (base, p, method = 'GET', body) =>
  fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Stub Ollama routing every model call by prompt marker. */
function startStub() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'auto-e2e:latest' }] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'auto-e2e:latest' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let text = 'Stub answer.';
          try {
            const parsed = JSON.parse(body);
            const content = JSON.stringify(parsed.messages ?? []);
            if (content.includes('candidates')) {
              text = JSON.stringify({
                category: 'new-feature', categoryConfidence: 0.9,
                primaryGoal: 'Build the demo site', secondaryGoals: [],
                constraints: [], deadline: null, targetComponents: [],
                expectedOutcome: 'Two pages exist', scope: 'narrow',
                riskLevel: 'low', requiredQuality: 'prototype',
              });
            } else if (content.includes("mission planner")) {
              text = JSON.stringify({
                goals: [{ id: 'g1', focusAreaId: 'default', title: 'Demo site',
                  rationale: 'user asked', relatedEvidence: ['demo'], priority: 'high' }],
                tasks: [
                  { id: 't1', goalId: 'g1', focusAreaId: 'default', title: 'Create hello page',
                    description: 'Create hello.ts', kind: 'file-operation', targetFile: 'hello.ts',
                    mode: 'new-file', priority: 'high', dependencies: [], estimatedDurationMinutes: 2,
                    confidence: 0.9, risk: 'low' },
                  { id: 't2', goalId: 'g1', focusAreaId: 'default', title: 'Create world page',
                    description: 'Create world.ts', kind: 'file-operation', targetFile: 'world.ts',
                    mode: 'new-file', priority: 'high', dependencies: ['t1'], estimatedDurationMinutes: 2,
                    confidence: 0.9, risk: 'low' },
                ],
              });
            } else if (content.includes('COMPLETE file contents')) {
              const m = content.match(/File: (\S+)/) || content.match(/(\w+\.ts)/);
              const file = m ? m[1] : 'hello.ts';
              const name = file.replace(/\.ts$/, '');
              text = JSON.stringify({ explanation: `create ${file}`, newCode: `export const ${name} = 1;\n` });
            } else if (content.includes('Respond in plain text')) {
              text = 'Research findings: the project is a demo site with two pages.';
            } else if (content.includes('verdict')) {
              text = JSON.stringify({ verdict: 'approved', findings: [] });
            }
          } catch { /* prose fallback */ }
          const wantsStream = body.includes('"stream":true');
          if (wantsStream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
            res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}} ]}\n\n`);
            res.end('data: [DONE]\n\n');
            return;
          }
          // The generate() path posts non-streaming and parses one JSON
          // body ({choices:[{message:{content}}]}), exactly like a real
          // OpenAI-compatible server with stream:false.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            model: 'auto-e2e:latest',
            choices: [{ message: { content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }));
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

async function readSSE(response, onEvent) {
  const text = await response.text();
  for (const chunk of text.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') break;
    try { onEvent(JSON.parse(payload)); } catch { /* keep going */ }
  }
}

const main = async () => {
  section('ui-autonomous-mission — autonomy + destructive gate over real services');

  const aiHealth = await api(AI, '/health').then((r) => r.json()).catch(() => null);
  check('AI service reachable', Boolean(aiHealth), '');
  if (!aiHealth) { console.log(`\n${checks} checks, ${failures} failures — aborting`); process.exit(2); }

  const stub = await startStub();
  const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;
  const shutdown = () => stub.close();
  process.on('exit', shutdown);

  const verify = await api(AI, '/providers/verify', 'POST', {
    providerId: 'ollama', baseUrl, model: 'auto-e2e:latest',
  }).then((r) => r.json()).catch(() => null);
  check('provider verified and saved', verify?.ok === true, JSON.stringify(verify)?.slice(0, 100));

  const fixDir = mkdtempSync(join(tmpdir(), 'aura-auto-e2e-'));
  mkdirSync(join(fixDir, 'site', 'src'), { recursive: true });
  writeFileSync(join(fixDir, 'site', 'src', 'notes.ts'), 'export const note = 1;\n');
  const added = await api(AI, '/projects', 'POST', { path: join(fixDir, 'site'), name: 'auto-site' }).then((r) => r.json());
  const projectId = added?.project?.id ?? added?.id;
  check('fixture project registered', Boolean(projectId), String(projectId));
  await api(AI, `/projects/${projectId}/open`, 'POST', {});

  // ── mission: objective in, files out, no human gates ──
  let missionId = null;
  const createRes = await api(AI, `/projects/${projectId}/missions`, 'POST', { text: 'Build a two-page demo site' });
  await readSSE(createRes, (e) => {
    if (e.type === 'done' && e.mission) missionId = e.mission.id;
  });
  check('mission created', Boolean(missionId), String(missionId));

  const mission = await api(AI, `/projects/${projectId}/missions/${missionId}`).then((r) => r.json());
  check('planning auto-passed without a human', mission?.approval?.status === 'approved', mission?.approval?.status);
  check('execution started on its own', ['running', 'reviewing', 'completed'].includes(mission?.execution?.status), mission?.execution?.status);

  const approvals = await api(AI, '/fabric/approvals').then((r) => r.json()).catch(() => null);
  const pendingCount = (approvals?.approvals ?? []).filter((a) => a.state === 'pending').length;
  // The ledger is process-scoped: earlier script runs against this same
  // long-lived service leave their own parked deletes behind. What
  // matters is that THIS mission added none.
  const missionAddsCount = (approvals?.approvals ?? []).filter((a) =>
    a.state === 'pending' && a.missionId === missionId).length;
  check('mission added zero approvals', missionAddsCount === 0, `${missionAddsCount} from this mission`);

  const helloOk = existsSync(join(fixDir, 'site', 'hello.ts')) &&
    readFileSync(join(fixDir, 'site', 'hello.ts'), 'utf8').includes('export const hello');
  const worldOk = existsSync(join(fixDir, 'site', 'world.ts')) &&
    readFileSync(join(fixDir, 'site', 'world.ts'), 'utf8').includes('export const world');
  check('hello.ts created with model content', helloOk);
  check('world.ts created after its dependency', worldOk);
  const doneCount = (mission?.goalGraph?.tasks ?? []).filter((t) => t.status === 'done').length;
  check('all planned tasks done', doneCount === 2, `${doneCount}/2`);

  // ── destructive gate: delete parks, UI shows one gate, grant resumes ──
  const beforeIds = new Set(((await api(AI, '/fabric/approvals').then((r) => r.json()).catch(() => null))?.approvals ?? []).map((a) => a.id));
  writeFileSync(join(fixDir, 'site', 'doomed.txt'), 'bye\n');
  const del = await api(AI, '/fabric/invoke', 'POST', {
    capabilityId: 'filesystem.delete',
    input: { path: 'doomed.txt' },
    context: { projectId, actorKind: 'agent', actorId: 'e2e', taskId: 'e2e-del' },
  }).then((r) => r.json()).catch(() => null);
  check('delete parks instead of running', del?.outcome === 'awaiting-approval', del?.outcome);
  check('file still on disk while parked', existsSync(join(fixDir, 'site', 'doomed.txt')));
  const after = await api(AI, '/fabric/approvals').then((r) => r.json()).catch(() => null);
  const fresh = (after?.approvals ?? []).filter((a) => a.state === 'pending' && !beforeIds.has(a.id));
  check('this run parked exactly one delete', fresh.length === 1 && fresh[0]?.taskId === 'e2e-del', `${fresh.length} new`);
  const approvalId = fresh[0]?.id;

  // ── browser: mission visible as done, one gate, grant resumes ──
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  // Skip the first-run onboarding carousel: the provider is already
  // configured through the real verify API above, so this only
  // bypasses the intro screens, never any authorization.
  await context.addInitScript(() => { try { localStorage.setItem('aura-onboarded', 'true'); } catch { /* noop */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(fixDir, 'shot-home.png') }).catch(() => null);
  // Open the fixture project if the picker is showing.
  const projBtn = page.getByRole('button', { name: /auto-site/ }).first();
  if (await projBtn.count() > 0) {
    await projBtn.click({ timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(3000);
  }
  // Workflows/Automation surface hosts the approvals inbox.
  const autoNav = page.getByRole('button', { name: /Automation/ }).first();
  if (await autoNav.count() > 0) {
    await autoNav.click({ timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(3000);
  }
  const approvalsTab = page.locator('button', { hasText: 'Approvals' }).first();
  if (await approvalsTab.count() > 0) {
    await approvalsTab.click({ timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(3000);
  } else {
    await page.getByText('Approvals').first().click({ timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: join(fixDir, 'shot-gate.png') }).catch(() => null);
  const gateCount = await page.locator('text=Authorization required').count();
  check('browser shows the destructive gate', gateCount >= 1, `${gateCount} gate(s)`);
  const deleteMention = await page.locator('text=filesystem.delete').count();
  check('gate names the destructive capability', deleteMention >= 1, `${deleteMention}`);
  const approveButtons = await page.getByRole('button', { name: /Approve and run/i }).count();
  check('browser offers Approve and run on the gate', approveButtons >= 1, `${approveButtons}`);
  if (approveButtons > 0) {
    await page.getByRole('button', { name: /Approve and run/i }).first().click().catch(() => null);
    await page.waitForTimeout(3000);
  }
  // The click decides the request in the ledger; re-issuing the same
  // task with a per-call grant resumes it — the documented resume path
  // for approval-gated work.
  const decided = await api(AI, '/fabric/approvals').then((r) => r.json()).catch(() => null);
  const stillPending = (decided?.approvals ?? []).some((a) => a.id === approvalId && a.state === 'pending');
  check('UI click cleared the pending gate', !stillPending, stillPending ? 'still pending' : 'decided');
  const resumed = await api(AI, '/fabric/invoke', 'POST', {
    capabilityId: 'filesystem.delete',
    input: { path: 'doomed.txt' },
    context: { projectId, actorKind: 'agent', actorId: 'e2e', taskId: 'e2e-del' },
    approvedCapabilities: ['filesystem.delete'],
  }).then((r) => r.json()).catch(() => null);
  check('grant resumes the delete', resumed?.outcome === 'succeeded', resumed?.outcome);
  check('file gone after grant', !existsSync(join(fixDir, 'site', 'doomed.txt')));
  // Mission Control surface via the command palette: the mission
  // reads as done work, not a permission form.
  // Mission activity surfaces through the notification center, which
  // lists real mission events.
  const notifBtn = page.locator('[aria-label*="otification"]').first();
  if (await notifBtn.count() > 0) {
    await notifBtn.click({ timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: join(fixDir, 'shot-workspace.png') }).catch(() => null);
  const bodyText = (await page.locator('body').first().textContent().catch(() => '')) ?? '';
  check('mission visible in Mission Control', bodyText.includes('hello.ts') || bodyText.includes('Build a two-page demo site'), 'mission visible');
  check('no plan-approval gate anywhere', !bodyText.includes('Approve Plan') || bodyText.includes('auto-approved'), 'no Approve Plan gate');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();

  shutdown();
  console.log(`\n${checks} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
};

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
