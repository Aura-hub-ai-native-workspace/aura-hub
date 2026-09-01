/**
 * ruleValidation — what is wrong with this rule, before it is saved.
 * ==================================================================
 * Shape checks only, against the same requirements the service's
 * `sanitize()` enforces in `packages/automation/src/store.ts`. It is not
 * a second engine:
 *
 *   • It never evaluates a condition. Whether a condition passes depends
 *     on a real event payload the editor does not have.
 *   • It never decides permission. A workflow's authority is the
 *     Capability Fabric's answer, read from the workflow's envelope.
 *
 * Two tiers, and the tier decides the consequence:
 *   error   — Save is disabled; the service would drop or reject this.
 *   warning — Save proceeds; the rule would probably never do anything.
 */

import type { AutomationRule } from '../../ai/automationClient';
import { ACTIONS, CONDITION_OPS, TRIGGERS } from './automationMeta';

export type FindingLevel = 'error' | 'warning';

export interface RuleFinding {
  id: string;
  level: FindingLevel;
  message: string;
  fix?: string;
}

export interface RuleReport {
  findings: RuleFinding[];
  errors: number;
  warnings: number;
  savable: boolean;
}

export interface RuleDraft {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  trigger: AutomationRule['trigger'];
  conditions: AutomationRule['conditions'];
  chain: AutomationRule['chain'];
  retry: AutomationRule['retry'];
}

export function validateRule(draft: RuleDraft, knownWorkflowIds: Set<string>): RuleReport {
  const findings: RuleFinding[] = [];
  const add = (f: RuleFinding) => findings.push(f);

  if (!draft.name.trim()) {
    add({ id: 'name', level: 'error', message: 'This rule needs a name.', fix: 'Name it after what it does — “PR merged → security review”.' });
  }

  if (draft.trigger.type === 'schedule') {
    // Mirrors the service's own check. The cron itself is validated there —
    // this only catches the empty cases before a round trip.
    if (!String(draft.trigger.cron ?? '').trim()) {
      add({ id: 'cron', level: 'error', message: 'A scheduled rule needs a cron expression.', fix: 'For example, 0 9 * * 1-5 runs at 09:00 on weekdays.' });
    } else if (String(draft.trigger.cron).trim().split(/\s+/).length !== 5) {
      add({ id: 'cron-shape', level: 'error', message: 'A cron expression has five fields.', fix: 'minute hour day-of-month month day-of-week' });
    }
    if (!String(draft.trigger.projectId ?? '').trim()) {
      add({ id: 'schedule-project', level: 'error', message: 'A scheduled rule has to name the project it runs against.', fix: 'Pick a project — a time trigger has no event to infer one from.' });
    }
  }

  if (!TRIGGERS[draft.trigger.type]) {
    add({ id: 'trigger', level: 'error', message: `“${draft.trigger.type}” is not a trigger this engine knows.`, fix: 'Pick one of the listed triggers.' });
  }

  /* ── the chain ───────────────────────────────────────────────────── */
  if (!draft.chain.length) {
    add({ id: 'chain', level: 'error', message: 'This rule does nothing — it has no actions.', fix: 'Add at least one action below.' });
  }

  draft.chain.forEach((a, i) => {
    const meta = ACTIONS[a.action];
    if (!meta) {
      add({ id: `action:${a.id}`, level: 'error', message: `Step ${i + 1} uses “${a.action}”, which is not an action this engine knows.`, fix: 'Remove the step, or pick a listed action.' });
      return;
    }
    if (a.action === 'run-workflow') {
      const id = String(a.config.workflowId ?? '').trim();
      if (!id) {
        add({ id: `wf:${a.id}`, level: 'error', message: `Step ${i + 1} runs a workflow but no workflow is chosen.`, fix: 'Pick a workflow for that step.' });
      } else if (knownWorkflowIds.size && !knownWorkflowIds.has(id)) {
        // A rule can outlive the workflow it names. Saying so is better
        // than letting the run fail later with a service-level error.
        add({ id: `wfmissing:${a.id}`, level: 'error', message: `Step ${i + 1} names a workflow that no longer exists.`, fix: 'Pick a workflow that is still in your library.' });
      }
    }
    if (a.action === 'save-memory' && !String(a.config.title ?? '').trim()) {
      add({ id: `mem:${a.id}`, level: 'warning', message: `Step ${i + 1} writes to memory with no title.`, fix: 'Give the entry a title so it can be found later.' });
    }
  });

  /* ── conditions ──────────────────────────────────────────────────── */
  draft.conditions.forEach((c, i) => {
    if (!c.field.trim()) {
      add({ id: `cond:${i}:field`, level: 'error', message: `Condition ${i + 1} has no field.`, fix: 'Pick a field from the trigger’s payload, or type a dot-path.' });
    }
    const op = CONDITION_OPS[c.op];
    if (!op) {
      add({ id: `cond:${i}:op`, level: 'error', message: `Condition ${i + 1} uses an operator this engine does not know.` });
      return;
    }
    const empty = c.value === undefined || c.value === null || (typeof c.value === 'string' && !c.value.trim());
    if (op.needsValue && empty) {
      add({ id: `cond:${i}:value`, level: 'error', message: `Condition ${i + 1} (“${op.label}”) needs a value to compare against.`, fix: 'Fill in the value, or use “is present” instead.' });
    }
    if (c.op === 'matches-regex' && typeof c.value === 'string' && c.value.trim()) {
      try {
        new RegExp(c.value);
      } catch {
        add({ id: `cond:${i}:regex`, level: 'error', message: `Condition ${i + 1} has a pattern that is not valid.`, fix: 'Fix the regular expression.' });
      }
    }
  });

  /* ── retry ───────────────────────────────────────────────────────── */
  if (draft.retry.maxAttempts < 1) {
    add({ id: 'retry:attempts', level: 'error', message: 'An action must be attempted at least once.', fix: 'Set attempts to 1 or more.' });
  }
  if (draft.retry.maxAttempts > 1 && draft.retry.delayMs <= 0) {
    add({ id: 'retry:delay', level: 'warning', message: 'Retries have no delay, so a failing action retries immediately.', fix: 'Add a delay so a transient failure has time to clear.' });
  }
  if (draft.retry.backoffFactor < 1) {
    add({ id: 'retry:backoff', level: 'error', message: 'Backoff cannot shrink the delay between attempts.', fix: 'Use 1 for a fixed delay, or more to back off.' });
  }

  /* ── things that would make the rule pointless ───────────────────── */
  if (!draft.enabled) {
    add({ id: 'disabled', level: 'warning', message: 'This rule is disabled, so the engine will skip it.', fix: 'Enable it when you are ready for it to fire.' });
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;
  return { findings, errors, warnings, savable: errors === 0 };
}

/** A blank rule, matching the service's own defaults in `sanitize()`. */
export function emptyDraft(): RuleDraft {
  return {
    name: '',
    description: '',
    category: 'General',
    enabled: true,
    trigger: { type: 'pr-merged' },
    conditions: [],
    chain: [],
    retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
  };
}

export function draftFrom(rule: AutomationRule): RuleDraft {
  return {
    name: rule.name,
    description: rule.description,
    category: rule.category,
    enabled: rule.enabled,
    trigger: rule.trigger,
    conditions: rule.conditions,
    chain: rule.chain,
    retry: rule.retry,
  };
}

export const newActionId = () => `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
