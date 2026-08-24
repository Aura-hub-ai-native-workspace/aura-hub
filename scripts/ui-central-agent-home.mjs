/**
 * ui-central-agent-home — browser verification of the Agent-centric Home.
 *
 * Drives the REAL stack end to end: Vite dev server (:1420), the real
 * workflow/AI service (:4319) and the real Python Central Agent API
 * (:4320, started from a disposable AURA_HOME). Every assertion reads
 * what the screen actually renders against what the services actually
 * did — no mocked responses anywhere.
 *
 * Prerequisites:
 *   • AI service  :4319  — `npm run ai`
 *   • Agent API   :4320  — `python3 backend/scripts/serve_central_agent_api.py 4320`
 *                           with a DISPOSABLE AURA_HOME
 *   • Dev server  :1420  — `npm run dev`
 *
 * Usage: node scripts/ui-central-agent-home.mjs [--headed]
 */
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL ?? 'http://localhost:1420';
const AGENT = process.env.AGENT_URL ?? 'http://localhost:4320';
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
  const gateVisible = await page.isVisible('text=Authorization required');
  check('existing ApprovalGate renders inside hero', gateVisible);

  // Replay guard on the wire: deciding an already-decided request is 409.
  const approvalsRes = await api('/fabric/approvals').then((r) => r.json());
  const pendingId = approvalsRes.approvals?.[0]?.id;
  check('parked approval visible in /fabric/approvals', Boolean(pendingId), pendingId);
  if (pendingId) {
    // The canonical gate owns the decision UI — click ITS controls.
    await page.getByRole('button', { name: /Approve and run/i }).click();
    const outcome3 = await waitOutcome(page, ['Completed', 'Waiting for you', 'Failed'], 60_000);
    check('resume after approval completes', outcome3 === 'Completed', String(outcome3));
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
