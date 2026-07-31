/**
 * confidence — the Confidence Engine. Every number is a ratio of real
 * checks fired/run — never a bare model opinion — and is always capped
 * below 1 so a badge can never honestly read "100%".
 */
import type { BugCategory, Classification, ConfidenceScores, DetectorCheck, ImpactReport, PatchLimiterStats } from './types';

export function capConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(0.99, Math.max(0, n));
}

function ratio(checks: DetectorCheck[]): number {
  if (!checks.length) return 0;
  return checks.filter((c) => c.fired).length / checks.length;
}

const WEIGHTS = { diagnosis: 0.3, patch: 0.3, architecture: 0.15, simulation: 0.25 } as const;

export function computeConfidence(
  classification: Classification,
  category: BugCategory,
  stats: PatchLimiterStats,
  impact: ImpactReport,
): ConfidenceScores {
  const diagnosis = capConfidence(ratio(classification.checksRun));

  const patch = capConfidence(
    (1 - stats.percentRemoved) * (stats.exportsRemoved.length ? 0 : 1) * (stats.entireFileChanged ? 0 : 1),
  );

  const architecture = capConfidence(
    category === 'architecture-smell' ? ratio(classification.checksRun) : stats.architectureLayerChanged ? 0.5 : 1.0,
  );

  const simChecks = [impact.compiled, !impact.categoryStillPresent, impact.referencesBroken.length === 0];
  const simulation = capConfidence(simChecks.filter(Boolean).length / simChecks.length);

  const overall = capConfidence(
    WEIGHTS.diagnosis * diagnosis + WEIGHTS.patch * patch + WEIGHTS.architecture * architecture + WEIGHTS.simulation * simulation,
  );

  return { diagnosis, patch, architecture, simulation, overall };
}
