/**
 * workspace-canvas-verify — the two pre-Phase-C prerequisites.
 * ==================================================================
 * PART A — Audit Defect #1: the orphaned Workspace canvas.
 *
 *   `layoutStore.openPanel()` is called from ten modules and roughly
 *   nineteen command-palette entries. The only component that rendered
 *   those windows was `WorkspaceCanvas`, and NOTHING imported it — so
 *   every one of those commands mutated a store no mounted component
 *   read. The panels existed, worked, and were unreachable.
 *
 *   Case 1 drives the real command palette and asserts a window actually
 *   appears. Against the pre-fix build this fails, which is the point.
 *
 * PART B — the Workspace canvas must obey the canonical state model.
 *   Windows are project-agnostic containers whose CONTENT resolves a
 *   project at render time, so a window left open across a project switch
 *   would repaint with the new project's data under the old project's
 *   heading. Case 2 asserts the switch retires them.
 *
 * PART C — Home's Ask AURA must reach the real /ask path.
 *   It used to answer from a regex table of canned strings. Case 3 asks a
 *   question the mock had a hard-coded answer for and asserts that the
 *   canned text is GONE and the real service's own words appear instead.
 *
 * Usage:
 *   npm run dev                                    # UI on :1420
 *   AURA_HOME=<isolated> node .aura/ai-service.mjs # service on :4319
 *   node scripts/workspace-canvas-verify.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');

const UI = process.env.HUB_UI ?? 'http://localhost:1420';
const API = process.env.HUB_API ?? 'http://127.0.0.1:4319';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const api = async (p) => (await fetch(`${API}${p}`)).json();

const projects = (await api('/projects')).projects ?? [];
if (projects.length < 2) {
  console.error(`FATAL  need at least two registered projects; found ${projects.length}.`);
  process.exit(1);
}
const [projA, projB] = projects;

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Open the ⌘K palette, run a command by its visible title. */
async function runCommand(title) {
  await page.keyboard.press('Control+k');
  const input = page.locator('input[placeholder*="Search actions"]');
  await input.waitFor({ timeout: 8000 });
  await input.fill(title);
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
}

const windowCount = () => page.locator('[data-testid="workspace-window"]').count();

try {
  await page.goto(UI);
  await page.evaluate((id) => {
    localStorage.setItem('aura-onboarded', 'true');
    localStorage.setItem('aura.activeProjectId', id);
  }, projA.id);
  await page.goto(UI);
  await page.waitForFunction(() => !document.querySelector('div.fixed.inset-0.z-\\[300\\]'), { timeout: 25000 });
  await page.waitForTimeout(1200);

  /* ── PART A — the canvas is mounted and the commands work ───────── */

  check('0. no windows are open to begin with', (await windowCount()) === 0);

  await runCommand('Open Mission Control');
  const afterMissionControl = await windowCount();
  check('1. THE DEFECT — a palette command actually opens a window',
    afterMissionControl === 1, `windows=${afterMissionControl}`);

  const kind = await page.locator('[data-testid="workspace-window"]').first().getAttribute('data-panel-kind');
  check('1b. and it is the panel that was asked for', kind === 'missions', `kind=${kind}`);

  check('1c. the command navigated to the Workspace, per the nav authority',
    await page.evaluate(() => !!document.querySelector('[data-testid="hub-surface"]')));

  await runCommand('Open Knowledge');
  const two = await windowCount();
  check('1d. a second panel opens alongside the first', two === 2, `windows=${two}`);

  /* ── PART B — the canvas follows the canonical project ──────────── */

  const activeBefore = await page.evaluate(() => localStorage.getItem('aura.activeProjectId'));
  check('2a. the active project is the canonical one', activeBefore === projA.id, `active=${activeBefore}`);

  // Switch project through the Hub's picker — the real user path, which
  // goes through `setActiveProject` on the one authority.
  await page.getByTestId('hub-project').selectOption(projB.id);
  await page.waitForTimeout(1200);

  const activeAfter = await page.evaluate(() => localStorage.getItem('aura.activeProjectId'));
  check('2b. the switch moved the canonical pointer', activeAfter === projB.id, `active=${activeAfter}`);

  const afterSwitch = await windowCount();
  check('2. windows do NOT survive a project switch',
    afterSwitch === 0, `windows still open=${afterSwitch}`);

  // And the canvas still works for the new project — retiring windows must
  // not leave the canvas dead.
  await runCommand('Open Mission Control');
  check('2c. the canvas still opens windows for the new project',
    (await windowCount()) === 1, `windows=${await windowCount()}`);

  /* ── PART C — Home's Ask AURA reaches the real service ──────────── */

  await runCommand('Go to Home');
  await page.waitForTimeout(600);

  await page.getByRole('button', { name: /Ask AURA/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(800);

  const composer = page.locator('textarea[placeholder*="Ask AURA anything"]');
  await composer.waitFor({ timeout: 8000 });

  /* Record outbound calls directly.
     `performance.getEntriesByType('resource')` is not dependable here: the
     Vite dev server loads hundreds of modules and overflows the default
     250-entry resource-timing buffer, silently dropping the very entry
     being looked for. Wrapping fetch observes the call itself. */
  await page.evaluate(() => {
    window.__auraCalls = [];
    const original = window.fetch;
    window.fetch = (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      window.__auraCalls.push(String(url));
      return original.apply(window, args);
    };
  });

  // A question the mock answered from its table. Its canned reply began
  // "AURA Hub is a **monorepo**" — if that string comes back, the mock is
  // still wired in.
  await composer.fill('Explain the AURA Hub architecture');
  await page.keyboard.press('Enter');

  // The real path either streams an answer or reports a real failure.
  // Both are acceptable; a canned answer is not.
  await page.waitForSelector('[data-testid="ask-aura-answer"], [data-testid="ask-aura-error"]', { timeout: 45000 });
  await page.waitForTimeout(1500);

  const reply = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="ask-aura-error"]')
      ?? [...document.querySelectorAll('[data-testid="ask-aura-answer"]')].pop();
    return el ? el.textContent ?? '' : '';
  });

  check('3. Ask AURA produced a response from the real path',
    reply.trim().length > 0, `"${reply.slice(0, 120)}"`);
  check('3b. the mock\'s canned architecture answer is GONE',
    !/monorepo with a workspace-based architecture/i.test(reply)
    && !/packages\/ui — the shared design system/i.test(reply),
    `"${reply.slice(0, 120)}"`);
  check('3c. the mock\'s generic fallback is GONE',
    !/For a precise answer grounded in real data, open a project/i.test(reply));

  // With no provider configured the service says so, in its own words.
  // That IS the real path answering — the mock could never produce it.
  const realServiceVoice = /No AI provider connected|provider|Service unreachable|model/i.test(reply);
  check('3d. the response is in the service\'s voice, not the chatbox\'s',
    realServiceVoice, `"${reply.slice(0, 160)}"`);

  const calls = await page.evaluate(() => window.__auraCalls ?? []);
  const hit = calls.find((u) => u.includes('/stream') || u.includes('/ask'));
  check('3e. the chatbox actually called the service',
    !!hit, hit ?? `observed: ${calls.join(', ').slice(0, 200) || '(none)'}`);

  /* ── 4. no uncaught errors ──────────────────────────────────────── */
  check('4. no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
} catch (e) {
  check('suite completed without throwing', false, e?.message ?? String(e));
} finally {
  await browser.close();
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
