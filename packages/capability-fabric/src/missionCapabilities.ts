/**
 * missionCapabilities — the two gaps preserved from the deleted planners.
 * ==================================================================
 * `docs/CONSOLIDATION_MAP.md` deleted three modules as duplicates of
 * Mission Control's own pipeline (§2.1 promptIntelligence, §2.2
 * missionPlanner, §2.3 orchestrator) and recorded that two behaviours in
 * them were *not* duplicates and had to survive the deletion:
 *
 *   1. §2.1 — a brief carries no `assumptions` or `openQuestions`, so the
 *      user is never shown what was filled in on their behalf.
 *   2. §2.2 / §2.3 — a task carries no statement of *which capability it
 *      needs*, so nothing can route it to something that provides one.
 *
 * This module is where both land. It is deliberately the smallest thing
 * that can hold them:
 *
 *   • **Additive.** It reads Mission Control's finished output and adds
 *     fields. It never re-classifies, never re-plans, never re-orders,
 *     and does not touch the mission engine's LLM prompt contract.
 *   • **Deterministic.** No model call. The same mission always produces
 *     the same annotation, so it can be recomputed on demand rather than
 *     persisted (§3 of the consolidation map — `MissionRecord` is written
 *     to disk and must not gain required fields).
 *   • **Not a mission model.** No task list, no ordering, no status, no
 *     lifecycle. `CapabilityBinding` is a projection keyed by an existing
 *     task id and is discarded when the mission ends.
 *
 * Inputs are declared **structurally** — the narrow set of fields
 * actually read — rather than imported from `ai-service`, because the
 * dependency direction forbids this package depending on the service.
 * Mission Control's real `ExtractedIntent`, `MissionSignals` and
 * `MissionTask` satisfy these shapes as they stand.
 */

import type { RiskLevel } from './types';
import { CAPABILITY_MANIFEST } from './manifest';

/* ════════════════════════════════════════════════════════════════�[...]
   Structural views of Mission Control's output
   ════════════════════════════════════════════════════════════════�[...]

/** The fields of `ExtractedIntent` (`mission/types.ts:83`) this reads. */
export interface IntentView {
  primaryGoal: string;
  secondaryGoals: string[];
  constraints: string[];
  deadline: string | null;
  targetComponents: string[];
  scope: 'narrow' | 'moderate' | 'broad';
  requiredQuality: 'prototype' | 'standard' | 'production';
}

/** The fields of `MissionSignals` (`mission/types.ts:133`) this reads. */
export interface SignalsView {
  gitStatus: { available: false; reason: string } | { available: true; branch: string; dirty: boolean; changedFiles: number };
  buildStatus: { available: false; reason: string } | { available: true; ok: boolean; message: string };
  securityFindings: unknown[];
}

/** The fields of `MissionTask` (`mission/types.ts:188`) this reads. */
export interface TaskView {
  id: string;
  title: string;
  kind: 'file-operation' | 'git-operation' | 'manual-operation' | 'review' | 'approval' | 'documentation' | 'research';
  targetFile: string | null;
  mode: 'diff' | 'new-file' | null;
  risk: RiskLevel;
}

/* ════════════════════════════════════════════════════════════════�[...]
   Outputs
   ════════════════════════════════════════════════════════════════�[...]

/**
 * What a single planned task will need from the Fabric. The sidecar of
 * §3 — derived, never persisted, keyed by the authoritative task id.
 */
export interface CapabilityBinding {
  taskId: string;
  /** Fabric capability ids, in the order the task would use them. */
  requires: string[];
  /**
   * The highest risk among `requires`, or the task's own planned risk if
   * it needs no capability at all. This is why `RiskLevel` was made
   * structurally identical to Mission Control's `TaskRisk`: planned risk
   * and required-capability risk are comparable without translation.
   */
  risk: RiskLevel;
  /** One line explaining the mapping, for the UI and the audit trail. */
  rationale: string;
}

/** Something the plan needs that the Fabric cannot currently perform. */
export interface CapabilityGap {
  capabilityId: string;
  /** Task ids blocked by it. Empty when only the mission as a whole needs it. */
  taskIds: string[];
  /** Why it cannot run: no such capability, or no registered executor. */
  reason: 'unknown-capability' | 'no-executor';
}

/**
 * The additive annotation over a finished mission plan. Every field is
 * something Mission Control does not already carry.
 */
export interface MissionCapabilityAnnotation {
  /** What was inferred on the user's behalf, so it can be shown to them. */
  assumptions: string[];
  /** What is genuinely unresolved. Questions, never blockers. */
  openQuestions: string[];
  /** Every distinct capability the plan needs, sorted for stable output. */
  requiredCapabilities: string[];
  /** Per-task projection. Same order as the tasks given. */
  bindings: CapabilityBinding[];
  /** Required capabilities with no executor behind them. */
  gaps: CapabilityGap[];
}

/* ════════════════════════════════════════════════════════════════[...]
   Task → capability mapping
   ════════════════════════════════════════════════════════════════[...]

/**
 * The mapping is intentionally coarse and total: every `TaskKind` has an
 * answer, and the answer depends only on fields the planner already
 * fills in. A finer mapping would need to understand task *content*,
 * which means a model call, which would make this non-deterministic and
 * put a second interpretation of the plan next to the first one.
 */
function requirementsFor(task: TaskView): { requires: string[]; rationale: string } {
  switch (task.kind) {
    case 'file-operation':
      if (task.targetFile === null) {
        return {
          requires: ['filesystem.list', 'filesystem.read'],
          rationale: 'Edits files, but no target was resolved at planning time — it must look before it writes.',
        };
      }
      return task.mode === 'new-file'
        ? { requires: ['filesystem.write'], rationale: `Creates ${task.targetFile}.` }
        : { requires: ['filesystem.read', 'filesystem.write'], rationale: `Rewrites ${task.targetFile}, so it reads the current contents first.` };

    case 'git-operation':
      return {
        requires: ['git.diff', 'git.commit'],
        rationale: 'Performs git operations (commit, branch, checkout, etc.).',
      };

    case 'documentation':
      return {
        requires: ['filesystem.write'],
        rationale: 'Produces written output on disk.',
      };

    case 'research':
      return {
        requires: ['knowledge.graph', 'memory.search'],
        rationale: 'Answers a question from what AURA already knows before reaching outside.',
      };

    case 'review':
      return {
        requires: ['git.diff'],
        rationale: 'Judges work that has already been done, so it reads the change rather than the file.',
      };

    case 'manual-operation':
      return {
        requires: ['terminal.execute'],
        rationale: 'Carried out by running a command.',
      };

    case 'approval':
      return {
        requires: [],
        rationale: 'A human gate. Mission Control owns it; the Fabric performs nothing.',
      };
  }
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function highestRisk(capabilityIds: string[], fallback: RiskLevel): RiskLevel {
  let worst: RiskLevel | null = null;
  for (const id of capabilityIds) {
    const descriptor = CAPABILITY_MANIFEST.find((c) => c.id === id);
    if (!descriptor) continue;
    if (worst === null || RISK_ORDER[descriptor.risk] > RISK_ORDER[worst]) worst = descriptor.risk;
  }
  return worst ?? fallback;
}

/**
 * Bind each planned task to the capabilities it will need. Pure, and
 * keyed by the task ids the caller already has — this returns a
 * projection, not a copy of the plan.
 */
export function bindTaskCapabilities(tasks: TaskView[]): CapabilityBinding[] {
  return tasks.map((task) => {
    const { requires, rationale } = requirementsFor(task);
    return { taskId: task.id, requires, risk: highestRisk(requires, task.risk), rationale };
  });
}

/* ════════════════════════════════════════════════════════════════[...]
   Execution planning — task → a single concrete Fabric invocation
   ════════════════════════════════════════════════════════════════[...]

/**
 * `CapabilityBinding.requires` lists everything a task may touch. Running
 * it needs something narrower: **one** capability and a complete argument
 * set. This is that decision, and it is separate on purpose — a binding
 * is a statement about a plan, an invocation plan is a commitment to act.
 */
export type TaskInvocationPlan =
  | { kind: 'invoke'; capabilityId: string; input: Record<string, unknown> }
  /**
   * The task cannot be expressed as a Fabric call from planning data
   * alone. `reason` is shown to the user as the next step, never
   * swallowed. This is not a failure — it is the honest boundary of what
   * a deterministic mapping can do.
   */
  | { kind: 'unbound'; reason: string };

/**
 * Deterministically derive the one action a task performs.
 *
 * The hard rule here is that **every argument must come from the plan or
 * the context** — never from a model. A `manual-operation` task says
 * "run the tests" in prose but carries no command line, and synthesising
 * one would mean an LLM call deciding what to execute on the user's
 * machine. That is refused by design: such tasks come back `unbound` and
 * stay with the human, which is what they already do today.
 */
export function planTaskInvocation(task: TaskView, projectId: string | null): TaskInvocationPlan {
  switch (task.kind) {
    case 'review':
      // Reading the working-tree diff needs no arguments, so a review
      // task is fully determined by its kind alone.
      return { kind: 'invoke', capabilityId: 'git.diff', input: {} };

    case 'research':
      if (!projectId) return { kind: 'unbound', reason: 'Research runs against a project, and this mission is not attached to one.' };
      // The task title is the user's own words for the question — it is
      // plan data, not an inference.
      return { kind: 'invoke', capabilityId: 'memory.search', input: { projectId, query: task.title } };

    case 'manual-operation':
      return {
        kind: 'unbound',
        reason: 'This task is carried out by running a command, but the plan does not say which one. Run it yourself and mark it complete — AURA will not invent a command to execute on your machine.',
      };

    case 'git-operation':
      return {
        kind: 'unbound',
        reason: 'Git operations are resolved and executed through Mission Control v3\'s dedicated git executor, not through direct capability invocation.',
      };

    case 'file-operation':
      return {
        kind: 'unbound',
        reason: task.targetFile
          ? 'File edits go through proposal review, so this task runs on the existing propose-then-accept path rather than as a direct capability call.'
          : 'This task edits files but no target file was resolved when it was planned.',
      };

    case 'documentation':
      return {
        kind: 'unbound',
        reason: 'Writing this document needs its content, which the plan does not contain. Draft it on the proposal path or complete it manually.',
      };

    case 'approval':
      return {
        kind: 'unbound',
        reason: 'This is a human decision point. Mission Control owns it, and the Fabric deliberately performs nothing here.',
      };
  }
}

/* ════════════════════════════════════════════════════════════════[...]
   Assumptions and open questions
   ════════════════════════════════════════════════════════════════[...]

/**
 * Both lists are derived only from *absences* in the extracted intent and
 * from signals the project scan actually measured. Nothing here guesses
 * at what the user meant — that is the mission engine's job, and it has
 * already done it by the time this runs. The distinction that decides
 * which list an item goes in: an **assumption** is something the plan
 * proceeded on and would not change if confirmed; an **open question** is
 * something whose answer would change the plan.
 */
function deriveAssumptions(intent: IntentView, signals: SignalsView): string[] {
  const out: string[] = [];

  if (intent.deadline === null) {
    out.push('No deadline was given, so the plan is ordered by dependency rather than by time.');
  }
  if (intent.constraints.length === 0) {
    out.push('No constraints were stated, so the project\'s existing conventions and stack were taken as the constraints.');
  }
  if (intent.secondaryGoals.length === 0) {
    out.push(`Treated as a single objective: ${intent.primaryGoal}`);
  }
  if (intent.requiredQuality === 'standard') {
    out.push('Quality bar was not specified, so it was planned to the project\'s normal standard rather than as a prototype.');
  }
  if (signals.buildStatus.available === false) {
    out.push(`Build status could not be read (${signals.buildStatus.reason}), so no task assumes a currently-passing build.`);
  }

  return out;
}

function deriveOpenQuestions(intent: IntentView, signals: SignalsView): string[] {
  const out: string[] = [];

  if (intent.targetComponents.length === 0) {
    out.push('Which part of the project should this focus on? The plan currently spans the whole repository.');
  }
  if (intent.scope === 'broad') {
    out.push('This was read as broad in scope. Is there a smaller first slice worth doing on its own?');
  }
  if (signals.gitStatus.available && signals.gitStatus.dirty) {
    out.push(
      `There ${signals.gitStatus.changedFiles === 1 ? 'is 1 uncommitted change' : `are ${signals.gitStatus.changedFiles} uncommitted changes`} on ${signals.gitStatus.branch}. Should they be committed or stashed first?`,
    );
  }
  if (signals.securityFindings.length > 0) {
    out.push(
      `The project scan found ${signals.securityFindings.length} security ${signals.securityFindings.length === 1 ? 'finding' : 'findings'}. Should fixing them be part of this mission?`,
    );
  }

  return out;
}

/* ════════════════════════════════════════════════════════════════[...]
   Entry point
   ════════════════════════════════════════════════════════════════[...]

/**
 * Annotate a finished mission plan.
 *
 * @param supported Capability ids that currently have a registered
 *   executor — normally `fabric.supported()`. Passed in rather than read
 *   from a singleton so this stays pure and testable, and so the gap list
 *   reflects the host that would actually run the mission. Omit it to
 *   skip gap detection entirely (`gaps` comes back empty) rather than
 *   report every capability as missing.
 */
export function annotateMissionCapabilities(
  intent: IntentView | null,
  signals: SignalsView,
  tasks: TaskView[],
  supported?: Iterable<string>,
): MissionCapabilityAnnotation {
  const bindings = bindTaskCapabilities(tasks);

  const required = new Set<string>();
  for (const binding of bindings) for (const id of binding.requires) required.add(id);

  const gaps: CapabilityGap[] = [];
  if (supported !== undefined) {
    const available = new Set(supported);
    for (const capabilityId of [...required].sort()) {
      const known = CAPABILITY_MANIFEST.some((c) => c.id === capabilityId);
      if (known && available.has(capabilityId)) continue;
      gaps.push({
        capabilityId,
        taskIds: bindings.filter((b) => b.requires.includes(capabilityId)).map((b) => b.taskId),
        reason: known ? 'no-executor' : 'unknown-capability',
      });
    }
  }

  return {
    // A mission whose extraction stage never ran has nothing to annotate;
    // that is reported as an empty annotation, not as a failure.
    assumptions: intent ? deriveAssumptions(intent, signals) : [],
    openQuestions: intent ? deriveOpenQuestions(intent, signals) : [],
    requiredCapabilities: [...required].sort(),
    bindings,
    gaps,
  };
}
