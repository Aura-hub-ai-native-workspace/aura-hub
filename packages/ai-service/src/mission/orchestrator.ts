/**
 * orchestrator — the Planner's planning run.
 * ==================================================================
 * Turns one goal into a structured, editable plan and saves it. It never
 * executes anything: execution is Workspace's, reached only through the
 * explicit handoff (mission/planner.ts `toWorkspacePlan`).
 *
 * Three stages, each one real work and each one reported as it happens:
 *
 *   context — deterministic: classify the goal and gather the project's
 *             real signals (health, hotspots, git, debt, open plans).
 *   plan    — EITHER the lightweight path (a short goal naming one file
 *             becomes a one-task plan, no model call) OR exactly one model
 *             call that writes the goal graph, with its own time budget.
 *   check   — deterministic validation the person can act on: broken or
 *             circular dependencies, files the goal names that no task
 *             targets, tasks Workspace could not carry out.
 *
 * What it used to do and no longer does, deliberately: a separate model
 * call to "extract intent" (the goal text and the deterministic
 * classification carry the same information into the one planning call),
 * an adversarial-review model call with an optional second regeneration
 * (up to three more slow calls on a local model, which is where planning
 * timed out), and a computed "quality score" presented as if it measured
 * the plan. A planning run is one call at most, and every number shown
 * is one that was measured.
 *
 * The record is saved as it goes, so a crash or a failed model call
 * leaves an honest partial record with its error — retried in place by
 * `replan` without losing the goal.
 */
import { classifyMissionIntent } from './intentClassifier';
import { gatherMissionSignals } from './signals';
import { strategyFor } from './strategies';
import { generateGoalGraph } from './goalGraph';
import { namedFiles, simpleAcceptance, simplePlan, validatePlan } from './planner';
import type { ExtractedIntent, MissionEvent, MissionRecord, PlanContext } from './types';
import type { MissionStore } from './store';
import type { WorkspaceManager } from '../workspace';

const now = () => new Date().toISOString();

/**
 * The one planning call's budget. A plan is written once and is worth
 * waiting for, so it does not share the interactive 30-second default;
 * and a timed-out plan is not silently retried — the person sees the
 * failure and chooses Retry.
 */
/** How often a waiting plan reports its elapsed time. */
export const PLAN_HEARTBEAT_MS = 5_000;
/**
 * The Planner reads the model's answer as a stream. `timeoutMs` is the overall
 * ceiling (documented, under the 10-minute transport bound); a model that goes
 * silent is cut off sooner by the adapter's idle timeout. On a CPU-only machine
 * a 4-5 task plan takes 90-175s of generation, which a fixed 180s deadline cut
 * off at random while the model was still writing.
 */
export const PLAN_CALL = { timeoutMs: 480_000, maxRetries: 0, maxTokens: 2048, stream: true };

function emptyRecord(text: string): Omit<MissionRecord, 'id' | 'createdAt' | 'projectId'> {
  return {
    text,
    classification: null,
    intent: null,
    signals: {
      health: null, healthIssues: [], architectureLayers: [], hotspots: [], changeVelocity: 0,
      verificationScore: 0, verificationRecommendations: [], securityFindings: [],
      buildStatus: { available: false, reason: 'not yet gathered' },
      gitStatus: { available: false, reason: 'not yet gathered' },
      recentCommits: [], technicalDebt: [], openMissions: [],
      dependencySummary: { total: 0, pinnedExact: 0, looseRange: 0 },
    },
    strategy: null,
    goalGraph: null,
    risk: null,
    review: null,
    quality: null,
    approval: { status: 'pending' },
    taskRuns: [],
    revision: 1,
    handoffs: [],
  };
}

/** The goal as the planning call reads it: the person's words, unparaphrased. */
function intentOf(text: string): ExtractedIntent {
  return {
    primaryGoal: text,
    secondaryGoals: [],
    constraints: [],
    deadline: null,
    targetComponents: namedFiles(text),
    expectedOutcome: text,
    scope: 'moderate',
    riskLevel: 'medium',
    requiredQuality: 'standard',
  };
}

export async function runMissionCreation(
  manager: WorkspaceManager,
  store: MissionStore,
  projectId: string,
  projectPath: string,
  text: string,
  emit: (e: MissionEvent) => void,
  signal?: AbortSignal,
  /** Re-plan this existing record in place (Retry) instead of creating one. */
  existingId?: string,
  /** Shared project context the plan must be built from (decisions, research). */
  context?: PlanContext,
): Promise<MissionRecord> {
  let record = existingId
    ? store.patch(projectId, existingId, { error: undefined, goalGraph: null, planIssues: [] }) ?? store.create(projectId, emptyRecord(text))
    : store.create(projectId, emptyRecord(text));
  const startedAt = now();
  const started = Date.now();

  emit({ type: 'stage', stage: 'context', status: 'start', at: now() });
  const classification = classifyMissionIntent(text);
  emit({ type: 'classification', classification });
  const signals = await gatherMissionSignals(manager, projectId, projectPath, record.id);
  emit({ type: 'signals', signals });
  const strategy = strategyFor(classification.category);
  const intent = intentOf(text);
  record = store.patch(projectId, record.id, { classification, signals, strategy, intent, ...(context ? { context } : {}) }) ?? record;
  emit({ type: 'stage', stage: 'context', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'plan', status: 'start', at: now() });
  let goalGraph = simplePlan(text, projectPath);
  let acceptance: string[] = goalGraph ? simpleAcceptance(goalGraph) : [];
  const pathTaken: 'deterministic' | 'model' = goalGraph ? 'deterministic' : 'model';
  record = store.patch(projectId, record.id, { planning: { path: pathTaken, startedAt } }) ?? record;
  if (!goalGraph) {
    // One model call can run for minutes on a local model. Say how long it has
    // really been waiting, against the deadline it really has, so a slow model
    // is not mistaken for a hung one.
    const waitStart = Date.now();
    let receivedChars = 0;
    const beat = setInterval(() => emit({ type: 'progress', stage: 'plan', elapsedMs: Date.now() - waitStart, deadlineMs: PLAN_CALL.timeoutMs, receivedChars }), PLAN_HEARTBEAT_MS);
    const res = await generateGoalGraph(manager.pipeline, text, intent, strategy, signals, signal, undefined, { ...PLAN_CALL, onProgress: (n: number) => { receivedChars = n; } } as typeof PLAN_CALL, context?.text)
      .finally(() => clearInterval(beat));
    if (!res.ok) {
      const message = `Planning failed: ${res.error.message}`;
      record = store.patch(projectId, record.id, {
        error: message,
        planning: { path: pathTaken, startedAt, finishedAt: now(), durationMs: Date.now() - started, model: manager.pipeline.modelLabel() },
      }) ?? record;
      emit({ type: 'error', message });
      emit({ type: 'done', mission: record });
      return record;
    }
    goalGraph = res.goalGraph;
    acceptance = res.acceptance;
  }
  record = store.patch(projectId, record.id, { goalGraph, acceptance }) ?? record;
  emit({ type: 'goal-graph', goalGraph });
  emit({ type: 'stage', stage: 'plan', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'check', status: 'start', at: now() });
  const planIssues = validatePlan(goalGraph, text);
  record = store.patch(projectId, record.id, {
    planIssues,
    planning: {
      path: pathTaken, startedAt, finishedAt: now(), durationMs: Date.now() - started,
      model: pathTaken === 'model' ? manager.pipeline.modelLabel() : null,
    },
  }) ?? record;
  emit({ type: 'stage', stage: 'check', status: 'done', at: now() });

  emit({ type: 'done', mission: record });
  return record;
}
