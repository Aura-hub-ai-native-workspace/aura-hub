import { PipelineManager, type IndexStatus, type PipelineOptions } from './pipeline';
import { ProjectRegistry, type ProjectRecord } from './projects';
import { getOrBuildProfile, loadProfile, type ProjectProfile } from './profile';
import { ProjectMemory, type MemoryItem, type MemoryKind } from './memory';
import { ProjectConversations, type Conversation, type ConversationSummary } from './conversations';
import { buildKnowledgeGraph, type KnowledgeGraph } from './knowledgeGraph';
import { runProjectIntelligence, runWorkspaceIntelligence, type ProjectIntelligenceReport, type WorkspaceIntelligenceReport } from './intelligence';
import { WorkflowStore } from './workflow/store';
import { runWorkflow, type RunResult } from './workflow/engine';
import type { RunEvent, Workflow } from './workflow/types';
import { getAdapter, getAllAdapters } from './provider/registry';
import { storeKey, removeKey, getKey, getActive, getAllProviderStores, storeModels, storeHealth, setActive } from './provider/credentialStore';
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

  /** Workspace-level intelligence across every registered project
   *  (workspace graph + cross-repository analysis). */
  workspaceIntelligence(): WorkspaceIntelligenceReport {
    return runWorkspaceIntelligence(this.registry.list().map((p) => ({ id: p.id, root: p.path })));
  }

  /* ── workflows ──────────────────────────────────────────────────── */

  readonly workflows = new WorkflowStore();

  async runWorkflow(wf: Workflow, inputs: Record<string, string>, emit: (e: RunEvent) => void, signal?: AbortSignal): Promise<RunResult> {
    const project = this.currentProject();
    if (!project) throw new Error('open a project before running a workflow');
    await this.pipeline.whenIndexed();
    return runWorkflow(wf, {
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      pipeline: this.pipeline,
      inputs,
      signal,
    }, emit);
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
    this.pipeline.runtimeManager.switchToProvider(providerId, models[0]?.id);
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

  switchToProvider(providerId: string, model?: string): { ok: boolean; error?: string } {
    const adapter = getAdapter(providerId);
    if (!adapter) return { ok: false, error: 'Unknown provider' };
    const apiKey = getKey(providerId);
    setActive(providerId, model);
    if (!apiKey) return { ok: true, error: 'No API key configured' };
    const switched = this.pipeline.runtimeManager.switchToProvider(providerId, model);
    return switched ? { ok: true } : { ok: true, error: 'Failed to activate runtime' };
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
