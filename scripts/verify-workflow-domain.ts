/**
 * Verification harness for the AURA Workflow domain model (Phase 1 + 2).
 *
 *   node scripts/run-ts.mjs scripts/verify-workflow-domain.ts
 *
 * Exercises: the constrained expression system, the node schema
 * registry, definition validation (ports, types, cycles, triggers,
 * capabilities, cron), and both stores (definition persistence with
 * versioning + export/import, run records + history stats).
 * Deterministic and self-contained: a temporary AURA_HOME is used and
 * cleaned up, and nothing here executes anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WorkflowDefinitionStore,
  WorkflowRunStore,
  evaluateExpression,
  hasErrors,
  parseExpression,
  validateDefinition,
  newRun,
  enabledTriggers,
  NODE_SCHEMAS,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@aura/workflow';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const N = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, x: 0, y: 0, config });
const E = (from: string, fromPort: string, to: string, toPort = 'in'): WorkflowDefinition['edges'][number] => ({ id: `e-${from}-${to}`, from, fromPort, to, toPort });

/** The canonical small workflow: manual → ask-aura → result. */
function canonical(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'wf-test',
    name: 'Test',
    description: '',
    projectId: null,
    status: 'ready',
    version: 1,
    nodes: [N('t', 'manual'), N('ai', 'ask-aura', { prompt: 'Summarize' }), N('r', 'result')],
    edges: [E('t', 'out', 'ai'), E('ai', 'out', 'r')],
    settings: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-workflow-verify-'));
  process.env.AURA_HOME = tmp;
  console.log(`[verify] AURA_HOME=${tmp}`);

  /* ── 1. expression system ─────────────────────────────────────── */
  console.log('\n[1] expressions');
  const parsed = parseExpression('Branch {{trigger.branch}}, files {{nodes.g.out.changedFiles.0}}');
  check('parses two references', parsed.ok && parsed.references.length === 2, JSON.stringify(parsed));
  check('path segments split', parsed.ok && parsed.references[0]!.path.join('.') === 'trigger.branch');
  check('rejects malformed braces', !parseExpression('{{unclosed').ok);
  check('rejects empty path', !parseExpression('{{}}').ok);
  check('rejects unsafe segment', !parseExpression('{{__proto__.x}}').ok);
  check('rejects code-like segment', !parseExpression('{{nodes.g.out["x"]}}').ok);

  const ev = evaluateExpression('Hello {{nodes.a.out.name}}!', { nodes: { a: { out: { name: 'AURA' } } } });
  check('evaluates nested path', ev.ok && ev.text === 'Hello AURA!', ev.ok ? ev.text : ev.error);
  const miss = evaluateExpression('{{nodes.a.out.missing}}', { nodes: { a: { out: {} } } });
  check('reports missing path', miss.ok && miss.missing.length === 1);
  const noeval = evaluateExpression('{{process.exit}}', {});
  check('cannot reach beyond scope (no eval)', noeval.ok && noeval.missing.length === 1 && noeval.text === '');

  /* ── 2. schema registry ───────────────────────────────────────── */
  console.log('\n[2] schema registry');
  const types = Object.keys(NODE_SCHEMAS);
  check('registry covers all six categories', new Set(Object.values(NODE_SCHEMAS).map((s) => s.category)).size === 6);
  check('all node types have schemas', types.length >= 32, `got ${types.length}`);
  check('trigger nodes accept no input', Object.values(NODE_SCHEMAS).filter((s) => s.category === 'trigger').every((s) => s.inputs.length === 0));
  check('condition exposes true/false', NODE_SCHEMAS.condition.outputs.map((p) => p.id).join(',') === 'true,false');
  check('loop exposes each/done', NODE_SCHEMAS.loop.outputs.map((p) => p.id).join(',') === 'each,done');
  check('capability node is the only tool', Object.values(NODE_SCHEMAS).filter((s) => s.category === 'tool').length === 1);

  /* ── 3. validation ────────────────────────────────────────────── */
  console.log('\n[3] validation');
  const clean = validateDefinition(canonical());
  check('canonical workflow validates clean', clean.length === 0, JSON.stringify(clean));

  const dup = canonical();
  dup.nodes = [N('t', 'manual'), N('t', 'manual')];
  check('duplicate node ids flagged', hasErrors(validateDefinition(dup)));

  const unknownType = canonical();
  unknownType.nodes = [N('t', 'manual'), N('x', 'not-a-type' as never), N('r', 'result')];
  check('unknown node type flagged', hasErrors(validateDefinition(unknownType)));

  const badPort = canonical();
  badPort.edges = [E('t', 'nope', 'ai')];
  check('unknown output port flagged', hasErrors(validateDefinition(badPort)));

  const badToPort = canonical();
  badToPort.edges = [E('t', 'out', 'ai', 'nope')];
  check('unknown input port flagged', hasErrors(validateDefinition(badToPort)));

  const strict = canonical();
  strict.nodes = [N('t', 'manual'), N('ai', 'ask-aura', { prompt: 'x' }), N('fe', 'for-each'), N('r', 'result')];
  strict.edges = [E('t', 'out', 'fe'), E('fe', 'each', 'ai'), E('ai', 'out', 'r')];
  // for-each.in is 'array'; manual.out is 'object' → mismatch
  check('port type mismatch flagged', hasErrors(validateDefinition(strict)));

  const intoEntry = canonical();
  intoEntry.edges = [E('t', 'out', 'ai'), E('r', 'out', 't')]; // edge INTO manual
  check('edge into entry node flagged', hasErrors(validateDefinition(intoEntry)));

  const mergeConflict = canonical();
  mergeConflict.nodes = [N('t', 'manual'), N('ai', 'ask-aura', { prompt: 'x' }), N('r', 'result')];
  mergeConflict.edges = [E('t', 'out', 'r'), E('ai', 'out', 'r')]; // two edges into result.in
  check('single-edge port conflict flagged', hasErrors(validateDefinition(mergeConflict)));

  const mergeOk = canonical();
  mergeOk.nodes = [N('t', 'manual'), N('ai', 'ask-aura', { prompt: 'x' }), N('m', 'merge'), N('r', 'result')];
  mergeOk.edges = [E('t', 'out', 'm'), E('ai', 'out', 'm'), E('m', 'out', 'r')];
  check('merge accepts many inputs', !hasErrors(validateDefinition(mergeOk)));

  const cycle = canonical();
  cycle.nodes = [N('t', 'manual'), N('m', 'merge'), N('a', 'ask-aura', { prompt: 'x' }), N('b', 'summarize', {})];
  cycle.edges = [E('t', 'out', 'm'), E('m', 'out', 'a'), E('a', 'out', 'b'), E('b', 'out', 'a')]; // a → b → a
  check('plain cycle flagged', validateDefinition(cycle).some((i) => i.code === 'cycle'));

  const loopCycle = canonical();
  loopCycle.nodes = [N('t', 'manual'), N('l', 'loop', {}), N('a', 'ask-aura', { prompt: 'x' })];
  loopCycle.edges = [E('t', 'out', 'l'), E('l', 'each', 'a'), E('a', 'out', 'l')]; // subtree returns to the loop
  check('cycle through loop still flagged', validateDefinition(loopCycle).some((i) => i.code === 'cycle'));

  const unreachable = canonical();
  unreachable.nodes = [N('t', 'manual'), N('r', 'result'), N('a', 'ask-aura', { prompt: 'x' }), N('b', 'summarize', {})];
  unreachable.edges = [E('t', 'out', 'r'), E('a', 'out', 'b'), E('b', 'out', 'a')]; // a/b disconnected from the entry
  check('unreachable node warned', validateDefinition(unreachable).some((i) => i.code === 'unreachable-node'));

  const badCron = canonical();
  badCron.nodes = [N('t', 'schedule', { cron: 'every monday' }), N('r', 'result')];
  badCron.edges = [E('t', 'out', 'r')];
  check('invalid cron flagged', hasErrors(validateDefinition(badCron)));

  const goodCron = canonical();
  goodCron.nodes = [N('t', 'schedule', { cron: '0 9 * * 1-5' }), N('r', 'result')];
  goodCron.edges = [E('t', 'out', 'r')];
  check('valid cron accepted', !hasErrors(validateDefinition(goodCron)));

  const badCap = canonical();
  badCap.nodes = [N('t', 'manual'), N('c', 'capability', { capabilityId: 'shell.boom' }), N('r', 'result')];
  badCap.edges = [E('t', 'out', 'c'), E('c', 'out', 'r')];
  check('unknown capability flagged', hasErrors(validateDefinition(badCap)));

  const goodCap = canonical();
  goodCap.nodes = [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute' }), N('r', 'result')];
  goodCap.edges = [E('t', 'out', 'c'), E('c', 'out', 'r')];
  check('manifest capability accepted', !hasErrors(validateDefinition(goodCap)));

  const badExpr = canonical();
  badExpr.nodes = [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: {{broken' }), N('r', 'result')];
  badExpr.edges = [E('t', 'out', 'c'), E('c', 'out', 'r')];
  check('invalid expression in config flagged', hasErrors(validateDefinition(badExpr)));

  const sw = canonical();
  sw.nodes = [N('t', 'manual'), N('s', 'switch', { field: '{{nodes.c.out.label}}', cases: 'bug\nfeature' }), N('r1', 'result'), N('r2', 'result'), N('r3', 'result')];
  sw.edges = [E('t', 'out', 's'), E('s', 'case-1', 'r1'), E('s', 'case-2', 'r2'), E('s', 'default', 'r3')];
  check('switch dynamic ports accepted', !hasErrors(validateDefinition(sw)));

  /* ── 4. definition store ──────────────────────────────────────── */
  console.log('\n[4] definition store');
  const defs = new WorkflowDefinitionStore();
  const created = defs.create({ name: 'Release Check', nodes: canonical().nodes, edges: canonical().edges, status: 'ready' });
  check('created with id and version 1', /^wf-/.test(created.id) && created.version === 1);
  check('readable from disk', defs.get(created.id)?.name === 'Release Check');
  check('listed', defs.list().some((d) => d.id === created.id));
  check('list shows node count', defs.list().find((d) => d.id === created.id)?.nodeCount === 3);

  const saved = defs.save(created.id, { name: 'Release Check v2' });
  check('save bumps version', saved?.version === 2, JSON.stringify(saved?.version));
  check('save keeps createdAt', saved?.createdAt === created.createdAt);

  const exported = defs.exportJson(created.id);
  check('exports JSON', exported !== null && exported.includes('"schemaVersion": 1'));
  const imported = defs.importJson(exported ?? '');
  check('import roundtrips', imported.ok && imported.definition.nodes.length === 3 && imported.definition.id !== created.id);
  check('import lands as draft', imported.ok && imported.definition.status === 'draft');
  check('import rejects garbage', !defs.importJson('{nope').ok);

  const draft = defs.create({ name: 'Half built', nodes: [N('t', 'manual'), N('c', 'capability', {})], edges: [] });
  check('incomplete draft saves', draft.status === 'draft');
  let promoteRejected = false;
  try {
    defs.markReady(draft.id);
  } catch {
    promoteRejected = true;
  }
  check('ready requires clean validation', promoteRejected);

  let threw = false;
  try {
    defs.create({ name: 'Bad ready', status: 'ready', nodes: [N('t', 'manual'), N('x', 'ghost' as never)], edges: [] });
  } catch {
    threw = true;
  }
  check('create refuses invalid ready', threw);

  check('remove works', defs.remove(created.id) && defs.get(created.id) === null);

  const scoped = defs.create({ name: 'Project bound', projectId: 'proj-1', nodes: canonical().nodes, edges: canonical().edges });
  check('list filters by project', defs.list('proj-1').some((d) => d.id === scoped.id) && !defs.list('other').some((d) => d.id === scoped.id));

  const trig = defs.create({
    name: 'Triggers',
    nodes: [
      N('m', 'manual', {}),
      N('s', 'schedule', { cron: '0 9 * * *', enabled: false }),
      N('r', 'result'),
    ],
    edges: [E('m', 'out', 'r'), E('s', 'out', 'r')],
  });
  const active = enabledTriggers(defs.get(trig.id)!);
  check('enabledTriggers honours enabled flag', active.length === 1 && active[0]!.id === 'm');

  /* ── 5. run store ─────────────────────────────────────────────── */
  console.log('\n[5] run store');
  const runs = new WorkflowRunStore();
  const run1 = newRun({ workflowId: created.id, workflowVersion: 2, projectId: null, triggerId: null });
  run1.status = 'completed';
  run1.finishedAt = new Date(Date.parse(run1.startedAt) + 1_800).toISOString();
  run1.nodeRuns = [
    { nodeId: 't', status: 'success', attempts: 1, logs: [], auditIds: [], ms: 300, startedAt: run1.startedAt, finishedAt: run1.finishedAt },
    { nodeId: 'r', status: 'success', attempts: 1, logs: [], auditIds: [], ms: 500 },
  ];
  runs.record(run1);
  const run2 = newRun({ workflowId: created.id, workflowVersion: 2, projectId: null, triggerId: 's' });
  run2.startedAt = new Date(Date.parse(run1.startedAt) + 1_000).toISOString();
  run2.status = 'failed';
  run2.error = 'boom';
  run2.finishedAt = new Date(Date.parse(run2.startedAt) + 2_200).toISOString();
  runs.record(run2);

  check('run recorded and readable', runs.get(created.id, run1.runId)?.status === 'completed');
  check('runs listed newest first', runs.list(created.id)[0]!.runId === run2.runId);
  const stats = runs.stats(created.id);
  check('stats count runs', stats.runs === 2, JSON.stringify(stats));
  check('stats success/failed', stats.success === 1 && stats.failed === 1);
  check('stats average duration', stats.avgDurationMs === 2_000, `got ${stats.avgDurationMs}`);
  check('last run is the failed one', stats.lastStatus === 'failed');
  check('run remove works', runs.remove(created.id, run1.runId) && runs.get(created.id, run1.runId) === null);

  /* ── cleanup ──────────────────────────────────────────────────── */
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AURA_HOME;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});