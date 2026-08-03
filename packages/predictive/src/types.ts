/**
 * @aura/predictive — sealed vocabulary.
 * ==================================================================
 * Everything the Predictive Engineering Platform reads and writes goes
 * through these types, which is exactly what makes it "future ML
 * compatible": `PredictiveEvidence` is a plain, serializable feature
 * vector, and every engine is a pure function
 * `evidence → PredictionReport`. A model trained on the same schema
 * could replace the deterministic scoring without touching callers.
 *
 * Nothing here invents data. Every field maps to a REAL platform
 * signal (git churn, governance findings, knowledge-graph edges,
 * mission/diagnosis/automation history). The host is responsible for
 * populating the evidence; the package only computes.
 */

/* ── Risk / severity vocabulary ───────────────────────────────────── */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PredictionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type Horizon = 'immediate' | 'short-term' | 'medium-term' | 'long-term';

/* ── The nine prediction kinds the platform produces ──────────────── */

export type PredictionKind =
  | 'file-failure'            // files likely to fail next
  | 'module-instability'      // modules likely to become unstable
  | 'future-tech-debt'        // markers/churn that will become real debt
  | 'dependency-conflict'     // dependency ranges/deprecation that will conflict
  | 'architecture-drift'      // upcoming architecture drift
  | 'mission-failure'         // probability a mission fails
  | 'proposal-success'        // probability an AI proposal succeeds
  | 'diagnosis-likelihood'    // likelihood a file needs a diagnosis
  | 'workflow-bottleneck';    // automation/workflow steps that will bottleneck

export type TargetType =
  | 'file'
  | 'module'
  | 'dependency'
  | 'mission'
  | 'candidate'
  | 'action'
  | 'rule'
  | 'project';

/* ══ Input — the sealed evidence schema ═════════════════════════════ */

/** Per-file real signals. Every field is populated by the host from a real source. */
export interface FileSignal {
  relPath: string;
  /** Package/app dir name (e.g. "ai-service"), or null for root files. */
  module: string | null;
  /** Knowledge-graph layer, if the fullstack graph resolved one. */
  layer: string | null;
  /** Git change count over the churn window. */
  churn: number;
  lines: number;
  /** 0..1 normalized structural complexity (large file/function/class spans). */
  complexity: number;
  /** TODO/FIXME/HACK/XXX marker count. */
  markers: number;
  hasTests: boolean;
  /** Prior diagnoses run on this exact file. */
  diagnosisCount: number;
  /** Prior diagnoses on this file that surfaced real failures (non-unknown). */
  diagnosisFired: number;
  /** Files that import this file (direct dependents). */
  dependents: string[];
  /** Security findings in this file. */
  securityFindings: number;
  isTest: boolean;
}

/** Dependency conflict signals from real manifests + security engine. */
export interface DependencySignal {
  name: string;
  /** Raw semver range from the manifest. */
  range: string;
  /** True when the range is not pinned exactly (^, ~, *, no version). */
  loose: boolean;
  deprecated: boolean;
  vulnerable: boolean;
  /** package.json (or other manifest) that declares it. */
  declaredIn: string;
  /** Manifest changed recently (churn on the declaring file). */
  changed: boolean;
}

/** Per-module aggregate signal. */
export interface ModuleSignal {
  name: string;
  relDir: string;
  churn: number;
  files: number;
}

/** Structural architecture signals from the Architecture Health engine. */
export interface ArchitectureSignal {
  sourceFiles: number;
  cycles: number;
  nodesInCycles: number;
  layerViolations: number;
  unusedModules: number;
  duplicatePairs: number;
  driftImports: number;
  longestChain: number;
  /** Files participating in dependency cycles. */
  cycleFiles: string[];
  /** Files doing undeclared cross-package imports (drift). */
  driftFiles: string[];
}

/** Git churn signals. */
export interface GitSignal {
  available: boolean;
  since: string;
  totalCommits: number;
  byFile: Record<string, number>;
  byModule: Record<string, { changes: number; added: number; deleted: number }>;
}

/** Technical-debt signals. */
export interface DebtSignal {
  totalItems: number;
  markers: { file: string; marker: string; line: number }[];
  largeFiles: string[];
  largeFunctions: string[];
  repeatedPairs: { a: string; b: string; similarity: number }[];
}

/** Security review signals. */
export interface SecuritySignal {
  findings: { file: string; type: string; severity: string }[];
  deprecatedDependencies: string[];
  criticalHigh: number;
}

/** Documentation governance signals. */
export interface DocsSignal {
  issues: { file: string; type: string }[];
  coverage: { packagesWithReadme: number; packagesTotal: number; modulesWithDocs: number; modulesTotal: number };
}

/** Engineering scorecard signals. */
export interface HealthSignal {
  dimensions: { dimension: string; value: number }[];
  overall: number;
  unavailable: string[];
}

/** Mission history — one entry per persisted mission record. */
export interface MissionHistory {
  id: string;
  category: string;
  approved: boolean;
  /** mission.risk.overall, normalized 0..1. */
  riskOverall: number | null;
  /** mission.quality.overall, normalized 0..1. */
  qualityOverall: number | null;
  executionStatus: string | null;
  failedTasks: number;
  totalTasks: number;
  rejectedTasks: number;
  createdAt: string;
}

/** Diagnosis history — one entry per diagnosis record, with candidate outcomes. */
export interface DiagnosisHistory {
  file: string;
  category: string;
  decision: string;
  candidates: {
    id: string;
    strategy: string;
    confidenceOverall: number;
    limiter: string;
    verdict: string;
  }[];
}

/** Automation run history — per-action execution states. */
export interface RunHistory {
  ruleId: string;
  ruleName: string;
  action: string;
  /** Run-level status (completed / failed / cancelled …). */
  status: string;
  /** Per-action state (completed / failed / skipped …). */
  actionStatus: string;
  retries: number;
  ms: number;
  startedAt: string;
}

/** Static workflow-shape signals (definitions; runs live in RunHistory). */
export interface WorkflowSignal {
  id: string;
  name: string;
  nodeCount: number;
  /** groq / generate-* / shell-command style nodes — expensive steps. */
  heavyNodes: number;
  /** Longest chain of edges in the workflow graph. */
  sequentialDepth: number;
}

/** The complete sealed input to every predictive engine. */
export interface PredictiveEvidence {
  projectId: string;
  projectPath: string;
  collectedAt: string;
  files: FileSignal[];
  dependencies: DependencySignal[];
  modules: ModuleSignal[];
  architecture: ArchitectureSignal;
  git: GitSignal;
  debt: DebtSignal;
  security: SecuritySignal;
  docs: DocsSignal;
  health: HealthSignal;
  missions: MissionHistory[];
  diagnoses: DiagnosisHistory[];
  runs: RunHistory[];
  workflows: WorkflowSignal[];
}

/* ══ Confidence Engine output ═══════════════════════════════════════ */

/** A single real signal behind a number. `weight` is the deterministic
 *  contribution the signal had to the value (0..1). */
export interface EvidencePoint {
  label: string;
  value: number | string | boolean;
  /** Human source tag, e.g. "git-churn", "architecture-health", "mission-store". */
  source: string;
  weight: number;
}

export interface Confidence {
  /** 0..1 — how much the deterministic computation is trusted. */
  score: number;
  /** Fraction of required inputs that were actually available. */
  coverage: number;
  /** Number of positive signals that fired. */
  signals: number;
  /** Human-readable reasons the score is not 1. */
  caveats: string[];
}

/* ══ Prediction Engine output ═══════════════════════════════════════ */

export interface Prediction {
  id: string;
  kind: PredictionKind;
  target: string;
  targetType: TargetType;
  severity: PredictionSeverity;
  /** 0..1 deterministic probability. */
  probability: number;
  confidence: Confidence;
  horizon: Horizon;
  drivers: EvidencePoint[];
  preventiveActions: string[];
  summary: string;
}

/* ══ Risk Engine output ═════════════════════════════════════════════ */

export interface RiskDimension {
  key: string;
  label: string;
  /** 0..1 — higher is riskier. */
  score: number;
  evidence: EvidencePoint[];
}

export interface RiskProfile {
  /** 0..1 overall project risk. */
  overall: number;
  level: RiskLevel;
  dimensions: RiskDimension[];
  topFiles: { file: string; risk: number; drivers: string[] }[];
  topModules: { module: string; risk: number; drivers: string[] }[];
}

/* ══ Prediction Report — the "Show" surface ═════════════════════════ */

export interface PredictionReport {
  projectId: string;
  projectPath: string;
  generatedAt: string;
  source: 'deterministic';
  risk: RiskProfile;
  predictions: Prediction[];
  /** Predicted hotspots — top file-failure + module-instability. */
  hotspots: Prediction[];
  /** Predicted regressions — files/modules with churn + low coverage. */
  regressions: Prediction[];
  /** Upcoming architecture risks. */
  architectureRisks: Prediction[];
  /** Deduplicated, deterministic suggested preventive actions. */
  preventiveActions: string[];
  confidence: Confidence;
}

/* ══ Impact Analysis + Simulation Engine output ═════════════════════ */

export interface ImpactAnalysis {
  target: string;
  directDependents: string[];
  transitiveDependents: string[];
  affectedLayers: string[];
  relationCount: number;
  /** 0..1 risk contributed by the affected surface. */
  riskScore: number;
}

export type SimulationChange = 'modify' | 'add' | 'remove';

export interface SimulationProjection {
  withoutAction: RiskLevel;
  withPreventive: RiskLevel;
}

export interface WhatIfSimulation {
  target: string;
  change: SimulationChange;
  impact: ImpactAnalysis;
  /** Expected risk-level shift from the change (0..1). */
  riskDelta: number;
  projection: SimulationProjection;
  notes: string[];
  /** Prediction ids this change aggravates. */
  affectedPredictions: string[];
}

/** Live-mission context passed to the mission-failure predictor.
 *  Serialized from a real MissionRecord by the host; absent fields are null. */
export interface MissionContext {
  id: string;
  text: string;
  category: string;
  riskOverall: number | null;
  qualityOverall: number | null;
  /** accepted / (accepted + proposed + rejected). */
  taskAcceptanceRate: number | null;
  tasks: { id: string; targetFile: string; status: string }[];
}

/** Live AI-proposal context passed to the proposal-success predictor. */
export interface CandidateContext {
  id: string;
  strategy: string;
  targetFile: string;
  confidenceOverall: number | null;
  /** Reason the proposal is limited (missing deps, conflicts…) or null. */
  limiter: string | null;
  dependencies: string[];
}

export const genPredictionId = (kind: PredictionKind, target: string): string =>
  `pred-${kind}-${target.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60)}`;
