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
import {
  genId,
  type AutomationRun,
  type AutomationRule,
  type AutomationRuleSummary,
  type AutomationRunSummary,
  type AutomationTriggerType,
  type RunStatus,
} from './types';

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
      // Carried verbatim. Validity is decided by `validateRule` at the API
      // boundary, not silently coerced here — a cron quietly rewritten into
      // something that parses would fire at a time nobody asked for.
      cron: typeof partial.trigger?.cron === 'string' && partial.trigger.cron.trim() ? partial.trigger.cron.trim() : undefined,
      projectId: typeof partial.trigger?.projectId === 'string' && partial.trigger.projectId ? partial.trigger.projectId : undefined,
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

/**
 * One place a run becomes a summary.
 *
 * Both `listRuns` and the cross-rule index derive from this, so the two
 * views of a run can never describe it differently.
 */
export function summarizeAutomationRun(run: AutomationRun, ruleName?: string): AutomationRunSummary {
  return {
    id: run.id,
    ruleId: run.ruleId,
    ruleName,
    trigger: run.event.type,
    status: run.status,
    projectId: run.event.projectId,
    actionCount: run.actions.length,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ms: run.ms,
    error: run.error,
    // Prefer the rollup; fall back to walking the actions so a run written
    // by an earlier build still reports what it produced.
    produced: run.produced ?? run.actions.map((a) => a.produced).filter((p): p is NonNullable<typeof p> => Boolean(p)),
  };
}

/**
 * The cross-rule run index.
 *
 * Exactly the design already used for workflow runs, for exactly the same
 * reason: answering "show me every automation run" by walking every rule
 * directory and parsing every run file is O(runs) file reads for a screen
 * that renders fifty rows, and it forces any client that wants a merged
 * view to do the merging itself — which it will get wrong the moment
 * retention prunes one rule's history and not another's.
 *
 * It is a CACHE and never an authority. Every entry is derived from a run
 * file, the run files remain the truth, and a missing or unparseable index
 * is rebuilt from them rather than reported as an empty history.
 */
const INDEX_FILE = () => homePath('automation', 'runs-index.json');
const MAX_INDEX_ENTRIES = 5000;

interface RunIndex {
  version: 1;
  runs: AutomationRunSummary[];
}

export interface AutomationRunQuery {
  ruleId?: string;
  projectId?: string;
  status?: RunStatus;
  trigger?: AutomationTriggerType;
  /** Runs that produced a run of THIS workflow. */
  workflowId?: string;
  /** Substring match over rule name and error text. */
  q?: string;
  /** ISO instants, inclusive. */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
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
        out.push(summarizeAutomationRun(run));
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
    // Queued runs belong in the index too — a run waiting behind another
    // is exactly what an operator wondering "why has nothing happened" is
    // looking for, and leaving it out until it starts would hide it.
    this.indexUpsert(run);
    return run;
  }

  saveRun(run: AutomationRun): AutomationRun {
    writeJsonFile(runFile(run.ruleId, run.id), run);
    this.indexUpsert(run);
    return run;
  }

  /* ── cross-rule index ────────────────────────────────────────────── */

  private readIndex(): RunIndex | null {
    const raw = readJsonFile<RunIndex | null>(INDEX_FILE(), null);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.runs)) return null;
    return raw;
  }

  private indexUpsert(run: AutomationRun): void {
    const index = this.readIndex() ?? { version: 1 as const, runs: [] };
    const summary = summarizeAutomationRun(run, this.getRule(run.ruleId)?.name);
    const at = index.runs.findIndex((r) => r.id === summary.id);
    if (at >= 0) index.runs[at] = summary;
    else index.runs.push(summary);
    if (index.runs.length > MAX_INDEX_ENTRIES) {
      index.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      index.runs.length = MAX_INDEX_ENTRIES;
    }
    writeJsonFile(INDEX_FILE(), index);
  }

  /**
   * Rebuild from the run files, which are the authority. Returns the count
   * so a caller reports a repair rather than performing one silently.
   */
  rebuildRunIndex(): number {
    const names = new Map(this.listRules().map((r) => [r.id, r.name]));
    const runs: AutomationRunSummary[] = [];
    for (const d of listRunDirs()) {
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        const run = readJsonFile<AutomationRun | null>(path.join(d, f), null);
        if (!run?.id) continue;
        runs.push(summarizeAutomationRun(run, names.get(run.ruleId)));
      }
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (runs.length > MAX_INDEX_ENTRIES) runs.length = MAX_INDEX_ENTRIES;
    writeJsonFile(INDEX_FILE(), { version: 1, runs });
    return runs.length;
  }

  /**
   * Every automation run, filtered and paged server-side.
   *
   * The backend is authoritative for this view. A client asking for "failed
   * runs of this project in the last day" gets exactly that, not every rule's
   * history to sift through.
   */
  indexRuns(query: AutomationRunQuery = {}): {
    runs: AutomationRunSummary[]; total: number; offset: number; limit: number;
  } {
    let index = this.readIndex();
    if (!index) { this.rebuildRunIndex(); index = this.readIndex(); }
    let runs = [...(index?.runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (query.ruleId) runs = runs.filter((r) => r.ruleId === query.ruleId);
    if (query.projectId) runs = runs.filter((r) => r.projectId === query.projectId);
    if (query.status) runs = runs.filter((r) => r.status === query.status);
    if (query.trigger) runs = runs.filter((r) => r.trigger === query.trigger);
    if (query.workflowId) {
      runs = runs.filter((r) => (r.produced ?? []).some((p) => p.kind === 'workflow-run' && p.workflowId === query.workflowId));
    }
    if (query.since) runs = runs.filter((r) => r.startedAt >= query.since!);
    if (query.until) runs = runs.filter((r) => r.startedAt <= query.until!);
    if (query.q) {
      const needle = query.q.toLowerCase();
      runs = runs.filter((r) => (r.ruleName ?? '').toLowerCase().includes(needle) || (r.error ?? '').toLowerCase().includes(needle));
    }

    const total = runs.length;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    return { runs: runs.slice(offset, offset + limit), total, offset, limit };
  }

  /** Counts by status, for a dashboard that must not fetch every run. */
  runStats(query: Pick<AutomationRunQuery, 'projectId' | 'ruleId'> = {}): Record<string, number> {
    const { runs } = this.indexRuns({ ...query, limit: MAX_INDEX_ENTRIES });
    const out: Record<string, number> = {};
    for (const r of runs) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
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
