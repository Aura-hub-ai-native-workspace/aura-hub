/**
 * Confidence System
 * ==================================================================
 * Distinguishes between documented facts, inferred information,
 * and uncertain claims. The AI never hallucinates when the repository
 * lacks evidence.
 */

import type { ConfidenceMark, ProjectIdentity, RepositorySummary } from './types';

export interface ConfidenceSource {
  identity: ProjectIdentity | null;
  summary: RepositorySummary | null;
  documentation: string[];
  graphEntities: string[];
}

/**
 * Evaluate confidence for a claim based on available evidence.
 */
export function evaluateConfidence(
  claim: string,
  source: ConfidenceSource,
): ConfidenceMark {
  const claimLower = claim.toLowerCase();

  // Check if the claim is directly supported by identity
  if (source.identity) {
    const id = source.identity;
    if (claimLower.includes(id.name.toLowerCase()) || claimLower.includes(id.repositoryType)) {
      return { level: 'documented', evidence: `Project identity states this is a ${id.repositoryType} project`, source: 'identity' };
    }
    if (id.purpose && claimLower.includes(id.purpose.toLowerCase().slice(0, 30))) {
      return { level: 'documented', evidence: 'Purpose is stated in project identity', source: 'identity' };
    }
  }

  // Check if the claim is supported by summary
  if (source.summary) {
    for (const mod of source.summary.modules) {
      if (claimLower.includes(mod.name.toLowerCase())) {
        return { level: 'documented', evidence: `Module "${mod.name}" is documented in repository summary`, source: 'summary' };
      }
    }
  }

  // Check if claim references specific files or entities
  const fileMatch = claim.match(/[\w/.-]+\.[a-z]{1,4}/);
  if (fileMatch) {
    const filePath = fileMatch[0];
    if (source.documentation.some(d => d.includes(filePath))) {
      return { level: 'documented', evidence: `Referenced file ${filePath} is in documentation`, source: 'documentation' };
    }
  }

  // Check if claim references graph entities
  for (const entity of source.graphEntities) {
    if (claimLower.includes(entity.toLowerCase())) {
      return { level: 'inferred', evidence: `Entity "${entity}" found in code graph but not explicitly documented`, source: 'graph' };
    }
  }

  // Default: uncertain
  return { level: 'uncertain', evidence: 'No direct evidence found in repository knowledge' };
}

/**
 * Format confidence mark as a human-readable prefix.
 */
export function formatConfidence(mark: ConfidenceMark): string {
  switch (mark.level) {
    case 'documented':
      return '';  // No prefix needed — confident
    case 'inferred':
      return `[Based on the indexed source code] `;
    case 'uncertain':
      return `[The available information is limited] `;
  }
}

/**
 * Should the response include a confidence disclaimer?
 */
export function shouldDisclaimConfidence(marks: ConfidenceMark[]): boolean {
  return marks.some(m => m.level === 'uncertain');
}
