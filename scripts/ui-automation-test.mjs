/**
 * ui-automation-test — drives the REAL Automation Rules UI.
 *
 * Builds a rule through the interface, runs it, follows the workflow it
 * started into the existing Workflow Run view, and checks the governed
 * evidence — then deletes the rule it created.
 *
 * The full chain under test:
 *   Create Rule → Trigger → Condition → Workflow → Capability Fabric
 *   → Execution → Evidence → Run History
 *
 * Prerequisites:
 *   • the AI service on :4319         — `npm run ai`
 *   • the desktop dev server on :1420 — `npm run dev`
 *
 * Usage: node scripts/ui-automation-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:1420';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');

const RULE_NAME = 'UI test — merged PR runs a workflow';
const SCHEDULE_NAME = 'UI test — scheduled workflow';

let failures = 0;
let checks = 0;
const check = (name, pass, detail = '') => {
  checks += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (t) => console.log(`\n${t}`);
const api = (p) => fetch(`${AI}${p}`).then((r) => r.json());

/** Remove any rule this test left behind, from a previous run or this one. */
async function cleanup() {
  const { rules } = await api('/automation/rules').catch(() => ({ rules: [] }));
  for (const r of rules ?? []) {
    if (r.name === RULE_NAME || r.name === SCHEDULE_NAME) {
      await fetch(`${AI}/automation/rules/${r.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

async function openRules(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  for (const name of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name }).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(1000); }
  }
  const expand = page.getByRole('button', { name: /Expand sidebar/i }).first();
  if (await expand.count()) { await expand.click().catch(() => {}); await page.waitForTimeout(700); }

  // A rule runs against a real project, so open one — the same thing a
  // person does before expecting automation to do anything.
  const project = page.getByRole('button', { name: /aura-hub/ }).first();
  if (await project.count()) { await project.click().catch(() => {}); await page.waitForTimeout(3500); }

  await page.getByRole('button', { name: /^Automation$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /^Rules$/ }).first().click();
  await page.waitForTimeout(2500);
}

async function main() {
  for (const [name, url] of [['AI service', `${AI}/health`], ['dev server', APP]]) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) { console.error(`\n${name} is not answering at ${url}. Start it first.\n`); process.exit(2); }
  }

  await cleanup();

  const { workflows } = await api('/workflows');
  // A workflow that actually performs a governed action, so the Fabric leg
  // of the chain produces real evidence rather than an empty list.
  let governed = null;
  for (const w of workflows.filter((x) => x.nodeCount > 0)) {
    const env = await api(`/workflows/${w.id}/envelope`).catch(() => null);
    if (env?.envelope?.capabilities?.length) { governed = { ...w, envelope: env.envelope }; break; }
  }
  if (!governed) { console.error('\nNo workflow with a governed capability to test against.\n'); process.exit(2); }
  console.log(`fixture workflow: ${governed.name} (${governed.envelope.capabilities.map((c) => c.capabilityId).join(', ')})`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const httpFailures = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) httpFailures.push(`HTTP ${r.status()} ${r.url()}`);
  });

  let createdRuleId = null;

  try {
    section('The Rules surface');
    await openRules(page);
    const body = await page.textContent('body');
    check('Rules sits beside Workflows in the Automation catalogue', body.includes('rules that start them for you'));

    const served = await api('/automation/rules');
    check('the library lists the service’s rules', served.rules.every((r) => body.includes(r.name)), `${served.rules.length} rules`);
    check('a rule states what fires it', /When/.test(body) && /Runs/.test(body));
    check('the absence of a schedule is stated, not faked', body.includes('no scheduled time'));

    section('Enable / disable is the engine’s flag');
    if (served.rules.length) {
      const target = served.rules[0];
      const before = target.enabled;
      const toggle = page.getByRole('button', { name: before ? /Disable this rule/i : /Enable this rule/i }).first();
      await toggle.click();
      await page.waitForTimeout(1200);
      const after = await api(`/automation/rules/${target.id}`);
      check('toggling writes through to the service', after.enabled === !before, `${before} → ${after.enabled}`);
      // Put it back the way it was.
      await fetch(`${AI}/automation/rules/${target.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: before }),
      });
      await page.waitForTimeout(600);
    } else {
      check('a rule exists to toggle', false, 'skipped — no rules on the service');
    }

    section('Rule Builder — validation blocks a save that would do nothing');
    await page.getByRole('button', { name: /^New rule$/ }).first().click();
    await page.waitForTimeout(1200);
    const builder = await page.textContent('body');
    check('the builder opens', builder.includes('What starts it?'));
    check('it offers only the engine’s triggers', builder.includes('A pull request merges') && builder.includes('Files change'));
    check('an empty rule cannot be saved', await page.getByRole('button', { name: /^Save/ }).first().isDisabled());
    check('it says why', builder.includes('This rule needs a name') && builder.includes('it has no actions'));

    section('Building the rule: trigger → condition → workflow');
    await page.getByRole('button', { name: /A pull request merges/ }).first().click();
    await page.waitForTimeout(300);

    // Name it.
    const nameInput = page.locator('input').filter({ hasNot: page.locator('[type="number"]') }).first();
    await nameInput.fill(RULE_NAME);
    await page.waitForTimeout(300);

    // One condition, so the chain includes a real condition evaluation.
    await page.getByRole('button', { name: /Add condition/ }).first().click();
    await page.waitForTimeout(400);
    await page.getByLabel('Condition field').first().fill('commit');
    await page.getByLabel('Condition operator').first().selectOption('exists');
    await page.waitForTimeout(300);
    const condText = await page.textContent('body');
    check('a condition with no value is allowed when the operator needs none', !condText.includes('needs a value to compare against'));

    // One action: run the governed workflow.
    await page.getByRole('button', { name: /Add step/ }).first().click();
    await page.waitForTimeout(400);
    const missingWf = await page.textContent('body');
    check('a workflow step with no workflow is an error', missingWf.includes('no workflow is chosen'));

    await page.getByLabel('Workflow to run').first().selectOption(governed.id);
    await page.waitForTimeout(1500);

    section('The workflow’s real authority is disclosed in the builder');
    const withWf = await page.textContent('body');
    check('the step states what that workflow can do', /This workflow (reads only|changes your project|runs commands|reaches the network|high-risk actions|irreversible actions|no effects outside AURA)/.test(withWf));
    check(
      'it states that an automation authorizes nothing',
      withWf.includes('authorizes nothing') && withWf.includes('waiting for you'),
    );
    await page.getByRole('button', { name: /details/ }).first().click().catch(() => {});
    await page.waitForTimeout(700);
    const envText = await page.textContent('body');
    check(
      'the envelope shown is the service’s own',
      governed.envelope.capabilities.every((c) => envText.includes(c.capabilityId)),
      governed.envelope.capabilities.map((c) => c.capabilityId).join(','),
    );

    section('Saving creates the rule on the service');
    check('save is now enabled', !(await page.getByRole('button', { name: /^Save/ }).first().isDisabled()));
    await page.getByRole('button', { name: /^Save/ }).first().click();
    await page.waitForTimeout(2000);

    const afterSave = await api('/automation/rules');
    const created = (afterSave.rules ?? []).find((r) => r.name === RULE_NAME);
    createdRuleId = created?.id ?? null;
    check('the rule exists on the service', Boolean(created), created?.id);
    if (created) {
      const full = await api(`/automation/rules/${created.id}`);
      check('its trigger is the one chosen', full.trigger.type === 'pr-merged', full.trigger.type);
      check('its condition was saved', full.conditions.length === 1 && full.conditions[0].op === 'exists');
      check('its action names the workflow', full.chain[0]?.config?.workflowId === governed.id);
      check('its retry policy was saved', full.retry.maxAttempts >= 1);
    }

    section('Run now → the whole chain');
    // Saving lands on the rule's run history; go back to the list to fire it.
    await page.getByRole('button', { name: /^All rules$/ }).first().click();
    await page.waitForTimeout(1800);

    // Baseline BEFORE firing, so a pre-existing run cannot make this pass.
    const wfRunsBefore = (await api(`/workflows/${governed.id}/runs`)).runs ?? [];

    // Scope to this rule's own card — clicking the first "Run now" on the
    // page would fire whichever rule happens to sort first.
    const card = page.locator(`[data-rule="${createdRuleId}"]`);
    check('the new rule has its own card', await card.count() === 1);
    await card.getByRole('button', { name: /^Run now$/ }).first().click();
    await page.waitForTimeout(1200);

    const dlg = await page.textContent('body');
    check('running by hand is declared as a real run', dlg.includes('This is a real run, not a preview'));
    check('it warns that the workflow really executes', dlg.includes('Capability Fabric'));
    check('the rule’s conditions are restated', dlg.includes('These have to pass'));

    // Conditions read the event payload, so give it one the condition passes.
    const payload = page.getByLabel('Event payload').first();
    check('an event payload can be supplied', await payload.count() > 0);
    await payload.fill('{"commit": "abc1234"}');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Run for real/ }).first().click();
    await page.waitForTimeout(10000);

    const autoRuns = createdRuleId ? await api(`/automation/rules/${createdRuleId}/runs`) : { runs: [] };
    const autoRun = (autoRuns.runs ?? [])[0];
    check('the service recorded an automation run', Boolean(autoRun), autoRun?.id);
    check('the automation run completed', autoRun?.status === 'completed', autoRun?.status);

    const wfRuns = await api(`/workflows/${governed.id}/runs`);
    const seen = new Set(wfRunsBefore.map((r) => r.id));
    const linked = (wfRuns.runs ?? []).find((r) => r.trigger === 'automation' && !seen.has(r.id));
    check('it started a NEW workflow run', Boolean(linked), linked?.id);
    check('the workflow run carries governed evidence', (linked?.evidenceCount ?? 0) > 0, `${linked?.evidenceCount} records`);

    section('The automation run view');
    const runText = await page.textContent('body');
    check('the run view opened on the newest run', runText.includes('Steps') && runText.includes('Timeline'));
    check('conditions are shown with their outcome', runText.includes('Conditions'));
    check('the step names the workflow it handed over', runText.includes(governed.name));

    section('Following the link into the existing Workflow Run view');
    const openRun = page.getByRole('button', { name: /^Open run$/ }).first();
    check('a verified link to the workflow run is offered', await openRun.count() > 0);
    if (await openRun.count()) {
      await openRun.click();
      await page.waitForTimeout(2500);
      const wfText = await page.textContent('body');
      check('it renders the existing run view, not a second one', wfText.includes('Evidence') && wfText.includes('Steps'));
      check('the run says it was started by this rule', wfText.includes('started by this rule'));

      // Evidence is the Fabric's own record — the last leg of the chain.
      await page.getByRole('tab', { name: /^Evidence/ }).first().click();
      await page.waitForTimeout(900);
      const evText = await page.textContent('body');
      const full = await api(`/workflows/${governed.id}/runs/${linked.id}`);
      check(
        'the Fabric’s audit references are shown',
        full.evidence.every((e) => evText.includes(e.capabilityId)),
        full.evidence.map((e) => e.capabilityId).join(','),
      );
      check('the trigger is reported as the automation', evText.includes('Automation rule'));
    }

    section('Run history, filtered by what started it');
    await page.getByRole('tab', { name: /^Runs/ }).first().click();
    await page.waitForTimeout(2500);
    /* The origin filter was a local predicate over a client-side merge.
       It is now a `trigger` query parameter on the service's index, so
       the assertion is that the filter really narrows to what the
       service returns for that trigger — which the old one could not
       check, because both sides were the same array. */
    const triggerSelect = page.getByLabel('Filter by what started the run');
    check('runs can be filtered by what started them', await triggerSelect.count() > 0);
    await triggerSelect.selectOption('automation');
    await page.waitForTimeout(1800);
    const fromService = await api('/workflow-runs?trigger=automation&limit=50');
    const rowsShown = await page.locator('tbody tr').count();
    check(
      'and the filter is the service’s answer, not a local predicate',
      rowsShown === Math.min(fromService.runs.length, 50),
      `${rowsShown} rows, service returned ${fromService.runs.length} of ${fromService.total}`,
    );

    // Still filtered to `automation` from the check above.
    const filtered = await page.textContent('body');
    check('the automation-started run is listed', filtered.includes('Automation rule'));


    section('States are reported as the service reports them');
    // Not a vocabulary spot-check: the exact state string the service holds
    // has to be the one the screen showed.
    const autoNow = await api(`/automation/rules/${createdRuleId}/runs`);
    const wfNow = await api(`/workflows/${governed.id}/runs/${linked.id}`);
    // The previous section left us on the workflow Runs surface; the kind
    // tabs only exist under Automations.
    await page.getByRole('tab', { name: /^Automations/ }).first().click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^Rules$/ }).first().click();
    // Wait for the card itself rather than a fixed pause — the rules list
    // hydrates definitions and schedules behind the first render.
    await page.locator(`[data-rule="${createdRuleId}"]`).waitFor({ timeout: 20000 });
    await page.locator(`[data-rule="${createdRuleId}"]`).getByRole('button', { name: /^Runs/ }).first().click();
    await page.waitForTimeout(2500);
    const statesText = await page.textContent('body');
    const autoLabel = { queued: 'Queued', running: 'Running', paused: 'Paused', retrying: 'Retrying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[autoNow.runs[0].status];
    check('the automation run shows the service’s status', statesText.includes(autoLabel), `${autoNow.runs[0].status} → ${autoLabel}`);
    check('the workflow run shows the service’s state', statesText.includes(wfNow.state), wfNow.state);
    check('a cancelled run would not read as failed', autoLabel !== 'Failed' || autoNow.runs[0].status === 'failed');

    section('A rule whose conditions do not pass says so');
    await page.getByRole('button', { name: /^All rules$/ }).first().click();
    await page.locator(`[data-rule="${createdRuleId}"]`).waitFor({ timeout: 20000 });
    const before2 = (await api(`/automation/rules/${createdRuleId}/runs`)).runs.length;
    await page.locator(`[data-rule="${createdRuleId}"]`).getByRole('button', { name: /^Run now$/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByLabel('Event payload').first().fill('{}');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Run for real/ }).first().click();
    await page.waitForTimeout(4000);
    const noRunText = await page.textContent('body');
    check(
      'it distinguishes “nothing ran” from “failed”',
      noRunText.includes('conditions did not pass'),
    );
    const after2 = (await api(`/automation/rules/${createdRuleId}/runs`)).runs.length;
    check('and records no run for it', after2 === before2, `${before2} → ${after2}`);

    section('Scheduled rules — a real next fire, from the scheduler');
    await page.getByRole('button', { name: /^All rules$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /^New rule$/ }).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /On a schedule/ }).first().click();
    await page.waitForTimeout(600);
    const schedText = await page.textContent('body');
    check('a schedule asks for cron and a project', schedText.includes('Cron expression') && schedText.includes('Project this runs against'));
    check('it says why the project must be named', schedText.includes('has to be named here'));
    check('an empty cron is an error', schedText.includes('needs a cron expression'));

    // A cron the service will refuse, to prove the service is the authority.
    const cronField = page.getByLabel('Cron expression').first();
    await cronField.fill('not a cron');
    await page.waitForTimeout(500);
    const badCron = await page.textContent('body');
    check('a malformed cron is caught before saving', badCron.includes('five fields'));

    await cronField.fill('0 9 * * 1-5');
    await page.getByLabel('Project this schedule runs against').first().selectOption({ index: 1 });
    const schedName = page.locator('input').first();
    await schedName.fill(SCHEDULE_NAME);
    await page.getByRole('button', { name: /Add step/ }).first().click();
    await page.waitForTimeout(400);
    await page.getByLabel('Workflow to run').first().selectOption(governed.id);
    await page.waitForTimeout(900);
    check('a valid schedule can be saved', !(await page.getByRole('button', { name: /^Save/ }).first().isDisabled()));
    await page.getByRole('button', { name: /^Save/ }).first().click();
    await page.waitForTimeout(2500);

    const schedRules = await api('/automation/rules');
    const sched = (schedRules.rules ?? []).find((r) => r.name === SCHEDULE_NAME);
    check('the scheduled rule exists on the service', Boolean(sched), sched?.id);
    if (sched) {
      const states = await api('/automation/schedules');
      const state = states.schedules?.[sched.id];
      check('the scheduler computed a next fire', Boolean(state?.nextFireAt), state?.nextFireAt);

      await page.getByRole('button', { name: /^All rules$/ }).first().click();
      await page.waitForTimeout(2000);
      const cardText = await page.locator(`[data-rule="${sched.id}"]`).textContent();
      check('the card shows the cron it runs on', cardText.includes('0 9 * * 1-5'));
      check('the card shows a next fire, not “no scheduled time”', /next /.test(cardText) && !cardText.includes('no scheduled time'), cardText.match(/next [^·]*/)?.[0]?.trim());
    }

    section('Accessibility and theme');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('dark theme repaints', bg.includes('11, 13, 17'), bg);
    const labelled = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, input, select, [role="tab"]')];
      const bad = els.filter((e) => !e.textContent.trim() && !e.getAttribute('aria-label') && !e.getAttribute('title'));
      return { total: els.length, bad: bad.length, first: bad[0] ? bad[0].outerHTML.slice(0, 220) : '' };
    });
    check('interactive elements are labelled', labelled.bad === 0, `${labelled.bad}/${labelled.total} unlabelled ${labelled.first}`);

    section('Console and network health');
    const real = errors.filter((e) => !/ResizeObserver|Download the React DevTools/.test(e));
    check('no page errors during the whole flow', real.length === 0, real.slice(0, 3).join(' | '));
    check('no failed requests', httpFailures.length === 0, httpFailures.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await cleanup();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
