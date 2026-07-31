/**
 * Scorecard math — explainable weighted scoring.
 * ==================================================================
 * Every score is a weighted mean of measurable parts; each part carries
 * its own evidence so any score can be traced to real analysis output.
 */

import type { Score, ScorePart } from './types';

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function to100(v: number): number {
  return Math.round(clamp01(v) * 100);
}

export function gradeOf(value: number): Score['grade'] {
  if (value >= 90) return 'A';
  if (value >= 75) return 'B';
  if (value >= 55) return 'C';
  if (value >= 35) return 'D';
  return 'F';
}

export function makeScore(parts: ScorePart[], summary: string): Score {
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const weighted = parts.reduce((s, p) => s + p.weight * clamp01(p.value), 0);
  const value = totalWeight > 0 ? weighted / totalWeight : 0;
  const rounded = Math.round(clamp01(value) * 100);
  return {
    value: rounded,
    grade: gradeOf(rounded),
    parts,
    explanation: summary,
  };
}

/** Invert a debt-like ratio (0..1 where 1 = everything is debt) into a health score part. */
export function debtRatioToPart(label: string, weight: number, ratio01: number, evidence: string[]): ScorePart {
  return { label, weight, value: to100(1 - clamp01(ratio01)), evidence };
}

export function countToPart(label: string, weight: number, count: number, maxBad: number, evidence: string[]): ScorePart {
  const ratio = Math.min(1, count / Math.max(1, maxBad));
  return { label, weight, value: to100(1 - ratio), evidence };
}

/** Sum of weight across parts — a guard for callers. */
export function totalWeight(parts: ScorePart[]): number {
  return parts.reduce((s, p) => s + p.weight, 0);
}
