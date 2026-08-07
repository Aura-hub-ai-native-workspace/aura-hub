/**
 * orchestrator — runs the full Mission Control v2 pipeline (Stages
 * 1-9) for one mission-creation request and returns the final
 * `MissionRecord`. The only function `workspace.ts` calls to create a
 * mission. Saves to the store as it goes — a crash mid-pipeline
 * leaves an honest partial record, not a lost one. Only `import type`
 * is used for `WorkspaceManager` (mirroring `signals.ts`'s existing
 * pattern) so this module never creates a runtime circular import even
 * though `workspace.ts` calls into it.
 *
 * Unlike the Diagnosis Engine, mission planning never stops early on
 * `'unknown'` — Stage 4's `'unknown'` strategy is itself a real,
 * honest fallback plan (a general health-pass), not a dead end.
 *
 * Stage 8's revision loop is bounded to exactly ONE regeneration pass:
 * if the reviewer returns `'revise'`, the Goal Graph (Stage 5) and Risk
 * Analysis (Stage 7) are recomputed once with the reviewer's findings
 * folded into the prompt, and the mission proceeds — it is never
 * re-reviewed, which would risk an unbounded loop.
 */
import { classifyMissionIntent } from './intentClassifier';
import { refineClassificationAndExtractIntent } from './intentExtraction';
import { gatherMissionSignals } from './signals';
import { strategyFor } from './strategies';
import { generateGoalGraph } from './goalGraph';
import { analyzeMissionRisk } from './risk';
import { reviewMission } from './reviewer';
import { computeMissionQuality } from './quality';
import type { MissionEvent, MissionRecord } from './types';
import type { MissionStore } from './store';
import type { WorkspaceManager } from '../workspace';

const now = () => new Date().toISOString();

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
): Promise<MissionRecord> {
  let record = store.create(projectId, emptyRecord(text));

  emit({ type: 'stage', stage: 'classify', status: 'start', at: now() });
  const deterministic = classifyMissionIntent(text);
  emit({ type: 'classification', classification: deterministic });
  emit({ type: 'stage', stage: 'classify', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'signals', status: 'start', at: now() });
  const signals = await gatherMissionSignals(manager, projectId, projectPath, record.id);
  emit({ type: 'signals', signals });
  record = store.patch(projectId, record.id, { signals }) ?? record;
  emit({ type: 'stage', stage: 'signals', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'intent', status: 'start', at: now() });
  const extractionRes = await refineClassificationAndExtractIntent(manager.pipeline, text, deterministic, signals, signal);
  if (!extractionRes.ok) {
    record = store.patch(projectId, record.id, { classification: deterministic, error: `Intent extraction failed: ${extractionRes.error.message}` }) ?? record;
    emit({ type: 'error', message: `Intent extraction failed: ${extractionRes.error.message}` });
    emit({ type: 'done', mission: record });
    return record;
  }
  const { classification, intent } = extractionRes;
  record = store.patch(projectId, record.id, { classification, intent }) ?? record;
  emit({ type: 'classification', classification });
  emit({ type: 'intent', intent });
  emit({ type: 'stage', stage: 'intent', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'strategy', status: 'start', at: now() });
  const strategy = strategyFor(classification.category);
  record = store.patch(projectId, record.id, { strategy }) ?? record;
  emit({ type: 'strategy', strategy });
  emit({ type: 'stage', stage: 'strategy', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'goal-graph', status: 'start', at: now() });
  const goalGraphRes = await generateGoalGraph(manager.pipeline, text, intent, strategy, signals, signal);
  if (!goalGraphRes.ok) {
    record = store.patch(projectId, record.id, { error: `Goal Graph generation failed: ${goalGraphRes.error.message}` }) ?? record;
    emit({ type: 'error', message: `Goal Graph generation failed: ${goalGraphRes.error.message}` });
    emit({ type: 'done', mission: record });
    return record;
  }
  let goalGraph = goalGraphRes.goalGraph;
  record = store.patch(projectId, record.id, { goalGraph }) ?? record;
  emit({ type: 'goal-graph', goalGraph });
  emit({ type: 'stage', stage: 'goal-graph', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'risk', status: 'start', at: now() });
  let risk = analyzeMissionRisk(goalGraph, signals, intent);
  emit({ type: 'risk', risk });
  emit({ type: 'stage', stage: 'risk', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'review', status: 'start', at: now() });
  const reviewRes = await reviewMission(manager.pipeline, text, intent, strategy, goalGraph, signals, signal);
  let review = reviewRes.ok
    ? reviewRes.verdict
    : { verdict: 'approved' as const, findings: [], summary: `Reviewer call failed (${reviewRes.error.message}) — treated as approved, not revised, since the failure is ours, not the plan's.`, revisionApplied: false };

  if (review.verdict === 'revise') {
    const revisionNotes = review.findings.map((f) => `[${f.type}] ${f.detail}`);
    const revisedRes = await generateGoalGraph(manager.pipeline, text, intent, strategy, signals, signal, revisionNotes);
    if (revisedRes.ok) {
      goalGraph = revisedRes.goalGraph;
      risk = analyzeMissionRisk(goalGraph, signals, intent);
      review = { ...review, revisionApplied: true };
    }
  }
  record = store.patch(projectId, record.id, { goalGraph, risk, review }) ?? record;
  emit({ type: 'risk', risk });
  emit({ type: 'review', review });
  emit({ type: 'stage', stage: 'review', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'quality', status: 'start', at: now() });
  const quality = computeMissionQuality(classification, intent, strategy, goalGraph, signals, risk, review);
  record = store.patch(projectId, record.id, { quality }) ?? record;
  emit({ type: 'quality', quality });
  emit({ type: 'stage', stage: 'quality', status: 'done', at: now() });

  emit({ type: 'done', mission: record });
  return record;
}
