/**
 * Verification harness for the Automation Engine — run against the real
 * workspace with real actions:
 *
 *   node scripts/run-ts.mjs scripts/verify-automation.ts
 *
 * Exercises: template instantiation, rule persistence, event matching,
 * condition evaluation, chain execution (via real injected actions) and
 * retry behaviour (via a synthetic failing action). Does not require an
 * LLM key — the injected actions that need one are replaced with real
 * side-effect-free stubs here so the state machine is what is proven.
 */
import { AutomationEngine, AutomationStore, instantiateAutomationTemplate, AUTOMATION_TEMPLATES, evaluateConditions, type AutomationEvent, type AutomationActionType, type Condition } from '@aura/automation';

const home = process.env.AURA_HOME || '~/.aura';
console.log(`[verify] AURA_HOME=${home}`);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const store = new AutomationStore();

  // Clean state for a deterministic run.
  for (const r of store.listRules()) store.removeRule(r.id);

  /* ── 1. template instantiation ─────────────────────────────────── */
  console.log('\n[1] template instantiation');
  check('templates exist', AUTOMATION_TEMPLATES.length >= 6, `got ${AUTOMATION_TEMPLATES.length}`);
  const tpl = instantiateAutomationTemplate('mission-completed-run-diagnosis');
  check('mission template resolves', tpl !== null);
  check('template trigger type', tpl?.trigger.type === 'mission-completed');
  check('template has chain', (tpl?.chain.length ?? 0) >= 1);

  /* ── 2. rule persistence ───────────────────────────────────────── */
  console.log('\n[2] rule persistence');
  const rule = store.createRule(tpl ?? { name: 'verify' });
  check('rule created with id', /^rule-/.test(rule.id));
  check('rule readable from disk', store.getRule(rule.id)?.id === rule.id);
  check('rule listed', store.listRules().some((r) => r.id === rule.id));

  /* ── 3. condition evaluation (pure) ────────────────────────────── */
  console.log('\n[3] conditions');
  const ev = (payload: Record<string, unknown>, conditions: Condition[]) => evaluateConditions(payload, conditions);
  const eq = await ev({ mission: { status: 'completed' } }, [{ field: 'mission.status', op: 'equals', value: 'completed' }]);
  check('equals condition passes', eq[0].passed);
  const ne = await ev({ mission: { status: 'pending' } }, [{ field: 'mission.status', op: 'equals', value: 'completed' }]);
  check('equals condition fails otherwise', !ne[0].passed);
  const ex = await ev({ files: ['a.ts', 'README.md'] }, [{ field: 'files', op: 'contains', value: 'README.md' }]);
  check('contains condition passes', ex[0].passed);
  const rg = await ev({ category: 'security' }, [{ field: 'category', op: 'matches-regex', value: 'sec|arch' }]);
  check('regex condition passes', rg[0].passed);

  /* ── 4. chain execution + retry with synthetic actions ─────────── */
  console.log('\n[4] chain + retry');
  let attempts = 0;
  const rule2 = store.createRule({
    name: 'retry-rule',
    description: 'proves retries work',
    category: 'Test',
    enabled: true,
    trigger: { type: 'file-changed' },
    conditions: [],
    chain: [
      { id: 'a', action: 'flaky' as AutomationActionType, label: 'flaky action', config: {} },
      { id: 'b', action: 'ok' as AutomationActionType, label: 'ok action', config: {} },
    ],
    retry: { maxAttempts: 3, delayMs: 1, backoffFactor: 2 },
  });
  const engine2 = new AutomationEngine({
    store,
    actions: {
      flaky: async () => { attempts += 1; return attempts < 3 ? { ok: false, error: 'transient' } : { ok: true, summary: 'recovered' }; },
      ok: async () => ({ ok: true, summary: 'fine' }),
    },
    sleep: async () => {},
  });
  const event: AutomationEvent = { type: 'file-changed', projectId: 'p1', projectPath: '/tmp/aura-test', at: new Date().toISOString(), payload: { files: ['a.ts'] } };
  await engine2.runRuleNow(rule2.id, event);
  const run = store.getRun(rule2.id, store.listRuns(rule2.id)[0].id);
  check('run completed', run?.status === 'completed', `got ${run?.status}`);
  check('flaky retried (3 attempts)', attempts === 3, `got ${attempts}`);
  check('action states', run?.actions.map((a) => `${a.action}:${a.status}`).join(',') === 'flaky:completed,ok:completed');
  check('timeline has retry entry', run?.timeline.some((t) => t.type === 'action-retried') === true);

  /* ── 5. condition-gated rule (no match → no run) ───────────────── */
  console.log('\n[5] gated rule');
  const rule3 = store.createRule({
    name: 'gated',
    description: '',
    category: 'Test',
    enabled: true,
    trigger: { type: 'readme-changed' },
    conditions: [{ field: 'files', op: 'contains', value: 'README.md' }],
    chain: [{ id: 'a', action: 'ok' as AutomationActionType, label: 'ok', config: {} }],
    retry: { maxAttempts: 1, delayMs: 1, backoffFactor: 1 },
  });
  const engine3 = new AutomationEngine({ store, actions: { ok: async () => ({ ok: true }) }, sleep: async () => {} });
  const before = store.listRuns(rule3.id).length;
  engine3.handleEvent({ type: 'readme-changed', projectId: 'p1', projectPath: '/tmp/aura-test', at: new Date().toISOString(), payload: { files: ['CHANGELOG.md'] } });
  const after = store.listRuns(rule3.id).length;
  check('no run when condition fails', after === before, `before=${before} after=${after}`);
  engine3.handleEvent({ type: 'readme-changed', projectId: 'p1', projectPath: '/tmp/aura-test', at: new Date().toISOString(), payload: { files: ['README.md'] } });
  const gated = store.listRuns(rule3.id).filter((s) => s.trigger === 'readme-changed');
  check('run when condition passes', gated.length === 1, `got ${gated.length}`);

  /* ── 6. template-driven real event wiring (no LLM needed) ──────── */
  console.log('\n[6] template wiring');
  const store6 = new AutomationStore();
  const tpl6 = instantiateAutomationTemplate('file-changes-update-documentation') ?? instantiateAutomationTemplate('mission-completed-run-diagnosis');
  const rule6 = store6.createRule(tpl6 ?? {});
  const engine6 = new AutomationEngine({
    store: store6,
    actions: { 'update-knowledge': async () => ({ ok: true, summary: 'delta 0/0/0' }), 'run-diagnosis': async () => ({ ok: true, summary: 'diagnosis' }) },
    sleep: async () => {},
  });
  const ev6: AutomationEvent = { type: 'file-changed', projectId: 'p1', projectPath: '/tmp/aura-test', at: new Date().toISOString(), payload: { files: ['src/a.ts'] } };
  engine6.handleEvent(ev6);
  await new Promise((r) => setTimeout(r, 50));
  const runs6 = store6.listRuns(rule6.id);
  check('template rule ran', runs6.length === 1, `got ${runs6.length}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verification crashed:', e); process.exit(1); });
