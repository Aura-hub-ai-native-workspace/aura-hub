/**
 * Impact Analysis — blast radius over the knowledge-graph dependency web.
 * ==================================================================
 * Given a target file, walks the sealed `dependents` adjacency lists to
 * find direct and transitive dependents, the layers they touch, and the
 * risk the affected surface carries. Pure, deterministic, and driven
 * entirely by PredictiveEvidence (which the host populates from the
 * fullstack knowledge graph's import edges).
 */

import type { ImpactAnalysis, PredictiveEvidence } from './types';
import { weighted } from './score';
import { fileRisk } from './risk';

export function analyzeImpact(e: PredictiveEvidence, target: string): ImpactAnalysis {
  const dependents = new Map<string, string[]>();
  for (const f of e.files) dependents.set(f.relPath, f.dependents);

  const direct = dependents.get(target) ?? [];
  const seen = new Set<string>([target, ...direct]);
  const queue = [...direct];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const d of dependents.get(cur) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  const transitive = [...seen].filter((f) => f !== target && !direct.includes(f));
  transitive.sort((a, b) => a.localeCompare(b));

  const fileByPath = new Map(e.files.map((f) => [f.relPath, f]));
  const affected = [...direct, ...transitive];
  const layers = [...new Set(affected.map((p) => fileByPath.get(p)?.layer ?? null).filter((l): l is string => l !== null))].sort((a, b) => a.localeCompare(b));

  const riskScore = affected.length > 0 ? weighted(affected.map((p) => ({ value: fileByPath.get(p) ? fileRisk(fileByPath.get(p)!).risk : 0.5, weight: 1 }))) : 0;

  return {
    target,
    directDependents: [...direct].sort((a, b) => a.localeCompare(b)),
    transitiveDependents: transitive,
    affectedLayers: layers,
    relationCount: direct.length + transitive.length,
    riskScore: Math.round(Math.min(1, riskScore) * 1000) / 1000,
  };
}
