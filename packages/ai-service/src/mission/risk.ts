/**
 * risk — Stage 7, Risk Analysis. 100% deterministic, zero model calls.
 * ==================================================================
 * Runs AFTER the Goal Graph exists (Stage 5) but BEFORE the mission is
 * finalized — every number here is a real, checkable ratio computed
 * from the actual tasks generated and the actual project signals
 * gathered in Stage 3, never a model's self-rating. Same "ratio of
 * real checks" philosophy as the Diagnosis Engine's Confidence Engine
 * (`diagnosis/confidence.ts`) — deliberately re-implemented here rather
 * than imported, since a mission's risk dimensions (architecture,
 * dependency, security, regression) are a different, mission-shaped
 * set of checks than a single patch's.
 */
import type { ExtractedIntent, GoalGraph, MissionSignals, MissionTask, RiskAnalysis } from './types';
import { capUnit } from './utils';

const ARCHITECTURE_FOCUS_KEYWORDS = ['architecture', 'layer', 'boundary', 'dependency-direction', 'migration-path', 'compatibility'];

function riskWeight(risk: MissionTask['risk']): number {
  return risk === 'high' ? 1 : risk === 'medium' ? 0.5 : 0.1;
}

function computeArchitectureRisk(goalGraph: GoalGraph, signals: MissionSignals): number {
  const relevant = goalGraph.tasks.filter((t) => ARCHITECTURE_FOCUS_KEYWORDS.some((k) => t.focusAreaId.includes(k)));
  if (!relevant.length) {
    // No architecture-shaped work planned — risk floor reflects only how
    // many real architecture layers exist to get wrong, not zero.
    return capUnit(signals.architectureLayers.length > 6 ? 0.15 : 0.05);
  }
  const avg = relevant.reduce((s, t) => s + riskWeight(t.risk), 0) / relevant.length;
  return capUnit(avg);
}

function computeDependencyRisk(signals: MissionSignals): number {
  const total = signals.dependencySummary.total;
  if (!total) return 0;
  return capUnit(signals.dependencySummary.looseRange / total);
}

function computeSecurityRisk(signals: MissionSignals): number {
  const high = signals.securityFindings.filter((f) => f.severity === 'high').length;
  const medium = signals.securityFindings.filter((f) => f.severity === 'medium').length;
  return capUnit(high * 0.25 + medium * 0.1);
}

function computeRegressionRisk(goalGraph: GoalGraph, signals: MissionSignals): number {
  const hotspotFiles = new Set(signals.hotspots.map((h) => h.file));
  const fileTasks = goalGraph.tasks.filter((t) => t.targetFile);
  const hotspotOverlap = fileTasks.length ? fileTasks.filter((t) => t.targetFile && hotspotFiles.has(t.targetFile)).length / fileTasks.length : 0;
  const coverageGap = capUnit(1 - signals.verificationScore / 100);
  return capUnit(0.5 * hotspotOverlap + 0.5 * coverageGap);
}

function computeComplexity(goalGraph: GoalGraph): number {
  const taskCountFactor = capUnit(goalGraph.tasks.length / 24);
  const depTasks = goalGraph.tasks.filter((t) => t.dependencies.length > 0).length;
  const dependencyFactor = goalGraph.tasks.length ? capUnit(depTasks / goalGraph.tasks.length) : 0;
  return capUnit(0.6 * taskCountFactor + 0.4 * dependencyFactor);
}

function computeConfidence(goalGraph: GoalGraph): number {
  if (!goalGraph.tasks.length) return 0;
  const avg = goalGraph.tasks.reduce((s, t) => s + t.confidence, 0) / goalGraph.tasks.length;
  return capUnit(avg);
}

function collectUnknowns(goalGraph: GoalGraph, signals: MissionSignals, intent: ExtractedIntent): string[] {
  const unknowns: string[] = [];
  if (!signals.buildStatus.available) unknowns.push(`Build status unknown — ${signals.buildStatus.reason}`);
  if (!signals.gitStatus.available) unknowns.push(`Git status unknown — ${signals.gitStatus.reason}`);
  if (!goalGraph.tasks.length) unknowns.push('No concrete tasks were generated for this mission.');
  const lowConfidence = goalGraph.tasks.filter((t) => t.confidence < 0.4);
  for (const t of lowConfidence.slice(0, 5)) unknowns.push(`Low planning confidence on task "${t.title}" (${Math.round(t.confidence * 100)}%).`);
  if (!intent.targetComponents.length) unknowns.push('Mission did not name specific target components — scope inferred project-wide.');
  return unknowns;
}

const WEIGHTS = { architecture: 0.2, dependency: 0.15, security: 0.2, regression: 0.2, complexity: 0.15, confidencePenalty: 0.1 } as const;

export function analyzeMissionRisk(goalGraph: GoalGraph, signals: MissionSignals, intent: ExtractedIntent): RiskAnalysis {
  const architectureRisk = computeArchitectureRisk(goalGraph, signals);
  const dependencyRisk = computeDependencyRisk(signals);
  const securityRisk = computeSecurityRisk(signals);
  const regressionRisk = computeRegressionRisk(goalGraph, signals);
  const complexity = computeComplexity(goalGraph);
  const confidence = computeConfidence(goalGraph);
  const unknowns = collectUnknowns(goalGraph, signals, intent);

  const overall = capUnit(
    WEIGHTS.architecture * architectureRisk +
    WEIGHTS.dependency * dependencyRisk +
    WEIGHTS.security * securityRisk +
    WEIGHTS.regression * regressionRisk +
    WEIGHTS.complexity * complexity +
    WEIGHTS.confidencePenalty * (1 - confidence),
  );

  return { architectureRisk, dependencyRisk, securityRisk, regressionRisk, complexity, confidence, unknowns, overall };
}
