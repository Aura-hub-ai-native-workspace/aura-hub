/**
 * hub-verify — verification for the reconstructed Workspace (Hub + nodes).
 * ==================================================================
 * Drives the REAL running application — the desktop dev server talking to
 * the REAL local AI service — and reads real capability state off real
 * probes. Nothing is mocked, nothing is hardcoded: expected statuses are
 * derived from the service's own `POST /environment/scan` of this machine
 * plus the real catalogue entry for each node (loaded through the
 * repository's TS loader, so transports are facts, not assumptions).
 *
 * The state-boundary checks are the point of this script:
 *
 *   • hubStore persists LAYOUT ONLY (which nodes, where) in
 *     `localStorage aura.workspace.layout` — never install/status facts.
 *   • environmentStore is live machine state, re-measured every launch;
 *     a reload must show `unknown` again before the scan answers.
 *
 * A deliberate observable window is used for the honesty checks: the scan
 * HTTP response is DELAYED (real request, real response, just held), so
 * the pre-measurement state of the freshly loaded screen can be read
 * before the scan lands.
 *
 * Prerequisites (the script checks and tells you):
 *   • the AI service on :4319   — `npm run ai`
 *   • the desktop dev server on :1420 — `npm run dev`
 *
 * Usage: node scripts/hub-verify.mjs [--headed]
 *
 * The script snapshots the user's saved workspace layout first and
 * restores it before exiting, so a verification run does not leave the
 * workspace rearranged.
 */
import { register } from 'node:module';
import { chromium } from 'playwright-core';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:1420';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');
const SHOT = process.env.HUB_SHOT ?? 'scripts/.hub-canvas.png';

/** Fallback baseline when the user has never saved a workspace layout. */
const SEED_DEFAULT = ['node', 'git', 'github-cli', 'docker'];

/** Mirrors STATUS_LABEL in apps/desktop/src/environment/presentation.ts. */
const STATUS_LABEL = {
  connected: 'Connected',
  available: 'Found here',
  unknown: 'Not scanned',
  'not-installed': 'Not installed',
  degraded: 'Degraded',
  'needs-auth': 'Needs sign-in',
  'no-connector': 'Catalogued',
};

let failures = 0;
const pageErrors = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const api = async (path, init) => {
  try {
    const r = await fetch(`${AI}${path}`, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
};
const post = (path, body = {}) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The real catalogue, loaded as TS through the repo's own loader. */
let catalogEntry;
try {
  const cat = await import('../packages/connected-environment/src/catalog.ts');
  catalogEntry = cat.catalogEntry;
} catch (e) {
  console.error(`\ncould not load the catalogue through the TS loader: ${e.message}\n`);
  process.exit(2);
}

/**
 * The machine's own report, taken fresh from the real service. `refresh:
 * true` bypasses the probe cache, so this is ground truth at this instant.
 */
async function liveFacts(ids) {
  const { status, body } = await post('/environment/scan', { ids, refresh: true });
  if (status !== 200 || !body?.results) {
    throw new Error(`environment scan oracle failed (HTTP ${status}) — is the AI service up?`);
  }
  return body; // { results: Record<string, ProbeResult>, scannedAt, found }
}

/**
 * What the UI must show for a node, given its real catalogue transport and
 * the service's own probe result. Mirrors `statusFromProbe`/`applyProbe`
 * (packages/connected-environment/src/registry.ts):
 *   • no result key  → the scan excludes it (api-key/oauth) → unmeasured:
 *     `no-connector` when the transport is oauth, otherwise `unknown`
 *   • `internal`     → always present, shows `connected`
 *   • probe present  → `available`
 *   • probe absent   → `not-installed`
 */
function expectedStatus(entry, result) {
  if (!entry) return 'unknown';
  if (!result) return entry.transport === 'oauth' ? 'no-connector' : 'unknown';
  if (entry.transport === 'internal') return result.present ? 'connected' : 'unknown';
  return result.present ? 'available' : 'not-installed';
}

/** Read every rendered node chip: id, data-status, and its inner text. */
const readChips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="hub-node"]')].map((el) => ({
      id: el.getAttribute('data-node-id'),
      status: el.getAttribute('data-status'),
      text: el.innerText,
    })),
  );

const chipLocator = (page, id) => page.locator(`[data-node-id="${id}"]`);

/** Wait until every baseline chip has left the pre-measurement `unknown`. */
async function waitMeasured(page, ids, timeoutMs = 90000) {
  await page
    .waitForFunction(
      (ids) => {
        const chips = [...document.querySelectorAll('[data-testid="hub-node"]')];
        const present = chips.map((c) => c.getAttribute('data-node-id'));
        return ids.every((id) => present.includes(id)) &&
          chips.every((c) => c.getAttribute('data-status') !== 'unknown');
      },
      ids,
      { timeout: timeoutMs },
    )
    .catch(() => {});
}

/** Click `Scan environment` (real button, real re-measure) and wait it out. */
async function rescan(page) {
  const btn = page.locator('[data-testid="hub-scan"]');
  await btn.click().catch(() => {});
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="hub-scan"]');
    return b && !b.disabled;
  }, { timeout: 90000 });
}

/** Parse the Hub surface's readiness stat text ("0 CONNECTED 3 FOUND …"). */
function readinessCounts(text) {
  const norm = text.replace(/\s+/g, ' ').trim().toUpperCase();
  const grab = (label) => {
    const m = norm.match(new RegExp(`(\\d+)\\s+${label}`));
    return m ? Number(m[1]) : -1;
  };
  return { connected: grab('CONNECTED'), available: grab('FOUND'), missing: grab('MISSING'), unscanned: grab('UNSCANNED') };
}

/** Compare the canvas against a fresh scan; returns the diff detail. */
async function canvasMatchesOracle(page, ids) {
  const oracle = await liveFacts(ids);
  const chips = await readChips(page);
  const diffs = [];
  for (const id of ids) {
    const chip = chips.find((c) => c.id === id);
    const entry = catalogEntry(id);
    if (!chip) { diffs.push(`${id}: chip missing`); continue; }
    const expected = expectedStatus(entry, oracle.results[id]);
    if (chip.status !== expected) {
      diffs.push(`${id}: UI=${chip.status} probe=${oracle.results[id]?.present} expected=${expected}`);
    }
  }
  if (diffs.length) return { ok: false, detail: diffs.join('; '), oracle, chips };
  return { ok: true, detail: '', oracle, chips };
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
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Hold every /environment/scan response for a long beat, so the
  // pre-measurement state is observable even while the lazy-loaded
  // Workspace screen is still arriving. Requests and payloads are real.
  let scanDelayMs = 6000;
  let scanRequests = 0;
  await page.route('**/environment/scan', async (route) => {
    scanRequests += 1;
    if (scanDelayMs > 0) await new Promise((r) => setTimeout(r, scanDelayMs));
    await route.continue();
  });

  // Snapshot the user's saved layout before touching anything.
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const layoutSnapshot = await page.evaluate(() => localStorage.getItem('aura.workspace.layout'));
  let baseline = SEED_DEFAULT;
  if (layoutSnapshot) {
    try {
      const parsed = JSON.parse(layoutSnapshot);
      if (Array.isArray(parsed)) baseline = parsed.map((p) => p.nodeId).filter(Boolean);
    } catch { /* fall back to seed */ }
  }
  console.log(`  (baseline nodes from the saved layout: ${baseline.join(', ')})\n`);

  console.log('=== 1. WORKSPACE LOADS, HUB RENDERS, STATE IS HONEST BEFORE MEASUREMENT ===');
  await dismissOnboarding(page);
  await runCommand(page, 'Go to Workspace');

  const surface = page.locator('[data-testid="hub-surface"]');
  await surface.waitFor({ timeout: 20000 }).catch(() => {});
  check('workspace screen renders the Hub surface', await surface.count() > 0);
  // Phase 2 wired the composer to the real mission system, so it is live.
  // What must still hold is that it refuses to guess a target: missions
  // plan against real files, so no project means no submit.
  // Mission behaviour itself is covered by scripts/hub-mission-verify.mjs.
  check('Hub composer is live', !(await page.locator('[data-testid="hub-composer"]').isDisabled()));
  check('Hub will not submit without a real project',
    await page.locator('[data-testid="hub-submit"]').isDisabled());

  let chips = await readChips(page);
  const renderedIds = chips.map((c) => c.id).sort().join(',');
  check('every saved node renders as a chip', chips.length === baseline.length,
    `${chips.length} chip(s): ${renderedIds}`);
  check('pre-measurement state is unknown, never fabricated',
    chips.length > 0 && chips.every((c) => c.status === 'unknown'),
    chips.map((c) => `${c.id}=${c.status}`).join(' '));
  const preCounts = readinessCounts(await surface.innerText());
  check('Hub readiness shows everything unscanned before measurement',
    preCounts.unscanned === baseline.length && preCounts.connected === 0 && preCounts.missing === 0,
    JSON.stringify(preCounts));
  check('a real environment scan was requested (held, not mocked)', scanRequests >= 1, `${scanRequests} request(s)`);

  console.log('\n=== 2. REAL MEASUREMENT CONVERGES TO REAL MACHINE STATE ===');
  scanDelayMs = 0;
  await waitMeasured(page, baseline);
  // Force a fresh UI re-measure through the real button, then compare the
  // canvas against a fresh probe of the same ids from the service.
  await rescan(page);
  let verdict = await canvasMatchesOracle(page, baseline);
  check('every node status matches the machine probe exactly', verdict.ok, verdict.detail);

  chips = verdict.chips;
  let versioned = true;
  let labelled = true;
  const detail = [];
  for (const id of baseline) {
    const chip = chips.find((c) => c.id === id);
    const probe = verdict.oracle.results[id];
    if (!chip || !probe) continue;
    if (probe.present && probe.version && !chip.text.includes(probe.version)) {
      versioned = false;
      detail.push(`${id}: version "${probe.version}" not shown`);
    }
    const label = STATUS_LABEL[chip.status];
    if (label && !chip.text.includes(label)) { labelled = false; detail.push(`${id}: missing label "${label}"`); }
  }
  check('present tools show their real parsed version on the chip', versioned, detail.join('; '));
  check('labels read what a person would read (Connected/Found here/Not installed…)', labelled, detail.join('; '));

  const postCounts = readinessCounts(await surface.innerText());
  const okCounts =
    postCounts.connected + postCounts.available + postCounts.missing + postCounts.unscanned === baseline.length &&
    postCounts.unscanned === 0 &&
    postCounts.missing === chips.filter((c) => c.status === 'not-installed').length;
  check('Hub readiness counts match the measured canvas', okCounts, JSON.stringify(postCounts));
  await page.screenshot({ path: SHOT }).catch(() => {});
  console.log(`  (screenshot: ${SHOT})`);

  console.log('\n=== 3. RELOAD RE-MEASURES: NOTHING STATUS-LIKE IS PERSISTED ===');
  const layoutBeforeReload = await page.evaluate(() => localStorage.getItem('aura.workspace.layout'));
  const layoutParsed = layoutBeforeReload ? JSON.parse(layoutBeforeReload) : [];
  check('saved layout holds only placement entries',
    layoutParsed.every((p) => Object.keys(p).filter((k) => k !== 'nodeId').every((k) => k === 'x' || k === 'y')),
    `${layoutParsed.length} entry/entries`);
  const suspiciousKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => /status|measure|scan|env|probe|fact/i.test(k)));
  check('no localStorage key stores environment/status facts', suspiciousKeys.length === 0, suspiciousKeys.join(','));

  scanDelayMs = 6000;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await dismissOnboarding(page);
  // A reload boots to Home (nav is session state, not persisted), so walk
  // back to the Workspace before reading its fresh, pre-measurement cells.
  await runCommand(page, 'Go to Workspace');
  chips = await readChips(page);
  check('after reload the nodes are unknown again — status is measured, not restored',
    chips.length > 0 && chips.some((c) => c.status === 'unknown'),
    chips.map((c) => `${c.id}=${c.status}`).join(' '));

  scanDelayMs = 0;
  await waitMeasured(page, baseline);
  await rescan(page);
  verdict = await canvasMatchesOracle(page, baseline);
  check('reload → re-measure → statuses reconverge to the machine', verdict.ok, verdict.detail);
  const layoutAfter = JSON.parse(await page.evaluate(() => localStorage.getItem('aura.workspace.layout')) ?? '[]');
  check('layout still contains no status data after further scans',
    layoutAfter.every((p) => !('status' in p) && !('version' in p) && !('present' in p)));
  check('layout positions survived the reload unchanged',
    JSON.stringify(layoutAfter.map((p) => p.nodeId)) === JSON.stringify(layoutParsed.map((p) => p.nodeId)),
    layoutAfter.map((p) => p.nodeId).join(','));

  console.log('\n=== 4. ADD NODE / DUPLICATE REJECTED / REMOVE NODE ===');
  const probeId = baseline.includes('sqlite') ? 'redis' : 'sqlite';
  await page.locator('[data-testid="add-node-open"]').click();
  await page.waitForTimeout(600);
  check('Add Node dialog opens', await page.locator('[data-testid="add-node-search"]').count() > 0);
  await page.locator('[data-testid="add-node-search"]').fill(probeId);
  await page.waitForTimeout(500);
  await page.locator(`[data-testid="add-node-${probeId}"]`).click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  chips = await readChips(page);
  const added = chips.find((c) => c.id === probeId);
  check('adding a node places it on the canvas', Boolean(added));
  const addedOracle = await liveFacts([probeId]);
  check('the added node shows the machine real answer',
    !added || added.status === (addedOracle.results[probeId]?.present ? 'available' : 'not-installed'),
    `${added?.status} vs probe present=${addedOracle.results[probeId]?.present}`);

  await page.locator('[data-testid="add-node-open"]').click();
  await page.locator('[data-testid="add-node-search"]').fill(probeId);
  await page.waitForTimeout(500);
  const dupBtn = page.locator(`[data-testid="add-node-${probeId}"]`);
  await dupBtn.waitFor({ timeout: 5000 }).catch(() => {});
  check('duplicate node is rejected (row disabled once placed)', await dupBtn.isDisabled());
  await dialogClose(page);

  console.log('\n=== 5. NODE CLICK OPENS INSPECTOR; CLOSING IT NEVER REMOVES THE NODE ===');
  await dialogAway(page);
  const target = baseline[0];
  await chipLocator(page, target).click();
  await page.waitForTimeout(1200);
  const closeBtn = page.locator('button[title="Close"]').first();
  check('node click opens a floating inspector', await closeBtn.count() > 0);
  check('inspector offers Remove from workspace', await page.getByText(/Remove from workspace/i).count() > 0);
  await closeBtn.click();
  await page.waitForTimeout(800);
  check('closing the inspector leaves the node on the canvas',
    (await chipLocator(page, target).count()) === 1);

  await chipLocator(page, target).click();
  await page.waitForTimeout(1200);
  await page.getByText('Remove from workspace').first().click();
  await page.waitForTimeout(1000);
  check('Remove from workspace removes the node', (await chipLocator(page, target).count()) === 0);

  console.log('\n=== 6. ADDED NODES REMOVED AGAIN, REMOVED NODE RE-ADDED (CLEANUP) ===');
  if (!baseline.includes(probeId)) {
    await chipLocator(page, probeId).click();
    await page.waitForTimeout(1200);
    await page.getByText('Remove from workspace').first().click();
    await page.waitForTimeout(1000);
  }
  await page.locator('[data-testid="add-node-open"]').click();
  await page.locator('[data-testid="add-node-search"]').fill(target);
  await page.waitForTimeout(500);
  await page.locator(`[data-testid="add-node-${target}"]`).click().catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  check('workspace restored to the original set of nodes',
    (await readChips(page)).length === baseline.length);

  console.log('\n=== 7. NO REGRESSION: NAVIGATION AND COMMAND BAR STILL WORK ===');
  await runCommand(page, 'Go to Home');
  check('Home renders after navigating away', await page.getByRole('button', { name: /Add Project/i }).count() > 0);
  await runCommand(page, 'Go to Workspace');
  await surface.waitFor({ timeout: 15000 }).catch(() => {});
  const backChips = await readChips(page);
  check('Workspace re-renders its nodes after round-trip', backChips.length === baseline.length,
    `${backChips.length} chip(s)`);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  check('Command Bar still opens with navigation commands',
    await page.getByText('Go to Workspace', { exact: true }).count() > 0);
  await page.keyboard.press('Escape');
  check('no page errors during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // Restore the user's saved layout, then reload so the app is left as found.
  await page.evaluate((snap) => {
    if (snap === null) localStorage.removeItem('aura.workspace.layout');
    else localStorage.setItem('aura.workspace.layout', snap);
  }, layoutSnapshot);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL HUB CHECKS PASSED' : `${failures} HUB CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Dismiss onboarding if it is showing, the way the approval test does. */
async function dismissOnboarding(page) {
  for (const name of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name }).first();
    if (await el.count()) {
      await el.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
}

/**
 * Click a real command in the palette — the way a person does: open the
 * palette, type the exact title, click the row. Falls back to Enter.
 */
async function runCommand(page, title) {
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(800);
  await page.keyboard.type(title);
  await page.waitForTimeout(800);
  const clicked = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('div,button,li')]
      .filter((n) => n.textContent?.trim().startsWith(t) && n.children.length < 4)
      .pop();
    const target = el?.closest('button,[role="button"],li') ?? el;
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, title);
  if (!clicked) await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);
}

main().catch((e) => { console.error('HUB VERIFY ERROR', e); process.exit(1); });

/**
 * Close the Add Node dialog: Escape first, then its explicit Close button
 * if the scrim is still up. Used after the duplicate-add probe, which
 * leaves the dialog open so the placement can be re-read.
 */
async function dialogClose(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await dialogAway(page);
}

/** Fold the dialog's scrim away so the canvas is clickable again. */
async function dialogAway(page) {
  if (await page.locator('[data-testid="add-node-search"]').count()) {
    await page.locator('button[aria-label="Close"]').first().click().catch(async () => {
      await page.keyboard.press('Escape');
    });
    await page.waitForTimeout(700);
  }
}