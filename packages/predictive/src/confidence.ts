/**
 * Confidence Engine — how much each deterministic prediction is trusted.
 * ==================================================================
 * Confidence is NOT a model opinion. It is a documented function of
 * evidence quality:
 *
 *   coverage   — the fraction of inputs the model ideally wants that
 *                were actually available (e.g. git history may be
 *                missing, so confidence drops).
 *   signal     — the share of available signals that fired positively.
 *   conflict   — negative / contradicting signals reduce confidence.
 *
 * Everything clamps to [0.05, 0.97]: 1.0 is reserved because real
 * engineering predictions always carry some uncertainty, and 0.05 is
 * the honest floor when nothing is available.
 */

import type { Confidence } from './types';
import { clamp01 } from './score';

export interface ConfidenceInput {
  /** Number of signals the predictor ideally needs. */
  required: number;
  /** Number of those that were actually available. */
  available: number;
  /** Of the available signals, how many fired positively. */
  positive: number;
  /** Contradicting signals (reduce trust). */
  negative?: number;
  /** Free-form caveats surfaced to the UI/AI chat. */
  caveats?: string[];
}

export function computeConfidence(input: ConfidenceInput): Confidence {
  const required = Math.max(1, input.required);
  const available = Math.max(0, Math.min(required, input.available));
  const coverage = available / required;
  const positive = Math.max(0, Math.min(available, input.positive));
  const signalScore = available > 0 ? positive / available : 0;
  const conflictPenalty = clamp01((input.negative ?? 0) * 0.08);

  const score = clamp01(0.15 + coverage * 0.4 + signalScore * 0.45 - conflictPenalty);
  const caveats = [...(input.caveats ?? [])];
  if (available < required) {
    caveats.push(`${required - available} of ${required} expected signals were unavailable — prediction is based on ${available}.`);
  }
  if (conflictPenalty > 0) caveats.push('Conflicting signals lowered confidence.');

  return {
    score: Math.round(score * 1000) / 1000,
    coverage: Math.round(coverage * 1000) / 1000,
    signals: positive,
    caveats,
  };
}
