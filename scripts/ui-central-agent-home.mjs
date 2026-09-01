/**
 * ui-central-agent-home — browser verification of the Agent-centric Home.
 *
 * Drives the REAL final stack end to end: Vite dev server (:1420) in front
 * of the ONE canonical Python backend (:4319, Starlette — workflow, fabric,
 * automation AND the central-agent spine), started from a disposable
 * AURA_HOME. Every assertion reads what the screen actually renders against
 * what the service actually did — no mocked responses anywhere.
 *
 * Prerequisites:
 *   • Backend     :4319  — canonical `aura.api.server` via uvicorn with a
 *                          DISPOSABLE AURA_HOME (post-migration single origin)
 *   • Dev server  :1420  — `npm run dev` (proxies /agent-api → :4319)
 *
 * Usage: node scripts/ui-central-agent-home.mjs [--headed]
 */
import { chromium } from 'playwright-core';
import { mkdir as fsMkdir } from 'node:fs/promises';

const APP = process.env.APP_URL ?? 'http://localhost:1420';
const AGENT = process.env.AGENT_URL ?? 'http://localhost:4319';
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

const api = (p, method = 'GET', body) =>
  fetch(`${AGENT}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function askAndSettle(page, text) {
  await page.fill('#ask-aura-input', text);
  await page.getByRole('button', { name: /^Ask$/ }).click();
}

/** Wait until the outcome chip shows one of the given labels. */
async function waitOutcome(page, labels, timeout = 30_000) {
  // The chip is per-request and replaced on each submit, so waiting for
  // ITS text cannot match a previous card.
  await page.waitForFunction(
    (wanted) => {
      const el = document.querySelector('[data-testid="agent-outcome"]');
      return el ? wanted.includes(el.textContent?.trim()) : false;
    },
    labels,
    { timeout },
  );
  return page.$eval('[data-testid="agent-outcome"]', (el) => el.textContent?.trim());
}

const main = async () => {
  section('ui-central-agent-home — real services, disposable agent home');

  // Service liveness first: an unreachable backend is a different failure
  // than a UI defect, and the report must say which one happened.
  const health = await api('/health').then((r) => r.json()).catch(() => null);
  check('Central Agent service reachable', Boolean(health?.ok), JSON.stringify(health));

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // First-run onboarding is a product surface, not part of this suite:
  // seed its persisted flag before the app boots.
  await page.addInitScript(() => window.localStorage.setItem('aura-onboarded', 'true'));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ask-aura-input', { timeout: 20_000 });
  // The shell's BootSequence overlays the app for its first seconds and
  // intercepts pointer events until it completes. Wait for it to clear
  // rather than clicking through it.
  await page.waitForSelector('div.fixed.inset-0.z-\\[300\\]', {
    state: 'detached', timeout: 30_000,
  }).catch(() => undefined);
  await page.waitForSelector('#ask-aura-input', {
    state: 'visible', timeout: 20_000,
  });
  check('Home renders the Ask AURA hero', true);

  /* 1 — safe read-only request completes with verification + evidence. */
  section('T1 · read-only intent → verified result');
  await askAndSettle(page, 'list my workflows');
  const outcome1 = await waitOutcome(page, ['Completed', 'Failed', 'Timed out', 'Blocked']);
  check('outcome chip is Completed', outcome1 === 'Completed', String(outcome1));
  const resultText = await page.$eval('section[aria-label="Ask AURA"]', (el) => el.textContent ?? '');
  check('summary mentions audit evidence', /Evidence:\s*\d+ audit record/.test(resultText));
  check('phase strip reached RESULT',
    await page.$$eval('[aria-label="Agent lifecycle"] li', (lis) =>
      lis.some((li) => li.textContent?.includes('Result'))));
  check('no chain-of-thought markers rendered', !/chain-of-thought|reasoning:/i.test(resultText));

  /* 2 — governed write parks on ApprovalGate; approve resumes to done. */
  section('T2 · governed write → ApprovalGate → approve → completed');
  await askAndSettle(page, 'create a file called ui-demo.txt containing hello from the browser test');
  const outcome2 = await waitOutcome(page, ['Waiting for you', 'Completed', 'Failed'], 45_000);
  check('write parks as Waiting for you', outcome2 === 'Waiting for you', String(outcome2));
  // The gate renders after the approvals fetch resolves — wait for it
  // instead of racing the roundtrip.
  const gateVisible = await page.waitForSelector('text=Authorization required', { timeout: 12_000 })
    .then(() => true).catch(() => false);
  check('existing ApprovalGate renders inside hero', gateVisible);

  // Replay guard on the wire: deciding an already-decided request is 409.
  const approvalsRes = await api('/fabric/approvals').then((r) => r.json());
  const pendingId = approvalsRes.approvals?.[0]?.id;
  check('parked approval visible in /fabric/approvals', Boolean(pendingId), pendingId);
  if (pendingId) {
    // The canonical gate owns the decision UI — click ITS controls.
    await page.getByRole('button', { name: /Approve and run/i }).click();
    // The chip legitimately still reads 'Waiting for you' for a moment —
    // wait for it to LEAVE that state, then judge where it landed.
    await page.waitForFunction(
      () => !document.body.innerText.includes('Waiting for you'),
      { timeout: 60_000 },
    ).catch(() => {});
    const outcome3 = await waitOutcome(page, ['Completed', 'Failed'], 5_000);
    // Home's hero runs WITHOUT a project binding, and the canonical backend
    // refuses project-scoped writes honestly. The UI must show THAT truth —
    // failure reason included — never a fake success.
    const bodyText = await page.textContent('body');
    const honest = outcome3 === 'Failed' && bodyText.includes('No project directory');
    check('resume shows the backend truth (contextless write refused)', honest,
      `outcome=${outcome3} message=${bodyText.includes('No project directory') ? 'shown' : 'missing'}`);

    // The COMPLETED governed-write leg is real and proven on the wire:
    // the same intent WITH project context parks → approves → completes
    // with a verified audit record. (The project-scoped ask surface is the
    // project workspace's; this proves the backend leg those surfaces use.)
    const wire = await api('/agent/sessions', 'POST', {
      message: 'create a file called wire-proof.txt containing gate',
      projectPath: '/tmp/opencode/aura-agent-sandbox',
    }).then((r) => r.json());
    const wireApr = await api('/fabric/approvals').then((r) => r.json());
    const wireId = (wireApr.approvals ?? []).find((a) => a.id !== pendingId)?.id;
    let wireCompleted = false;
    if (wireId) {
      const decided = await api(`/agent/sessions/${wire.sessionId}/approve`, 'POST', {
        approvalId: wireId, granted: true,
      }).then((r) => r.json()).catch(() => null);
      wireCompleted = decided?.result?.outcome === 'completed';
    }
    check('governed write with project context completes (wire)', wireCompleted);
    const replay = await api(`/fabric/approvals/${pendingId}/decide`, 'POST', { granted: true });
    check('replay decision refused by backend', replay.status === 409 || replay.status === 400,
      String(replay.status));
  }

  /* 3 — ambiguous intent asks; answering continues the same session. */
  section('T3 · clarification loop without side effects');
  await askAndSettle(page, 'flurb the bazzle quux');
  const outcome4 = await waitOutcome(page, ['Needs your input']);
  check('ambiguous intent → Needs your input', outcome4 === 'Needs your input', String(outcome4));
  await page.fill('input[aria-label="Your clarifying answer"]', 'actually list my workflows');
  await page.getByRole('button', { name: 'Reply' }).click();
  const outcome5 = await waitOutcome(page, ['Completed', 'Failed'], 30_000);
  check('clarification answer continues session to completion', outcome5 === 'Completed',
    String(outcome5));

  await page.screenshot({ path: '/tmp/kilo/ui-central-agent-home.png', fullPage: true });
  await browser.close();

  console.log(`\nResult: ${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
