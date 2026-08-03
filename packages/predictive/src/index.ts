/**
 * @aura/predictive — Predictive Engineering Platform.
 * ==================================================================
 * Public facade. Everything is deterministic: given the same sealed
 * PredictiveEvidence the engines always return the same report. No ML
 * is used; the export surface is designed so an ML layer can later
 * consume the same schema:
 *
 *   PredictiveEngine.report(evidence)      → PredictionReport
 *   PredictiveEngine.features(evidence)    → ready-to-train matrix
 *   PredictiveEngine.impact / simulate     → blast radius + what-if
 *   PredictiveEngine.predictMission…       → live-context predictors
 *
 * The host (ai-service) is responsible for building PredictiveEvidence
 * from real platform state — this package only computes.
 */

import type {
  CandidateContext,
  ImpactAnalysis,
  MissionContext,
  Prediction,
  PredictionReport,
  PredictiveEvidence,
  SimulationChange,
  WhatIfSimulation,
} from './types';
import { computeConfidence } from './confidence';
import { computeRiskProfile } from './risk';
import { predictAll } from './prediction';
import { analyzeImpact } from './impact';
import { simulateChange } from './simulation';
import { sortByScoreDesc } from './score';

/** ML-ready export: one feature row per source file + binary labels. */
export interface FeatureMatrix {
  featureColumns: string[];
  rows: Record<string, number>[];
  labels: number[];
  targets: string[];
}

const FILE_FEATURES = [
  'churn',
  'lines',
  'complexity',
  'markers',
  'dependents',
  'diagnosisCount',
  'hasTests',
  'securityFindings',
] as const;

export function extractFeatures(e: PredictiveEvidence): FeatureMatrix {
  const rows: Record<string, number>[] = [];
  const labels: number[] = [];
  const targets: string[] = [];
  for (const f of e.files) {
    rows.push({
      churn: f.churn,
      lines: f.lines,
      complexity: f.complexity,
      markers: f.markers,
      dependents: f.dependents.length,
      diagnosisCount: f.diagnosisCount,
      hasTests: f.hasTests ? 1 : 0,
      securityFindings: f.securityFindings,
    });
    labels.push(f.diagnosisFired > 0 ? 1 : 0);
    targets.push(f.relPath);
  }
  return { featureColumns: [...FILE_FEATURES], rows, labels, targets };
}

export class PredictiveEngine {
  constructor(private readonly evidence: PredictiveEvidence) {}

  getEvidence(): PredictiveEvidence {
    return this.evidence;
  }

  report(missionCtx?: MissionContext, candidateCtx?: CandidateContext): PredictionReport {
    const e = this.evidence;
    const risk = computeRiskProfile(e);
    const predictions = predictAll(e, missionCtx, candidateCtx);

    const hotspots = sortByScoreDesc(
      predictions.filter((p) => p.kind === 'file-failure' || p.kind === 'module-instability'),
      (p) => p.probability,
      (p) => p.target,
    );
    const testless = new Set(e.files.filter((f) => !f.hasTests).map((f) => f.relPath));
    const regressions = sortByScoreDesc(
      predictions.filter(
        (p) => (p.kind === 'file-failure' && testless.has(p.target)) || p.kind === 'diagnosis-likelihood',
      ),
      (p) => p.probability,
      (p) => p.target,
    );
    const architectureRisks = sortByScoreDesc(
      predictions.filter((p) => p.kind === 'architecture-drift' || p.kind === 'dependency-conflict'),
      (p) => p.probability,
      (p) => p.target,
    );

    const preventiveActions = [...new Set(predictions.flatMap((p) => p.preventiveActions))].sort();
    const kindsProduced = new Set(predictions.map((p) => p.kind));
    const reportConfidence = computeConfidence({
      required: 9,
      available: kindsProduced.size,
      positive: predictions.filter((p) => p.severity === 'high' || p.severity === 'critical').length,
      caveats: e.git.available ? [] : ['Git history unavailable — churn-based predictions carry lower confidence.'],
    });

    return {
      projectId: e.projectId,
      projectPath: e.projectPath,
      generatedAt: e.collectedAt,
      source: 'deterministic',
      risk,
      predictions,
      hotspots,
      regressions,
      architectureRisks,
      preventiveActions,
      confidence: reportConfidence,
    };
  }

  missionFailure(ctx: MissionContext): Prediction {
    const p = predictAll(this.evidence, ctx).find((x) => x.kind === 'mission-failure' && x.target === ctx.id);
    if (!p) throw new Error(`predictive: no mission-failure prediction produced for ${ctx.id}`);
    return p;
  }

  proposalSuccess(ctx: CandidateContext): Prediction {
    const p = predictAll(this.evidence, undefined, ctx).find((x) => x.kind === 'proposal-success' && x.target === ctx.id);
    if (!p) throw new Error(`predictive: no proposal-success prediction produced for ${ctx.id}`);
    return p;
  }

  impact(target: string): ImpactAnalysis {
    return analyzeImpact(this.evidence, target);
  }

  simulate(target: string, change: SimulationChange): WhatIfSimulation {
    return simulateChange(this.evidence, target, change);
  }

  features(): FeatureMatrix {
    return extractFeatures(this.evidence);
  }
}

export * from './types';
export * from './confidence';
export * from './risk';
export * from './prediction';
export * from './impact';
export * from './simulation';
