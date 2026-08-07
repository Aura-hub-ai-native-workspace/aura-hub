/**
 * Diagnosis Engine — shared shapes for all 10 stages.
 * ==================================================================
 * The classifier (Stage 2) is 100% deterministic — it is never asked
 * to guess. `'unknown'` is a first-class, honest outcome: it means
 * none of the real detectors fired, not that the engine failed.
 * Every confidence number in this file is a ratio of real checks
 * fired/run — never a bare model opinion — and is always capped
 * below 1 (see confidence.ts's capConfidence).
 */
import type { CodeRelationRef } from '../codeAction';
import type { RiskLevel } from '../jsonMode';

export type { RiskLevel, CodeRelationRef };

export type BugCategory = 'null-bug' | 'dead-code' | 'broken-api' | 'architecture-smell' | 'unknown';

export interface DetectorCheck {
  name: string;
  fired: boolean;
}

export interface DetectorResult {
  fires: boolean;
  evidence: string[];
  checksRun: DetectorCheck[];
}

export interface Classification {
  category: BugCategory;
  evidence: string[];
  checksRun: DetectorCheck[];
}

/** A minimal projection of a graph Entity — all detectors need. */
export interface EntityLayerRef {
  relPath: string;
  layer: string;
  kind: string;
  name: string;
}

/**
 * Everything a detector needs, gathered once by signals.ts and re-used
 * unchanged for Patch Simulation's "does the category still fire against
 * the patched text" re-check (only `fileText`/`selectionRange` differ).
 */
export interface DetectorContext {
  projectPath: string;
  absFilePath: string;
  relPath: string;
  language: string;
  fileText: string;
  selectionText: string;
  selectionRange: TargetRange | null;
  symbolName: string | null;
  entities: EntityLayerRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
}

export interface GitLogEntry { hash: string; date: string; subject: string }
export interface GitBlameLine { line: number; hash: string; author: string; date: string }
export type Unavailable = { unavailable: true; reason: string };

export interface CrossLayerImport {
  specifier: string;
  resolvedRelPath: string;
  targetLayer: string;
  allowed: boolean;
}

export interface CompilerDiagnostic {
  message: string;
  line: number;
}

export interface FailureSignals {
  file: { relPath: string; language: string; totalLines: number };
  symbol: { id: string; name: string; kind: string; line: number } | null;
  imports: { local: string[]; external: string[] };
  exports: string[];
  dependencies: CodeRelationRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
  architectureLayer: string;
  crossLayerImports: CrossLayerImport[];
  gitHistory: GitLogEntry[] | Unavailable;
  gitBlame: GitBlameLine[] | Unavailable;
  relatedTests: { found: boolean; paths: string[] };
  relatedDocs: CodeRelationRef[];
  relatedApis: (CodeRelationRef & { method?: string; path?: string })[];
  dbRelations: CodeRelationRef[];
  compilerDiagnostics: CompilerDiagnostic[];
  runtimeLogs: Unavailable;
  memoryRecall: { id: string; kind: string; title: string }[];
}

export interface RootCause {
  summary: string;
  evidenceUsed: string[];
  relatedComponents: CodeRelationRef[];
  aiStatedConfidence: 'low' | 'medium' | 'high';
}

export interface PatchLimiterStats {
  linesAdded: number;
  linesRemoved: number;
  percentRemoved: number;
  entireFileChanged: boolean;
  exportsRemoved: string[];
  exportsAdded: string[];
  functionsModified: number;
  importsRemovedCount: number;
  architectureLayerChanged: boolean;
}

export type PatchDecision = 'auto-approved' | 'requires-manual-approval' | 'auto-rejected';

export interface PatchLimiterResult {
  decision: PatchDecision;
  reasons: string[];
  stats: PatchLimiterStats;
}

export interface ImpactReport {
  compiled: boolean;
  diagnostics: CompilerDiagnostic[];
  categoryStillPresent: boolean;
  referencesBroken: CodeRelationRef[];
  testsFound: boolean;
  testFilePaths: string[];
  notes: string[];
}

export interface ConfidenceScores {
  diagnosis: number;
  patch: number;
  architecture: number;
  simulation: number;
  overall: number;
}

export interface ReviewerVerdict {
  verdict: 'pass' | 'reject';
  flaws: string[];
  summary: string;
}

export type PatchStrategy = 'minimal-fix' | 'defensive-fix' | 'refactor-adjacent-fix';

export interface TargetRange {
  startLine: number;
  endLine: number;
}

export interface PatchCandidate {
  id: 'A' | 'B' | 'C';
  strategy: PatchStrategy;
  summary: string;
  explanation: string;
  targetRange: TargetRange;
  newText: string;
  limiter: PatchLimiterResult;
  impact: ImpactReport;
  confidence: ConfidenceScores;
  reviewer: ReviewerVerdict;
}

export interface DiagnosisRequest {
  projectId: string;
  filePath: string;
  language: string;
  selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
}

export interface DiagnosisComparison {
  recommended: 'A' | 'B' | 'C' | null;
  writeup: string;
}

export interface DiagnosisDecision {
  status: 'pending' | 'accepted' | 'rejected';
  candidateId?: 'A' | 'B' | 'C';
  at?: string;
  reason?: string;
}

export interface DiagnosisRecord {
  id: string;
  projectId: string;
  filePath: string;
  createdAt: string;
  signals: FailureSignals;
  classification: Classification;
  rootCause: RootCause | null;
  candidates: PatchCandidate[];
  comparison: DiagnosisComparison | null;
  decision: DiagnosisDecision;
}

export interface DiagnosisSummary {
  id: string;
  projectId: string;
  filePath: string;
  createdAt: string;
  category: BugCategory;
  decision: DiagnosisDecision;
}

export type DiagnosisEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'done'; at: string }
  | { type: 'signals'; signals: FailureSignals }
  | { type: 'classification'; classification: Classification }
  | { type: 'root-cause'; rootCause: RootCause }
  | { type: 'candidate'; candidate: PatchCandidate }
  | { type: 'comparison'; comparison: DiagnosisComparison }
  | { type: 'unknown-stop'; message: string }
  | { type: 'done'; diagnosis: DiagnosisRecord }
  | { type: 'error'; message: string };
