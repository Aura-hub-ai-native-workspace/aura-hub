/**
 * Rule dry run — what a rule WOULD do, with nothing done.
 * ==================================================================
 * The workflow dry run answers "what would this graph do". This answers
 * the question one level up: given a rule, would it even fire, and if it
 * did, what would follow?
 *
 * It is built ENTIRELY out of things that already exist:
 *
 *   • `evaluateConditions()` — the Automation Engine's own predicate
 *     evaluator, a pure function over a payload;
 *   • `dryRunWorkflow()`     — the workflow dry run, which itself only
 *     calls the Capability Fabric's read-only `evaluate()`;
 *   • `describeCron` / `nextFire` — the scheduler's own arithmetic.
 *
 * Nothing here executes, and nothing here re-implements. There is no
 * second condition evaluator and no second executor, because the two
 * places that already decide those things are called directly.
 *
 * ── The determinism contract ───────────────────────────────────────
 * Every answer is labelled, and the labels mean precise things:
 *
 *   known       — determined now, from data in hand.
 *   conditional — determined by data that exists at run time. The report
 *                 says what it depends on.
 *   unknown     — cannot be determined here at all, and no amount of
 *                 analysis would change that.
 *
 * The distinction is load-bearing. A dry run that reported a guess as a
 * fact would be worse than no dry run, because it would be trusted. So
 * condition outcomes are `known` only when the caller supplied a sample
 * payload and `conditional` otherwise; chain position past the first
 * action is `conditional`; and loop counts, model output and external
 * responses are listed as `unknowns` rather than estimated.
 */

import {
  describeCron,
  evaluateConditions,
  nextFire,
  validateRule,
  type AutomationEvent,
  type AutomationRule,
  type ConditionEvaluation,
} from '@aura/automation';
import type { DryRunReport } from './workflow/dryrun';
import type { Workflow } from './workflow/types';

export type Certainty = 'known' | 'conditional' | 'unknown';

export interface Determination<T> {
  certainty: Certainty;
  /** Null whenever `certainty` is not `known`. Never a guess. */
  value: T | null;
  /** Why it is what it is. Always populated, always plain language. */
  reason: string;
  /** What it depends on, for `conditional`. */
  dependsOn?: string;
}

export interface PlannedAction {
  actionId: string;
  action: string;
  label: string;
  /** Would the chain reach this action? */
  reached: Determination<boolean>;
  /** Present for `run-workflow`: which workflow, and its full dry run. */
  workflow?: { workflowId: string; workflowName: string; dryRun: DryRunReport | null; error?: string };
  /** Capabilities this action would request, flattened from the workflow. */
  capabilities: { capabilityId: string; decision: string; rule: string; risk: string; wouldAskHuman: boolean; wouldBeDenied: boolean }[];
  continueOnError: boolean;
}

export interface RuleDryRunReport {
  ruleId: string;
  ruleName: string;
  enabled: boolean;
  at: string;
  /** Structural problems. A rule with these can never run correctly. */
  issues: { field: string; message: string }[];
  trigger: {
    type: string;
    accepted: Determination<boolean>;
    schedule?: { cron: string; description: string; nextFireAt: string | null; timezone: 'local' };
  };
  conditions: {
    outcome: Determination<boolean>;
    /** Per-condition results, present only when a sample payload was given. */
    evaluations: ConditionEvaluation[];
  };
  actions: PlannedAction[];
  capabilitiesRequested: string[];
  approvalsRequired: { actionId: string; capabilityId: string; reason: string; rule: string }[];
  denials: { actionId: string; capabilityId: string; reason: string; rule: string }[];
  wouldRunUnattended: Determination<boolean>;
  /** Named uncertainties, so the report is explicit about its own limits. */
  unknowns: { what: string; why: string }[];
  /**
   * Proof of inertness, carried on the report.
   *
   * A dry run that quietly performed something is the one bug this file
   * cannot be allowed to have, so it states what it did not do and the
   * verification suite checks every claim against the real system.
   */
  sideEffects: {
    automationRunsCreated: 0;
    workflowRunsCreated: 0;
    invocations: 0;
    approvalsCreated: 0;
    filesWritten: 0;
    note: string;
  };
}

const known = <T>(value: T, reason: string): Determination<T> => ({ certainty: 'known', value, reason });
const conditional = <T>(reason: string, dependsOn: string): Determination<T> => ({ certainty: 'conditional', value: null, reason, dependsOn });

export interface RuleDryRunInput {
  rule: AutomationRule;
  /**
   * A sample event to reason against.
   *
   * Optional, and the difference it makes is exactly the known/conditional
   * boundary: with a payload the conditions are really evaluated; without
   * one they cannot be, and the report says so rather than assuming they
   * pass.
   */
  sampleEvent?: AutomationEvent;
  resolveWorkflow: (workflowId: string) => Workflow | null;
  /** The EXISTING workflow dry run. Never executes. */
  dryRunWorkflow: (wf: Workflow, projectId: string) => DryRunReport;
  projectId?: string;
}

/** Dotted-path read over a payload, matching the engine's own lookup. */
function atPath(payload: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    payload,
  );
}

export function dryRunRule(input: RuleDryRunInput): RuleDryRunReport {
  const { rule } = input;
  const issues = validateRule(rule);
  const unknowns: RuleDryRunReport['unknowns'] = [];

  /* ── would the trigger be accepted? ───────────────────────────── */

  let triggerAccepted: Determination<boolean>;
  let schedule: RuleDryRunReport['trigger']['schedule'];

  if (!rule.enabled) {
    triggerAccepted = known(false, 'This rule is disabled, so no event reaches it.');
  } else if (rule.trigger.type === 'schedule') {
    const cron = rule.trigger.cron ?? '';
    const next = nextFire(cron, new Date());
    if (!next.ok) {
      triggerAccepted = known(false, `The schedule cannot fire: ${next.error}`);
    } else {
      triggerAccepted = known(true, 'A schedule fires on the clock, so its trigger is always accepted.');
      schedule = {
        cron,
        description: describeCron(cron),
        nextFireAt: next.at ? next.at.toISOString() : null,
        // Stated, never selectable. The scheduler has no timezone database,
        // and offering a picker would imply a capability that is absent.
        timezone: 'local',
      };
      if (!next.at) unknowns.push({ what: 'the next fire', why: 'This expression has no occurrence within the next four years.' });
    }
  } else if (input.sampleEvent) {
    const typeMatches = input.sampleEvent.type === rule.trigger.type;
    let matchOk = true;
    if (typeMatches && rule.trigger.match) {
      for (const [k, v] of Object.entries(rule.trigger.match)) {
        if (JSON.stringify(atPath(input.sampleEvent.payload, k)) !== JSON.stringify(v)) { matchOk = false; break; }
      }
    }
    triggerAccepted = typeMatches && matchOk
      ? known(true, 'The sample event matches this rule’s trigger type and filter.')
      : known(
          false,
          typeMatches
            ? 'The sample event does not satisfy the trigger filter.'
            : `The sample event is a "${input.sampleEvent.type}", not a "${rule.trigger.type}".`,
        );
  } else {
    triggerAccepted = conditional(
      `This rule fires when a "${rule.trigger.type}" event happens. Whether one happens is not something a dry run can decide.`,
      'a real platform event',
    );
    unknowns.push({ what: 'whether the trigger fires', why: 'It depends on a future event. Supply a sample event to reason about a specific one.' });
  }

  /* ── would the conditions pass? ───────────────────────────────── */

  let conditionOutcome: Determination<boolean>;
  let evaluations: ConditionEvaluation[] = [];

  if (!rule.conditions.length) {
    conditionOutcome = known(true, 'This rule has no conditions, so nothing can block it.');
  } else if (input.sampleEvent) {
    // The engine's OWN evaluator on the caller's payload. Not a copy of it.
    evaluations = evaluateConditions(input.sampleEvent.payload, rule.conditions);
    const passed = evaluations.every((c) => c.passed);
    conditionOutcome = known(
      passed,
      passed
        ? `All ${evaluations.length} condition${evaluations.length === 1 ? '' : 's'} pass against this payload.`
        : `${evaluations.filter((c) => !c.passed).length} of ${evaluations.length} conditions fail against this payload.`,
    );
  } else {
    conditionOutcome = conditional(
      `${rule.conditions.length} condition${rule.conditions.length === 1 ? '' : 's'} would be evaluated against the event payload.`,
      'the payload of the event that fires',
    );
    unknowns.push({ what: 'the condition outcome', why: 'Conditions read the event payload, which does not exist until the event does.' });
  }

  /* ── which actions, and what would they ask for? ──────────────── */

  const actions: PlannedAction[] = [];
  const approvalsRequired: RuleDryRunReport['approvalsRequired'] = [];
  const denials: RuleDryRunReport['denials'] = [];
  const capabilitiesRequested = new Set<string>();

  let priorContinues = true;
  for (const [i, action] of rule.chain.entries()) {
    const reached: Determination<boolean> = i === 0
      ? (conditionOutcome.certainty === 'known' && conditionOutcome.value === true
          ? known(true, 'The first action runs whenever the conditions pass.')
          : conditional('The first action runs if the conditions pass.', 'the condition outcome'))
      : priorContinues
        ? conditional('This action runs if every earlier action in the chain succeeded.', 'the outcome of the earlier actions')
        : conditional('An earlier action stops the chain on failure, so this may not be reached.', 'the outcome of the earlier actions');

    const planned: PlannedAction = {
      actionId: action.id,
      action: action.action,
      label: action.label,
      reached,
      capabilities: [],
      continueOnError: action.continueOnError === true,
    };

    if (action.action === 'run-workflow') {
      const workflowId = String(action.config?.workflowId ?? '');
      const wf = workflowId ? input.resolveWorkflow(workflowId) : null;
      if (!wf) {
        planned.workflow = {
          workflowId,
          workflowName: '',
          dryRun: null,
          error: workflowId ? `No workflow is stored under "${workflowId}".` : 'This action names no workflow.',
        };
      } else {
        const projectId = input.projectId ?? input.sampleEvent?.projectId ?? rule.trigger.projectId ?? '';
        try {
          const report = input.dryRunWorkflow(wf, projectId);
          planned.workflow = { workflowId, workflowName: wf.name, dryRun: report };
          for (const step of report.plan) {
            if (!step.capabilityId || !step.policy) continue;
            capabilitiesRequested.add(step.capabilityId);
            planned.capabilities.push({
              capabilityId: step.capabilityId,
              decision: step.policy.decision,
              rule: step.policy.rule,
              risk: step.policy.risk,
              wouldAskHuman: step.wouldAskHuman === true,
              wouldBeDenied: step.wouldBeDenied === true,
            });
          }
          for (const a of report.approvalsRequired) approvalsRequired.push({ actionId: action.id, ...a });
          for (const d of report.denials) denials.push({ actionId: action.id, ...d });

          // Named uncertainties, sourced from the graph rather than assumed.
          if (report.plan.some((p) => p.type === 'loop')) {
            unknowns.push({ what: `how many times the loop in "${wf.name}" repeats`, why: 'A loop repeats over its input, which does not exist yet.' });
          }
          if (report.plan.some((p) => p.type === 'condition')) {
            unknowns.push({ what: `which branch "${wf.name}" takes`, why: 'A condition routes on data produced during the run.' });
          }
          if (report.plan.some((p) => p.nodeClass === 'intelligence')) {
            unknowns.push({ what: `what the AI nodes in "${wf.name}" produce`, why: 'A model’s output is not predictable, and neither is what a branch does with it.' });
          }
          if (!report.offlineCapable) {
            unknowns.push({ what: `the responses "${wf.name}" gets from external services`, why: 'A network call’s result is not knowable in advance.' });
          }
        } catch (error) {
          planned.workflow = { workflowId, workflowName: wf.name, dryRun: null, error: (error as Error).message };
        }
      }
    }

    actions.push(planned);
    priorContinues = action.continueOnError === true;
  }

  /* ── verdict ──────────────────────────────────────────────────── */

  const wouldRunUnattended: Determination<boolean> = issues.length
    ? known(false, `This rule cannot run: ${issues[0].message}`)
    : denials.length
      ? known(false, `${denials.length} action${denials.length === 1 ? '' : 's'} would be refused by policy.`)
      : approvalsRequired.length
        ? known(false, `${approvalsRequired.length} action${approvalsRequired.length === 1 ? '' : 's'} would stop and ask you.`)
        : triggerAccepted.certainty === 'known' && triggerAccepted.value === false
          ? known(false, triggerAccepted.reason)
          : conditionOutcome.certainty === 'known' && conditionOutcome.value === true && triggerAccepted.certainty === 'known'
            ? known(true, 'Nothing in this rule needs a person, and nothing is refused.')
            : conditional('Nothing needs a person, provided the trigger fires and the conditions pass.', 'the trigger and the conditions');

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    enabled: rule.enabled,
    at: new Date().toISOString(),
    issues,
    trigger: { type: rule.trigger.type, accepted: triggerAccepted, schedule },
    conditions: { outcome: conditionOutcome, evaluations },
    actions,
    capabilitiesRequested: [...capabilitiesRequested].sort(),
    approvalsRequired,
    denials,
    wouldRunUnattended,
    unknowns,
    sideEffects: {
      automationRunsCreated: 0,
      workflowRunsCreated: 0,
      invocations: 0,
      approvalsCreated: 0,
      filesWritten: 0,
      note: 'A rule dry run evaluates conditions and policy. It creates no run, invokes no capability, opens no approval and writes nothing.',
    },
  };
}
