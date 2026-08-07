/**
 * @aura/governance — shared governance vocabulary.
 * ==================================================================
 * Real-analysis types shared by every governance engine. No mock data:
 * every value is derived from the actual workspace (files, imports,
 * git history, node_modules metadata) or explicitly marked unavailable
 * with the reason why.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Evidence {
  file: string;
  line?: number;
  snippet?: string;
  /** Why this evidence is trusted (real derivation path). */
  basis: string;
}

/** A scored dimension: value 0..100, grade A..F, fully explained. */
export interface Score {
  value: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  parts: ScorePart[];
  explanation: string;
}

export interface ScorePart {
  label: string;
  weight: number;
  value: number;
  evidence: string[];
}

export interface Finding {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  description: string;
  evidence: Evidence[];
  recommendation: string;
}

/** Every report carries its derivation so nothing is unverifiable. */
export interface ReportMeta {
  root: string;
  analyzedFiles: number;
  generatedAt: string;
  durationMs: number;
  unavailable: string[];
}
