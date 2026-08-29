/**
 * ui-dryrun-test — drives the REAL Dry Run / Pre-Execution UI.
 *
 * Covers the workflow dry run, the composed rule preview, the policy and
 * approval previews, KNOWN / CONDITIONAL / UNKNOWN labelling, and the
 * zero-side-effect messaging — and proves inertness the only way that
 * counts: by checking the service's audit trail and run history did not
 * grow while the previews ran.
 *
 * Prerequisites:
 *   • the AI service on :4319         — `npm run ai`
 *   • the desktop dev server on :1420 — `npm run dev`
 *
 * Usage: node scripts/ui-dryrun-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:1420';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');

const RULE_NAME = 'Dry-run test — previews a governed workflow';

/** The repository this suite plans against — a real, registered project. */
const PROJECT_PATH = '/mnt/storage/aura-hub';

let failures = 0;

let checks = 0;
const check = (name, pass, detail = '') => {
  checks += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (t) => console.log(`\n${t}`);
const api = (p) => fetch(`${AI}${p}`).then((r) => r.json());
const post = (p, body) =>
  fetch(`${AI}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .then((r) => r.json());

async function cleanup() {
  const { rules } = await api('/automation/rules').catch(() => ({ rules: [] }));
  for (const r of rules ?? []) {
    if (r.name === RULE_NAME) await fetch(`${AI}/automation/rules/${r.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function openApp(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  for (const name of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name }).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(1000); }
  }
  const expand = page.getByRole('button', { name: /Expand sidebar/i }).first();
  if (await expand.count()) { await expand.click().catch(() => {}); await page.waitForTimeout(700); }
  const project = page.getByRole('button', { name: /aura-hub/ }).first();
  if (await project.count()) { await project.click().catch(() => {}); await page.waitForTimeout(3500); }
  await page.getByRole('button', { name: /^Automation$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function main() {
  for (const [name, url] of [['AI service', `${AI}/health`], ['dev server', APP]]) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) { console.error(`\n${name} is not answering at ${url}. Start it first.\n`); process.exit(2); }
  }
  await cleanup();

  const { workflows } = await api('/workflows');
  // One workflow with a governed step (so policy has something to say),
  // and preferably one whose policy gates it (so approvals appear).
  const nameCount = new Map();
  for (const w of workflows) nameCount.set(w.name, (nameCount.get(w.name) ?? 0) + 1);
  const unique = workflows.filter((x) => x.nodeCount > 0 && nameCount.get(x.name) === 1);

  let governed = null;
  let gated = null;
  for (const w of unique) {
    const dr = await post(`/workflows/${w.id}/dry-run`, { projectId: 'aura-hub-2' }).catch(() => null);
    if (!dr || dr.error) continue;
    if (!governed && dr.plan.some((s) => s.nodeClass === 'governed')) governed = { ...w, report: dr };
    if (!gated && dr.approvalsRequired.length) gated = { ...w, report: dr };
  }
  if (!governed) { console.error('\nNo workflow with a governed step to preview.\n'); process.exit(2); }
  console.log(`fixture: ${governed.name}${gated ? ` · gated fixture: ${gated.name}` : ' · no gated fixture found'}`);

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

  // The only measurement that proves inertness.
  const auditBefore = (await api('/fabric/audit')).audit.length;
  const runsBefore = (await api(`/workflows/${governed.id}/runs`)).runs.length;

  try {
    section('Workflow dry run');
    await openApp(page);
    await page.getByRole('button', { name: /^Workflows$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByText(governed.name, { exact: true }).first().click();
    await page.waitForTimeout(2000);

    check('the editor offers a Dry run action', await page.getByRole('button', { name: /^Dry run$/ }).count() > 0);
    check('a Preview view exists', await page.getByRole('tab', { name: /^Preview/ }).count() > 0);

    await page.getByRole('button', { name: /^Dry run$/ }).first().click();
    await page.waitForTimeout(3500);
    const dr = await page.textContent('body');

    check('it declares itself a preview', dr.includes('This is a preview. Nothing was executed.'));
    check(
      'the inertness claim is the service’s own sentence',
      dr.includes(governed.report.sideEffects.note),
      governed.report.sideEffects.note.slice(0, 50) + '…',
    );
    check('it reports zero invocations', /capabilities invoked\s*0/.test(dr.replace(/\s+/g, ' ')));
    check(
      'it reports how many policy questions it asked',
      dr.includes(String(governed.report.sideEffects.policyEvaluations)),
      `${governed.report.sideEffects.policyEvaluations}`,
    );

    section('KNOWN / CONDITIONAL / UNKNOWN');
    check('certainty is stated in the brief’s words', dr.includes('KNOWN'));
    const hasConditional = governed.report.plan.some((s) => s.reachability === 'conditional');
    const hasUnreachable = governed.report.plan.some((s) => s.reachability === 'unreachable');
    check(
      'the plan’s certainty matches the service',
      (!hasConditional || dr.includes('CONDITIONAL')) && (!hasUnreachable || dr.includes('UNKNOWN')),
      `${governed.report.plan.map((s) => s.reachability).join(',')}`,
    );
    check('it says what it cannot know', dr.includes('What this preview cannot tell you'));
    check('loops are described by their bound, not a count', !/repeats exactly/i.test(dr));

    section('Policy and capability preview');
    const govSteps = governed.report.plan.filter((s) => s.nodeClass === 'governed');
    check(
      'every governed capability is shown',
      govSteps.every((s) => dr.includes(s.capabilityId)),
      govSteps.map((s) => s.capabilityId).join(','),
    );
    check(
      'each policy decision comes from the service',
      govSteps.every((s) => !s.policy || dr.includes(s.policy.rule)),
      govSteps.map((s) => s.policy?.rule).join(','),
    );
    check('the authority envelope is reused, not rebuilt', dr.includes('What it cannot do'));
    check('the “cannot” sentence is the service’s', dr.includes(governed.report.envelope.cannot.slice(0, 40)));
    check('least-privilege grants are shown', dr.includes('Least-privilege grants'));

    section('The verdict');
    check(
      'unattended execution is stated either way',
      dr.includes(governed.report.wouldRunUnattended ? 'unattended: yes' : 'unattended: no'),
      `service says ${governed.report.wouldRunUnattended}`,
    );
    check('offline capability is stated', /works offline|needs the network/.test(dr));

    section('Approval preview (a gated workflow)');
    if (gated) {
      await page.getByRole('button', { name: /^Library$/ }).first().click();
      await page.waitForTimeout(1500);
      await page.getByText(gated.name, { exact: true }).first().click();
      await page.waitForTimeout(2000);
      await page.getByRole('button', { name: /^Dry run$/ }).first().click();
      await page.waitForTimeout(3500);
      const gt = await page.textContent('body');
      check('it says the run would stop and ask', gt.includes('would stop and ask you'));
      check(
        'the gated capability is named',
        gated.report.approvalsRequired.every((a) => gt.includes(a.capabilityId)),
        gated.report.approvalsRequired.map((a) => a.capabilityId).join(','),
      );
      check('it states no approval was created', gt.includes('No approval request has been created'));
      check('the verdict is not “success”', !/would run unattended/i.test(gt) || gated.report.wouldRunUnattended);
    } else {
      check('a gated workflow exists to preview', false, 'skipped — no workflow in this library is policy-gated');
    }

    section('Rule dry run');
    // Build a rule that runs the governed workflow, through the real API so
    // the UI test stays focused on the preview itself.
    const created = await post('/automation/rules', {
      name: RULE_NAME,
      description: 'Created by the dry-run test.',
      category: 'Test',
      enabled: true,
      trigger: { type: 'pr-merged' },
      conditions: [{ field: 'commit', op: 'exists' }],
      chain: [{ id: 'a1', action: 'run-workflow', label: 'Run a workflow', config: { workflowId: governed.id } }],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    });
    check('the fixture rule was created', Boolean(created?.id), created?.id);

    // The editor replaces the catalogue, tab strip and all — Library first.
    await page.getByRole('button', { name: /^Library$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /^Rules$/ }).first().click();
    await page.waitForTimeout(2500);
    // The card's title opens the builder; "Runs" opens history instead.
    await page.locator(`[data-rule="${created.id}"]`).getByRole('heading', { name: RULE_NAME }).click();
    await page.waitForTimeout(2200);

    const dryBtn = page.getByRole('button', { name: /^Dry run$/ }).first();
    check('the rule builder offers a Dry run', await dryBtn.count() > 0);
    await dryBtn.click();
    await page.waitForTimeout(5000);
    const rp = await page.textContent('body');

    /* This block used to assert a preview COMPOSED in the renderer,
       because no rule-level dry run existed: conditions were marked
       UNKNOWN with "would be a second engine" as the reason, and the gap
       was disclosed on screen. `POST /automation/rules/:id/dry-run` now
       exists and the screen renders the service's report, so the same
       questions are asked of the real contract instead. */
    const svcReport = await post(`/automation/rules/${created.id}/dry-run`, { projectId: 'aura-hub-2' });
    check('the service has a rule dry-run contract', !('error' in svcReport), Object.keys(svcReport).join(','));
    check('the rule preview declares itself', rp.includes('THIS IS A PREVIEW. NOTHING WAS EXECUTED.'));
    check(
      'the inertness counts are the service’s own',
      rp.includes(svcReport.sideEffects.note.slice(0, 40)),
      svcReport.sideEffects.note.slice(0, 50),
    );
    check('the chain is laid out trigger → conditions → actions', rp.includes('Trigger') && rp.includes('Conditions') && rp.includes('Actions'));
    check(
      'certainty is rendered in the service’s own vocabulary',
      rp.includes(svcReport.trigger.accepted.certainty.toUpperCase()),
      `trigger certainty ${svcReport.trigger.accepted.certainty}`,
    );
    check(
      'and the reason shown is the service’s reason',
      rp.includes(svcReport.trigger.accepted.reason.slice(0, 40)),
    );
    check(
      'the condition outcome comes from the service',
      rp.includes(svcReport.conditions.outcome.reason.slice(0, 40)),
      svcReport.conditions.outcome.certainty,
    );
    check(
      'what the preview cannot know is named',
      svcReport.unknowns.length === 0 || rp.includes(svcReport.unknowns[0].what),
      `${svcReport.unknowns.length} unknowns`,
    );
    const nested = svcReport.actions.find((a) => a.workflow?.dryRun);
    check(
      'a run-workflow action carries the nested workflow plan',
      Boolean(nested),
      nested ? `${nested.workflow.workflowName}: ${nested.workflow.dryRun.plan.length} steps` : 'none',
    );
    check(
      'and that plan is reachable from the rule preview',
      !nested || rp.includes(nested.workflow.workflowName),
    );


    /* ── the sample event, which is what moves the line ────────────
       Without a payload the service cannot say whether the conditions
       pass — only what they depend on. With one it really evaluates
       them. That boundary IS the known/conditional distinction, so it is
       worth proving rather than assuming. */
    section('A sample event moves conditions from conditional to known');
    const noSample = await post(`/automation/rules/${created.id}/dry-run`, { projectId: 'aura-hub-2' });
    check('without a sample the conditions are not claimed',
      noSample.conditions.outcome.certainty !== 'known' && noSample.conditions.outcome.value === null,
      `${noSample.conditions.outcome.certainty}, value ${JSON.stringify(noSample.conditions.outcome.value)}`);
    check('and no per-condition results are invented',
      noSample.conditions.evaluations.length === 0);

    const withSample = await post(`/automation/rules/${created.id}/dry-run`, {
      projectId: 'aura-hub-2',
      sampleEvent: {
        type: 'pr-merged', projectId: 'aura-hub-2', projectPath: PROJECT_PATH,
        at: new Date().toISOString(), payload: { commit: 'abc1234' },
      },
    });
    check('with a sample the conditions are really evaluated',
      withSample.conditions.outcome.certainty === 'known',
      `${withSample.conditions.outcome.certainty}, value ${JSON.stringify(withSample.conditions.outcome.value)}`);
    check('and each condition reports its own result',
      withSample.conditions.evaluations.length === 1 && withSample.conditions.evaluations[0].field === 'commit',
      JSON.stringify(withSample.conditions.evaluations));

    // A payload that does NOT satisfy the condition must be answered
    // `known: false`, not merely "conditional" — otherwise the report is
    // only ever optimistic.
    const failing = await post(`/automation/rules/${created.id}/dry-run`, {
      projectId: 'aura-hub-2',
      sampleEvent: {
        type: 'pr-merged', projectId: 'aura-hub-2', projectPath: PROJECT_PATH,
        at: new Date().toISOString(), payload: {},
      },
    });
    check('a payload that fails the condition is answered, not hedged',
      failing.conditions.outcome.certainty === 'known' && failing.conditions.outcome.value === false,
      `${failing.conditions.outcome.certainty}, value ${JSON.stringify(failing.conditions.outcome.value)}`);

    // Now through the UI, which must show the service's evaluation.
    const sampleBtn = page.getByRole('button', { name: /Reason about a specific event/ }).first();
    check('the preview offers a sample event', await sampleBtn.count() > 0);
    if (await sampleBtn.count()) {
      await sampleBtn.click();
      await page.waitForTimeout(600);
      const box = page.getByLabel('Sample event payload as JSON');
      await box.fill('{"commit":"abc1234"}');
      await page.getByRole('button', { name: /Preview against this event/ }).first().click();
      await page.waitForTimeout(3500);
      const sampled = await page.textContent('body');
      check('the UI shows the condition was evaluated', sampled.includes('KNOWN'));
      check('and names the field the service evaluated', sampled.includes('commit'));
      check('the reason shown is the service’s reason',
        sampled.includes(withSample.conditions.outcome.reason.slice(0, 40)),
        withSample.conditions.outcome.reason.slice(0, 50));
    }

    section('Zero side effects — measured, not asserted');

    const auditAfter = (await api('/fabric/audit')).audit.length;
    const runsAfter = (await api(`/workflows/${governed.id}/runs`)).runs.length;
    const autoRuns = (await api(`/automation/rules/${created.id}/runs`)).runs.length;
    check('the Fabric audit trail did not grow', auditAfter === auditBefore, `${auditBefore} → ${auditAfter}`);
    check('no workflow run was created', runsAfter === runsBefore, `${runsBefore} → ${runsAfter}`);
    check('no automation run was created', autoRuns === 0, `${autoRuns}`);

    section('Structured workflow-run linking — no summary parsing');
    // Fire the rule for real, then confirm the link came off `produced`.
    const fired = await post(`/automation/rules/${created.id}/run`, {
      projectId: 'aura-hub-2',
      payload: { commit: 'abc1234' },
    });
    check('the rule ran', Boolean(fired?.id), fired?.id ?? fired?.error);
    if (fired?.id) {
      const full = await api(`/automation/rules/${created.id}/runs/${fired.id}`);
      const act = (full.actions ?? []).find((a) => a.action === 'run-workflow');
      check('the action carries a structured produced ref', act?.produced?.kind === 'workflow-run', JSON.stringify(act?.produced));
      check('it carries both ids', Boolean(act?.produced?.workflowId && act?.produced?.runId));
      check('the run rolls produced up', Array.isArray(full.produced) && full.produced.length > 0, `${full.produced?.length}`);

      await page.getByRole('button', { name: /Back to the rule/ }).first().click().catch(() => {});
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: /^All rules$/ }).first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await page.locator(`[data-rule="${created.id}"]`).getByRole('button', { name: /^Runs/ }).first().click();
      await page.waitForTimeout(3000);
      const rv = await page.textContent('body');
      check('the run view shows the causal chain', rv.includes('Workflow run') && rv.includes('Evidence'));
      check('the linked workflow run is reachable', await page.getByRole('button', { name: /^Open run$/ }).count() > 0);
      const wfRun = await api(`/workflows/${act.produced.workflowId}/runs/${act.produced.runId}`);
      check('it links to the run the service named', rv.includes(wfRun.state), `${act.produced.runId} · ${wfRun.state}`);
    }

    section('Cross-rule automation run index');
    await page.getByRole('button', { name: /^All rules$/ }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.getByRole('tab', { name: /^Runs/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /^Automation runs$/ }).first().click();
    await page.waitForTimeout(2500);
    const idx = await api('/automation/runs?limit=25');
    const ix = await page.textContent('body');
    check('the index is read from the service', ix.includes('indexed by the service'), `${idx.total} total`);
    check('it is paged by the service', typeof idx.total === 'number' && typeof idx.offset === 'number');
    check('search, state, workflow and project filters exist',
      (await page.getByLabel('Search automation runs by rule name').count()) > 0
      && (await page.getByLabel('State').count()) > 0
      && (await page.getByLabel('Workflow').count()) > 0
      && (await page.getByLabel('Project').count()) > 0);
    check('a date filter exists', await page.getByLabel('Only runs since this date').count() > 0);
    if (idx.runs?.length) {
      const withProduced = idx.runs.find((r) => (r.produced ?? []).length);
      check('a row links to the workflow run it started', Boolean(withProduced), withProduced?.produced?.[0]?.runId);
      if (withProduced) {
        check('the link carries both ids', Boolean(withProduced.produced[0].workflowId && withProduced.produced[0].runId));
        check('the linked state is shown', ix.includes(withProduced.produced[0].state), withProduced.produced[0].state);
      }
    }

    // Filtering is the service's, so a narrowing filter must narrow the result.
    await page.getByLabel('State').first().selectOption('failed');
    await page.waitForTimeout(1500);
    const failedIdx = await api('/automation/runs?status=failed&limit=25');
    const afterFilter = await page.textContent('body');
    check(
      'filtering asks the service, not the browser',
      failedIdx.total === 0 ? /Nothing matches|No automation runs/.test(afterFilter) : afterFilter.includes(`${failedIdx.total} run`),
      `${failedIdx.total} failed`,
    );
    await page.getByRole('button', { name: /^Clear$/ }).first().click().catch(() => {});
    await page.waitForTimeout(1000);

    section('Failure and unavailable states');
    const bad = await post('/workflows/does-not-exist/dry-run', { projectId: 'aura-hub-2' });
    check('the service refuses an unknown workflow', Boolean(bad?.error), bad?.error);

    section('Agentic AI Node reflects the service, whichever way it reads');
    await page.getByRole('tab', { name: /^Automations/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /^Workflows$/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByText(governed.name, { exact: true }).first().click();
    await page.waitForTimeout(1800);
    await page.getByRole('button', { name: /Agent node/ }).first().click();
    await page.waitForTimeout(1200);
    const ag = await page.textContent('body');
    // Availability is the service's answer; the assertion is that the UI
    // agrees with it rather than that it says either particular thing.
    const agSpec = (await api('/workflows/specs')).specs.find((sp) => sp.type === 'agent');
    check(
      'the availability badge matches the served spec',
      agSpec?.disabled ? ag.includes('disabled by the service') : ag.includes('enabled'),
      `spec.disabled = ${JSON.stringify(agSpec?.disabled)}`,
    );
    check('its bounds are still shown', ag.includes('Worst case'));
    // Assert against the trace surface itself, not the tab label.
    await page.getByRole('tab', { name: /^trace$/i }).first().click();
    await page.waitForTimeout(800);
    const tr = await page.textContent('body');
    check('no trace is invented', tr.includes('No trace to show'));
    check('it explains what a trace would show', tr.includes('Observation') && tr.includes('Intervention'));

    section('Layout and accessibility');
    for (const w of [1024, 1440]) {
      await page.setViewportSize({ width: w, height: 860 });
      await page.waitForTimeout(700);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`no horizontal overflow at ${w}px`, !overflow);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('dark theme repaints', bg.includes('11, 13, 17'), bg);

    const labelled = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, input, select, [role="tab"]')];
      const bad = els.filter((e) => !e.textContent.trim() && !e.getAttribute('aria-label') && !e.getAttribute('title'));
      return { total: els.length, bad: bad.length, first: bad[0] ? bad[0].outerHTML.slice(0, 160) : '' };
    });
    check('interactive elements are labelled', labelled.bad === 0, `${labelled.bad}/${labelled.total} ${labelled.first}`);

    const focusable = await page.evaluate(() => {
      const el = document.querySelector('[role="tab"]');
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    });
    check('tabs take keyboard focus', focusable);

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
