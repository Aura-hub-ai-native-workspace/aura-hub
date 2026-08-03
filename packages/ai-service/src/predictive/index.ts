/**
 * Predictive facade — @aura/predictive wired to real platform state.
 * ==================================================================
 * `buildPredictiveEngine(projectId, projectPath)` collects real evidence
 * (git churn, governance reports, knowledge graph, mission/diagnosis/
 * automation history) and returns a ready PredictiveEngine. Mission and
 * candidate contexts are built from live records so Mission Control and
 * Diagnosis can ask "will this fail?" without leaving the process.
 */

import { PredictiveEngine } from '@aura/predictive';
import { collectPredictiveEvidence, missionContextFrom, candidateContextFrom, type CollectOptions } from './collect';

export async function buildPredictiveEngine(opts: CollectOptions): Promise<PredictiveEngine> {
  const evidence = await collectPredictiveEvidence(opts);
  return new PredictiveEngine(evidence);
}

export { collectPredictiveEvidence, missionContextFrom, candidateContextFrom, type CollectOptions };
export { PredictiveEngine };
