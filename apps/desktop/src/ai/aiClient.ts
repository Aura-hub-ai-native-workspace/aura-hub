const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  type: string;
  language: string;
  icon: string;
  color: string;
  favorite: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
}

export interface FolderNode { name: string; files: number; dirs: number }
export interface ProjectProfile {
  id: string;
  path: string;
  generatedAt: string;
  type: string;
  primaryLanguage: string;
  languages: { name: string; files: number }[];
  packageManager: string | null;
  frameworks: string[];
  dependencies: { name: string; version: string; kind: 'runtime' | 'dev' }[];
  has: { frontend: boolean; backend: boolean; database: boolean; config: boolean; git: boolean; docker: boolean; ci: boolean; tests: boolean };
  structure: FolderNode[];
  architectureDocs: { title: string; relPath: string }[];
  fileCount: number;
  summary: string;
  purpose: string;
  entryPoints: string[];
  buildSystem: string | null;
  importantFiles: string[];
  codingStyle: { indent: string; quotes: string; semicolons: boolean } | null;
}

export interface ConvMessage { id: string; role: 'user' | 'assistant'; content: string; at: string; meta?: unknown; error?: boolean }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: ConvMessage[] }
export interface ConversationSummary { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number; preview: string }

export interface KGNode { id: string; type: string; label: string; group: string; relPath?: string; line?: number; detail?: string }
export interface KGEdge { from: string; to: string; kind: string }
export interface KnowledgeGraph { nodes: KGNode[]; edges: KGEdge[]; counts: Record<string, number> }

/* ── repository intelligence (Group A engines) ─────────────────────── */
export interface VerificationSection { name: string; score: number; status: 'pass' | 'warn' | 'fail'; findings: string[] }
/* ── Context Fabric ────────────────────────────────────────────────
   Mirrors `packages/ai-service/src/context/types.ts`.

   Restated here rather than imported because the renderer talks to the
   service over HTTP and deliberately does not depend on the service
   package — the same convention every other type in this file follows.
   The service remains the authority for the SHAPE; this is the wire
   contract as the UI reads it. */

export type FreshnessState = 'fresh' | 'stale' | 'unknown';

export interface ContextView {
  contextVersion: number;
  generatedAt: string;
  freshness: {
    state: FreshnessState;
    generatedAt: string | null;
    reason: string | null;
    changedFiles: number;
    addedFiles: number;
    removedFiles: number;
    truncated: boolean;
  };
  project: { id: string; name: string; root: string; type: string; language: string; mounted: boolean };
  repository: {
    purpose: string | null;
    repositoryType: string | null;
    architectureStyle: string | null;
    primaryLanguage: string | null;
    secondaryLanguages: string[];
    frameworks: string[];
    buildSystem: string | null;
    packageManager: string | null;
    mainModules: string[];
    entryPoints: string[];
    fileCount: number | null;
    modules: { name: string; path: string; description: string }[];
    intelligence: 'ready' | 'partial' | 'absent';
  };
  git: {
    available: boolean;
    branch: string | null;
    dirty: boolean | null;
    changedFiles: number | null;
    recentCommits: { hash: string; subject: string; date: string }[];
    reason: string | null;
  };
  environment: {
    os: string; platform: string; arch: string; nodeVersion: string; shell: string | null;
    presentNodes: { id: string; name: string; version: string | null }[];
    presentCount: number; catalogueCount: number; scannedAt: string | null;
  };
  tools: { available: string[]; missing: string[] };
  agents: {
    codingAgents: { id: string; name: string; version: string | null; drivable: boolean }[];
    provider: { id: string | null; connected: boolean; model: string | null };
  };
  mission: {
    active: { id: string; text: string; status: string; createdAt: string } | null;
    total: number;
    pendingApprovals: number;
  };
  activity: { events: { at: string; kind: string; summary: string }[] };
  constraints: { id: string; text: string }[];
  buildMs: number;
}

export interface ProjectIntelligence {
  verification: { overallScore: number; summary: string; sections: VerificationSection[]; recommendations: string[] };
  architecture: {
    hierarchy: { name: string; path: string; type: string; children: unknown[] };
    dependencies: { nodes: { id: string; label: string; type: string }[]; edges: { source: string; target: string; type: string }[] };
    entryPoints: { file: string; type: string; description: string }[];
    apiSurface: { endpoints: unknown[]; classes: unknown[]; functions: unknown[] };
  };
  personality: { communicationStyle: string; codeStyle: string; documentationTone: string; technicalLevel: string; responsePatterns: { verbosity: string; useExamples: boolean; includeReferences: boolean } };
  validation: { valid: boolean; score: number; violations: { rule: string; severity: string; message: string; file?: string }[]; warnings: { rule: string; message: string; suggestion: string }[]; passedRules: string[] };
  change: { report: string; hotspots: { file: string; score: number; reason: string }[]; patterns: unknown[]; velocity: number };
  versions: { totalVersions: number; currentVersion: number; oldestVersion: string | null; newestVersion: string | null; current: { version: number; timestamp: string } | null };
  agent: { info: { name: string; description: string; language: string; frameworks: string[]; entryPoints: string[]; modules: string[] }; tree: Record<string, unknown> };
  performance: { hasChanges: boolean; changed: number; added: number; removed: number; totalIndexed: number };
}
export interface WorkspaceIntelligence {
  stats: { totalRepositories: number; totalDependencies: number; totalGroups: number; languageDistribution: Record<string, number>; frameworkDistribution: Record<string, number> };
  repositories: { id: string; name: string; path: string }[];
  crossRepo: { totalRepositories: number; totalEdges: number; totalClusters: number; averageConnectivity: number } | null;
}

export interface IndexStatus {
  projectId: string | null;
  phase: 'empty' | 'indexing' | 'ready' | 'error';
  coding: { processed: number; total: number; chunks: number };
  fullstack: { processed: number; total: number; entities: number; relations: number };
  message: string;
  error?: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type MemoryKind = 'conversation' | 'decision' | 'code' | 'accepted' | 'rejected' | 'correction' | 'pinned' | 'learning' | 'diagnosis';
export interface MemoryItem { id: string; kind: MemoryKind; title: string; body: string; pinned: boolean; at: string }

export interface GraphEntity { id: string; kind: string; layer: string; name: string; relPath: string; line?: number; summary?: string }
export interface GraphRelation { id: string; from: string; to: string; kind: string; confidence: number }
export interface GraphView { entities: GraphEntity[]; relations: GraphRelation[]; stats: unknown }

export interface RetrieveResult { entries: { source: string; score: number; snippet: string; lines: { start: number; end: number }[] }[]; totalTokens: number }

/* ── Code Workspace AI actions (real, single-shot, grounded in the graph) ── */
export type ActionKind =
  | 'explain' | 'refactor' | 'optimize'
  | 'generate-tests' | 'add-docs' | 'review-security' | 'simplify'
  | 'convert' | 'rename' | 'custom';
export type RiskLevel = 'safe' | 'medium' | 'high';
export interface CodeRelationRef { id: string; name: string; kind: string; relPath: string }
export interface CodeActionRequest {
  projectId?: string;
  action: ActionKind;
  filePath: string;
  language: string;
  selectedCode: string;
  selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
  surroundingContext: { before: string; after: string };
  symbol: { id: string; name: string; kind: string; line: number } | null;
  dependencies: CodeRelationRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
  customInstruction?: string;
  riskFloor: { level: RiskLevel; reasons: string[] };
}
export interface CodeActionFinding { severity: 'info' | 'warning' | 'critical'; title: string; detail: string; line?: number }
export interface CodeActionResponse {
  ok: boolean;
  action: ActionKind;
  mode: 'diff' | 'findings' | 'new-file';
  explanation: string;
  newCode: string | null;
  newFilePath?: string;
  findings: CodeActionFinding[] | null;
  risk: { level: RiskLevel; reasons: string[] };
  error?: { type: string; message: string; retryable: boolean };
}

/* ── architecture layers (from graphify graph.json) ─────────────── */
export interface ArchitectureLayer {
  title: string;
  subtitle?: string;
  items?: string[];
  color: string;
  width?: number;
}

/** A real inter-layer dependency: `from` depends on `to`, `weight` is how many entity-level relations it represents. Joined against `ArchitectureLayer.title`. */
export interface ArchitectureLayerEdge {
  from: string;
  to: string;
  weight: number;
}

export interface HealthResult {
  health: { ok: boolean; latencyMs: number; status?: number; models?: string[]; error?: string };
  key: { configured: boolean; fingerprint: string };
  index?: IndexStatus;
  project?: ProjectRecord | null;
}

/* ── Mission Control types now live in `missionClient.ts` (its own file, mirroring `diagnosisClient.ts`'s split from this one) ── */
export interface AiSettings { streaming: boolean; temperature: number; maxTokens: number; timeoutMs: number; maxRetries: number }
export interface SettingsResult { settings: AiSettings; key: { configured: boolean; fingerprint: string } }

export interface InspectResult {
  intent: string;
  intentConfidence: number;
  enhancedPrompt: string;
  systemHints: string[];
  engines: string[];
  coding: { files: string[]; chunks: number; tokens: number };
  fullstack: { hits: string[]; paths: string[] };
  memory: { items: { id: string; kind: string; title: string }[]; tokens: number };
  contextTokens: number;
  projectId: string | null;
}

export interface StreamDone {
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  citations?: { sourceId: string; title: string; ref?: string }[];
  latencyMs?: number;
  trace?: { stage: string; durationMs: number; ok: boolean }[];
  provider?: string;
  engineId?: string;
}
export interface StreamError { type: string; message: string; retryable: boolean }

/* ── Provider / BYOAK types ─────────────────────────────────────── */
export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  apiEndpoint?: string;
  docsUrl?: string;
}
export interface ConnectedProvider {
  id: string;
  name: string;
  fingerprint: string;
  models: { id: string; name: string }[];
  activeModel: string;
  health?: { ok: boolean; latencyMs: number; error?: string; lastChecked: string } | null;
}
export interface ProviderStatus {
  type: 'byoak' | 'none';
  providerId: string | null;
  label: string;
  model: string;
}
export interface ProvidersResult {
  providers: ProviderInfo[];
  defaultProvider: string | null;
  connected: ConnectedProvider[];
  active: string | null;
  activeModel: string;
  status: ProviderStatus;
}

/* ── workflows ──────────────────────────────────────────────────── */
export type WfNodeType = string;
export interface WfNode { id: string; type: WfNodeType; x: number; y: number; config: Record<string, unknown> }
export interface WfEdge { id: string; from: string; fromPort: string; to: string }
export interface Workflow {
  id: string; name: string; description: string; category: string; favorite: boolean;
  createdAt: string; updatedAt: string; nodes: WfNode[]; edges: WfEdge[];
}
export interface WorkflowSummary { id: string; name: string; description: string; category: string; favorite: boolean; createdAt: string; updatedAt: string; nodeCount: number }
export interface WorkflowTemplateInfo { id: string; name: string; description: string; category: string; nodeCount: number }
export interface FieldSpec { key: string; label: string; kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean'; options?: string[]; placeholder?: string; default?: unknown; help?: string }
export interface NodeSpecInfo {
  type: WfNodeType; label: string; category: 'source' | 'intelligence' | 'generate' | 'logic' | 'action' | 'io';
  description: string; inputs: 0 | 1 | 'many'; outputs: string[]; disabled?: boolean; fields: FieldSpec[];
}
export type NodeRunState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
export type NodeState =
  | 'queued' | 'running' | 'awaiting-approval' | 'succeeded'
  | 'failed' | 'denied' | 'skipped' | 'cancelled' | 'timed-out';
export type WfRunEvent =
  | { type: 'start'; workflowId: string; at: string }
  | { type: 'node'; nodeId: string; status: NodeRunState; ms?: number; summary?: string; error?: string }
  | { type: 'log'; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'output'; nodeId: string; title: string; text: string }
  | { type: 'done'; status: 'completed' | 'failed'; ms: number; error?: string };

/* ── Context Fabric ─────────────────────────────────────────────── */
export type ContextFreshness = 'fresh' | 'stale' | 'unknown';
export interface ContextSection<T> {
  value: T | null;
  freshness: ContextFreshness;
  generatedAt: string | null;
  reason?: string;
}
export type ContextSurface = 'general' | 'coding' | 'debugging' | 'architecture' | 'git' | 'testing' | 'mission' | 'planning' | 'review';
export type CapabilityAvailability = 'available' | 'approval' | 'not-drivable' | 'unavailable';
export interface ContextView {
  contractVersion: 1;
  contextVersion: number | null;
  composedAt: string;
  surface: ContextSurface;
  freshness: ContextFreshness;
  project: { id: string; name: string; root: string; type: string; language: string; mounted: boolean; lastOpenedAt: string | null };
  repository: ContextSection<{ identity: { name: string; purpose: string; repositoryType: string; primaryLanguage: string; architectureStyle: string; frameworks: string[]; entryPoints: string[] } | null; modules: { name: string; path: string; fileCount: number; description: string }[]; totalFiles: number | null; entryPoints: string[]; profile: { architectureStyle: string; designPatterns: string[]; keyDecisions: string[] } | null; health: { score: { overall: number } } | null }>;
  changes: ContextSection<{ velocity: number; hotspots: { file: string; score: number; reason: string }[]; patterns: string[] }>;
  git: ContextSection<{ branch: string; dirty: boolean; changedFiles: number; recentCommits: { hash: string; date: string; subject: string }[] }>;
  environment: ContextSection<{ os: string; arch: string; tools: { id: string; name: string; capabilities: string[]; version: string | null; internal: boolean }[]; providedCapabilities: string[] }>;
  capabilities: ContextSection<{ id: string; name: string; risk: string; availability: CapabilityAvailability; rule?: string; reason?: string }[]>;
  missions: ContextSection<{ id: string; text: string; createdAt: string; category: string; status: string | null; taskCount: number; completedTasks: number; approved: boolean }[]>;
  activity: ContextSection<{ at: string; capabilityId: string; actor: string; nodeId?: string; outcome: string; decision: string }[]>;
  constraints: { id: string; text: string }[];
}
export interface ContextUnavailable { contractVersion: 1; status: 'unavailable'; projectId: string; reason: string; }
export const contextUnavailable = (r: ContextView | ContextUnavailable): r is ContextUnavailable => (r as ContextUnavailable).status === 'unavailable';

/* ── Evidence and Node Records ─────────────────────────────────────── */
export interface EvidenceRef {
  invocationId: string;
  capabilityId: string;
  outcome: string;
  decision: string;
  decisionRule: string;
  risk: string;
  verified: boolean | null;
  approvalId?: string;
  nodeId?: string;
  at: string;
  durationMs: number;
}
export interface StateTransition {
  at: string;
  from: NodeState;
  to: NodeState;
  note?: string;
}
export interface NodeRunRecord {
  nodeId: string;
  type: string;
  state: NodeState;
  iteration: number;
  startedAt?: string;
  finishedAt?: string;
  ms: number;
  summary?: string;
  error?: string;
  transitions?: StateTransition[];
  evidence?: EvidenceRef[];
}

const jget = <T>(p: string): Promise<T> => fetch(BASE + p).then((r) => r.json() as Promise<T>);
const jsend = <T>(method: string, p: string, body?: unknown): Promise<T> =>
  fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<T>);
const jpost = <T>(p: string, body: unknown): Promise<T> => jsend<T>('POST', p, body);

export const aiClient = {
  base: BASE,

  /* AI */
  health: () => jget<HealthResult>('/health'),
  getSettings: () => jget<SettingsResult>('/settings'),
  setSettings: (partial: Partial<AiSettings>) => jpost<{ settings: AiSettings }>('/settings', partial),
  setKey: (apiKey: string, persist = false) => jpost<{ ok: boolean; fingerprint: string; reason?: string }>('/settings/key', { apiKey, persist }),
  clearKey: () => jsend('DELETE', '/settings/key'),
  inspect: (text: string) => jpost<InspectResult>('/inspect', { text }),
  reindex: () => jpost<IndexStatus>('/reindex', {}),
  /**
   * Re-index a NAMED project. Refuses (409) when that project is not the
   * one AURA has open, rather than re-indexing whichever is — the generic
   * `reindex()` above cannot express which project it means.
   */
  reindexProject: (id: string) => jpost<IndexStatus | { error: string; requested: string; mounted: string | null }>(`/projects/${id}/reindex`, {}),
  codeAction: (req: CodeActionRequest) => jpost<CodeActionResponse>('/code/action', req),

  /* Context Fabric */
  contextView: (id: string, surface: ContextSurface = 'general') =>
    jget<ContextView | ContextUnavailable>(`/projects/${id}/context?surface=${surface}`),
  contextContract: (id: string, surface: ContextSurface = 'general') =>
    jget<{ projectId: string; surface: ContextSurface; contract: string } | { error: string }>(
      `/projects/${id}/context/contract?surface=${surface}`,
    ),

  /* BYOAK providers */
  getProviders: () => jget<ProvidersResult>('/providers'),
  connectProvider: (providerId: string, apiKey: string) => jpost<{ ok: boolean; fingerprint?: string; models?: { id: string; name: string }[]; error?: string }>('/providers/connect', { providerId, apiKey }),
  disconnectProvider: (providerId: string) => jpost<{ ok: boolean }>('/providers/disconnect', { providerId }),
  switchProvider: (providerId: string, model?: string) => jpost<{ ok: boolean; status: ProviderStatus; error?: string }>('/providers/switch', { providerId, model }),
  discoverModels: (providerId: string, apiKey: string) => jpost<{ models: { id: string; name: string }[] }>(`/providers/models`, { providerId, apiKey }),

  /* projects */
  listProjects: () => jget<{
    projects: ProjectRecord[];
    current: ProjectRecord | null;
    /** Absent on older services; treated as readable when missing. */
    registry?: { readable: boolean; error: string | null };
  }>('/projects'),
  addProject: (path: string, name?: string) => jpost<{ project: ProjectRecord; profile: ProjectProfile } | { error: string }>('/projects', { path, name }),
  openProject: (id: string) => jpost<{ project: ProjectRecord; profile: ProjectProfile; status: IndexStatus } | { error: string }>(`/projects/${id}/open`, {}),
  renameProject: (id: string, name: string) => jsend<ProjectRecord>('PATCH', `/projects/${id}`, { name }),
  favoriteProject: (id: string, favorite: boolean) => jsend<ProjectRecord>('PATCH', `/projects/${id}`, { favorite }),
  removeProject: (id: string) => jsend<{ ok: boolean }>('DELETE', `/projects/${id}`),
  profile: (id: string) => jget<ProjectProfile>(`/projects/${id}/profile`),
  indexStatus: () => jget<IndexStatus>('/index'),

  /* graph + retrieval */
  graph: () => jget<GraphView>('/graph'),
  knowledgeGraph: (id: string) => jget<KnowledgeGraph>(`/projects/${id}/graph`),
  projectIntelligence: (id: string) => jget<ProjectIntelligence>(`/projects/${id}/intelligence`),
  /**
   * The Context Fabric read model for one project.
   *
   * Takes the project id explicitly rather than reading "the current
   * project" — the caller passes the canonical `activeProjectId`, so this
   * client can never become a competing answer to which project is active.
   * `prompt: true` additionally returns the rendered agent contract.
   */
  projectContext: (id: string, opts?: { prompt?: boolean }) =>
    jget<{ view: ContextView; contract?: string }>(`/projects/${id}/context${opts?.prompt ? '?prompt=1' : ''}`),
  workspaceIntelligence: () => jget<WorkspaceIntelligence>('/workspace/intelligence'),
  retrieve: (text: string) => jpost<RetrieveResult>('/retrieve', { text }),

  /* graphify graph visualization */
  projectGraphifyHtml: (id: string): Promise<string> =>
    fetch(`${BASE}/projects/${id}/graphify`).then((r) => r.ok ? r.text() : ''),
  graphifyStatus: (id: string): Promise<{ exists: boolean; phase: 'idle' | 'running' | 'done' | 'error' | 'unavailable'; error?: string }> =>
    fetch(`${BASE}/projects/${id}/graphify/status`)
      .then((r) => (r.ok ? r.json() : { exists: false, phase: 'unavailable' as const }))
      .catch(() => ({ exists: false, phase: 'unavailable' as const })),
  generateGraphify: (id: string): Promise<{ ok: boolean; unavailable?: boolean }> =>
    fetch(`${BASE}/projects/${id}/graphify/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : { ok: false, unavailable: true }))
      .catch(() => ({ ok: false, unavailable: true })),
  projectArchitectureLayers: (id: string): Promise<{ layers: ArchitectureLayer[]; edges: ArchitectureLayerEdge[] }> =>
    jget(`/projects/${id}/architecture-layers`),

  /* conversations (per project) */
  listConversations: (id: string) => jget<{ conversations: ConversationSummary[] }>(`/projects/${id}/conversations`),
  getConversation: (id: string, cid: string) => jget<Conversation>(`/projects/${id}/conversations/${cid}`),
  createConversation: (id: string, title?: string) => jpost<Conversation>(`/projects/${id}/conversations`, { title }),
  renameConversation: (id: string, cid: string, title: string) => jsend<Conversation>('PATCH', `/projects/${id}/conversations/${cid}`, { title }),
  removeConversation: (id: string, cid: string) => jsend<{ ok: boolean }>('DELETE', `/projects/${id}/conversations/${cid}`),
  appendMessage: (id: string, cid: string, msg: { role: 'user' | 'assistant'; content: string; meta?: unknown; error?: boolean }) => jpost<ConvMessage>(`/projects/${id}/conversations/${cid}/message`, msg),
  removeLastAssistantMessage: (id: string, cid: string) => jsend<{ ok: boolean }>('DELETE', `/projects/${id}/conversations/${cid}/message/last`),

  /* memory */
  listMemory: (id: string) => jget<{ items: MemoryItem[] }>(`/projects/${id}/memory`),
  addMemory: (id: string, item: { kind: MemoryKind; title: string; body: string; pinned?: boolean }) => jpost<MemoryItem>(`/projects/${id}/memory`, item),
  pinMemory: (id: string, memId: string, pinned: boolean) => jpost<MemoryItem>(`/projects/${id}/memory/${memId}/pin`, { pinned }),
  removeMemory: (id: string, memId: string) => jsend<{ ok: boolean }>('DELETE', `/projects/${id}/memory/${memId}`),

  /* workflows */
  listWorkflows: () => jget<{ workflows: WorkflowSummary[] }>('/workflows'),
  workflowSpecs: () => jget<{ specs: NodeSpecInfo[] }>('/workflows/specs'),
  workflowTemplates: () => jget<{ templates: WorkflowTemplateInfo[] }>('/workflows/templates'),
  getWorkflow: (id: string) => jget<Workflow>(`/workflows/${id}`),
  createWorkflow: (input: { name?: string; template?: string; category?: string }) => jpost<Workflow>('/workflows', input),
  saveWorkflow: (id: string, def: Workflow) => jsend<Workflow>('PUT', `/workflows/${id}`, def),
  patchWorkflow: (id: string, partial: { name?: string; favorite?: boolean; category?: string; description?: string }) => jsend<Workflow>('PATCH', `/workflows/${id}`, partial),
  duplicateWorkflow: (id: string) => jpost<Workflow>(`/workflows/${id}/duplicate`, {}),
  removeWorkflow: (id: string) => jsend<{ ok: boolean }>('DELETE', `/workflows/${id}`),
  importWorkflow: (def: unknown) => jpost<Workflow>('/workflows/import', { def }),
  /** The AI Workflow Builder — natural language to a real, saved, validated workflow graph. */
  generateWorkflow: (text: string) => jpost<Workflow | { error: string }>('/workflows/generate', { text }),
  ensureWorkflowWebhook: (id: string) => jpost<{ token: string; path: string } | { error: string }>(`/workflows/${id}/webhook-token`, {}),
  rotateWorkflowWebhook: (id: string) => jpost<{ token: string; path: string } | { error: string }>(`/workflows/${id}/webhook-token`, { rotate: true }),

  async runWorkflow(id: string, inputs: Record<string, string>, onEvent: (e: WfRunEvent) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs }), signal });
    } catch (e) {
      onEvent({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message || 'Service unreachable' });
      return;
    }
    if (!res.body) { onEvent({ type: 'done', status: 'failed', ms: 0, error: 'No stream body' }); return; }
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
          onEvent(JSON.parse(d) as WfRunEvent);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onEvent({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message });
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },

  async stream(
    text: string,
    handlers: { onMeta?: (m: InspectResult) => void; onToken?: (t: string) => void; onDone?: (d: StreamDone) => void; onError?: (e: StreamError) => void },
    signal?: AbortSignal,
    scope?: { projectId?: string; conversationId?: string },
  ): Promise<void> {
    let res: Response;
    try {
      const body = { text, ...scope };
      res = await fetch(BASE + '/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      handlers.onError?.({ type: 'network', message: (e as Error).message || 'Service unreachable', retryable: true });
      return;
    }
    if (!res.body) { handlers.onError?.({ type: 'network', message: 'No stream body', retryable: false }); return; }
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
          let ev: { type: string; [k: string]: unknown };
          try {
            ev = JSON.parse(d);
          } catch {
            handlers.onError?.({ type: 'parse_error', message: 'Received malformed data from the server.', retryable: false });
            continue;
          }
          if (ev.type === 'meta') handlers.onMeta?.(ev.meta as InspectResult);
          else if (ev.type === 'token') handlers.onToken?.(ev.text as string);
          else if (ev.type === 'done') handlers.onDone?.(ev as unknown as StreamDone);
          else if (ev.type === 'error') handlers.onError?.(ev.error as StreamError);
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      handlers.onError?.({ type: 'network', message: (e as Error).message, retryable: true });
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },
};
