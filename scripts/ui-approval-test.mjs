/**
 * ui-approval-test — drives the REAL desktop UI through the approval gate.
 *
 * Not an endpoint test. This launches the actual app in a browser, finds
 * the rendered ApprovalGate inside Mission Control, reads what a person
 * would read off the screen, and clicks the actual buttons.
 *
 * Prerequisites (the script checks and tells you):
 *   • the AI service on :4319        — `npm run ai`
 *   • the desktop dev server on :5173 — `npm run dev`
 *
 * Usage: node scripts/ui-approval-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');

const PROJECT = process.env.UI_PROJECT ?? 'hub-login-page';
const MISSION = process.env.UI_MISSION ?? 'mission-ms99d6uv-1mr15w';
const TASK = process.env.UI_TASK ?? 'task-ms99e1xr-86upwl';

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const api = async (path, init) => {
  const r = await fetch(`${AI}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

/** Reset the task and open a fresh gate, via the service (test fixture only). */
async function armGate() {
  await post('/fabric/policy', { allowAutonomous: false });
  await post(`/projects/${PROJECT}/missions/${MISSION}/approve`);
  await post(`/projects/${PROJECT}/missions/${MISSION}/start`);
  await post(`/projects/${PROJECT}/missions/${MISSION}/tasks/${TASK}/retry`);
  await post(`/projects/${PROJECT}/missions/${MISSION}/tasks/${TASK}/run`);
  const { body } = await api('/fabric/approvals');
  return (body?.approvals ?? []).find((r) => r.taskId === TASK) ?? null;
}

/**
 * Drive the app the way a person does: dismiss onboarding, open the
 * project, open Mission Control from the command bar, pick the mission,
 * switch to its Tasks tab. No store pokes, no injected state.
 */
async function openMissionTasks(page, { fresh = true } = {}) {
  if (fresh) {
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
  }
  for (const name of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name }).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  const proj = page.getByRole('button', { name: new RegExp(PROJECT) }).first();
  if (await proj.count()) { await proj.click().catch(() => {}); await page.waitForTimeout(3500); }

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(900);
  await page.keyboard.type('Mission Control');
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  // Mission rows are titled by their text; find the row for our mission id
  // by matching the row that selects it.
  const { body: list } = await api(`/projects/${PROJECT}/missions`);
  const summary = (list?.missions ?? []).find((m) => m.id === MISSION);
  if (summary) {
    // Rows nest the title in a div; click the real clickable ancestor so
    // the event lands on the row rather than on an overlapping child.
    await page.evaluate((title) => {
      const el = [...document.querySelectorAll('div,button')]
        .filter((n) => n.textContent?.trim().startsWith(title) && n.children.length < 4)
        .pop();
      (el?.closest('button,[role="button"]') ?? el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, summary.text.slice(0, 24));
    await page.waitForTimeout(3000);
  }
  const tasksTab = page.getByRole('button', { name: /^Tasks$/i }).first();
  if (await tasksTab.count()) { await tasksTab.click().catch(() => {}); await page.waitForTimeout(2500); }
}

/**
 * Click a real button by its visible label.
 *
 * Tries a genuine pointer click first. Panel entry animations can leave a
 * neighbouring rail briefly overlapping the hit point, so on interception
 * it falls back to dispatching a bubbling click on the same element —
 * still the real button, still the real React handler.
 */
async function clickButton(page, label) {
  const btn = page.getByRole('button', { name: label }).first();
  if (!(await btn.count())) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(700);
  try {
    await btn.click({ timeout: 4000 });
    return true;
  } catch {
    return page.evaluate((text) => {
      const re = new RegExp(text, 'i');
      const el = [...document.querySelectorAll('button')].find((b) => re.test(b.innerText.trim()));
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }, label.source ?? String(label));
  }
}

async function main() {
  for (const [label, url] of [['AI service', `${AI}/fabric/capabilities`], ['desktop dev server', APP]]) {
    try { await fetch(url); } catch {
      console.error(`\n${label} is not reachable at ${url}. Start it first.\n`);
      process.exit(2);
    }
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('\n=== 1. APPROVAL REQUEST RENDERS IN MISSION DETAIL ===');
  const armed = await armGate();
  if (!armed) { console.error('could not arm an approval gate'); process.exit(2); }
  console.log(`  (service opened request ${armed.id} for ${armed.items[0].capabilityId})`);

  await openMissionTasks(page);
  const gate = page.locator('text=Authorization required').first();
  await gate.waitFor({ timeout: 20000 }).catch(() => {});
  check('gate is rendered on screen', await gate.count() > 0);

  // Read exactly what the gate itself puts on screen — walk up from the
  // heading to the gate container rather than guessing with a selector.
  const gateText = async () => page.evaluate(() => {
    const heading = [...document.querySelectorAll('span,div')]
      .find((n) => n.textContent?.trim() === 'Authorization required');
    let el = heading;
    while (el && !(el.className?.toString?.() ?? '').includes('border-attention')) el = el.parentElement;
    return (el ?? heading?.parentElement)?.innerText ?? '';
  });
  const shown = await gateText();
  check('capability displayed', shown.includes(armed.items[0].capabilityId), armed.items[0].capabilityId);
  check('risk displayed', /\b(low|medium|high) risk\b/i.test(shown));
  check('reason displayed', shown.includes(armed.summary.slice(0, 32)));
  check('intended action (Approve consequence) displayed', shown.includes('Approve') && shown.includes(armed.onAccept.slice(0, 24)));
  check('decline consequence displayed', shown.includes('Nothing runs'));
  check('policy rule displayed', shown.includes(armed.rule));
  check('Run Task button suppressed while gated', !/Run Task/.test(shown));
  await page.screenshot({ path: 'scripts/.ui-gate.png' }).catch(() => {});

  console.log('\n=== 2. REFRESH WHILE PENDING ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openMissionTasks(page);
  const afterReload = page.locator('text=Authorization required').first();
  await afterReload.waitFor({ timeout: 20000 }).catch(() => {});
  check('gate still rendered after reload', await afterReload.count() > 0);
  const { body: afterReloadApi } = await api('/fabric/approvals');
  const same = (afterReloadApi?.approvals ?? []).filter((r) => r.taskId === TASK);
  check('same approvalId preserved across refresh', same.length === 1 && same[0].id === armed.id, same[0]?.id);

  console.log('\n=== 3. NO DUPLICATE REQUESTS FROM UI ACTIVITY ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openMissionTasks(page);
  await post(`/projects/${PROJECT}/missions/${MISSION}/tasks/${TASK}/run`);
  const { body: dupes } = await api('/fabric/approvals');
  const forTask = (dupes?.approvals ?? []).filter((r) => r.taskId === TASK);
  check('exactly one pending request for the task', forTask.length === 1, `${forTask.length} found`);

  console.log('\n=== 4. APPROVE BUTTON -> SAME TASK RESUMES AND EXECUTES ===');
  check('Approve button present', await page.getByRole('button', { name: /Approve and run/i }).count() > 0);
  check('Approve button clicked', await clickButton(page, /Approve and run/i));
  await page.waitForTimeout(4000);

  const { body: mission } = await api(`/projects/${PROJECT}/missions/${MISSION}`);
  const task = (mission?.goalGraph?.tasks ?? []).find((t) => t.id === TASK);
  check('SAME taskId resumed and completed', task?.status === 'done', `${TASK} -> ${task?.status}`);

  const { body: auditA } = await api('/fabric/audit');
  const granted = (auditA?.audit ?? []).filter((r) => r.approvalId === armed.id && r.approvalDecision === 'granted');
  check('grant recorded in Fabric audit', granted.length === 1);
  const exec = (auditA?.audit ?? []).filter((r) => r.taskId === TASK && r.outcome === 'succeeded');
  check('execution recorded (task actually ran)', exec.length > 0, `${exec.length} succeeded record(s)`);
  check('verification reported', exec.length > 0 && 'verified' in exec[exec.length - 1],
    `verified=${exec[exec.length - 1]?.verified}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openMissionTasks(page);
  check('gate disappears once decided', await page.locator('text=Authorization required').count() === 0);

  console.log('\n=== 5. DECLINE FROM UI -> NOTHING EXECUTES ===');
  const armed2 = await armGate();
  if (!armed2) { console.error('could not arm second gate'); process.exit(2); }
  const beforeDecline = ((await api('/fabric/audit')).body?.audit ?? [])
    .filter((r) => r.taskId === TASK && r.outcome === 'succeeded').length;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openMissionTasks(page);
  await page.locator('text=Authorization required').first().waitFor({ timeout: 20000 }).catch(() => {});
  check('Decline button present', await page.getByRole('button', { name: /^Decline$/i }).count() > 0);
  check('Decline button clicked', await clickButton(page, /^Decline$/i));
  await page.waitForTimeout(600);
  const reasonBox = page.locator('input[placeholder*="declining"]').first();
  check('decline reason prompt shown', await reasonBox.count() > 0);
  await reasonBox.fill('Declined from the UI during validation');
  check('Confirm decline clicked', await clickButton(page, /Confirm decline/i));
  await page.waitForTimeout(3500);

  const { body: mission2 } = await api(`/projects/${PROJECT}/missions/${MISSION}`);
  const task2 = (mission2?.goalGraph?.tasks ?? []).find((t) => t.id === TASK);
  check('declined task is rejected', task2?.status === 'rejected', `${TASK} -> ${task2?.status}`);

  const afterDecline = ((await api('/fabric/audit')).body?.audit ?? [])
    .filter((r) => r.taskId === TASK && r.outcome === 'succeeded').length;
  check('declined task NEVER executed', afterDecline === beforeDecline,
    `succeeded records before=${beforeDecline} after=${afterDecline}`);

  const { body: auditB } = await api('/fabric/audit');
  const denied = (auditB?.audit ?? []).filter((r) => r.approvalId === armed2.id && r.approvalDecision === 'denied');
  check('decline recorded in Fabric audit with reason', denied.length === 1 && /Declined from the UI/.test(denied[0]?.inputSummary ?? ''));

  await page.screenshot({ path: 'scripts/.ui-declined.png' }).catch(() => {});
  await post('/fabric/policy', { allowAutonomous: true });
  await browser.close();

  console.log(`\n${failures === 0 ? 'ALL UI CHECKS PASSED' : `${failures} UI CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('UI TEST ERROR', e); process.exit(1); });
