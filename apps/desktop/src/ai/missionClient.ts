/**
 * missionClient — fetch wrappers for Mission Control v2, matching
 * `diagnosisClient.ts`'s style and split out of `aiClient.ts` the same
 * way. `run` reuses the exact SSE reader loop already established in
 * `aiClient.runWorkflow`/`diagnosisClient.run` (buffered `\n`-split,
 * `data:`/`[DONE]` framing) — copied, not reinvented, so all three stay
 * in lockstep if the framing ever changes.
 */
import { aiClient, type ArchitectureLayer } from './aiClient';

const BASE = aiClient.base;

/* ── Stage 1 — Intent Classification ──────────────────────────────── */
export type MissionCategory =
  | 'feature-development' | 'architecture' | 'bug-resolution' | 'performance'
  | 'security' | 'documentation' | 'testing' | 'presentation' | 'deployment'
  | 'migration' | 'maintenance' | 'research' | 'release' | 'refactoring' | 'unknown';

export interface CategoryCandidate { category: MissionCategory; score: number; matchedSignals: string[] }
export interface IntentClassification { category: MissionCategory; confidence: number; candidates: CategoryCandidate[]; source: 'deterministic' | 'refined' }

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

/* ── Stage 3 — Project Analysis ───────────────────────────────────── */
export interface MissionHealthScore { overall: number; documentation: number; architecture: number; testing: number; dependencies: number; maintainability: number }
export interface MissionHealthIssue { severity: 'critical' | 'warning' | 'info'; category: string; message: string; file?: string }
export interface MissionHotspot { file: string; score: number; reason: string }
export interface SecurityFinding { pattern: string; file: string; line: number; snippet: string; severity: 'high' | 'medium' }
export type BuildStatus = { available: false; reason: string } | { available: true; ok: boolean; message: string };
export type GitStatusSignal = { available: false; reason: string } | { available: true; branch: string; dirty: boolean; changedFiles: number };
export interface RecentCommit { hash: string; date: string; subject: string }
export interface TechnicalDebtMarker { marker: 'TODO' | 'FIXME' | 'HACK' | 'XXX'; file: string; line: number; text: string }
export interface DependencySummary { total: number; pinnedExact: number; looseRange: number }

export interface MissionSignals {
  health: MissionHealthScore | null;
  healthIssues: MissionHealthIssue[];
  architectureLayers: ArchitectureLayer[];
  hotspots: MissionHotspot[];
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

/* ── Stage 4 — Mission Strategy Selection ─────────────────────────── */
export interface FocusArea { id: string; label: string; description: string }
export interface MissionStrategy { category: MissionCategory; guidance: string; focusAreas: FocusArea[] }

/* ── Stage 5 — Goal Graph Generation ──────────────────────────────── */
export type GoalPriority = 'high' | 'medium' | 'low';
export interface MissionGoal { id: string; focusAreaId: string; title: string; rationale: string; relatedEvidence: string[]; priority: GoalPriority }

export type AutomationLevel = 'automatic' | 'assisted' | 'manual';
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
  mode: TaskMode | null;
  priority: TaskPriority;
  dependencies: string[];
  estimatedDurationMinutes: number;
  confidence: number;
  risk: TaskRisk;
  owner: 'ai' | 'human';
  automationLevel: AutomationLevel;
  status: TaskStatus;
}

export interface GoalGraph { goals: MissionGoal[]; tasks: MissionTask[] }

/* ── Stage 6 — Execution ──────────────────────────────────────────── */
export interface TaskProposal { explanation: string; newCode: string | null; error?: { type: string; message: string; retryable: boolean } }
export interface MissionTaskRun { taskId: string; status: TaskStatus; proposal: TaskProposal | null; updatedAt: string }

/* ── Stage 7 — Risk Analysis ──────────────────────────────────────── */
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

/* ── Stage 8 — Mission Review ─────────────────────────────────────── */
export type ReviewFindingType = 'missing-goal' | 'unnecessary-work' | 'wrong-assumption' | 'over-planning' | 'duplicate-task' | 'weak-prioritization';
export interface MissionReviewFinding { type: ReviewFindingType; detail: string }
export interface MissionReviewVerdict { verdict: 'approved' | 'revise'; findings: MissionReviewFinding[]; summary: string; revisionApplied: boolean }

/* ── Stage 9 — Mission Quality Score ──────────────────────────────── */
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
export interface MissionApproval { status: 'pending' | 'approved' | 'rejected'; at?: string }

/* ── Mission Control v3 — execution domain ───────────────────────── */
export type ExecutionTaskStatus =
  | 'queued' | 'waiting' | 'blocked' | 'running' | 'paused' | 'review'
  | 'completed' | 'rejected' | 'cancelled' | 'retrying' | 'failed' | 'rollback';

export type CheckpointKey = 'planning' | 'execution' | 'review' | 'completion';
export type CheckpointStatus = 'not-started' | 'pending' | 'passed' | 'failed' | 'skipped';
export interface CheckpointState { key: CheckpointKey; label: string; status: CheckpointStatus; at?: string; note?: string }

export type ExecutionStatus = 'idle' | 'approved' | 'running' | 'paused' | 'reviewing' | 'completed' | 'cancelled' | 'failed';

export interface DagNode {
  id: string; title: string; kind: TaskKind; targetFile: string | null;
  priority: TaskPriority; risk: TaskRisk; owner: 'ai' | 'human';
  estimatedDurationMinutes: number; depth: number; batch: number;
  dependencies: string[]; blockedBy: string[]; status: ExecutionTaskStatus;
}
export interface DagEdge { from: string; to: string; kind: 'dependency' | 'block' }
export interface ExecutionDag {
  nodes: DagNode[]; edges: DagEdge[]; criticalPath: string[];
  criticalDurationMinutes: number; batches: string[][];
  hasCycle: boolean; cycle: string[];
}

export type TimelineType =
  | 'created' | 'approved' | 'rejected-plan' | 'execution-started' | 'execution-paused'
  | 'task-started' | 'task-proposed' | 'task-accepted' | 'task-rejected' | 'task-completed'
  | 'task-failed' | 'task-retried' | 'checkpoint' | 'review-passed' | 'completed' | 'cancelled' | 'note';
export type ActorKind = 'ai' | 'human' | 'system';
export interface TimelineEntry { id: string; at: string; type: TimelineType; actor: ActorKind; title: string; detail?: string; taskId?: string; checkpoint?: CheckpointKey }
export interface ActivityEntry { id: string; at: string; actor: ActorKind; kind: TimelineType; message: string; taskId?: string; checkpoint?: CheckpointKey }
export interface ReplayFrame {
  id: string; at: string; type: 'created' | 'approved' | 'state' | 'task' | 'checkpoint' | 'done';
  snapshot: {
    executionStatus: ExecutionStatus;
    taskStates: Record<string, ExecutionTaskStatus>;
    checkpointStates: Record<CheckpointKey, CheckpointStatus>;
    batchIndex: number; completedCount: number; totalTasks: number;
  };
}
export interface MissionMetrics {
  tasksTotal: number; tasksQueued: number; tasksWaiting: number; tasksBlocked: number;
  tasksRunning: number; tasksReview: number; tasksCompleted: number; tasksRejected: number;
  tasksFailed: number; tasksCancelled: number; completion: number;
  criticalPathLength: number; criticalPathDone: number; criticalPathTotal: number;
  parallelBatches: number; currentBatch: number; estimatedRemainingMinutes: number;
  elapsedMinutes: number; throughput: number;
}
export interface MissionExecution {
  status: ExecutionStatus;
  checkpoints: CheckpointState[];
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  replay: ReplayFrame[];
  dag: ExecutionDag | null;
  metrics: MissionMetrics | null;
  batchIndex: number;
  startedAt?: string;
  completedAt?: string;
  lastUpdatedAt: string;
}

export interface MissionRecord {
  id: string; projectId: string; text: string; createdAt: string;
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
  execution?: MissionExecution;
  error?: string;
}
export interface MissionSummary {
  id: string; projectId: string; text: string; createdAt: string;
  category: MissionCategory; goalCount: number; taskCount: number;
  approval: MissionApproval; qualityOverall: number | null;
  execution: MissionExecution | null;
}

export interface MissionTaskActionResult {
  ok: boolean;
  error?: string;
  /**
   * The task is parked at a Capability Fabric authorization gate: nothing
   * ran, and nothing failed. Distinct from `ok: false` so the UI offers
   * Approve rather than Retry. The request itself is read from
   * `fabricClient.approvals()`, which is authoritative.
   */
  awaitingApproval?: boolean;
  mission?: MissionRecord;
}

export type ExecutionEvent =
  | { type: 'execution'; record: { id: string; projectId: string; execution: MissionExecution } }
  | { type: 'error'; message: string };

export interface MissionReplayPayload {
  frames: ReplayFrame[];
  status: ExecutionStatus;
  metrics: MissionMetrics | null;
  checkpoints: CheckpointState[];
}

export interface MissionDashboard {
  totals: {
    projects: number; missions: number; planned: number; approved: number;
    active: number; reviewing: number; completed: number; cancelled: number; failed: number;
  };
  tasks: { total: number; completed: number; review: number; failed: number; blocked: number; running: number; completion: number };
  riskDistribution: { low: number; medium: number; high: number };
  byCategory: { category: MissionCategory; count: number }[];
  recent: MissionSummary[];
}

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

export const missionClient = {
  list: (projectId: string): Promise<{ missions: MissionSummary[] }> =>
    fetch(`${BASE}/projects/${projectId}/missions`).then(async (r) => {
      if (!r.ok) throw new Error(`Mission list failed (${r.status})`);
      return r.json();
    }),

  get: (projectId: string, mid: string): Promise<MissionRecord | { error: string }> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}`).then((r) => r.json()),

  approve: (projectId: string, mid: string): Promise<MissionRecord> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/approve`, { method: 'POST' }).then((r) => r.json()),

  reject: (projectId: string, mid: string, reason?: string): Promise<MissionRecord> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }).then((r) => r.json()),

  start: (projectId: string, mid: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/start`, { method: 'POST' }).then((r) => r.json()),

  pause: (projectId: string, mid: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/pause`, { method: 'POST' }).then((r) => r.json()),

  resume: (projectId: string, mid: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/resume`, { method: 'POST' }).then((r) => r.json()),

  cancel: (projectId: string, mid: string, reason?: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }).then((r) => r.json()),

  review: (projectId: string, mid: string, pass: boolean, note?: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pass, note }) }).then((r) => r.json()),

  replay: (projectId: string, mid: string): Promise<MissionReplayPayload | { error: string }> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/replay`).then((r) => r.json()),

  dashboard: (): Promise<MissionDashboard> =>
    fetch(`${BASE}/missions/dashboard`).then(async (r) => {
      if (!r.ok) throw new Error(`Mission dashboard failed (${r.status})`);
      return r.json();
    }),

  runTask: (projectId: string, mid: string, taskId: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/tasks/${taskId}/run`, { method: 'POST' }).then((r) => r.json()),

  acceptTask: (projectId: string, mid: string, taskId: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/tasks/${taskId}/accept`, { method: 'POST' }).then((r) => r.json()),

  rejectTask: (projectId: string, mid: string, taskId: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/tasks/${taskId}/reject`, { method: 'POST' }).then((r) => r.json()),

  completeManualTask: (projectId: string, mid: string, taskId: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/tasks/${taskId}/complete`, { method: 'POST' }).then((r) => r.json()),

  retryTask: (projectId: string, mid: string, taskId: string): Promise<MissionTaskActionResult> =>
    fetch(`${BASE}/projects/${projectId}/missions/${mid}/tasks/${taskId}/retry`, { method: 'POST' }).then((r) => r.json()),

  /** Stream the current ready wave (SSE) — emits ExecutionEvents as the engine advances. */
  async execute(projectId: string, mid: string, onEvent: (e: ExecutionEvent) => void, opts: { maxParallel?: number; signal?: AbortSignal } = {}): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/missions/${mid}/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxParallel: opts.maxParallel ?? 2 }),
        signal: opts.signal,
      });
    } catch (e) {
      onEvent({ type: 'error', message: (e as Error).message || 'Service unreachable' });
      return;
    }
    if (!res.body) { onEvent({ type: 'error', message: 'No stream body' }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') return;
          onEvent(JSON.parse(d) as ExecutionEvent);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onEvent({ type: 'error', message: (e as Error).message });
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },

  async create(projectId: string, text: string, onEvent: (e: MissionEvent) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/missions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal,
      });
    } catch (e) {
      onEvent({ type: 'error', message: (e as Error).message || 'Service unreachable' });
      return;
    }
    if (!res.body) { onEvent({ type: 'error', message: 'No stream body' }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') return;
          onEvent(JSON.parse(d) as MissionEvent);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onEvent({ type: 'error', message: (e as Error).message });
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },
};
