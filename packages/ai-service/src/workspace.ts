import { PipelineManager, type IndexStatus, type PipelineOptions } from './pipeline';
import { ProjectRegistry, slug, type ProjectRecord } from './projects';
import { getOrBuildProfile, loadProfile, type ProjectProfile } from './profile';
import { extractArchitectureLayers, layersFromFullstack, type LayerStack } from './architectureExtractor';
import { graphifyJsonPath } from './graphify';
import { ProjectMemory, type MemoryItem, type MemoryKind } from './memory';
import { engineeringMemory, decisionMemory, missionMemory, type BaseMemoryRecord, type DecisionAlternative } from '@aura/engineering-memory';
import { ProjectConversations, type Conversation, type ConversationSummary } from './conversations';
import { buildKnowledgeGraph, type KnowledgeGraph } from './knowledgeGraph';
import { runProjectIntelligence, runWorkspaceIntelligence, type ProjectIntelligenceReport, type WorkspaceIntelligenceReport } from './intelligence';
import { loadChangeLog, analyzeChangePatterns, getChangeVelocity, detectHotspots, type ChangeEntry, type ChangePattern } from './intelligence/changeIntelligence';
import { WorkflowStore } from './workflow/store';
import { createAutomationRuntime, automationEvent, type AutomationRuntime, type AutomationEvent } from './automation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagnosisStore } from './diagnosis/store';
import { runDiagnosis } from './diagnosis/orchestrator';
import { splicePatch } from './diagnosis/patchLimiter';
import { resolveInsideProject } from './diagnosis/repoScan';
import type { DiagnosisEvent, DiagnosisRecord, DiagnosisRequest, DiagnosisSummary, PatchCandidate } from './diagnosis/types';
import { MissionStore } from './mission/store';
import { runMissionCreation } from './mission/orchestrator';
import { generateTaskProposal } from './mission/taskGen';
import { planTaskInvocation, type CapabilityFabric } from '@aura/capability-fabric';
import { MissionExecutionEngine } from './mission/execution/engine';
import type { RunReadyOptions, RunTaskResult } from './mission/execution/engine';
import type { ExecutionEvent } from './mission/execution/types';
import type { MissionEvent, MissionRecord, MissionSummary, MissionTask } from './mission/types';
import { getAdapter, getAllAdapters, ENV_VAR_BY_PROVIDER } from './provider/registry';
import { storeKey, removeKey, getKey, getActive, getAllProviderStores, storeModels, storeHealth } from './provider/credentialStore';
import { detectProvider } from './provider/detector';
import type { DiscoveredModel } from './provider/types';

export interface OpenResult {
  project: ProjectRecord;
  profile: ProjectProfile;
  status: IndexStatus;
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
}

export interface ConnectedProvider {
  id: string;
  name: string;
  fingerprint: string;
  models: { id: string; name: string }[];
  health: { ok: boolean; latencyMs: number; error?: string; lastChecked: string } | null;
  active: boolean;
}

export class WorkspaceManager {
  readonly pipeline: PipelineManager;
  readonly registry = new ProjectRegistry();

  constructor(opts: PipelineOptions = {}) {
    this.pipeline = new PipelineManager(opts);
    this.initAutomation();
  }

  /* ── projects ───────────────────────────────────────────────────── */

  listProjects(): ProjectRecord[] {
    return this.registry.list();
  }

  addProject(input: { name?: string; path: string; icon?: string }): { project: ProjectRecord; profile: ProjectProfile } {
    const record = this.registry.add(input);
    const profile = getOrBuildProfile(record.id, record.path, true);
    const project = this.registry.update(record.id, {
      type: profile.type,
      language: profile.primaryLanguage,
      icon: input.icon ?? record.icon,
    });
    return { project, profile };
  }

  /**
   * Create a brand-new project folder on disk (as opposed to `addProject`,
   * which only ever imports a folder that already exists). Scaffolds a
   * minimal real directory, then hands off to the exact same
   * `registry.add()` + profiling path `addProject` uses — a new project is
   * never a separate concept from an added one, just a folder that didn't
   * exist a moment ago.
   */
  createProject(input: { name: string; parentPath?: string }): { project: ProjectRecord; profile: ProjectProfile } {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error('Project name is required');
    if (/[/\\]|^\.\.?$/.test(name)) throw new Error('Project name cannot contain path separators');

    const parent = input.parentPath?.trim() || path.join(os.homedir(), 'AuraProjects');
    const dirName = slug(name);
    const target = path.resolve(parent, dirName);

    if (fs.existsSync(target)) throw new Error(`A folder already exists at ${target}`);

    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'README.md'), `# ${name}\n`);

    return this.addProject({ name, path: target });
  }

  renameProject(id: string, name: string): ProjectRecord {
    return this.registry.update(id, { name });
  }

  setFavorite(id: string, favorite: boolean): ProjectRecord {
    return this.registry.update(id, { favorite });
  }

  removeProject(id: string): boolean {
    if (this.pipeline.currentProjectId === id) this.pipeline.unmount();
    return this.registry.remove(id);
  }

  open(id: string): OpenResult {
    const project = this.registry.get(id);
    if (!project) throw new Error(`no such project: ${id}`);
    this.registry.touch(id);
    const profile = getOrBuildProfile(project.id, project.path);
    this.pipeline.mount({ id: project.id, path: project.path, name: project.name });
    return { project, profile, status: this.pipeline.indexStatus() };
  }

  currentProject(): ProjectRecord | null {
    const id = this.pipeline.currentProjectId;
    return id ? this.registry.get(id) ?? null : null;
  }

  profile(id: string): ProjectProfile | null {
    return loadProfile(id);
  }

  indexStatus(): IndexStatus {
    return this.pipeline.indexStatus();
  }

  async whenIndexed(): Promise<IndexStatus> {
    return this.pipeline.whenIndexed();
  }

  /* ── memory ─────────────────────────────────────────────────────── */

  memoryOf(id: string): ProjectMemory {
    return new ProjectMemory(id);
  }

  listMemory(id: string): MemoryItem[] {
    return this.memoryOf(id).list();
  }

  addMemory(id: string, input: { kind: MemoryKind; title: string; body: string; pinned?: boolean }): MemoryItem {
    if (this.pipeline.currentProjectId === id && this.pipeline.memory) return this.pipeline.memory.add(input);
    return this.memoryOf(id).add(input);
  }

  pinMemory(id: string, memId: string, pinned: boolean): MemoryItem | undefined {
    const store = this.pipeline.currentProjectId === id && this.pipeline.memory ? this.pipeline.memory : this.memoryOf(id);
    return store.setPinned(memId, pinned);
  }

  removeMemory(id: string, memId: string): boolean {
    const store = this.pipeline.currentProjectId === id && this.pipeline.memory ? this.pipeline.memory : this.memoryOf(id);
    return store.remove(memId);
  }

  /* ── Engineering Memory ──────────────────────────────────────────── */

  listEngineeringMemory(id: string): BaseMemoryRecord[] {
    return engineeringMemory.queryProject(id);
  }

  addEngineeringMemory(record: Omit<BaseMemoryRecord, 'id' | 'timestamp'>): BaseMemoryRecord {
    return engineeringMemory.create(record);
  }

  private recordDiagnosisMemory(projectId: string, diagnosis: DiagnosisRecord, eventType: 'created' | 'accepted' | 'rejected', candidateId?: 'A' | 'B' | 'C', reason?: string): void {
    engineeringMemory.create({
      projectId,
      category: eventType === 'created' ? 'diagnosis-created' : eventType === 'accepted' ? 'diagnosis-accepted' : 'diagnosis-rejected',
      relatedDiagnosisId: diagnosis.id,
      relatedFiles: [diagnosis.filePath],
      relatedSymbols: diagnosis.signals.symbol?.name ? [diagnosis.signals.symbol.name] : [],
      importance: eventType === 'accepted' ? 'high' : 'medium',
      confidence: 'high',
      tags: ['diagnosis', diagnosis.classification.category],
      summary: `Diagnosis ${eventType}: ${diagnosis.filePath} (${diagnosis.classification.category})`,
      detailedRecord: candidateId
        ? `Candidate ${candidateId} selected${reason ? ` — ${reason}` : ''}`
        : `Category: ${diagnosis.classification.category}`,
      references: [],
    });
  }

  private recordPatchMemory(projectId: string, diagnosis: DiagnosisRecord, candidate: PatchCandidate, eventType: 'accepted' | 'rejected', reason?: string): void {
    engineeringMemory.create({
      projectId,
      category: eventType === 'accepted' ? 'patch-accepted' : 'patch-rejected',
      relatedDiagnosisId: diagnosis.id,
      relatedFiles: [diagnosis.filePath],
      relatedSymbols: diagnosis.signals.symbol?.name ? [diagnosis.signals.symbol.name] : [],
      importance: eventType === 'accepted' ? 'high' : 'medium',
      confidence: 'high',
      tags: ['patch', candidate.strategy],
      summary: `Patch ${eventType}: ${diagnosis.filePath} (${candidate.strategy})`,
      detailedRecord: `${candidate.summary}${reason ? ` — ${reason}` : ''}`,
      references: [],
    });
  }

  private recordDecisionMemory(projectId: string, opts: {
    problem: string;
    decision: 'approve' | 'reject' | 'accept';
    rationale?: string;
    relatedMissionId?: string;
    relatedDiagnosisId?: string;
    affectedComponents?: string[];
  }): void {
    const chosen: DecisionAlternative = {
      id: 'chosen',
      name: opts.decision,
      description: opts.problem,
      pros: [],
      cons: [],
      complexity: 'low',
      risk: 'low',
    };
    const rejectedSolutions: DecisionAlternative[] = opts.decision === 'reject'
      ? [{ id: 'rejected', name: 'reject', description: opts.problem, pros: [], cons: [], complexity: 'low', risk: 'high' }]
      : [];
    decisionMemory.createDecision(projectId, {
      problem: opts.problem,
      alternatives: [chosen, ...rejectedSolutions],
      chosenSolution: chosen,
      rejectedSolutions,
      reasoning: opts.rationale ?? opts.problem,
      tradeoffs: [],
      expectedOutcome: opts.decision,
      affectedComponents: opts.affectedComponents ?? [],
      relatedMissionId: opts.relatedMissionId,
      relatedDiagnosisId: opts.relatedDiagnosisId,
      tags: ['decision', opts.decision],
      confidence: 'high',
      importance: 'high',
    });
  }

  private recordMissionMemory(projectId: string, mission: MissionRecord, eventType: 'created' | 'approved' | 'rejected' | 'completed' | 'failed', _taskId?: string): void {
    const goalCount = mission.goalGraph?.goals.length ?? 0;
    const relatedFiles = mission.goalGraph?.tasks.filter((t) => t.targetFile).map((t) => t.targetFile as string) ?? [];
    const missionTags = ['mission', mission.classification?.category ?? 'unknown'];

    if (eventType === 'created') {
      engineeringMemory.createMissionCreated(projectId, {
        missionId: mission.id,
        intent: mission.text,
        relatedFiles,
        tags: missionTags,
        summary: `Mission created: ${mission.text.slice(0, 80)}`,
        detailedRecord: `${mission.text}\nGoals: ${goalCount}, Tasks: ${mission.goalGraph?.tasks.length ?? 0}`,
      });
      missionMemory.createMission(projectId, {
        intent: mission.text,
        outcome: 'pending',
        durationMinutes: 0,
        tags: missionTags,
      });
    } else if (eventType === 'completed' || eventType === 'failed') {
      engineeringMemory.createMissionCompleted(projectId, {
        missionId: mission.id,
        outcome: eventType === 'completed' ? 'success' : 'failure',
        durationMinutes: 0,
        goalsCompleted: eventType === 'completed' ? goalCount : 0,
        goalsTotal: goalCount,
        relatedFiles,
        tags: missionTags,
        importance: eventType === 'failed' ? 'high' : 'medium',
      });
    } else if (eventType === 'approved' || eventType === 'rejected') {
      this.recordDecisionMemory(projectId, {
        problem: `Mission plan ${eventType === 'approved' ? 'approved' : 'rejected'}: ${mission.text.slice(0, 80)}`,
        decision: eventType === 'approved' ? 'approve' : 'reject',
        rationale: eventType === 'approved' ? 'Mission plan approved for execution' : 'Mission plan rejected',
        relatedMissionId: mission.id,
        affectedComponents: relatedFiles,
      });
    }
  }

  /* ── conversations ──────────────────────────────────────────────── */

  conversationsOf(id: string): ProjectConversations {
    return new ProjectConversations(id);
  }
  listConversations(id: string): ConversationSummary[] {
    return this.conversationsOf(id).list();
  }
  getConversation(id: string, cid: string): Conversation | undefined {
    return this.conversationsOf(id).get(cid);
  }
  createConversation(id: string, title?: string): Conversation {
    return this.conversationsOf(id).create(title);
  }
  renameConversation(id: string, cid: string, title: string): Conversation | undefined {
    return this.conversationsOf(id).rename(cid, title);
  }
  removeConversation(id: string, cid: string): boolean {
    return this.conversationsOf(id).remove(cid);
  }
  appendMessage(id: string, cid: string, msg: { role: 'user' | 'assistant'; content: string; meta?: unknown; error?: boolean }) {
    return this.conversationsOf(id).append(cid, msg);
  }
  removeLastAssistantMessage(id: string, cid: string): boolean {
    return this.conversationsOf(id).removeLastAssistant(cid);
  }
  conversationHistory(id: string, cid: string) {
    return this.conversationsOf(id).history(cid);
  }

  /* ── knowledge graph ────────────────────────────────────────────── */

  knowledgeGraph(id: string): KnowledgeGraph | null {
    if (this.pipeline.currentProjectId !== id || !this.pipeline.fullstack || !this.pipeline.memory) return null;
    return buildKnowledgeGraph(this.pipeline.fullstack, this.pipeline.memory, this.conversationsOf(id));
  }

  /* ── repository intelligence (verification / architecture / personality
   *    / validation / change / versioning / agent APIs / performance) ── */

  projectIntelligence(id: string): ProjectIntelligenceReport | null {
    const project = this.registry.get(id);
    if (!project) return null;
    return runProjectIntelligence(id, project.path);
  }

  /** Real architecture layers (+ the real inter-layer dependency edges the extractor computes alongside them) — prefers the rich graphify graph, falls back to the FullStack graph for the mounted project. */
  resolveArchitectureLayers(id: string): LayerStack {
    const name = this.registry.get(id)?.name;
    const jp = graphifyJsonPath(id);
    let stack = jp ? extractArchitectureLayers(jp, name) : { layers: [], edges: [] };
    if (stack.layers.length <= 1 && this.pipeline.currentProjectId === id) {
      const g = this.pipeline.graphView() as { entities?: { id: string; name: string; relPath: string }[]; relations?: { from: string; to: string }[] };
      if (g.entities?.length) stack = layersFromFullstack(g.entities, g.relations ?? [], name);
    }
    return stack;
  }

  /**
   * The Engineering Twin's change-intelligence log (file-level history,
   * detected patterns, velocity, hotspots) — see intelligence/changeIntelligence.ts.
   * `projectIntelligence()`'s `.change` field already reads this same log for
   * its summary numbers; this returns the full entry list the Twin's
   * timeline/heat-map/risk-map views need. The log itself is currently a
   * single workspace-wide file (not scoped per project) and nothing yet
   * calls `recordChange()` to populate it, so this legitimately returns an
   * empty log today — that's a data-population gap, not a reason to hide
   * the endpoint.
   */
  changeLog(id: string): { entries: ChangeEntry[]; patterns: ChangePattern[]; velocity: number; hotspots: { file: string; score: number; reason: string }[] } | null {
    if (!this.registry.get(id)) return null;
    const log = loadChangeLog();
    if (!log) return { entries: [], patterns: [], velocity: 0, hotspots: [] };
    return {
      entries: log.entries.map((e) => ({ ...e, linesAdded: e.linesAdded ?? 0, linesRemoved: e.linesRemoved ?? 0 })),
      patterns: analyzeChangePatterns(log),
      velocity: getChangeVelocity(log),
      hotspots: detectHotspots(log),
    };
  }

  /** Workspace-level intelligence across every registered project
   *  (workspace graph + cross-repository analysis). */
  workspaceIntelligence(): WorkspaceIntelligenceReport {
    return runWorkspaceIntelligence(this.registry.list().map((p) => ({ id: p.id, root: p.path })));
  }

  /* ── workflows ──────────────────────────────────────────────────── */

  readonly workflows = new WorkflowStore();

  /* ── Automation Engine ─────────────────────────────────────────────
   * Event-driven workflows: rules react to REAL platform moments by
   * running real actions (diagnosis, governance audits, knowledge
   * update, engineering memory). Created per-manager so the emitted
   * events can be streamed to the UI. */

  automation!: AutomationRuntime;

  /** Push a real platform event into the Automation Engine. */
  pushAutomationEvent(event: AutomationEvent): void {
    this.automation.engine.handleEvent(event);
  }

  private initAutomation(): void {
    this.automation = createAutomationRuntime({
      projectPath: (projectId) => {
        const p = this.registry.get(projectId);
        if (!p) throw new Error(`no such project: ${projectId}`);
        return p.path;
      },
      pipelineFor: () => this.pipeline,
      memoryFor: (projectId) => this.memoryOf(projectId),
      diagnoses: this.diagnoses,
    });
  }

  /* ── Engineering Diagnosis Engine ──────────────────────────────────
   * Only `acceptDiagnosis` ever touches the filesystem — running a
   * diagnosis only computes and stores candidates. */

  readonly diagnoses = new DiagnosisStore();

  async runDiagnosis(id: string, req: Omit<DiagnosisRequest, 'projectId'>, emit: (e: DiagnosisEvent) => void, signal?: AbortSignal): Promise<DiagnosisRecord> {
    const project = this.registry.get(id);
    if (!project) throw new Error(`no such project: ${id}`);
    await this.pipeline.whenIndexed();
    const memory = this.pipeline.currentProjectId === id ? this.pipeline.memory : this.memoryOf(id);
    const result = await runDiagnosis(this.pipeline, memory, this.diagnoses, project.path, { ...req, projectId: id }, emit, signal);

    this.recordDiagnosisMemory(id, result, 'created');

    // Real platform moment → Automation Engine (diagnosis-completed).
    this.automation.engine.handleEvent(automationEvent('diagnosis-completed', id, project.path, {
      diagnosisId: result.id,
      filePath: result.filePath,
      category: result.classification.category,
      decision: result.decision.status,
    }));

    return result;
  }

  listDiagnoses(id: string): DiagnosisSummary[] {
    return this.diagnoses.list(id);
  }

  getDiagnosis(id: string, did: string): DiagnosisRecord | null {
    return this.diagnoses.get(id, did);
  }

  /** The only place a diagnosis patch is ever written to disk — requires an explicit human Accept. */
  acceptDiagnosis(id: string, did: string, candidateId: 'A' | 'B' | 'C'): { ok: boolean; error?: string } {
    const diagnosis = this.diagnoses.get(id, did);
    if (!diagnosis) return { ok: false, error: 'no such diagnosis' };
    const candidate = diagnosis.candidates.find((c) => c.id === candidateId);
    if (!candidate) return { ok: false, error: 'no such candidate' };
    if (candidate.limiter.decision === 'auto-rejected') {
      return { ok: false, error: `Candidate ${candidateId} was auto-rejected by the Patch Limiter (${candidate.limiter.reasons.join('; ')}) and cannot be accepted.` };
    }
    const project = this.registry.get(id);
    if (!project) return { ok: false, error: 'no such project' };

    let abs: string;
    try {
      abs = resolveInsideProject(project.path, diagnosis.filePath);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const original = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, splicePatch(original, candidate.targetRange, candidate.newText));

    this.diagnoses.patch(id, did, { decision: { status: 'accepted', candidateId, at: new Date().toISOString() } });
    if (this.pipeline.currentProjectId === id) void this.pipeline.reindex();
    const memory = this.pipeline.currentProjectId === id ? this.pipeline.memory : this.memoryOf(id);
    memory?.add({ kind: 'accepted', title: `Diagnosis accepted: ${diagnosis.filePath}`, body: `Candidate ${candidateId} (${candidate.strategy}): ${candidate.summary}` });

    // Real platform moment → Automation Engine (diagnosis-accepted).
    this.automation.engine.handleEvent(automationEvent('diagnosis-accepted', id, project.path, {
      diagnosisId: diagnosis.id,
      filePath: diagnosis.filePath,
      category: diagnosis.classification.category,
      candidateId,
      strategy: candidate.strategy,
    }));

    this.recordDiagnosisMemory(id, diagnosis, 'accepted', candidateId);
    this.recordPatchMemory(id, diagnosis, candidate, 'accepted');
    this.recordDecisionMemory(id, {
      problem: `Diagnosis accepted: ${diagnosis.filePath}`,
      decision: 'accept',
      rationale: `Accepted candidate ${candidateId} (${candidate.strategy}) for ${diagnosis.signals.file.relPath}. ${candidate.summary}`,
      relatedDiagnosisId: diagnosis.id,
      affectedComponents: [diagnosis.filePath],
    });
    return { ok: true };
  }

  rejectDiagnosis(id: string, did: string, candidateId?: 'A' | 'B' | 'C', reason?: string): { ok: boolean; error?: string } {
    const diagnosis = this.diagnoses.get(id, did);
    if (!diagnosis) return { ok: false, error: 'no such diagnosis' };
    this.diagnoses.patch(id, did, { decision: { status: 'rejected', candidateId, reason, at: new Date().toISOString() } });
    const memory = this.pipeline.currentProjectId === id ? this.pipeline.memory : this.memoryOf(id);
    memory?.add({ kind: 'rejected', title: `Diagnosis rejected: ${diagnosis.filePath}`, body: reason ?? 'No reason given' });

    this.recordDiagnosisMemory(id, diagnosis, 'rejected', candidateId, reason);
    if (candidateId) {
      const candidate = diagnosis.candidates.find((c) => c.id === candidateId);
      if (candidate) this.recordPatchMemory(id, diagnosis, candidate, 'rejected', reason);
    }
    this.recordDecisionMemory(id, {
      problem: `Diagnosis rejected: ${diagnosis.filePath}`,
      decision: 'reject',
      rationale: `Rejected ${candidateId ? `candidate ${candidateId}` : 'diagnosis'} for ${diagnosis.signals.file.relPath}. ${reason ?? 'No reason given'}`,
      relatedDiagnosisId: diagnosis.id,
      affectedComponents: [diagnosis.filePath],
    });
    return { ok: true };
  }

  /* ── Mission Control v2 ──────────────────────────────────────────────
   * A mission is built through a 9-stage pipeline (see `mission/orchestrator.ts`):
   * deterministic intent classification → combined LLM classification-
   * refinement + intent extraction → deterministic project-signal
   * gathering → deterministic strategy-scaffold selection → one LLM
   * Goal Graph call → deterministic risk analysis → one adversarial LLM
   * mission review (bounded to at most one revision pass) → deterministic
   * quality scoring. Execution remains human-gated exactly as in v1: the
   * whole plan must be explicitly approved before any task can run, and
   * each task's AI-generated proposal must be explicitly accepted before
   * it is ever written to disk. No unattended execution.
   *
   * ── Mission Control v3 ──────────────────────────────────────────────
   * The `MissionExecutionEngine` (see `mission/execution/`) turns the
   * approved plan into an execution DAG (dependencies/blocks/critical
   * path/parallel batches/auto-ordering) and drives the runtime state
   * machine. It consumes ONLY already-computed plan fields and never
   * touches the filesystem — proposal generation (`generateTaskProposal`)
   * and the accept-write are injected here, keeping both human gates. */

  readonly missions = new MissionStore();

  /**
   * The Capability Fabric, attached after construction because
   * `createFabric()` needs this manager — the cycle is broken by wiring
   * rather than by giving the manager a second execution path. Missions
   * fall back to the proposal path when it is absent, so the service is
   * never left unable to run a task.
   */
  private fabric: CapabilityFabric | null = null;

  attachFabric(fabric: CapabilityFabric): void {
    this.fabric = fabric;
  }

  /**
   * Route one mission task through the Fabric.
   *
   * This is the whole mission→Fabric integration. It runs *inside* the
   * engine's own `runTask` hook, which means ordering, the DAG, the state
   * machine, the timeline, metrics and replay all remain exactly where
   * they were — this only decides what a single task's execution *is*, and
   * translates one `InvocationResult` into one existing `TaskStatus`.
   *
   * Returns null when the task is not Fabric-executable, so the caller
   * falls through to the untouched proposal path.
   */
  private async runTaskThroughFabric(
    id: string,
    record: MissionRecord,
    task: MissionTask,
    approvedCapabilities?: string[],
  ): Promise<RunTaskResult | null> {
    const fabric = this.fabric;
    if (!fabric) return null;
    const plan = planTaskInvocation(task, id);
    if (plan.kind === 'unbound') return null;

    const project = this.registry.get(id);
    const result = await fabric.invoke(plan.capabilityId, plan.input, {
      actor: { kind: 'agent', id: `mission:${record.id}` },
      projectId: id,
      cwd: project?.path,
      // Correlation keys into the authoritative MissionRecord. The Fabric
      // stores no mission state of its own; these are what let its audit
      // trail and this task's timeline be reconciled afterwards.
      missionId: record.id,
      taskId: task.id,
      approvedCapabilities,
    });

    // The node that did the work, as the executor itself reported it.
    // Read only from the executor's output — never inferred from the
    // capability, which several nodes can provide.
    const reported = (result.output as { nodeId?: unknown } | undefined)?.nodeId;
    const nodeId = typeof reported === 'string' && reported ? reported : undefined;

    const attempted = result.attempts > 1 ? ` after ${result.attempts} attempts` : '';
    const verified = result.verification.passed === true ? ' Verified.'
      : result.verification.passed === null ? ` Not independently verifiable (${result.verification.detail}).`
      : '';

    switch (result.outcome) {
      case 'succeeded':
        return { ok: true, status: 'done', detail: `${result.detail}${verified}${attempted}`, nodeId };

      // Ran but could not be shown to have done what it claimed. Treated as
      // a failure on purpose — an unverified effect the operator believes
      // succeeded is worse than one they know to re-check.
      case 'unverified':
        return { ok: false, status: 'error', detail: result.detail, nodeId };

      case 'awaiting-approval':
        // `pending` keeps the task queued and still runnable, so granting
        // approval resumes THIS task rather than starting a new one.
        return { ok: false, pending: true, status: 'pending', detail: result.detail };

      case 'denied':
        return { ok: false, status: 'rejected', detail: `${result.detail} (policy: ${result.policy.rule})` };

      case 'unsupported':
        return { ok: false, status: 'error', detail: result.detail };

      case 'failed':
        // A failed run is still attributable — the operator needs to know
        // WHICH node failed, not merely that something did.
        return { ok: false, status: 'error', detail: `${result.detail}${attempted}`, nodeId };
    }
  }

  private missionEngine(
    id: string,
    signal?: AbortSignal,
    emit?: (e: ExecutionEvent) => void,
    approvedCapabilities?: string[],
  ): MissionExecutionEngine {
    return new MissionExecutionEngine({
      runTask: async ({ record, task }) => {
        const project = this.registry.get(id);
        const goal = record.goalGraph?.goals.find((g) => g.id === task.goalId);
        if (!project || !goal) return { ok: false, error: 'invalid mission state' };

        // Fabric first: a task it can execute is executed under policy,
        // approval, verification, recovery and audit. Nothing bypasses it
        // for convenience — the proposal path below is reached only for
        // tasks the Fabric genuinely cannot express as a call.
        const viaFabric = await this.runTaskThroughFabric(id, record, task, approvedCapabilities);
        if (viaFabric) return viaFabric;

        if (task.kind !== 'file-operation' || !task.targetFile) {
          // The planner's own words for why this is not a capability call —
          // a specific next step instead of a generic refusal.
          const plan = planTaskInvocation(task, id);
          return { ok: false, error: plan.kind === 'unbound' ? plan.reason : 'This task has no single target file — complete it manually instead of running it.' };
        }
        const result = await generateTaskProposal(this.pipeline, project.path, task, goal, record.text, signal);
        return {
          ok: result.ok,
          error: result.ok ? undefined : result.proposal.error?.message,
          proposal: result.proposal,
          mode: result.isNewFile ? 'new-file' : 'diff',
        };
      },
      persist: (rec) => { this.missions.save(id, rec); },
      emit,
    });
  }

  async runMissionCreation(id: string, text: string, emit: (e: MissionEvent) => void, signal?: AbortSignal): Promise<MissionRecord> {
    const project = this.registry.get(id);
    if (!project) throw new Error(`no such project: ${id}`);
    await this.pipeline.whenIndexed();
    const result = await runMissionCreation(this, this.missions, id, project.path, text, emit, signal);

    this.recordMissionMemory(id, result, 'created');

    return result;
  }

  listMissions(id: string): MissionSummary[] {
    return this.missions.list(id);
  }

  getMission(id: string, mid: string): MissionRecord | null {
    return this.missions.get(id, mid);
  }

  approveMission(id: string, mid: string): MissionRecord | null {
    const mission = this.missions.get(id, mid);
    if (!mission) return null;
    const result = this.missionEngine(id).approve(mission);
    if (result) {
      this.recordMissionMemory(id, result, 'approved');
    }
    return result;
  }

  rejectMission(id: string, mid: string, reason?: string): MissionRecord | null {
    const mission = this.missions.get(id, mid);
    if (!mission) return null;
    const result = this.missionEngine(id).rejectPlan(mission, reason);
    if (result) {
      this.recordMissionMemory(id, result, 'rejected');
    }
    return result;
  }

  /**
   * v2-compatible single-task run — now engine-backed (auto-starts execution when approved).
   *
   * `approvedCapabilities` is the operator's per-call authorization, passed
   * straight through to the Fabric. Re-running the same `taskId` with a
   * grant is how an approval-gated task resumes: the task never left the
   * queue, so this continues it rather than starting anything new.
   */
  async runMissionTask(id: string, mid: string, taskId: string, signal?: AbortSignal, approvedCapabilities?: string[]): Promise<{ ok: boolean; error?: string; awaitingApproval?: boolean; mission?: MissionRecord }> {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    if (mission.approval.status !== 'approved') return { ok: false, error: 'This mission plan has not been approved yet — approve it before running any task.' };
    const engine = this.missionEngine(id, signal, undefined, approvedCapabilities);
    if (!mission.execution || mission.execution.status === 'approved') engine.startExecution(mission);
    const result = await engine.runTask(mission, taskId);
    if (result.record && result.ok) {
      this.recordMissionMemory(id, result.record, 'created', taskId);
    }
    // `awaitingApproval` distinguishes "parked at a gate, nothing ran" from
    // "failed" — the desktop needs that to offer Approve rather than Retry.
    return { ok: result.ok, error: result.error, awaitingApproval: result.awaitingApproval, mission: result.record };
  }

  /**
   * The only place a mission task's proposal is ever written to disk —
   * requires an explicit human Accept.
   *
   * The write itself goes through the Capability Fabric's
   * `filesystem.write`, not a direct `fs` call. That is what subjects the
   * single most consequential action in the mission system to policy, to
   * read-back verification, to bounded recovery and to the audit trail.
   *
   * The operator's Accept **is** the authorization, so it is passed as the
   * per-invocation grant. That is not a bypass: policy still evaluates,
   * the hard floors still apply, the path is still resolved inside the
   * project by the executor, and the write is still verified afterwards.
   * Without the grant the Fabric parks the write at `awaiting-approval`
   * and nothing reaches disk.
   */
  async acceptMissionTask(id: string, mid: string, taskId: string, approvedCapabilities: string[] = ['filesystem.write']): Promise<{ ok: boolean; error?: string; mission?: MissionRecord }> {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    const task = mission.goalGraph?.tasks.find((t) => t.id === taskId);
    const run = mission.taskRuns.find((r) => r.taskId === taskId);
    if (!task || !run || run.status !== 'proposed' || !run.proposal?.newCode) return { ok: false, error: 'no pending proposal for this task' };
    const project = this.registry.get(id);
    if (!project) return { ok: false, error: 'no such project' };

    if (this.fabric) {
      const result = await this.fabric.invoke(
        'filesystem.write',
        { path: task.targetFile as string, content: run.proposal.newCode },
        {
          actor: { kind: 'human', id: 'user' },
          projectId: id,
          cwd: project.path,
          missionId: mission.id,
          taskId,
          approvedCapabilities,
        },
      );
      if (result.outcome !== 'succeeded') {
        // Nothing was written, or it was written and failed its read-back.
        // Either way the task must not be marked accepted. `result.detail`
        // already carries the verification reason — appending it again
        // would print the same sentence twice to the operator.
        return { ok: false, error: result.detail, mission };
      }
    } else {
      // No Fabric attached (library use without a host) — the original
      // direct write, kept so the manager is never left unable to accept.
      let abs: string;
      try {
        abs = resolveInsideProject(project.path, task.targetFile as string);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      fs.writeFileSync(abs, run.proposal.newCode);
    }

    const updated = this.missionEngine(id).acceptTask(mission, taskId);
    if (this.pipeline.currentProjectId === id) void this.pipeline.reindex();
    const memory = this.pipeline.currentProjectId === id ? this.pipeline.memory : this.memoryOf(id);
    memory?.add({ kind: 'accepted', title: `Mission task accepted: ${task.title}`, body: run.proposal.explanation });

    // Real platform moment → Automation Engine (mission-accepted).
    this.automation.engine.handleEvent(automationEvent('mission-accepted', id, project.path, {
      missionId: mission.id,
      taskId,
      taskTitle: task.title,
      targetFile: task.targetFile,
      mission: { text: mission.text },
      task: { title: task.title },
    }));

    if (updated) {
      this.recordMissionMemory(id, updated, 'completed', taskId);
      this.recordDecisionMemory(id, {
        problem: `Mission task accepted: ${task.title}`,
        decision: 'accept',
        rationale: run.proposal.explanation,
        relatedMissionId: mission.id,
        affectedComponents: task.targetFile ? [task.targetFile] : [],
      });
    }
    return { ok: true, mission: updated };
  }

  rejectMissionTask(id: string, mid: string, taskId: string, reason?: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    const task = mission.goalGraph?.tasks.find((t) => t.id === taskId);
    const updated = this.missionEngine(id).rejectTask(mission, taskId, reason);
    if (updated && task) {
      this.recordMissionMemory(id, updated, 'failed', taskId);
      this.recordDecisionMemory(id, {
        problem: `Mission task rejected: ${task.title}`,
        decision: 'reject',
        rationale: reason ?? `Task ${taskId} rejected`,
        relatedMissionId: mission.id,
        affectedComponents: task.targetFile ? [task.targetFile] : [],
      });
    }
    return { ok: true, mission: updated };
  }

  /** Manual/review/approval/documentation/research tasks (no single target file) are resolved by the human directly — no AI call, no file write. */
  completeManualTask(id: string, mid: string, taskId: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    const task = mission?.goalGraph?.tasks.find((t) => t.id === taskId);
    if (!mission || !task) return { ok: false, error: 'no such task' };
    if (task.kind === 'file-operation') return { ok: false, error: 'this task has a target file — run it instead of completing it manually' };
    const updated = this.missionEngine(id).completeManualTask(mission, taskId);
    if (updated) {
      this.recordMissionMemory(id, updated, 'completed', taskId);
      this.recordDecisionMemory(id, {
        problem: `Manual task completed: ${task.title}`,
        decision: 'accept',
        rationale: `Manual task ${taskId} of type ${task.kind} completed`,
        relatedMissionId: mission.id,
      });
    }
    return { ok: true, mission: updated };
  }

  /* ── Mission Control v3 — execution lifecycle ───────────────────── */

  startMissionExecution(id: string, mid: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    if (mission.approval.status !== 'approved') return { ok: false, error: 'This mission plan has not been approved yet — approve it before starting execution.' };
    return { ok: true, mission: this.missionEngine(id).startExecution(mission) };
  }

  /** Run the current ready wave (deps satisfied). Streams ExecutionEvents over SSE when `emit` is given. */
  async runMissionBatch(id: string, mid: string, opts: RunReadyOptions = {}, emit?: (e: ExecutionEvent) => void): Promise<{ ok: boolean; error?: string; mission?: MissionRecord }> {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    const engine = this.missionEngine(id, undefined, emit);
    if (!mission.execution || mission.execution.status === 'approved') {
      const started = engine.startExecution(mission);
      if (started.execution?.status !== 'running') return { ok: false, error: 'could not start execution', mission: started };
    }
    if (mission.execution?.status !== 'running') return { ok: false, error: 'execution is not running', mission };
    const updated = await engine.runReadyTasks(mission, opts);
    if (updated.execution?.status === 'completed') {
      const project = this.registry.get(id);
      // Real platform moment → Automation Engine (mission-completed).
      if (project) {
        const lastDone = [...(updated.goalGraph?.tasks ?? [])].reverse().find((t) => updated.taskRuns.find((r) => r.taskId === t.id)?.status === 'accepted');
        this.automation.engine.handleEvent(automationEvent('mission-completed', id, project.path, {
          missionId: updated.id,
          category: updated.classification?.category ?? 'unknown',
          quality: updated.quality?.overall ?? null,
          taskCount: updated.goalGraph?.tasks.length ?? 0,
          filePath: lastDone?.targetFile ?? null,
          mission: { status: 'completed', text: updated.text },
        }));
      }
    }
    return { ok: true, mission: updated };
  }

  pauseMissionExecution(id: string, mid: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    return { ok: true, mission: this.missionEngine(id).pauseExecution(mission) };
  }

  resumeMissionExecution(id: string, mid: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    return { ok: true, mission: this.missionEngine(id).resumeExecution(mission) };
  }

  cancelMissionExecution(id: string, mid: string, reason?: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    return { ok: true, mission: this.missionEngine(id).cancelExecution(mission, reason) };
  }

  retryMissionTask(id: string, mid: string, taskId: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    return { ok: true, mission: this.missionEngine(id).retryTask(mission, taskId) };
  }

  reviewMissionCheckpoint(id: string, mid: string, pass: boolean, note?: string): { ok: boolean; error?: string; mission?: MissionRecord } {
    const mission = this.missions.get(id, mid);
    if (!mission) return { ok: false, error: 'no such mission' };
    return { ok: true, mission: this.missionEngine(id).reviewCheckpoint(mission, pass, note) };
  }

  getMissionReplay(id: string, mid: string) {
    const mission = this.missions.get(id, mid);
    if (!mission?.execution) return null;
    return {
      frames: mission.execution.replay,
      status: mission.execution.status,
      metrics: mission.execution.metrics,
      checkpoints: mission.execution.checkpoints,
    };
  }

  /** Global engineering dashboard — aggregates every mission across every registered project. */
  missionDashboard() {
    const projects = this.registry.list();
    const summaries: MissionSummary[] = projects.flatMap((p) => this.missions.list(p.id));
    const records = new Map<string, MissionRecord | null>();
    for (const s of summaries) records.set(s.id, this.missions.get(s.projectId, s.id));
    const counts = {
      planned: 0, approved: 0, active: 0, reviewing: 0, completed: 0, cancelled: 0, failed: 0,
    };
    const taskCounts = { total: 0, completed: 0, review: 0, failed: 0, blocked: 0, running: 0 };
    const riskCounts = { low: 0, medium: 0, high: 0 };
    const byCategory = new Map<string, number>();
    let completedTasks = 0;
    let totalTasks = 0;
    for (const summary of summaries) {
      const rec = records.get(summary.id) ?? null;
      const ex = summary.execution;
      const status = ex?.status ?? 'idle';
      if (status === 'idle') counts.planned += 1;
      else if (status === 'approved') counts.approved += 1;
      else if (status === 'reviewing') counts.reviewing += 1;
      else if (status === 'completed') counts.completed += 1;
      else if (status === 'cancelled') counts.cancelled += 1;
      else if (status === 'failed') counts.failed += 1;
      else counts.active += 1;
      byCategory.set(summary.category, (byCategory.get(summary.category) ?? 0) + 1);

      const tasks = rec?.goalGraph?.tasks ?? [];
      totalTasks += tasks.length;
      for (const t of tasks) {
        const run = rec?.taskRuns.find((r) => r.taskId === t.id);
        const runtime = run?.proposal?.error ? 'failed' : t.status;
        if (runtime === 'accepted' || runtime === 'done') { taskCounts.completed += 1; completedTasks += 1; }
        else if (runtime === 'proposed') taskCounts.review += 1;
        else if (runtime === 'error') taskCounts.failed += 1;
        if (t.risk === 'low') riskCounts.low += 1;
        else if (t.risk === 'medium') riskCounts.medium += 1;
        else riskCounts.high += 1;
      }
    }
    return {
      totals: { projects: projects.length, missions: summaries.length, ...counts },
      tasks: { ...taskCounts, total: totalTasks, completion: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100) },
      riskDistribution: riskCounts,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      recent: summaries.slice(0, 12),
    };
  }

  /* ── BYOAK provider management ──────────────────────────────────── */

  listKnownProviders(): ProviderInfo[] {
    // Every provider is bring-your-own-key — there is no built-in default.
    return getAllAdapters().map((a) => ({
      id: a.metadata.id,
      name: a.metadata.name,
      description: a.metadata.description,
      docsUrl: a.metadata.docsUrl,
    }));
  }

  byoakStatus(): { connected: ConnectedProvider[]; active: string | null; model: string } {
    const activeInfo = getActive();
    const stores = getAllProviderStores();
    const connected: ConnectedProvider[] = stores.map((s) => {
      const adapter = getAdapter(s.id);
      return {
        id: s.id,
        name: adapter ? adapter.metadata.name : s.id,
        fingerprint: s.fingerprint,
        models: s.models ?? [],
        health: s.health,
        active: s.id === activeInfo.providerId,
      };
    });
    return { connected, active: activeInfo.providerId, model: activeInfo.model };
  }

  async autoConnectProvider(apiKey: string): Promise<{ ok: boolean; providerId?: string; fingerprint?: string; models?: DiscoveredModel[]; error?: string }> {
    const detected = await detectProvider(apiKey);
    if (!detected) return { ok: false, error: 'Could not determine provider — key format not recognised' };
    return this.connectProvider(detected.adapter.metadata.id, apiKey);
  }

  /**
   * Connect every provider whose key is supplied through an environment
   * variable (e.g. MISTRAL_API_KEY). Providers already connected keep their
   * stored key. Runs the exact same validate → discover → health → activate
   * path as a manual connect in Settings, so an env-configured provider
   * becomes the active runtime on startup.
   */
  async connectEnvProviders(): Promise<{ providerId: string; ok: boolean; error?: string }[]> {
    const results: { providerId: string; ok: boolean; error?: string }[] = [];
    for (const [providerId, envVar] of Object.entries(ENV_VAR_BY_PROVIDER)) {
      const apiKey = process.env[envVar]?.trim();
      if (!apiKey) continue;
      if (getKey(providerId)) {
        results.push({ providerId, ok: true });
        continue;
      }
      const result = await this.connectProvider(providerId, apiKey);
      results.push({ providerId, ok: result.ok, error: result.error });
      console.log(`[providers] ${envVar} → "${providerId}": ${result.ok ? 'connected' : `rejected — ${result.error ?? 'unknown error'}`}`);
    }
    return results;
  }

  async connectProvider(providerId: string, apiKey: string): Promise<{ ok: boolean; fingerprint?: string; models?: DiscoveredModel[]; error?: string }> {
    const adapter = getAdapter(providerId);
    if (!adapter) return { ok: false, error: 'Unknown provider' };
    const validation = await adapter.validate(apiKey);
    if (!validation.ok) return { ok: false, error: validation.error ?? 'Key validation failed' };
    const { fingerprint } = storeKey(providerId, apiKey);
    let models: DiscoveredModel[] = [];
    try {
      models = await adapter.discoverModels(apiKey);
      if (models.length) storeModels(providerId, models);
    } catch { models = []; }
    const health = await adapter.checkHealth(apiKey);
    storeHealth(providerId, health);
    await this.pipeline.runtimeManager.switchToProvider(providerId, models[0]?.id);
    return { ok: true, fingerprint, models };
  }

  disconnectProvider(providerId: string): void {
    removeKey(providerId);
    if (getActive().providerId === providerId) {
      this.pipeline.runtimeManager.deactivate();
    }
  }

  /** Turn off AI — no provider active until the user connects one. */
  deactivateProvider(): void {
    this.pipeline.runtimeManager.deactivate();
  }

  async switchToProvider(providerId: string, model?: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = getAdapter(providerId);
    if (!adapter) return { ok: false, error: 'Unknown provider' };
    const apiKey = getKey(providerId);
    if (!apiKey) return { ok: false, error: 'No API key configured for this provider' };
    // RuntimeManager.switchToProvider() persists the active pointer itself
    // (credentialStore.setActive) — only on success, so a failed switch never
    // leaves the store pointing at a provider with no working runtime.
    const switched = await this.pipeline.runtimeManager.switchToProvider(providerId, model);
    return switched ? { ok: true } : { ok: false, error: 'Failed to activate runtime' };
  }

  async discoverModels(providerId: string, apiKey: string): Promise<DiscoveredModel[]> {
    const adapter = getAdapter(providerId);
    if (!adapter) return [];
    try {
      const models = await adapter.discoverModels(apiKey);
      return models;
    } catch { return []; }
  }
}
