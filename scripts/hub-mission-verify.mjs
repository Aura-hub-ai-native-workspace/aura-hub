/**
 * hub-mission-verify — proves the Hub is a real front door to AURA's
 * existing mission engine, not a textbox that looks like one.
 * ==================================================================
 * Drives the REAL running desktop app against the REAL ai-service. The
 * decisive checks are the ones that compare what the UI did against what
 * the SERVICE independently reports:
 *
 *   • a mission typed into the Hub must appear in `GET /projects/:id/missions`
 *     with the exact text submitted — proving it reached `runMissionCreation`
 *     rather than any local imitation of it;
 *   • the mission id shown by the Hub must be the id the service stored —
 *     proving one mission model, not two;
 *   • the Hub's phase must track the record's canonical state;
 *   • a provider/planning failure must surface, not be swallowed.
 *
 * Nothing here asserts a *successful* plan: whether the LLM pipeline
 * succeeds depends on a live provider. The test asserts the mission was
 * genuinely handed to the real system and that the outcome — success or
 * failure — is reported honestly.
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/Groot/aura-hub/package.json')('playwright-core');

const UI = process.env.HUB_UI ?? 'http://localhost:1420';
const API = process.env.HUB_API ?? 'http://localhost:4319';
const S = '/tmp/claude-1000/-home-Groot-aura-hub/615b7fbc-bd62-488e-a4fb-ca66447d02b9/scratchpad';
/**
 * Which project to plan against. Run it twice to cover both outcomes:
 *   HUB_PROJECT=verify          → a project whose path is gone (honest failure)
 *   HUB_PROJECT=hub-login-page  → a real project on disk (planning path)
 */
const PROJECT = process.env.HUB_PROJECT ?? 'verify';
const EXPECT = process.env.HUB_EXPECT ?? 'any'; // 'failure' | 'plan' | 'any'
const MISSION_TEXT = `Add a health check endpoint and document it [hub-verify ${Date.now()}]`;

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const api = async (p) => (await fetch(`${API}${p}`)).json();

/** Missions the service knows about, independently of the UI. */
const serviceMissions = async () => (await api(`/projects/${PROJECT}/missions`)).missions ?? [];

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  /* ── ground truth BEFORE the UI does anything ─────────────────── */
  const before = await serviceMissions();
  console.log(`service missions before: ${before.length}\n`);

  await page.goto(UI);
  await page.evaluate(() => {
    localStorage.setItem('aura-onboarded', 'true');
    // Start with NO project selected. The Hub's own `aura.workspace.projectId`
    // is retired; the shell's single active-project key is what must be clear.
    localStorage.removeItem('aura.activeProjectId');
  });
  await page.goto(UI);
  await page.waitForFunction(() => !document.querySelector('div.fixed.inset-0.z-\\[300\\]'), { timeout: 25000 });
  await page.waitForTimeout(1000);

  /* ── 1. open the Workspace ────────────────────────────────────── */
  await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Workspace$/ }).first().click({ timeout: 10000 });
  await page.waitForSelector('[data-testid="hub-surface"]', { timeout: 15000 });
  check('1. Workspace opens with the Hub', true);

  /* ── 2. the composer is genuinely editable ────────────────────── */
  const composer = page.getByTestId('hub-composer');
  const disabledBefore = await composer.isDisabled();
  check('2. composer is enabled (no longer the phase-1 disabled state)', !disabledBefore);

  const bodyText = await page.evaluate(() => document.body.innerText);
  check('2b. the "lands in the next phase" message is gone',
    !/lands in the next phase/i.test(bodyText));

  /* ── 3. typing works, including multiline ─────────────────────── */
  await composer.click({ timeout: 8000 });
  await composer.fill('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  const typed = await composer.inputValue();
  check('3. accepts typing and Shift+Enter multiline', typed.includes('\n'), JSON.stringify(typed));

  /* ── honest refusal to guess a project ────────────────────────── */
  const submitDisabledNoProject = await page.getByTestId('hub-submit').isDisabled();
  check('3b. cannot submit without a project (no invented target)', submitDisabledNoProject);

  /* ── 4. choose a real project and submit ──────────────────────── */
  await page.getByTestId('hub-project').selectOption(PROJECT);
  await page.waitForTimeout(400);
  await composer.fill(MISSION_TEXT);
  const canSubmit = !(await page.getByTestId('hub-submit').isDisabled());
  check('4. submit enables once a real project is chosen', canSubmit);

  await page.getByTestId('hub-submit').click({ timeout: 8000 });

  /* ── 5+6. the EXISTING mission system receives it ─────────────── */
  let created = null;
  for (let i = 0; i < 90; i++) {
    const now = await serviceMissions();
    created = now.find((m) => m.text === MISSION_TEXT) ?? null;
    if (created) break;
    await page.waitForTimeout(1000);
  }
  check('5. the existing mission system received the prompt',
    !!created, created ? `service stored mission ${created.id}` : 'no mission appeared in the service');
  check('6. a real MissionRecord exists for it',
    !!created && typeof created.createdAt === 'string' && created.projectId === PROJECT,
    created ? `projectId=${created.projectId} createdAt=${created.createdAt}` : '');

  /* the Hub shows a live phase while this happens */
  const phases = new Set();
  for (let i = 0; i < 12; i++) {
    phases.add(await page.getByTestId('hub-surface').getAttribute('data-phase'));
    await page.waitForTimeout(700);
  }
  console.log(`  observed Hub phases: ${[...phases].join(' → ')}`);
  check('7. the Hub reports real phases (not stuck idle)',
    [...phases].some((p) => p && p !== 'idle'), [...phases].join(','));

  /* wait for the pipeline to settle either way */
  let settled = null;
  for (let i = 0; i < 240; i++) {
    const p = await page.getByTestId('hub-surface').getAttribute('data-phase');
    if (['awaiting-approval', 'preparing', 'completed', 'failed'].includes(p)) { settled = p; break; }
    await page.waitForTimeout(1000);
  }
  const detail = await page.getByTestId('hub-detail').innerText().catch(() => '');
  console.log(`  settled phase: ${settled} — "${detail}"`);

  /* ── 7. exactly one mission model ─────────────────────────────── */
  const after = await serviceMissions();
  check('8. exactly one mission was created, not two',
    after.length === before.length + 1, `${before.length} → ${after.length}`);

  const record = created ? await api(`/projects/${PROJECT}/missions/${created.id}`) : null;
  if (record && !record.error) {
    const canonical = record.execution?.status ?? null;
    console.log(`  record: approval=${record.approval?.status} execution=${canonical} tasks=${record.goalGraph?.tasks?.length ?? 0}`);
    // The phase the UI shows must be a reading of this record, never its own state.
    const consistent =
      settled === 'failed'
        ? !!record.error || !record.goalGraph
        : settled === 'awaiting-approval'
          ? record.approval?.status === 'pending'
          : true;
    check('9. the Hub phase matches the record\'s canonical state', consistent,
      `phase=${settled} approval=${record.approval?.status}`);
  }

  /* ── 9. errors surface honestly ───────────────────────────────── */
  if (settled === 'failed') {
    const errVisible = await page.getByTestId('hub-error').isVisible().catch(() => false);
    const errText = errVisible ? await page.getByTestId('hub-error').innerText() : '';
    // The banner must carry the real reason, not a generic apology.
    check('10. a planning failure is shown in the error banner', errVisible, `banner="${errText}"`);
    check('10b. the banner states the real reason', errText.trim().length > 10, `banner="${errText}"`);
  } else {
    console.log('SKIP  10. planning did not fail — nothing to surface');
  }

  if (EXPECT === 'failure') {
    check('E. expected an honest failure for a project whose path is gone', settled === 'failed', `settled=${settled}`);
  }
  /* The Fabric's approval queue is global. Whatever the Hub says must be
     attributable to THIS mission — never borrowed from another one. */
  const allApprovals = (await api('/fabric/approvals')).approvals ?? [];
  const foreign = allApprovals.filter((a) => a.state === 'pending' && a.missionId !== created?.id);
  if (foreign.length > 0) {
    check('9b. the Hub does not report another mission\'s approval as its own',
      !foreign.some((a) => a.summary && a.summary === detail),
      `${foreign.length} unrelated pending request(s); detail="${detail}"`);
  } else {
    console.log('SKIP  9b. no unrelated pending approvals to confuse it with');
  }

  if (EXPECT === 'plan') {
    check('E. expected a real plan for a project that exists',
      settled === 'awaiting-approval' || settled === 'preparing',
      `settled=${settled} detail="${detail}"`);
  }

  /* ── 8. workspace stays responsive ────────────────────────────── */
  const nodesVisible = await page.locator('[data-testid="hub-node"]').count();
  await page.getByTestId('add-node-open').click({ timeout: 8000 });
  const dialogOpen = await page.getByTestId('add-node-search').isVisible({ timeout: 6000 }).catch(() => false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('11. Workspace stays responsive during/after a mission',
    nodesVisible > 0 && dialogOpen, `${nodesVisible} nodes, Add-node dialog opened=${dialogOpen}`);

  await page.screenshot({ path: `${S}/hub-mission.png` });

  /* ── 10. existing flows still work ────────────────────────────── */
  await page.getByRole('button', { name: /^Home$/ }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const homeOk = (await page.evaluate(() => document.body.innerText)).length > 200;
  check('12. Home still works', homeOk);

  await page.getByRole('button', { name: /^Connected Environment$/ }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const envOk = await page.evaluate(() => document.body.innerText.length > 200);
  check('13. Connected Environment still works', envOk);

  await page.getByRole('button', { name: /^Workspace$/ }).first().click({ timeout: 10000 });
  await page.waitForSelector('[data-testid="hub-surface"]', { timeout: 12000 });
  const backText = await page.getByTestId('hub-composer').inputValue();
  check('14. returning to the Workspace still renders the Hub', true, `composer="${backText}"`);

  check('15. no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  console.log(`ERROR ${e.message.split('\n')[0]}`);
  failed = true;
  await page.screenshot({ path: `${S}/hub-mission-error.png` }).catch(() => {});
} finally {
  await browser.close();
}
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
