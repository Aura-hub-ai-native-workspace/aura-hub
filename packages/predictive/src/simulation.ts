/**
 * Simulation Engine — deterministic what-if projections.
 * ==================================================================
 * Answer: "what happens to risk if I modify / add / remove this file?"
 * Each projection is computed from real signals only:
 *
 *   riskDelta   — the expected 0..1 shift in project risk introduced
 *                 by the simulated change (derived from the target's
 *                 own risk and its blast radius).
 *   withoutAction — risk level that follows the change if nothing is
 *                 done preventively.
 *   withPreventive — risk level if the recommended preventive action
 *                 is taken (we model it as halving the exposed risk).
 *
 * Nothing is random; everything is reproducible.
 */

import type { PredictiveEvidence, SimulationChange, WhatIfSimulation } from './types';
import { analyzeImpact } from './impact';
import { fileRisk } from './risk';
import { clamp01, riskLevelOf } from './score';
import { predictFileFailures, predictModuleInstability } from './prediction';

export function simulateChange(e: PredictiveEvidence, target: string, change: SimulationChange): WhatIfSimulation {
  const impact = analyzeImpact(e, target);
  const targetRisk = fileRisk(e.files.find((f) => f.relPath === target) ?? { relPath: target, module: null, layer: null, churn: 0, lines: 0, complexity: 0, markers: 0, hasTests: true, diagnosisCount: 0, diagnosisFired: 0, dependents: [], securityFindings: 0, isTest: false }).risk;

  let riskDelta: number;
  const notes: string[] = [];
  switch (change) {
    case 'remove':
      riskDelta = -clamp01(impact.riskScore) * 0.5;
      notes.push(`Removing ${target} eliminates ${impact.relationCount} dependency edge(s) and ${impact.affectedLayers.length} layer(s) of exposure.`);
      break;
    case 'add':
      riskDelta = clamp01(impact.riskScore) * 0.5;
      notes.push(`Adding to ${target} exposes ${impact.relationCount} dependent(s) across ${impact.affectedLayers.length} layer(s).`);
      break;
    default: // modify
      riskDelta = clamp01(impact.riskScore) * 0.6 + targetRisk * 0.4;
      notes.push(`Modifying ${target} (risk ${targetRisk.toFixed(2)}) propagates to ${impact.relationCount} dependent(s).`);
  }

  const afterChange = clamp01(targetRisk + riskDelta);
  const withPreventive = clamp01(targetRisk + riskDelta * 0.3);

  const all = [...predictFileFailures(e), ...predictModuleInstability(e)];
  const affectedPredictions = all
    .filter((p) => p.target === target || impact.directDependents.includes(p.target) || impact.transitiveDependents.includes(p.target))
    .map((p) => p.id)
    .sort();

  return {
    target,
    change,
    impact,
    riskDelta: Math.round(riskDelta * 1000) / 1000,
    projection: {
      withoutAction: riskLevelOf(afterChange),
      withPreventive: riskLevelOf(withPreventive),
    },
    notes,
    affectedPredictions,
  };
}
