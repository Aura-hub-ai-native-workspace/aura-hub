/**
 * Mission Control v2 — shared shapes for the 9-stage planning pipeline.
 * ==================================================================
 * A mission is a free-text objective turned into a Goal Graph through
 * a pipeline that runs DETERMINISTIC analysis before every model call,
 * and never lets a model invent a category, a signal, or a number it
 * wasn't given. Two different missions must be able to produce two
 * structurally different plans — this is enforced by construction:
 * Stage 1 (classification) and Stage 4 (strategy selection) are both
 * deterministic lookups that hand the model a category-specific
 * scaffold, rather than asking one generic prompt to "be creative
 * differently" for every request.
 *
 * Execution remains human-gated at two points, unchanged from v1: the
 * whole plan must be explicitly approved before any task can run, and
 * each task's AI-generated proposal must be explicitly accepted before
 * it is ever written to disk. Planning (Stages 1-9) is pure computation
 * — nothing is written to the real filesystem until a task is accepted.
 */
import type { HealthIssue, HealthScore } from '../intelligence/types';
import type { LayerDef } from '../architectureExtractor';
import type { MissionExecution } from './execution/types';

export type { HealthIssue, HealthScore, LayerDef };
export type ArchitectureLayer = LayerDef;

export interface Hotspot {
  file: string;
  score: number;
  reason: string;
}

/* ── Stage 1 — Intent Classification ──────────────────────────────── */

/**
 * The fixed, closed set of mission categories. A model may only ever
 * select ONE of these — never invent a new string. `'unknown'` is a
 * first-class, honest outcome when no deterministic pattern matches.
 */
export type MissionCategory =
  | 'feature-development'
  | 'architecture'
  | 'bug-resolution'
  | 'performance'
  | 'security'
  | 'documentation'
  | 'testing'
  | 'presentation'
  | 'deployment'
  | 'migration'
  | 'maintenance'
  | 'research'
  | 'release'
  | 'refactoring'
  | 'unknown';

export interface CategoryCandidate {
  category: MissionCategory;
  score: number;
  matchedSignals: string[];
}

/**
 * Stage 1's output. `source: 'deterministic'` means the keyword
 * classifier's top candidate was used as-is; `'refined'` means the LLM
 * (Stage 2's combined call) picked a different candidate from the SAME
 * deterministic candidate list — never a category the classifier
 * didn't already surface.
 */
export interface IntentClassification {
  category: MissionCategory;
  confidence: number;
  candidates: CategoryCandidate[];
  source: 'deterministic' | 'refined';
}

/* ── Stage 2 — Intent Extraction ──────────────────────────────────── */

export type MissionScope = 'narrow' | 'moderate' | 'broad';
export type MissionRiskLevel = 'low' | 'medium' | 'high';
export type RequiredQuality = 'prototype' | 'standard' | 'production';

export interface ExtractedIntent {
  primaryGoal: string;
  secondaryGoals: string[];
  constraints: string[];
  deadline: string | null;
  targetComponents: string[];
  expectedOutcome: string;
  scope: MissionScope;
  riskLevel: MissionRiskLevel;
  requiredQuality: RequiredQuality;
}

/* ── Stage 3 — Project Analysis (deterministic, zero model calls) ──── */

export interface SecurityFinding {
  pattern: string;
  file: string;
  line: number;
  snippet: string;
  severity: 'high' | 'medium';
}

export type BuildStatus =
  | { available: false; reason: string }
  | { available: true; ok: boolean; message: string };

export type GitStatusSignal =
  | { available: false; reason: string }
  | { available: true; branch: string; dirty: boolean; changedFiles: number };

export interface RecentCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface TechnicalDebtMarker {
  marker: 'TODO' | 'FIXME' | 'HACK' | 'XXX';
  file: string;
  line: number;
  text: string;
}

export interface DependencySummary {
  total: number;
  pinnedExact: number;
  looseRange: number;
}

/** Stage 3's output. Every field is a real signal already computed elsewhere in this app, or a real, bounded, freshly-run scan. Nothing here is fabricated. */
export interface MissionSignals {
  health: HealthScore | null;
  healthIssues: HealthIssue[];
  architectureLayers: ArchitectureLayer[];
  hotspots: Hotspot[];
  changeVelocity: number;
  verificationScore: number;
  verificationRecommendations: string[];
  securityFindings: SecurityFinding[];
  buildStatus: BuildStatus;
  gitStatus: GitStatusSignal;
  recentCommits: RecentCommit[];
  technicalDebt: TechnicalDebtMarker[];
  openMissions: MissionSummary[];
  dependencySummary: DependencySummary;
}

/* ── Stage 4 — Mission Strategy Selection (deterministic registry) ─── */

export interface FocusArea {
  id: string;
  label: string;
  description: string;
}

export interface MissionStrategy {
  category: MissionCategory;
  guidance: string;
  focusAreas: FocusArea[];
}

/* ── Stage 5 — Goal Graph Generation ──────────────────────────────── */

export type GoalPriority = 'high' | 'medium' | 'low';

export interface MissionGoal {
  id: string;
  focusAreaId: string;
  title: string;
  rationale: string;
  relatedEvidence: string[];
  priority: GoalPriority;
}

/** How a task is actually carried out — distinct from `kind`, which is what it's FOR. */
export type AutomationLevel = 'automatic' | 'assisted' | 'manual';

/** What a task IS — drives Stage 6's execution routing (§ Execution Planning: never treat every task equally). */
export type TaskKind = 'file-operation' | 'manual-operation' | 'review' | 'approval' | 'documentation' | 'research';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskRisk = 'low' | 'medium' | 'high';
export type TaskMode = 'diff' | 'new-file';
export type TaskStatus = 'pending' | 'proposed' | 'accepted' | 'rejected' | 'done' | 'error';

export interface MissionTask {
  id: string;
  goalId: string;
  focusAreaId: string;
  title: string;
  description: string;
  kind: TaskKind;
  targetFile: string | null;
  /** Only meaningful once `targetFile` is set — resolved for real (existsSync) at run time, never trusted from planning time. */
  mode: TaskMode | null;
  priority: TaskPriority;
  /** Ids of other tasks in this same mission that should be resolved first. Advisory — not enforced as a hard block. */
  dependencies: string[];
  estimatedDurationMinutes: number;
  confidence: number;
  risk: TaskRisk;
  owner: 'ai' | 'human';
  automationLevel: AutomationLevel;
  status: TaskStatus;
}

export interface GoalGraph {
  goals: MissionGoal[];
  tasks: MissionTask[];
}

/* ── Stage 6 — Execution ──────────────────────────────────────────── */

export interface TaskProposal {
  explanation: string;
  newCode: string | null;
  error?: { type: string; message: string; retryable: boolean };
}

export interface MissionTaskRun {
  taskId: string;
  status: TaskStatus;
  proposal: TaskProposal | null;
  updatedAt: string;
}

/* ── Stage 7 — Risk Analysis (deterministic) ──────────────────────── */

export interface RiskAnalysis {
  architectureRisk: number;
  dependencyRisk: number;
  securityRisk: number;
  regressionRisk: number;
  complexity: number;
  confidence: number;
  unknowns: string[];
  overall: number;
}

/* ── Stage 8 — Mission Review ──────────────────────────────────────── */

export type ReviewFindingType = 'missing-goal' | 'unnecessary-work' | 'wrong-assumption' | 'over-planning' | 'duplicate-task' | 'weak-prioritization';

export interface MissionReviewFinding {
  type: ReviewFindingType;
  detail: string;
}

export interface MissionReviewVerdict {
  verdict: 'approved' | 'revise';
  findings: MissionReviewFinding[];
  summary: string;
  revisionApplied: boolean;
}

/* ── Stage 9 — Mission Quality Score (deterministic) ──────────────── */

export interface QualityScore {
  intentUnderstanding: number;
  architectureAwareness: number;
  knowledgeUsage: number;
  projectAwareness: number;
  taskQuality: number;
  safety: number;
  realism: number;
  overall: number;
}

/* ── Approval + the mission record ────────────────────────────────── */

export interface MissionApproval {
  status: 'pending' | 'approved' | 'rejected';
  at?: string;
}

export interface MissionRecord {
  id: string;
  projectId: string;
  text: string;
  createdAt: string;
  classification: IntentClassification | null;
  intent: ExtractedIntent | null;
  signals: MissionSignals;
  strategy: MissionStrategy | null;
  goalGraph: GoalGraph | null;
  risk: RiskAnalysis | null;
  review: MissionReviewVerdict | null;
  quality: QualityScore | null;
  approval: MissionApproval;
  taskRuns: MissionTaskRun[];
  /**
   * Mission Control v3 — the full execution domain (DAG, checkpoint
   * lifecycle, timeline, activity feed, replay frames, metrics).
   * Optional and additive: records created by v2 planning hydrate this
   * on first read. Absent only when planning never produced a plan.
   */
  execution?: MissionExecution;
  error?: string;
}

export interface MissionSummary {
  id: string;
  projectId: string;
  text: string;
  createdAt: string;
  category: MissionCategory;
  goalCount: number;
  taskCount: number;
  approval: MissionApproval;
  qualityOverall: number | null;
  /** v3 — mirrors the record's execution block for list views. */
  execution: MissionExecution | null;
}

/* ── SSE events for mission creation (planning only — never for task execution) ── */

export type MissionEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'done'; at: string }
  | { type: 'classification'; classification: IntentClassification }
  | { type: 'intent'; intent: ExtractedIntent }
  | { type: 'signals'; signals: MissionSignals }
  | { type: 'strategy'; strategy: MissionStrategy }
  | { type: 'goal-graph'; goalGraph: GoalGraph }
  | { type: 'risk'; risk: RiskAnalysis }
  | { type: 'review'; review: MissionReviewVerdict }
  | { type: 'quality'; quality: QualityScore }
  | { type: 'done'; mission: MissionRecord }
  | { type: 'error'; message: string };
