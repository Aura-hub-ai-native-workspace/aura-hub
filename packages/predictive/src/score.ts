/**
 * Deterministic scoring helpers shared by every engine.
 * ==================================================================
 * Pure, tiny math utilities. Determinism is guaranteed by construction:
 * no randomness, no timestamps in the pipeline, and stable tie-breaking
 * by the caller.
 */

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Normalize a raw count against a reference max, clamped to 0..1. */
export const normalize = (value: number, max: number): number => (max > 0 ? clamp01(value / max) : 0);

/** Weighted mean of value/weight pairs. Returns 0 when no weight. */
export const weighted = (items: { value: number; weight: number }[]): number => {
  const tw = items.reduce((s, i) => s + i.weight, 0);
  if (tw <= 0) return 0;
  return items.reduce((s, i) => s + i.value * i.weight, 0) / tw;
};

/** Severity bucket from a 0..1 probability, deterministic thresholds. */
export const severityOf = (p: number): 'low' | 'medium' | 'high' | 'critical' => {
  if (p >= 0.75) return 'critical';
  if (p >= 0.5) return 'high';
  if (p >= 0.25) return 'medium';
  return 'low';
};

/** Horizon from probability — higher risk ⇒ sooner expected impact. */
export const horizonOf = (p: number): 'immediate' | 'short-term' | 'medium-term' | 'long-term' => {
  if (p >= 0.6) return 'immediate';
  if (p >= 0.4) return 'short-term';
  if (p >= 0.2) return 'medium-term';
  return 'long-term';
};

export const riskLevelOf = (p: number): 'low' | 'medium' | 'high' | 'critical' => severityOf(p);

/** Stable descending sort by score, then ascending by key for determinism. */
export function sortByScoreDesc<T>(items: T[], score: (t: T) => number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => score(b) - score(a) || key(a).localeCompare(key(b)));
}
