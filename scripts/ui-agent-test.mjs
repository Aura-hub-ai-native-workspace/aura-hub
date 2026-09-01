/**
 * ui-agent-test — the Agent UI against REAL agent executions.
 *
 * Every trace this suite renders was produced by the real Workflow Engine
 * dispatching the real agent runtime through the real Capability Fabric
 * and policy engine, against a disposable git repository. Nothing is
 * injected: no synthetic AgentTrace, no fabricated beats, no mocked
 * NodeRunRecord. Each assertion compares what the screen shows against
 * what the service persisted for that same run.
 *
 * SAFETY
 * ------------------------------------------------------------------
 * Governed actions run against a throwaway repo under the scratchpad,
 * registered as its own project. The user's own tree is never a target.
 * `git.push` is never requested.
 *
 * Prerequisites:
 *   • the AI service on :4319         — `npm run ai`
 *   • the desktop dev server on :1420 — `npm run dev`
 *
 * Usage: node scripts/ui-agent-test.mjs [--headed]
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AI = process.env.AI_URL ?? 'http://localhost:4319';
const APP = process.env.APP_URL ?? 'http://localhost:1420';
const CHROME = process.env.CHROMIUM ?? '/usr/bin/chromium';
const HEADED = process.argv.includes('--headed');

const SANDBOX = process.env.AGENT_SANDBOX
  ?? '/tmp/claude-1000/-mnt-storage-aura-hub/731e8910-7b83-4e46-b772-c35a1e6cd715/scratchpad/agent-sandbox';
const TAG = 'AGENTUI';

let failures = 0;
let checks = 0;
const check = (name, pass, detail = '') => {
  checks += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (t) => console.log(`\n${t}`);
const api = (p) => fetch(`${AI}${p}`).then((r) => r.json());
const post = (p, b) =>
  fetch(`${AI}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })
    .then((r) => r.json());
const put = (p, b) =>
  fetch(`${AI}${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

/** Read an SSE run to completion and return the runId it announced. */
async function stream(url, body) {
  const res = await fetch(`${AI}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let runId = null;
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return { runId, events };
      const e = JSON.parse(d);
      events.push(e);
      if (e.runId) runId = e.runId;
    }
  }
  return { runId, events };
}

/** A disposable git repo, registered as its own project. */
async function ensureSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: SANDBOX, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'agent-probe@aura.local');
  git('config', 'user.name', 'Agent Probe');
  writeFileSync(path.join(SANDBOX, 'README.md'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(path.join(SANDBOX, 'README.md'), 'seed\nchanged\n');

  const existing = (await api('/projects')).projects.find((p) => p.path === SANDBOX);
  const id = existing?.id ?? (await post('/projects', { name: 'agent-sandbox', path: SANDBOX })).id;
  if (!id) throw new Error('could not register the sandbox project');
  await post(`/projects/${id}/open`, {});
  return id;
}

/** Build a real agent workflow. `extra` nodes/edges widen the envelope. */
async function agentWorkflow(name, agentConfig, extraNodes = [], extraEdges = []) {
  const wf = await post('/workflows', { name: `${TAG} ${name}`, category: 'AgentUITest' });
  await put(`/workflows/${wf.id}`, {
    ...wf,
    name: `${TAG} ${name}`,
    description: 'Created by ui-agent-test. Deleted afterwards.',
    nodes: [
      { id: 'ag', type: 'agent', x: 60, y: 60, config: agentConfig },
      { id: 'out', type: 'output', x: 420, y: 60, config: { title: 'Agent result' } },
      ...extraNodes,
    ],
    edges: [{ id: 'e1', from: 'ag', fromPort: 'done', to: 'out' }, ...extraEdges],
  });
  return wf.id;
}

async function cleanup() {
  const { workflows } = await api('/workflows').catch(() => ({ workflows: [] }));
  for (const w of workflows ?? []) {
    if (w.name.startsWith(TAG)) await fetch(`${AI}/workflows/${w.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * Open a run through the real UI.
 *
 * `row` selects which history row to click, newest first. The table shows
 * timestamps rather than ids, so a chain's legs cannot be told apart by
 * their text — position is the only handle the rendered page actually
 * offers, and the caller knows the order it created them in.
 */
async function openRunInUI(page, workflowName, runId, row = 0) {

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  for (const n of [/^Begin$/i, /Continue in Offline Mode/i]) {
    const el = page.getByRole('button', { name: n }).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(1000); }
  }
  const expand = page.getByRole('button', { name: /Expand sidebar/i }).first();
  if (await expand.count()) { await expand.click().catch(() => {}); await page.waitForTimeout(700); }
  await page.getByRole('button', { name: /^Automation$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.getByText(workflowName, { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: /^Runs/ }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('tbody tr').nth(row).click();

  await page.waitForTimeout(2000);
}

async function main() {
  for (const [n, url] of [['AI service', `${AI}/health`], ['dev server', APP]]) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) { console.error(`\n${n} is not answering at ${url}.\n`); process.exit(2); }
  }
  await cleanup();
  const projectId = await ensureSandbox();
  console.log(`sandbox project: ${projectId} at ${SANDBOX}`);

  /* ── PHASE 1/3 — the service's own answer on availability ─────── */
  section('The service reports the agent node as enabled');
  const specs = await api('/workflows/specs');
  const agentSpec = specs.specs.find((s) => s.type === 'agent');
  check('an agent spec is served', Boolean(agentSpec), agentSpec?.label);
  check('its `disabled` flag is falsy', !agentSpec?.disabled, `disabled = ${JSON.stringify(agentSpec?.disabled)}`);
  check('it declares three termination ports', JSON.stringify(agentSpec?.outputs) === JSON.stringify(['done', 'needs-human', 'failed']));

  const boundsContract = await api('/agent/bounds');
  check('bounds defaults and ceilings are served', boundsContract.defaults?.maxIterations > 0 && boundsContract.ceilings?.maxIterations > 0);

  /* ── PHASE 4 — a REAL agent execution ─────────────────────────── */
  section('A real agent run, through the real engine');
  const okWf = await agentWorkflow(
    'completes',
    { task: 'Reply with one short sentence describing what you were asked to do.', maxIterations: 3, timeoutMs: 45_000, maxTokens: 3000, tools: '' },
  );
  const okRun = await stream(`/workflows/${okWf}/run`, { projectId, inputs: {} });
  check('the run announced a runId', Boolean(okRun.runId), okRun.runId);
  const okRec = await api(`/workflows/${okWf}/runs/${okRun.runId}`);
  const okTrace = okRec.nodes.ag?.agentTrace;
  check('the agent node executed', okRec.nodes.ag?.state === 'succeeded', okRec.nodes.ag?.state);
  check('the service persisted a real AgentTrace', Boolean(okTrace), okTrace ? `${okTrace.beats.length} beats` : 'none');
  check('the trace carries effectiveBounds', Boolean(okTrace?.effectiveBounds), JSON.stringify(okTrace?.effectiveBounds));
  check('the trace states where its token count came from', ['provider', 'estimated', 'mixed'].includes(okTrace?.tokenSource), okTrace?.tokenSource);
  check('the trace states its input provenance', typeof okTrace?.inputProvenance === 'string', okTrace?.inputProvenance);

  /* ── PHASE 6 — the live beat channel ──────────────────────────────
     This block used to assert the ABSENCE of agent events and point at
     `docs/BACKEND_CONTRACTS_REQUIRED.md` §15. The service has since
     delivered the channel, so the assertion is inverted rather than
     deleted: the same question is still being asked of the same stream,
     and it now has to answer the other way. */
  section('PHASE 6 — live agent beats on the run stream');
  const agentEvents = okRun.events.filter((e) => e.type === 'agent');
  check('the SSE stream carries agent beat events', agentEvents.length > 0, `${agentEvents.length} agent events`);
  check('every one names the node it belongs to', agentEvents.every((e) => e.nodeId === 'ag'));
  check('every one names the run it belongs to', agentEvents.every((e) => typeof e.runId === 'string'));
  check('every one carries a typed beat', agentEvents.every((e) => e.beat && typeof e.beat.seq === 'number' && typeof e.beat.kind === 'string'));
  check(
    'sequence numbers strictly increase',
    agentEvents.every((e, i) => i === 0 || e.beat.seq > agentEvents[i - 1].beat.seq),
    agentEvents.map((e) => e.beat.seq).join(','),
  );
  /* The live event and the persisted beat must be the SAME object, or a
     client cannot reconcile the two — which is the entire premise of
     treating the stream as an early view and the record as truth. */
  const persistedBySeq = new Map((okTrace?.beats ?? []).map((b) => [b.seq, b]));
  check(
    'every live beat reappears in the persisted ledger at the same seq',
    agentEvents.every((e) => persistedBySeq.has(e.beat.seq)),
    `${agentEvents.length} live / ${okTrace?.beats?.length ?? 0} persisted`,
  );
  check(
    'and a live beat is identical to its persisted twin',
    agentEvents.every((e) => JSON.stringify(e.beat) === JSON.stringify(persistedBySeq.get(e.beat.seq))),
  );
  check('the node-level stream still reports the agent step', okRun.events.some((e) => e.type === 'node' && e.nodeId === 'ag' && e.status === 'running'));

  /* ── PHASE 6b — a reader that arrives mid-run ─────────────────────
     The reason the UI needed a partial-trace type at all: while the agent
     is still thinking the run record carries a ledger with beats and no
     verdict, and the renderer used to reject it outright — so anyone who
     opened a running agent saw nothing until it finished. */
  section('PHASE 6b — the mid-run snapshot a late reader sees');
  const slowWf = await agentWorkflow('midrun', {
    task: 'Run git status, then read README.md, then describe both. Use your tools one at a time.',
    maxIterations: 6, timeoutMs: 120_000, maxTokens: 8000, tools: 'git.status\nfilesystem.read',
  });
  const snapshots = [];
  const slowDone = stream(`/workflows/${slowWf}/run`, { projectId, inputs: {} });
  /* Poll the record the way a cold reader would: discover the run by
     listing, then read it over HTTP. Deliberately NOT taking the id from
     the stream we started — a reconnecting client does not have that
     stream, so taking the id from it would test a path nobody walks. */
  const poller = setInterval(() => {
    void api(`/workflows/${slowWf}/runs`)
      .then((r) => (r.runs ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0])
      .then((s) => (s ? api(`/workflows/${slowWf}/runs/${s.id}`) : null))
      .then((rec) => { const t = rec?.nodes?.ag?.agentTrace; if (t) snapshots.push(t); })
      .catch(() => {});
  }, 250);
  const slowRun = await slowDone;

  clearInterval(poller);

  const partials = snapshots.filter((t) => t.partial === true);
  check('a cold reader sees a ledger while the agent is still running', partials.length > 0, `${partials.length} partial snapshots`);
  check('the partial ledger already carries beats', partials.every((t) => Array.isArray(t.beats) && t.beats.length > 0));
  check('a partial ledger states no verdict', partials.every((t) => t.stopReason === undefined));
  check('and claims no effective bounds it cannot yet know', partials.every((t) => t.effectiveBounds === undefined));
  const slowFinal = await api(`/workflows/${slowWf}/runs/${slowRun.runId}`);
  const slowTrace = slowFinal.nodes.ag?.agentTrace;
  check('the finished ledger clears `partial`', slowTrace?.partial === false, JSON.stringify(slowTrace?.partial));
  check('and carries the verdict the snapshot did not', typeof slowTrace?.stopReason === 'string' && Boolean(slowTrace?.effectiveBounds), slowTrace?.stopReason);
  check(
    'the finished ledger is a superset of the last snapshot',
    partials.length > 0 && slowTrace.beats.length >= partials[partials.length - 1].beats.length,
    `${partials[partials.length - 1]?.beats?.length ?? 0} → ${slowTrace?.beats?.length ?? 0}`,
  );


  /* ── PHASE 13 — real, distinct terminal states ────────────────── */
  section('Real bound stops, each distinct');
  const stops = {};
  for (const [label, cfg] of [
    // Each of these must require a tool call, so the loop actually
    // iterates and the bound is reached. An agent that answers on its
    // first pass finishes before any bound is tested — which is correct
    // behaviour, and would make these fixtures meaningless.
    // Two tool calls before answering forces at least two passes, so the
    // wall-clock bound is certain to be tested. A task the model can
    // answer in one pass finishes before any bound is checked.
    ['timeout', { task: 'Call the git.status tool, then call it a second time, and only then answer.', maxIterations: 5, timeoutMs: 1, maxTokens: 3000, tools: 'git.status' }],
    ['token-budget', { task: 'Call the git.status tool, then summarise what it returned.', maxIterations: 5, timeoutMs: 45_000, maxTokens: 1, tools: 'git.status' }],
    ['max-iterations', { task: 'Call a tool, then call it again, before answering.', maxIterations: 1, timeoutMs: 45_000, maxTokens: 4000, tools: 'git.status' }],
  ]) {
    const wid = await agentWorkflow(label, cfg, [{ id: 'gs', type: 'git-status', x: 60, y: 240, config: {} }]);
    const r = await stream(`/workflows/${wid}/run`, { projectId, inputs: {} });
    const rec = await api(`/workflows/${wid}/runs/${r.runId}`);
    stops[label] = { wid, runId: r.runId, rec, trace: rec.nodes.ag?.agentTrace };
    check(`${label} is reported as itself`, stops[label].trace?.stopReason === label, `stop = ${stops[label].trace?.stopReason}`);
  }
  check('a timeout is not flattened into failed', stops.timeout.rec.state === 'timed-out', stops.timeout.rec.state);
  check('each bound stop names its own limit', Object.values(stops).every((s) => Boolean(s.rec.nodes.ag?.error)), 'backend reasons present');
  check('the backend reason is used verbatim, not paraphrased', /time bound|budget is|iterations/.test(stops.timeout.rec.nodes.ag.error + stops['token-budget'].rec.nodes.ag.error + stops['max-iterations'].rec.nodes.ag.error));

  /* ── PHASE 7 — approval, on a real governed call ──────────────── */
  section('A real governed tool request parks for approval');
  const apWf = await agentWorkflow(
    'approval',
    { task: "Commit the current changes using the git.commit tool with the message 'agent ui probe'.", maxIterations: 4, timeoutMs: 60_000, maxTokens: 6000, tools: 'git.commit' },
    [{ id: 'gc', type: 'git-commit', x: 420, y: 240, config: { message: 'only on failure' } }],
    [{ id: 'e2', from: 'ag', fromPort: 'failed', to: 'gc' }],
  );
  const apRun = await stream(`/workflows/${apWf}/run`, { projectId, inputs: {} });
  const apRec = await api(`/workflows/${apWf}/runs/${apRun.runId}`);
  const apTrace = apRec.nodes.ag?.agentTrace;
  const parkedOnAgent = apRec.nodes.ag?.state === 'awaiting-approval';
  check('the agent parked on a governed call', parkedOnAgent, `agent = ${apRec.nodes.ag?.state}, run = ${apRec.state}`);

  let approvalId = null;
  if (parkedOnAgent) {
    check('the run is marked resumable', apRec.resumable === true);
    check('the node records the approval request', Boolean(apRec.nodes.ag.approval?.requestId), apRec.nodes.ag.approval?.capabilityId);
    check('the trace names the same request', apTrace?.approval?.requestId === apRec.nodes.ag.approval.requestId);
    check('the trace carries resume state', Boolean(apTrace?.resume?.pendingCall), apTrace?.resume?.pendingCall?.capabilityId);
    check('the parked call is the one the agent proposed', apTrace.resume.pendingCall.capabilityId === 'git.commit');
    check(
      'the beat chain is ask → decide → wait',
      ['proposal', 'permission', 'intervention'].every((k) => apTrace.beats.some((b) => b.kind === k)),
      apTrace.beats.map((b) => b.kind).join(' → '),
    );
    check('the policy decision came from the Fabric', apTrace.beats.some((b) => b.kind === 'permission' && b.actor === 'fabric'));
    approvalId = apRec.nodes.ag.approval.requestId;
  }

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

  try {
    /* ── PHASE 5 — the UI renders the REAL trace ────────────────── */
    section('The UI renders the real trace, not a reconstruction');
    await openRunInUI(page, `${TAG} completes`, okRun.runId);
    const disclosure = page.getByRole('button', { name: /Agent reasoning/ }).first();
    check('the run view offers the agent ledger', await disclosure.count() > 0);
    await disclosure.click();
    await page.waitForTimeout(1200);
    const t1 = await page.textContent('body');

    check('every persisted beat kind is rendered', okTrace.beats.every((b) => t1.includes(b.kind.charAt(0).toUpperCase() + b.kind.slice(1))), okTrace.beats.map((b) => b.kind).join(','));
    check('the agent’s real answer is shown', t1.includes(okTrace.output.slice(0, 40)), okTrace.output.slice(0, 40));
    check('the stop reason is the service’s', t1.includes(okTrace.stopReason), okTrace.stopReason);
    check('the port the workflow continued from is named', t1.includes(okTrace.port));
    check(
      'the effective bounds are shown, not the configuration',
      t1.includes(`${okTrace.effectiveBounds.maxIterations}`) && t1.includes('effective bounds'),
      JSON.stringify(okTrace.effectiveBounds),
    );
    check('iterations match the record', t1.includes(`${okTrace.iterations}/${okTrace.effectiveBounds.maxIterations}`), `${okTrace.iterations}/${okTrace.effectiveBounds.maxIterations}`);
    check(
      'the token count says whether it was measured or estimated',
      t1.includes(okTrace.tokenSource === 'provider' ? 'measured' : okTrace.tokenSource === 'estimated' ? 'estimated' : 'part-estimated'),
      okTrace.tokenSource,
    );

    /* ── PHASE 15 — trust presentation ──────────────────────────── */
    section('Trust boundaries are visible');
    check('AI-authored beats are attributed to the model', t1.includes('AI'));
    check('system beats are attributed to the system', t1.includes('System'));
    const provenanceShown = !['authored'].includes(okTrace.inputProvenance);
    check(
      'input provenance is disclosed when the input is not an instruction',
      provenanceShown ? /treated as data|summarise its input/.test(t1) : true,
      okTrace.inputProvenance,
    );

    /* ── PHASE 7 (UI) — approval through the existing gate ──────── */
    if (parkedOnAgent) {
      section('The approval is offered through the existing gate');
      await openRunInUI(page, `${TAG} approval`, apRun.runId);
      const ui = await page.textContent('body');
      check('the run reads as parked, not failed', /Waiting for you|Parked, waiting/.test(ui));
      check('the existing ApprovalGate is used', ui.includes('Authorization required'));
      check('the gate names the capability the agent asked for', ui.includes('git.commit'));
      check('the parked call is shown with its arguments', ui.includes('agent ui probe') || ui.includes('parked on your decision'));
      check('resuming is described as continuing, not restarting', ui.includes('did not restart the clock') || ui.includes('linked resume run'));

      const approveBtn = page.getByRole('button', { name: /Approve and run/ }).first();
      check('the approve control is present', await approveBtn.count() > 0);
      if (await approveBtn.count()) {
        await approveBtn.click();
        // `GET /fabric/approvals` returns ONLY pending requests, so the
        // observable evidence that a decision landed is the request
        // leaving that set — not a `granted` row appearing in it.
        let stillPending = true;
        for (let i = 0; i < 10 && stillPending; i++) {
          await page.waitForTimeout(700);
          stillPending = (await api('/fabric/approvals')).approvals.some((a) => a.id === approvalId);
        }
        check('the decision reached the Fabric', !stillPending, stillPending ? 'still pending' : 'no longer pending');
        check('the gate stops offering a decision it already has', await page.getByRole('button', { name: /Approve and run/ }).count() === 0);
      }

      /* ── PHASE 9 — resume ────────────────────────────────────── */
      section('Resume continues the work with its spent budget');
      const resumed = await stream(`/workflows/${apWf}/runs/${apRun.runId}/resume`, { approvedCapabilities: ['git.commit'] });
      const runsAfter = (await api(`/workflows/${apWf}/runs`)).runs;
      const resumeRec = await api(`/workflows/${apWf}/runs/${runsAfter[0].id}`);
      const rTrace = resumeRec.nodes.ag?.agentTrace;

      check('the resumed agent completed', rTrace?.stopReason === 'completed', rTrace?.stopReason);
      check('it performed the governed call', (rTrace?.evidence?.length ?? 0) > 0, `${rTrace?.evidence?.length} audit references`);
      check('the tool output is marked untrusted', rTrace.beats.some((b) => b.kind === 'observation' && b.untrusted === true));
      check('the earlier leg is carried forward', rTrace.beats.length > apTrace.beats.length, `${apTrace.beats.length} → ${rTrace.beats.length}`);
      check('the iteration count did not restart', rTrace.iterations >= apTrace.iterations, `${apTrace.iterations} → ${rTrace.iterations}`);
      check('the bounds were preserved', JSON.stringify(rTrace.effectiveBounds) === JSON.stringify(apTrace.effectiveBounds));

      // The service's own model: a resume is a NEW run referencing the old.
      check(
        'the service links the resume to the run it continued',
        resumeRec.trigger?.kind === 'resume' && resumeRec.trigger?.of === apRun.runId,
        JSON.stringify(resumeRec.trigger),
      );

      await openRunInUI(page, `${TAG} approval`, resumeRec.id);
      const rui = await page.textContent('body');
      check('the UI states which run this continues', rui.includes('continues an earlier one') && rui.includes(apRun.runId));
      await page.getByRole('button', { name: /Agent reasoning/ }).first().click();
      await page.waitForTimeout(1200);
      const rtxt = await page.textContent('body');
      check('the resume boundary is marked in the ledger', rtxt.includes('Resumed here'));
      check('the execution beat is rendered', rtxt.includes('Execution'));
      check('the untrusted observation is quarantined', rtxt.includes('untrusted') && rtxt.includes('does not follow instructions'));
      check('the audit reference is shown', rtxt.includes('audit '));

      /* ── PHASE 7b — one execution, several runs ─────────────────
         A resume is a new run, so the leg it continued must stop
         claiming to be actionable. Its `state` stays
         `awaiting-approval` — that is how it ended — which is exactly
         why anything asking "is someone waiting on me?" has to read the
         chain instead. See `docs/AGENT_RESUME_SEMANTICS.md`. */
      section('PHASE 7b — the superseded leg stops asking to be approved');
      const parkedAfter = await api(`/workflows/${apWf}/runs/${apRun.runId}`);
      check('the earlier leg points forward to its continuation', parkedAfter.supersededBy === resumeRec.id, parkedAfter.supersededBy);
      check('with a timestamp', Boolean(parkedAfter.supersededAt), parkedAfter.supersededAt);
      check('it is no longer resumable', parkedAfter.resumable === false);
      check('and says which run continued it', /continued as run/.test(parkedAfter.notResumableReason ?? ''), parkedAfter.notResumableReason);
      check(
        'its state is deliberately left alone',
        parkedAfter.state === 'awaiting-approval',
        `${parkedAfter.state} — the honest account of how that leg ended`,
      );
      check('a second resume is refused', /already continued as/.test(
        JSON.stringify(await stream(`/workflows/${apWf}/runs/${apRun.runId}/resume`, {}).catch((e) => ({ error: String(e) }))),
      ));

      const chainA = await api(`/workflows/${apWf}/runs/${apRun.runId}/chain`);
      const chainB = await api(`/workflows/${apWf}/runs/${resumeRec.id}/chain`);
      check('the chain reads oldest-first from the head', chainA.chain?.[0]?.id === apRun.runId, chainA.chain?.map((r) => r.id).join(' -> '));
      check('and is navigable from the tail too', JSON.stringify(chainB.chain?.map((r) => r.id)) === JSON.stringify(chainA.chain?.map((r) => r.id)));
      check('the summary carries the back link', chainA.chain?.[0]?.supersededBy === resumeRec.id);
      check(
        'evidence is not copied between legs',
        parkedAfter.evidence.length + resumeRec.evidence.length ===
          new Set([...parkedAfter.evidence, ...resumeRec.evidence].map((e) => e.invocationId)).size,
        `${parkedAfter.evidence.length} + ${resumeRec.evidence.length}`,
      );

      // The UI is still on the resumed leg from the checks above.
      check('the resumed leg draws the whole execution', rui.includes('One execution') && rui.includes('legs'));
      check('and marks which leg is being read', rui.includes('you are here'));

      // Now the leg that was superseded.
      await openRunInUI(page, `${TAG} approval`, parkedAfter.id, 1);
      const sui = await page.textContent('body');
      check('the superseded leg says it was continued', sui.includes('continued as another run'), 'notice');
      check('it names the run that picked it up', sui.includes(resumeRec.id));
      check(
        'and it no longer asks to be approved',
        !sui.includes('Parked, waiting on a decision'),
        'the parked notice must not appear on a leg whose question was answered',
      );

      /* The bug this whole contract exists to prevent: finished work
         sitting in the "waiting for you" list forever. */
      await page.getByRole('button', { name: /^All runs$/ }).first().click();
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: /Waiting for you/ }).first().click();
      await page.waitForTimeout(1200);
      /* Counted, not searched for by id: the history table renders
         timestamps rather than run ids, so "the id is not on the page"
         would be true whether the fix worked or not. The number of rows
         is the thing that actually changes. */
      const shownRows = await page.locator('tbody tr').count();
      const allRuns = (await api(`/workflows/${apWf}/runs`)).runs ?? [];
      const trulyPending = allRuns.filter((r) => r.state === 'awaiting-approval' && !r.supersededBy);
      const supersededParked = allRuns.filter((r) => r.state === 'awaiting-approval' && r.supersededBy);
      check(
        'there is a superseded parked leg to get wrong',
        supersededParked.length > 0,
        `${supersededParked.length} superseded, ${trulyPending.length} genuinely pending`,
      );
      check(
        '"waiting for you" lists only the legs actually waiting',
        shownRows === trulyPending.length,
        `${shownRows} rows shown, ${trulyPending.length} pending, ${supersededParked.length} superseded excluded`,
      );

    }


    /* ── PHASE 12 — dry run does not execute the agent ──────────── */
    section('A dry run plans the agent without running it');
    const auditBefore = (await api('/fabric/audit')).audit.length;
    const dr = await post(`/workflows/${okWf}/dry-run`, { projectId });
    check('the agent step appears in the plan', dr.plan?.some((s) => s.type === 'agent'), dr.plan?.map((s) => s.type).join(','));
    check('the dry run invoked nothing', dr.sideEffects?.invocations === 0);
    const auditAfter = (await api('/fabric/audit')).audit.length;
    check('the audit trail did not grow', auditAfter === auditBefore, `${auditBefore} → ${auditAfter}`);
    const drRuns = (await api(`/workflows/${okWf}/runs`)).runs.length;
    check('no run was created by the dry run', drRuns === 1, `${drRuns} run(s)`);

    /* ── PHASE 16 — accessibility ───────────────────────────────── */
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
      return { total: els.length, bad: bad.length, first: bad[0] ? bad[0].outerHTML.slice(0, 140) : '' };
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
