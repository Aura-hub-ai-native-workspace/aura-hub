/**
 * Runtime smoke test — proves the REAL action bindings in
 * packages/ai-service/src/automation.ts execute against real engines.
 *
 *   node scripts/run-ts.mjs scripts/verify-automation-runtime.ts
 *
 * No LLM key needed: it uses the save-memory action (writes through a real
 * ProjectMemory) and the update-knowledge action (real FullStackKnowledgeEngine
 * on the small automation package src dir via the fresh-engine fallback).
 */
import { createAutomationRuntime, automationEvent, type AutomationHost, ProjectMemory } from '@aura/ai-service';
import { instantiateAutomationTemplate, AutomationStore } from '@aura/automation';
import { DiagnosisStore } from '@aura/ai-service/diagnosis/store';
import path from 'node:path';

const root = path.resolve('packages', 'automation', 'src');
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const projectId = 'verify-runtime';
  const memory = new ProjectMemory(projectId);
  memory.list(); // warm constructor

  const host: AutomationHost = {
    projectPath: () => root,
    pipelineFor: () => ({ fullstack: null }) as never,
    memoryFor: () => memory,
    diagnoses: new DiagnosisStore(),
  };

  const runtime = createAutomationRuntime(host);
  const events: string[] = [];
  const unsub = runtime.subscribe((e) => events.push(e.type === 'run' ? `${e.type}:${e.run.status}` : `${e.type}`));

  const store = new AutomationStore();
  const tpl = instantiateAutomationTemplate('mission-accepted-generate-engineering-memory');
  check('template instantiated', tpl !== null);
  const rule = store.createRule(tpl ?? { name: 'mem' });

  console.log('\n[save-memory via real ProjectMemory]');
  const before = memory.list().length;
  const run = await runtime.engine.runRuleNow(rule.id, automationEvent('mission-accepted', projectId, root, {
    missionId: 'm1',
    taskId: 't1',
    taskTitle: 'Add login flow',
    mission: { text: 'Implement authentication' },
    task: { title: 'Add login flow' },
  }));
  check('rule matched + ran', run !== null, 'conditions not met or rule missing');
  check('run completed', run?.status === 'completed', `got ${run?.status}`);
  check('memory written', memory.list().length === before + 1, `before=${before} after=${memory.list().length}`);
  const item = memory.list()[0];
  check('memory title interpolated', item.title === 'Accepted: Add login flow', `got "${item.title}"`);
  check('memory body interpolated', item.body.includes('Implement authentication'), `got "${item.body}"`);
  check('subscribe received events', events.length > 0, `got ${events.length}`);
  unsub();

  console.log('\n[update-knowledge via real FullStackKnowledgeEngine]');
  const store2 = new AutomationStore();
  const rule2 = store2.createRule(instantiateAutomationTemplate('file-changes-update-documentation') ?? { name: 'upd' });
  const run2 = await runtime.engine.runRuleNow(rule2.id, automationEvent('file-changed', projectId, root, { files: ['engine.ts'] }));
  check('knowledge update run completed', run2?.status === 'completed', `got ${run2?.status}`);
  check('knowledge action summary', Boolean(run2?.actions[0]?.summary?.includes('knowledge')), `got ${run2?.actions[0]?.summary}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('runtime smoke test crashed:', e); process.exit(1); });
