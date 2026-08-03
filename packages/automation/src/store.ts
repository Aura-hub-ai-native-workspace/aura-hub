/**
 * AutomationStore — persistent local automation rules + run history.
 * ==================================================================
 * One JSON file per rule under ~/.aura/automation/rules/<id>.json and
 * one file per execution under ~/.aura/automation/runs/<ruleId>/<id>.json
 * (AURA_HOME aware), written atomically — exact mirror of
 * `workflow/store.ts`'s pattern. Rules and their runs are separate
 * concerns so run history never bloats the rule definition.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from './persist';
import { genId, type AutomationRun, type AutomationRule, type AutomationRuleSummary, type AutomationRunSummary } from './types';

const rulesDir = () => {
  const d = homePath('automation', 'rules');
  mkdirSync(d, { recursive: true });
  return d;
};
const runsDir = (ruleId: string) => {
  const d = homePath('automation', 'runs', ruleId);
  mkdirSync(d, { recursive: true });
  return d;
};
const ruleFile = (id: string) => path.join(rulesDir(), `${id}.json`);
const runFile = (ruleId: string, id: string) => path.join(runsDir(ruleId), `${id}.json`);

function sanitize(partial: Partial<AutomationRule>, id: string): AutomationRule {
  const now = new Date().toISOString();
  const chain = Array.isArray(partial.chain)
    ? partial.chain.filter((a) => a && typeof a.id === 'string' && typeof a.action === 'string').map((a) => ({ id: a.id, action: a.action, label: typeof a.label === 'string' ? a.label : a.action, config: a.config && typeof a.config === 'object' ? a.config : {}, continueOnError: a.continueOnError === true }))
    : [];
  return {
    id,
    name: typeof partial.name === 'string' && partial.name.trim() ? partial.name.trim() : 'Untitled automation',
    description: typeof partial.description === 'string' ? partial.description : '',
    category: typeof partial.category === 'string' && partial.category.trim() ? partial.category.trim() : 'General',
    enabled: partial.enabled !== false,
    trigger: {
      type: (partial.trigger?.type ?? 'mission-completed') as AutomationRule['trigger']['type'],
      match: partial.trigger?.match && typeof partial.trigger.match === 'object' ? partial.trigger.match : undefined,
    },
    conditions: Array.isArray(partial.conditions)
      ? partial.conditions.filter((c) => c && typeof c.field === 'string' && typeof c.op === 'string').map((c) => ({ field: c.field, op: c.op, value: c.value }))
      : [],
    chain,
    retry: {
      maxAttempts: typeof partial.retry?.maxAttempts === 'number' ? Math.max(1, partial.retry.maxAttempts) : 1,
      delayMs: typeof partial.retry?.delayMs === 'number' ? Math.max(0, partial.retry.delayMs) : 1000,
      backoffFactor: typeof partial.retry?.backoffFactor === 'number' ? Math.max(1, partial.retry.backoffFactor) : 2,
    },
    createdAt: typeof partial.createdAt === 'string' ? partial.createdAt : now,
    updatedAt: now,
  };
}

export class AutomationStore {
  /* ── rules ──────────────────────────────────────────────────────── */

  listRules(): AutomationRuleSummary[] {
    const out: AutomationRuleSummary[] = [];
    for (const f of readdirSync(rulesDir())) {
      if (!f.endsWith('.json')) continue;
      const rule = readJsonFile<AutomationRule | null>(path.join(rulesDir(), f), null);
      if (!rule?.id) continue;
      out.push({
        id: rule.id, name: rule.name, description: rule.description, category: rule.category,
        enabled: rule.enabled, trigger: rule.trigger.type,
        conditionCount: rule.conditions.length, actionCount: rule.chain.length,
        createdAt: rule.createdAt, updatedAt: rule.updatedAt,
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getRule(id: string): AutomationRule | null {
    return readJsonFile<AutomationRule | null>(ruleFile(id), null);
  }

  createRule(partial: Partial<AutomationRule> = {}): AutomationRule {
    const rule = sanitize({ ...partial, createdAt: new Date().toISOString() }, genId('rule'));
    writeJsonFile(ruleFile(rule.id), rule);
    return rule;
  }

  saveRule(id: string, partial: Partial<AutomationRule>): AutomationRule | null {
    const existing = this.getRule(id);
    if (!existing) return null;
    const rule = sanitize({ ...existing, ...partial, id, createdAt: existing.createdAt }, id);
    writeJsonFile(ruleFile(id), rule);
    return rule;
  }

  removeRule(id: string): boolean {
    try {
      rmSync(ruleFile(id));
      return true;
    } catch {
      return false;
    }
  }

  /* ── runs ───────────────────────────────────────────────────────── */

  listRuns(ruleId?: string): AutomationRunSummary[] {
    const dirs = ruleId ? [runsDir(ruleId)] : listRunDirs();
    const out: AutomationRunSummary[] = [];
    for (const d of dirs) {
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        const run = readJsonFile<AutomationRun | null>(path.join(d, f), null);
        if (!run?.id) continue;
        out.push({
          id: run.id, ruleId: run.ruleId, trigger: run.event.type, status: run.status,
          actionCount: run.actions.length, startedAt: run.startedAt,
          finishedAt: run.finishedAt, ms: run.ms, error: run.error,
        });
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRun(ruleId: string, id: string): AutomationRun | null {
    return readJsonFile<AutomationRun | null>(runFile(ruleId, id), null);
  }

  createRun(rule: AutomationRule, event: AutomationRun['event']): AutomationRun {
    const run: AutomationRun = {
      id: genId('run'),
      ruleId: rule.id,
      event,
      status: 'queued',
      timeline: [{ id: genId('t'), at: event.at, type: 'queued', message: 'Triggered', level: 'info' }],
      actions: rule.chain.map((a) => ({ actionId: a.id, action: a.action, label: a.label, status: 'pending', attempts: 0 })),
      conditions: [],
      startedAt: event.at,
    };
    writeJsonFile(runFile(rule.id, run.id), run);
    return run;
  }

  saveRun(run: AutomationRun): AutomationRun {
    writeJsonFile(runFile(run.ruleId, run.id), run);
    return run;
  }
}

function listRunDirs(): string[] {
  const base = homePath('automation', 'runs');
  try {
    return readdirSync(base).map((e) => path.join(base, e)).filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
