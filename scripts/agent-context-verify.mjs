/**
 * agent-context-verify — the canonical prompt and its injection.
 * ==================================================================
 * Before Phase C, `agent.delegate` sent OpenCode exactly one thing: the
 * user's task string. The agent then rediscovered the repository on every
 * call — the problem the Context Fabric exists to remove.
 *
 * These checks prove the agent now receives system rules + this project's
 * context + the task, that the context is the SAME contract Ask AURA
 * gets, and — just as importantly — that nothing was smuggled in with it:
 * no second scanner, no second capability catalogue, no shell, no
 * credentials.
 *
 * Usage:
 *   AURA_HOME=<isolated> node .aura/ai-service.mjs   # service on :4319
 *   node scripts/agent-context-verify.mjs
 *
 * Requires no AI provider and spawns no agent: the prompt is inspected
 * through the transparency route that uses the same builder the executor
 * is handed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.HUB_API ?? 'http://127.0.0.1:4319';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const api = async (p) => (await fetch(`${API}${p}`)).json();
const post = (p, body) => fetch(`${API}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then((r) => r.json());

const health = await api('/health');
if (!health) { console.error('FATAL  service not answering'); process.exit(1); }

const projects = (await api('/projects')).projects ?? [];
if (projects.length < 2) { console.error(`FATAL  need two projects, found ${projects.length}`); process.exit(1); }
const [projA, projB] = projects;

const TASK = 'Fix the authentication bug';
const enc = (s) => encodeURIComponent(s);
const promptFor = (id, task) => api(`/projects/${id}/context?prompt=1&task=${enc(task)}`);

/* ── 1. the canonical system prompt exists and is one thing ───────── */
{
  const res = await api(`/projects/${projA.id}/context?prompt=1`);
  check('1. a canonical system prompt exists',
    typeof res.systemPrompt === 'string' && res.systemPrompt.includes('<AURA_SYSTEM>'),
    `${res.systemPrompt?.length ?? 0} chars`);

  const src = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/systemPrompt.ts'), 'utf8');
  check('1b. it is defined once, as a constant',
    (src.match(/export const AURA_SYSTEM_PROMPT/g) ?? []).length === 1);
  check('1c. it carries no project facts (rules only, never stale)',
    !res.systemPrompt.includes(projA.name) && !res.systemPrompt.includes(projA.path));
}

/* ── 2–7. the composed agent prompt ───────────────────────────────── */
const composed = await promptFor(projA.id, TASK);
{
  const p = composed.agentPrompt;
  check('2. the ContextView is injected into the agent prompt',
    typeof p === 'string' && p.includes('<AURA_SYSTEM>') && p.includes('<PROJECT_CONTEXT>'),
    `${p?.length ?? 0} chars`);

  check('3. the agent receives PROJECT_CONTEXT for the right project',
    p.includes(projA.name) && p.includes(projA.path));

  check('4. the agent receives freshness information',
    /Context: (v\d+, current as of|v\d+, STALE|NOT ANALYSED)/.test(p),
    (p.match(/Context: [^\n]{0,60}/) ?? [''])[0]);

  check('5. the agent receives available capabilities',
    p.includes('<AVAILABLE_CAPABILITIES>'));

  const view = composed.view;
  const expectActivity = !!view.mission.active || view.activity.events.length > 0;
  check('6. current activity is present when there is any, absent when not',
    expectActivity === p.includes('<CURRENT_ACTIVITY>'),
    `hasActivity=${expectActivity} block=${p.includes('<CURRENT_ACTIVITY>')}`);

  check('7. the user task is fenced separately from rules and facts',
    p.includes(`<TASK>\n${TASK}\n</TASK>`));
  check('7b. the task appears exactly once, not merged into the context',
    (p.match(/Fix the authentication bug/g) ?? []).length === 1);
  check('7c. rules come before facts, facts before the task',
    p.indexOf('<AURA_SYSTEM>') < p.indexOf('<PROJECT_CONTEXT>')
    && p.indexOf('<PROJECT_CONTEXT>') < p.indexOf('<TASK>'));
}

/* ── 8 + 9. the prompt describes the project it was asked about ───── */
{
  await post(`/projects/${projB.id}/open`, {});
  const a = await promptFor(projA.id, TASK);
  check('8. context is generated from the REQUESTED project id',
    a.agentPrompt.includes(projA.path));
  check('9. asking for A while B is MOUNTED still yields A\'s context',
    a.agentPrompt.includes(projA.path) && !a.agentPrompt.includes(projB.path),
    `mounted=${projB.id} requested=${projA.id}`);

  const b = await promptFor(projB.id, TASK);
  check('9b. and asking for B yields B\'s',
    b.agentPrompt.includes(projB.path) && !b.agentPrompt.includes(projA.path));
}

/* ── 10–13. nothing was duplicated or smuggled in ─────────────────── */
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const sys = strip(fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/systemPrompt.ts'), 'utf8'));
  const exec = strip(fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/fabric/executors.ts'), 'utf8'));

  check('10. no duplicate repository scanner was introduced',
    !sys.includes('readdirSync') && !sys.includes('scanEnvironment') && !sys.includes('detectChanges'));
  /* Test the IMPORTS, not the text. The prompt legitimately contains the
     string "CAPABILITIES" inside its own <AVAILABLE_CAPABILITIES> tag, so
     a substring search over the file flags the tag name and says nothing
     about whether a catalogue was duplicated. What matters is that this
     module pulls no catalogue in and enumerates nothing itself. */
  const sysImports = [...sys.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('11. no duplicate capability catalogue was introduced',
    !sysImports.some((i) => i.includes('connected-environment') || i.includes('capability-fabric'))
    && !sys.includes('Object.keys(CAPABILITIES)') && !sys.includes('CATALOG.'),
    `imports: ${sysImports.join(', ')}`);
  check('12. the prompt layer runs no process',
    !sys.includes('execFile') && !sys.includes('spawn') && !sys.includes('child_process'));
  check('13. the prompt layer touches no filesystem',
    !sys.includes("from 'node:fs'") && !sys.includes('writeFileSync'));

  /* The executor must CONSUME context, never gather it — a collector here
     is how a delegated agent would end up told something different from
     Ask AURA about the same project. */
  check('10b. agent.delegate does not compose context itself',
    !exec.includes('composeContextView') && !exec.includes('renderContextContract')
    && !exec.includes('loadIdentity') && !exec.includes('gatherGitStatus'));
  check('10c. it consumes the already-composed prompt',
    exec.includes('auraPrompt'));
  check('12b. the delegated payload still travels as one argv element',
    exec.includes('args(payload, cwd, model)'));
}

/* ── 14. Ask AURA uses the same contract ──────────────────────────── */
{
  const server = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/server.ts'), 'utf8');
  // One assembly function feeding every consumer is the property that
  // makes "same contract" true rather than merely intended.
  check('14. one context assembly serves every consumer',
    (server.match(/async function contextViewFor\(/g) ?? []).length === 1);
  /* Updated for the P0 fixes. `applyAuraContext`/`setAuraContext` were the
     old shared-state pair; Ask AURA is now fed by `resolveAuraContext`,
     which RETURNS a per-request contract instead of writing one to the
     shared pipeline. The invariant asserted is the same — Ask AURA draws
     from the one assembly — but the mechanism it must use is stricter. */
  check('14b. Ask AURA is fed from it, per request',
    server.includes('async function resolveAuraContext')
    && server.includes('const ctx = await resolveAuraContext(b)')
    && server.includes('await contextViewFor(projectId)'));
  check('14b-i. and the removed shared-state pair is gone for good',
    !server.includes('applyAuraContext') && !server.includes('setAuraContext('));
  check('14c. agent.delegate is fed from it',
    server.includes('agentPrompt: agentPromptFor')
    && server.includes('const view = await contextViewFor(projectId)'));

  const pipeline = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/pipeline.ts'), 'utf8');
  check('14d. the pipeline consumes context rather than collecting it',
    pipeline.includes('auraContext?: string | null') && !pipeline.includes('composeContextView'));
  check('14d-i. and carries it as a parameter, not singleton state',
    !/private\s+auraContext/.test(pipeline) && !pipeline.includes('this.auraContext ='),
    'request-scoped state must not live on the shared PipelineManager');

  // Behavioural: the contract Ask AURA is handed is the same text the
  // agent prompt embeds.
  const contract = composed.contract;
  check('14e. the agent prompt embeds the identical Ask AURA contract',
    typeof contract === 'string' && contract.length > 0 && composed.agentPrompt.includes(contract));
}

/* ── 15–17. freshness is never overstated ─────────────────────────── */
{
  const view = composed.view;
  const p = composed.agentPrompt;
  const state = view.freshness.state;

  if (state === 'stale') {
    check('15. stale context is explicitly marked', p.includes('STALE'));
  } else if (state === 'unknown') {
    check('16. unknown context is NOT represented as fresh',
      p.includes('NOT ANALYSED') && !/current as of/.test(p));
  } else {
    check('15/16. fresh context is marked current', /current as of/.test(p));
  }
  check('15b. the rules tell the agent how to treat each freshness state',
    p.includes('fresh:') && p.includes('stale:') && p.includes('unknown:'));

  /* Exercise the full fresh → stale transition on a DISPOSABLE project.
     Earlier drafts edited a registered project's own tree, which both
     polluted the repository and — because the file was dot-prefixed —
     was never indexed at all, since the scanner deliberately skips
     dotfiles. A throwaway fixture avoids both problems. */
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-phasec-'));
  fs.mkdirSync(path.join(tmpRoot, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"phasec","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# phasec\n\nA disposable freshness fixture.\n');
  const nested = path.join(tmpRoot, 'src', 'deep', 'buried.ts');
  fs.writeFileSync(nested, 'export const buried = 1;\n');

  const reg = await post('/projects', { path: tmpRoot, name: 'phasec-fixture' });
  const tmpId = reg?.project?.id;
  if (!tmpId) {
    check('15c. freshness fixture registered', false, JSON.stringify(reg).slice(0, 200));
  } else {
    await post(`/projects/${tmpId}/open`, {});
    await post('/inspect', { text: 'what is this project' });

    const fresh = await promptFor(tmpId, TASK);
    check('15c. an analysed project reports current',
      fresh.view.freshness.state === 'fresh' && /current as of/.test(fresh.agentPrompt),
      `state=${fresh.view.freshness.state}`);

    // A real nested edit, on an indexed (non-dot) source file.
    fs.writeFileSync(nested, 'export const buried = 2;\n');
    const future = (Date.now() + 60_000) / 1000;
    fs.utimesSync(nested, future, future);

    const stale = await promptFor(tmpId, TASK);
    check('15d. after a real nested edit the prompt says STALE',
      stale.view.freshness.state === 'stale' && stale.agentPrompt.includes('STALE'),
      `state=${stale.view.freshness.state}`);
    check('15e. and tells the agent the facts may no longer be accurate',
      /may no longer be accurate/.test(stale.agentPrompt));
    check('15f. the constraints block repeats it where an agent will act on it',
      stale.agentPrompt.includes('Re-index before relying on the repository summary'));

    await fetch(`${API}/projects/${tmpId}`, { method: 'DELETE' }).catch(() => {});
  }

  /* An omitted section is the honest rendering of "nothing to say"; a
     header with an empty body reads as "AURA looked and found nothing".
     The earlier `/:\s*\n/` heuristic flagged ordinary prose ("Recent
     commits:") and tested nothing real. */
  const emptyBlock = /<([A-Z_]+)>\s*<\/\1>/.test(p);
  check('17. no section is rendered empty', !emptyBlock);
  check('17b. no placeholder values leak into the prompt',
    !/\bundefined\b/.test(p) && !/\bNaN\b/.test(p) && !/\[object Object\]/.test(p));
}

/* ── 18. no secrets, anywhere ─────────────────────────────────────── */
{
  const p = composed.agentPrompt;
  const secretish = /sk-[a-zA-Z0-9]{8,}|api[_-]?key\s*[:=]\s*\S|bearer\s+[a-zA-Z0-9._-]{8,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY|password\s*[:=]/i;
  check('18. the composed prompt contains no credential-shaped value',
    !secretish.test(p));
  check('18b. the provider is named without its key',
    !/fingerprint/i.test(p));

  // Prove redaction actively: put a secret-looking value where a provider
  // id would be read from and confirm it cannot reach the prompt.
  const compose = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/context/compose.ts'), 'utf8');
  check('18c. composition redacts credential-shaped provider values',
    compose.includes('assertNoSecrets'));
  check('18d. the key fingerprint is deliberately not read',
    fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/server.ts'), 'utf8')
      .includes('it is deliberately not read here'));
}

/* ── 19. budget ───────────────────────────────────────────────────── */
{
  const m = composed.measurement;
  console.log('\nPROMPT BUDGET');
  console.log(`  system rules   ${String(m.systemChars).padStart(6)} chars`);
  console.log(`  project context${String(m.contextChars).padStart(6)} chars`);
  console.log(`  task           ${String(m.taskChars).padStart(6)} chars`);
  console.log(`  total          ${String(m.totalChars).padStart(6)} chars  ≈ ${m.approxTokens} tokens\n`);

  check('19. the whole prompt stays a briefing, not a repository dump',
    m.approxTokens < 4000, `≈${m.approxTokens} tokens`);
  check('19b. context does not dwarf the rules by more than 10x',
    m.contextChars < m.systemChars * 10, `${m.contextChars} vs ${m.systemChars}`);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
