/**
 * ui-workflow-test — drives the REAL Workflow Automation UI.
 *
 * Not an endpoint test and not a snapshot test. This launches the actual
 * app in a browser, navigates the way a person does, and reads what a
 * person would read off the screen.
 *
 * Prerequisites:
 *   • the AI service on :4319         — `npm run ai`
 *   • the desktop dev server on :1420 — `npm run dev`
 *
 * Usage: node scripts/ui-workflow-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:1420';
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

/** Dismiss onboarding and land on the Automation screen. */
async function openAutomation(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  for (const name of [/^Begin$/i, /Continue in Offline Mode/i, /^Get started$/i, /^Enter AURA$/i]) {
    const el = page.getByRole('button', { name }).first();
    if (await el.count().then((n) => n > 0).catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(900);
    }
  }
  // The rail collapses to icons, and those buttons carry no accessible
  // name (a pre-existing LeftNav gap). Expand it first so navigation is
  // reachable the way a keyboard or screen-reader user would need.
  const expand = page.getByRole('button', { name: /Expand sidebar/i }).first();
  if (await expand.count() > 0) {
    await expand.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  // A workflow runs against the open project, so open one first — the
  // editor refuses to run without one, which is itself correct behaviour.
  const project = page.getByRole('button', { name: /aura-hub/ }).first();
  if (await project.count() > 0) {
    await project.click().catch(() => {});
    await page.waitForTimeout(3500);
  }

  const nav = page.getByRole('button', { name: /^Automation$/ }).first();
  await nav.click({ timeout: 15000 });
  await page.waitForTimeout(2500);
}

async function main() {
  for (const [name, url] of [['AI service', `${AI}/health`], ['dev server', APP]]) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) {
      console.error(`\n${name} is not answering at ${url}. Start it first.\n`);
      process.exit(2);
    }
  }

  const { workflows } = await api('/workflows');
  const { specs } = await api('/workflows/specs');
  const caps = await api('/fabric/capabilities');
  const withNodes = workflows.find((w) => w.nodeCount > 3);
  const empty = workflows.find((w) => w.nodeCount === 0);

  const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The console's "Failed to load resource … 404" line names no URL, so it
  // is not actionable on its own; the response listener below is the signal
  // that can be acted on, and the two would otherwise double-count.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const httpFailures = [];
  page.on('response', (r) => {
    // /favicon.ico is a dev-server artifact: index.html declares no icon.
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) httpFailures.push(`HTTP ${r.status()} ${r.url()}`);
  });

  try {
    section('Automation domain — three standing surfaces');
    await openAutomation(page);

    for (const label of ['Automations', 'Runs', 'Approvals']) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${label}`) }).first();
      check(`the "${label}" surface exists`, await tab.count() > 0);
    }

    const body = await page.textContent('body');
    check('the library lists the real workflows', body.includes(workflows[0].name), workflows[0].name);

    section('Library cards carry state, not just a node count');
    const cardText = await page.textContent('body');
    const hasPermissionSummary = /reads only|changes your project|actions need you|high-risk actions|no effects outside AURA|irreversible action/.test(cardText);
    check('a permissions summary is rendered on cards', hasPermissionSummary);

    section('Runs surface');
    await page.getByRole('tab', { name: /^Runs/ }).first().click();
    await page.waitForTimeout(700);
    const runsText = await page.textContent('body');
    check(
      'the run list says where it comes from',
      runsText.includes('No runs recorded yet') || runsText.includes('Covers the workflows currently in your library'),
    );
    check(
      'the run list states its own scale',
      /No runs recorded yet|across your workflows/.test(runsText),
    );

    section('Approvals surface — the real Fabric store');
    await page.getByRole('tab', { name: /^Approvals/ }).first().click();
    await page.waitForTimeout(900);
    const apprText = await page.textContent('body');
    const live = await api('/fabric/approvals');
    const pending = (live.approvals ?? []).filter((a) => a.state === 'pending');
    check(
      'the approvals surface matches the service',
      pending.length > 0
        ? apprText.includes('Authorization required')
        : apprText.includes('Nothing is waiting on you'),
      `${pending.length} pending on the service`,
    );
    check(
      'the inbox says where requests come from',
      apprText.includes("a workflow's governed node, an agent step"),
    );
    check(
      'and why a decided request leaves the list',
      apprText.includes('returns pending requests'),
    );

    section('Editor — validation gates the Run button');
    await page.getByRole('tab', { name: /^Automations/ }).first().click();
    await page.waitForTimeout(600);
    if (empty) {
      await page.getByText(empty.name, { exact: true }).first().click();
      await page.waitForTimeout(1600);
      const t = await page.textContent('body');
      check('an empty graph reports the real reason', t.includes('This workflow has no nodes'), t.includes('problem') ? 'strip present' : '');
      const runBtn = page.getByRole('button', { name: /^Run/ }).first();
      check('Run is disabled while the graph cannot run', await runBtn.isDisabled().catch(() => false));
      await page.getByRole('button', { name: /^Library$/ }).first().click();
      await page.waitForTimeout(1200);
    } else {
      check('an empty workflow exists to test with', false, 'skipped — none in the registry');
    }

    section('Editor — the real graph');
    await page.getByText(withNodes.name, { exact: true }).first().click();
    await page.waitForTimeout(1800);

    for (const label of ['Design', 'Runs', 'Versions', 'Permissions']) {
      check(`the "${label}" view exists`, await page.getByRole('tab', { name: new RegExp(`^${label}`) }).count() > 0);
    }

    section('Node library — search-first');
    // At 1440px the palette starts collapsed so the canvas keeps the width.
    // Expanding it is the same gesture a person makes.
    const showPalette = page.getByRole('button', { name: /Show the node library/i }).first();
    const wasCollapsed = await showPalette.count() > 0;
    check('the palette collapses to a rail on a laptop-width window', wasCollapsed);
    if (wasCollapsed) { await showPalette.click(); await page.waitForTimeout(600); }
    const search = page.getByPlaceholder('Search nodes…').first();
    check('the palette has a search field', await search.count() > 0);
    await search.fill('commit');
    await page.waitForTimeout(500);
    const paletteText = await page.textContent('body');
    // Scope the assertion to the palette: the canvas may legitimately
    // contain a node whose label the search filtered out of the list.
    const palette = await page.locator('input[placeholder="Search nodes…"]').first()
      .evaluate((el) => el.closest('div.flex.w-\\[240px\\]')?.textContent ?? '');
    check('search narrows the palette', palette.includes('Git Commit') && !palette.includes('Current Conversation'), palette.slice(0, 80));
    await search.fill('');
    await page.waitForTimeout(400);

    section('Node inspector — effect, risk and governance');
    // Click the first node card on the canvas.
    const node = page.locator('[data-inport]').first();
    if (await node.count() > 0) {
      const box = await node.boundingBox();
      await page.mouse.click(box.x + 80, box.y + 8);
      await page.waitForTimeout(600);
    }
    const inspText = await page.textContent('body');
    check('the inspector states what the node does', inspText.includes('Effect'));
    check('port shape is stated in words', /in: (none|one|many)/.test(inspText));

    section('Versions — append-only history');
    await page.getByRole('tab', { name: /^Versions/ }).first().click();
    await page.waitForTimeout(1000);
    const verText = await page.textContent('body');
    const servedVersions = await api(`/workflows/${withNodes.id}/versions`);
    check(
      'the version list matches the service',
      (servedVersions.versions ?? []).length > 0
        ? servedVersions.versions.every((v) => verText.includes(v.graphHash))
        : verText.includes('No versions yet'),
      `${(servedVersions.versions ?? []).length} versions`,
    );
    check('restoring is described as append-only', verText.includes('publishes a new version rather than rewinding') || verText.includes('No versions yet'));

    section('Permission Envelope — from the service manifest');
    await page.getByRole('tab', { name: /^Permissions/ }).first().click();
    await page.waitForTimeout(900);
    const envText = await page.textContent('body');
    check('the envelope states what the workflow can do', envText.includes('What this workflow can do'));
    check('the envelope states what it cannot do', envText.includes('What it cannot do'));
    check('the "cannot" line is a real sentence', /This workflow cannot .+\./.test(envText));
    check(
      'risk is attributed to the service, not asserted locally',
      envText.includes('Computed by the local service'),
    );
    // The service computes the envelope, so the check is that the UI shows
    // exactly what the service said — not that any particular workflow has
    // a governed capability.
    const served = await api(`/workflows/${withNodes.id}/envelope`);
    const env = served.envelope;
    check('the envelope matches the service', envText.includes(env.cannot), env.cannot?.slice(0, 60));
    check(
      'every capability the service listed is shown',
      env.capabilities.every((c) => envText.includes(c.capabilityId)),
      `${env.capabilities.length} capabilities`,
    );

    section('Agentic AI Node — authority made explicit');
    await page.getByRole('tab', { name: /^Design$/ }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Agent node/ }).first().click();
    await page.waitForTimeout(900);
    const agentText = await page.textContent('body');
    check('the agent panel opens', agentText.includes('Agentic AI Node'));
    // Availability is the service's answer, so the assertion is that the
    // badge agrees with the served spec — not that it says either thing.
    const agentSpecServed = (await api('/workflows/specs')).specs.find((sp) => sp.type === 'agent');
    check(
      'the availability badge matches the served spec',
      agentSpecServed?.disabled
        ? agentText.includes('disabled by the service')
        : agentText.includes('enabled'),
      `spec.disabled = ${JSON.stringify(agentSpecServed?.disabled)}`,
    );
    check('the bounds are shown as a worst case', agentText.includes('Worst case'));
    /* The no-provider warning is conditional on the SERVICE's answer, so
       it must agree with `/health` in both directions. A notice that
       showed regardless would be permanent noise on a working install,
       which is the failure mode this asserts against. The other side of
       the same claim is covered by `ui-agent-noprovider-test.mjs`, which
       runs a real keyless service. */
    const providerHealth = await api('/health');
    check(
      'the provider notice agrees with /health',
      providerHealth.key?.configured
        ? !agentText.includes('No AI provider is connected')
        : agentText.includes('No AI provider is connected'),
      `key.configured = ${JSON.stringify(providerHealth.key?.configured)}`,
    );


    // Bounds and tools now come from the service's own agent contract, and
    // tools are scoped to THIS workflow's authority rather than the whole
    // manifest — so the assertions check the service's answer for it.
    const agentBounds = await api('/agent/bounds');
    check(
      'the service ceilings are disclosed',
      agentText.includes(`max ${agentBounds.ceilings.maxIterations}`),
      `max ${agentBounds.ceilings.maxIterations}`,
    );
    check('the clamping rule is explained', agentText.includes('a bound a definition can raise is not a bound'));

    const agentTools = await api(`/agent/tools?workflowId=${withNodes.id}`);
    check(
      'the tool list is the service’s answer for this workflow',
      agentTools.allowed.length
        ? agentTools.allowed.every((t) => agentText.includes(t))
        : agentText.includes('no governed capability'),
      agentTools.allowed.length ? agentTools.allowed.join(',') : 'none — reasoning only',
    );
    check(
      'refusals carry the service’s reason',
      agentTools.refused.every((r) => agentText.includes(r.capabilityId)),
      `${agentTools.refused.length} refused`,
    );
    check('the three termination ports are named', agentText.includes('needs-human'));

    const traceTab = page.getByRole('tab', { name: /^trace/i }).first();
    if (await traceTab.count() > 0) {
      await traceTab.click();
      await page.waitForTimeout(500);
      const traceText = await page.textContent('body');
      check('no example trace is invented', traceText.includes('No trace to show'));
      check('the nine beats are documented', traceText.includes('Observation') && traceText.includes('Intervention'));
    }

    section('Running a real workflow');
    await page.getByRole('button', { name: /Agent node/ }).first().click();
    await page.waitForTimeout(300);
    const runsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('aura.workflow.runs.v1') ?? '[]').length);
    const runBtn = page.getByRole('button', { name: /^Run/ }).first();
    const runnable = !(await runBtn.isDisabled().catch(() => true));
    if (runnable) {
      await runBtn.click();
      await page.waitForTimeout(1200);
      const dlg = page.getByRole('button', { name: /^Run$/ }).last();
      if (await page.locator('text=This workflow asks for input').count() > 0) {
        await dlg.click();
      }
      await page.waitForTimeout(9000);
      const runText = await page.textContent('body');
      check('the run panel shows step progress', /\d+\/\d+ steps/.test(runText));
      check('an outcome is reported', /Completed|Failed|Running|Cancelled/.test(runText));
      check('evidence is offered', runText.includes('Evidence'));

      const mid = await api(`/workflows/${withNodes.id}/runs`);
      check('the run was recorded by the service', (mid.runs ?? []).length > runsBefore, `${runsBefore} → ${(mid.runs ?? []).length}`);

      // The service persists runs, so history is verified against it.
      const after = await api(`/workflows/${withNodes.id}/runs`);
      const latest = (after.runs ?? [])[0];
      check('the service recorded the run', Boolean(latest), latest?.id);
      check('the run names the version it executed', Boolean(latest?.versionId), latest?.versionId);

      await page.getByRole('tab', { name: /^Runs/ }).first().click();
      await page.waitForTimeout(1200);
      const histText = await page.textContent('body');
      check('the run appears in this workflow’s history', latest ? histText.includes(latest.versionId) : false);
    } else {
      check('the workflow could be run', false, 'Run was disabled — validation blocked it');
    }

    section('Theme and accessibility');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('dark theme repaints the canvas', bg.includes('11, 13, 17') || bg.includes('rgb(11'), bg);
    const labelled = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, input, [role="tab"]')];
      const bad = els.filter((e) => !e.textContent.trim() && !e.getAttribute('aria-label') && !e.getAttribute('title'));
      return { total: els.length, bad: bad.length };
    });
    check('interactive elements are labelled', labelled.bad === 0, `${labelled.bad}/${labelled.total} unlabelled`);

    const tabRoles = await page.locator('[role="tab"]').count();
    check('tabs use the tab role', tabRoles > 0, `${tabRoles} tabs`);

    section('Console and network health');
    const real = errors.filter((e) => !/ResizeObserver|Download the React DevTools/.test(e));
    check('no page errors during the whole flow', real.length === 0, real.slice(0, 3).join(' | '));
    check('no failed requests', httpFailures.length === 0, httpFailures.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
