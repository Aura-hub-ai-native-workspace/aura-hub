/**
 * useAutomation — the Automation Engine's state, read from the service.
 * ==================================================================
 * Rules, their runs, and the engine's live event stream. This store is
 * not an authority on anything:
 *
 *   • `enabled` is the engine's flag. Toggling calls PATCH and then
 *     re-reads; it never flips a local boolean and hopes.
 *   • Run status comes from the engine's own records. Nothing here
 *     derives, guesses or advances a run's state.
 *   • There is no local execution. A "run now" asks the service, and the
 *     service still evaluates the rule's conditions — a run that does not
 *     happen because conditions failed is a real answer, reported as one.
 */

import { create } from 'zustand';
import {
  automationClient,
  type AutomationRule,
  type AutomationRuleSummary,
  type AutomationRun,
  type AutomationRunSummary,
  type AutomationTemplateInfo,
  type RuleValidationIssue,
  type ScheduleState,
} from '../ai/automationClient';

interface AutomationState {
  loaded: boolean;
  reachable: boolean | null;
  rules: AutomationRuleSummary[];
  templates: AutomationTemplateInfo[];
  /** Full definitions, hydrated behind the list. */
  defs: Record<string, AutomationRule>;
  /** Run summaries per rule, from the service. */
  runs: Record<string, AutomationRunSummary[]>;
  /** The scheduler's own state per scheduled rule — next fire, misses. */
  schedules: Record<string, ScheduleState>;
  /** Problems the service found with the last save. */
  issues: RuleValidationIssue[];
  busy: string | null;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadRule: (id: string) => Promise<AutomationRule | null>;
  loadRuns: (ruleId: string) => Promise<void>;
  loadSchedules: () => Promise<void>;

  create: (input: Partial<AutomationRule> | { template: string }) => Promise<AutomationRule | null>;
  save: (id: string, partial: Partial<AutomationRule>) => Promise<AutomationRule | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;

  runNow: (id: string, projectId: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; run: AutomationRun | null; message: string }>;
  pause: (id: string) => Promise<string | null>;
  resume: (id: string) => Promise<string | null>;
  cancelRun: (ruleId: string, runId: string) => Promise<void>;

  /** Subscribe to the engine's stream; returns the matching stop function. */
  watch: () => () => void;
}

const isRule = (v: unknown): v is AutomationRule =>
  Boolean(v && typeof v === 'object' && 'id' in (v as AutomationRule));

export const useAutomation = create<AutomationState>((set, get) => ({
  loaded: false,
  reachable: null,
  rules: [],
  templates: [],
  defs: {},
  runs: {},
  schedules: {},
  issues: [],
  busy: null,
  error: null,

  async init() {
    try {
      const [r, t] = await Promise.all([automationClient.listRules(), automationClient.templates()]);
      set({ rules: r.rules ?? [], templates: t.templates ?? [], loaded: true, reachable: true });
      void get().loadSchedules();
      // Definitions and run history behind the list — the library needs the
      // chain to say which workflow a rule runs, and the last run to say
      // whether it worked. Neither blocks the list rendering.
      void Promise.all((r.rules ?? []).map((s) => get().loadRule(s.id).then(() => get().loadRuns(s.id))));
    } catch (e) {
      set({ loaded: true, reachable: false, error: (e as Error).message });
    }
  },

  async refresh() {
    try {
      const r = await automationClient.listRules();
      set({ rules: r.rules ?? [], reachable: true });
      void get().loadSchedules();
    } catch {
      set({ reachable: false });
    }
  },

  async loadSchedules() {
    const res = await automationClient.schedules().catch(() => null);
    if (res && res.schedules) set({ schedules: res.schedules });
  },

  async loadRule(id) {
    const rule = await automationClient.getRule(id).catch(() => null);
    if (!isRule(rule)) return null;
    set({ defs: { ...get().defs, [id]: rule } });
    return rule;
  },

  async loadRuns(ruleId) {
    const res = await automationClient.listRuns(ruleId).catch(() => null);
    if (!res || !Array.isArray(res.runs)) return;
    const sorted = [...res.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    set({ runs: { ...get().runs, [ruleId]: sorted } });
  },

  async create(input) {
    set({ busy: 'create', error: null });
    try {
      const rule = await automationClient.createRule(input);
      if (!isRule(rule)) {
        const body = rule as { error?: string; issues?: RuleValidationIssue[] };
        set({ error: body.error ?? 'The service refused this rule.', issues: body.issues ?? [] });
        return null;
      }
      set({ issues: [] });
      await get().refresh();
      set({ defs: { ...get().defs, [rule.id]: rule } });
      return rule;
    } finally {
      set({ busy: null });
    }
  },

  async save(id, partial) {
    set({ busy: id, error: null });
    try {
      const rule = await automationClient.saveRule(id, partial);
      if (!isRule(rule)) {
        const body = rule as { error?: string; issues?: RuleValidationIssue[] };
        set({ error: body.error ?? 'The service refused this rule.', issues: body.issues ?? [] });
        return null;
      }
      set({ issues: [] });
      set({ defs: { ...get().defs, [id]: rule } });
      await get().refresh();
      return rule;
    } finally {
      set({ busy: null });
    }
  },

  async setEnabled(id, enabled) {
    set({ busy: id, error: null });
    try {
      // PATCH, then re-read. The flag the engine acts on is the one on the
      // service, so the UI shows what came back rather than what was asked.
      const rule = await automationClient.patchRule(id, { enabled });
      if (isRule(rule)) set({ defs: { ...get().defs, [id]: rule } });
      else set({ error: (rule as { error: string }).error });
      await get().refresh();
    } finally {
      set({ busy: null });
    }
  },

  async remove(id) {
    set({ busy: id });
    try {
      await automationClient.removeRule(id).catch(() => null);
      const defs = { ...get().defs };
      const runs = { ...get().runs };
      delete defs[id];
      delete runs[id];
      set({ defs, runs });
      await get().refresh();
    } finally {
      set({ busy: null });
    }
  },

  async runNow(id, projectId, payload) {
    set({ busy: id, error: null });
    try {
      const res = await automationClient.runRule(id, projectId, payload);
      await get().loadRuns(id);
      if (isRule(res as unknown) || (res && 'status' in (res as AutomationRun))) {
        return { ok: true, run: res as AutomationRun, message: 'The rule ran.' };
      }
      const err = (res as { error?: string }).error ?? 'The service did not start a run.';
      // "conditions not met" is the engine working, not a failure. Saying
      // so plainly is the difference between a user learning how their rule
      // behaves and a user thinking the button is broken.
      return {
        ok: false,
        run: null,
        message:
          err === 'conditions not met'
            ? 'Nothing ran — this rule’s conditions did not pass for that event.'
            : err,
      };
    } finally {
      set({ busy: null });
    }
  },

  async pause(id) {
    const res = await automationClient.pauseRule(id).catch(() => null);
    await get().loadRuns(id);
    if (res && 'error' in res) return res.error ?? 'The service refused the pause.';
    return null;
  },

  async resume(id) {
    const res = await automationClient.resumeRule(id).catch(() => null);
    await get().loadRuns(id);
    if (res && 'error' in res) return res.error ?? 'The service refused the resume.';
    return null;
  },

  async cancelRun(ruleId, runId) {
    await automationClient.cancelRun(ruleId, runId).catch(() => null);
    await get().loadRuns(ruleId);
  },

  watch() {
    // The engine pushes a `run` event on every state transition, so the
    // library and the run view stay live without polling. The stream is a
    // convenience: every screen still reads its state from the store's
    // service-backed records, so a dropped stream degrades to stale-until-
    // refresh rather than to wrong.
    return automationClient.subscribe((e) => {
      if (e.type === 'run') {
        void get().loadRuns(e.run.ruleId);
      } else if (e.type === 'done') {
        // The done event names no rule, so refresh the rules whose runs we
        // are already tracking rather than guessing which one finished.
        for (const ruleId of Object.keys(get().runs)) void get().loadRuns(ruleId);
      }
    });
  },
}));

/* ── derived ───────────────────────────────────────────────────────── */

/** The most recent run for a rule, or null. */
export function lastRunOf(runs: AutomationRunSummary[] | undefined): AutomationRunSummary | null {
  return runs?.[0] ?? null;
}

/** Whether any run of this rule is currently pausable. */
export function activeRunOf(runs: AutomationRunSummary[] | undefined): AutomationRunSummary | null {
  return runs?.find((r) => r.status === 'running' || r.status === 'retrying' || r.status === 'queued') ?? null;
}

/** Whether any run of this rule is currently paused. */
export function pausedRunOf(runs: AutomationRunSummary[] | undefined): AutomationRunSummary | null {
  return runs?.find((r) => r.status === 'paused') ?? null;
}
