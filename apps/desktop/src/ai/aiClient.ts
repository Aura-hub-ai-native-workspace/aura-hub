/**
 * Type-only, and deliberately so.
 *
 * The agent contract mirror lives beside the agent UI because that is the
 * only place that renders it; this file needs the beat shape purely to
 * type one member of the run-event union. `import type` is erased at
 * compile time, so the two modules referring to each other's types costs
 * nothing at runtime and duplicating the shape here would be worse — two
 * declarations of one wire format is exactly the drift this codebase
 * avoids elsewhere.
 */
import type { AgentBeat } from '../screens/workflows/agent/types';

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
/**
 * Per-node status on the live event stream. Extended additively by the
 * service: a node the policy engine refused, a node a human stopped and a
 * node that ran out of time need three different responses from an
 * operator, so they are three states rather than one `failed`.
 */
export type NodeRunState =
  | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped'
  | 'awaiting-approval' | 'denied' | 'cancelled' | 'timed-out';

export type WfRunEvent =
  | { type: 'start'; workflowId: string; at: string; runId?: string; versionId?: string }
  | { type: 'node'; nodeId: string; status: NodeRunState; ms?: number; summary?: string; error?: string }
  | { type: 'log'; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'output'; nodeId: string; title: string; text: string }
  /**
   * One agent beat, live, as it happens.
   *
   * The payload IS the beat that lands in the persisted `AgentTrace` — same
   * object, same `seq`, same redaction, same `untrusted` flag. There is no
   * second trace format, which is what lets a reader reconcile the stream
   * against the final trace by `(runId, nodeId, seq)`.
   *
   * **The persisted trace stays authoritative.** These events are a
   * courtesy for someone watching a long agent: they can be missed
   * entirely (nobody was connected), duplicated (a reconnect replays), or
   * arrive out of order. So the UI treats them as an early view and the
   * run record as truth — never the other way round.
   */
  | { type: 'agent'; nodeId: string; runId?: string; beat: AgentBeat }
  /** `runState` is the honest, unflattened outcome; `status` stays two-valued
   *  for the consumers that already switch on it. Read `runState`. */
  | { type: 'done'; status: 'completed' | 'failed'; ms: number; error?: string; runState?: RunState; runId?: string };


/* ── authority envelope (GET /workflows/:id/envelope) ─────────────
   Computed by the service from the graph and its own capability manifest.
   The renderer never derives risk: it reads it. */

/** The Capability Fabric's risk scale. Distinct from this file's
 *  `RiskLevel`, which is the code-action scale ('safe'|'medium'|'high'). */
export type CapabilityRisk = 'low' | 'medium' | 'high';

export type PermissionScope =
  | 'project.read' | 'project.write' | 'process.execute' | 'network.outbound'
  | 'account.authorize' | 'resource.destroy' | 'system.modify' | 'aura.read' | 'aura.write';

export interface EnvelopeCapability {
  capabilityId: string;
  name: string;
  risk: CapabilityRisk;
  irreversible: boolean;
  permissions: PermissionScope[];
  nodeIds: string[];
}

export interface EnvelopeScope {
  scope: PermissionScope;
  label: string;
  capabilityIds: string[];
  nodeIds: string[];
  risk: CapabilityRisk;
}

export interface AuthorityEnvelope {
  capabilities: EnvelopeCapability[];
  scopes: EnvelopeScope[];
  /** Scopes NOT requested. The load-bearing half of the envelope. */
  notRequested: PermissionScope[];
  /** Plain sentence naming what this workflow can never do. */
  cannot: string;
  hasIrreversible: boolean;
  highestRisk: CapabilityRisk | null;
  hosts: { known: string[]; dynamic: boolean };
  offlineCapable: boolean;
  auraInternalEffects: { nodeId: string; type: string }[];
  unknownNodes: string[];
}

export interface EnvelopeDiff {
  widened: boolean;
  addedScopes: PermissionScope[];
  removedScopes: PermissionScope[];
  addedCapabilities: string[];
  removedCapabilities: string[];
  newlyIrreversible: boolean;
  summary: string | null;
}

/* ── dry run (POST /workflows/:id/dry-run) ────────────────────────
   A plan, not a prediction. The service evaluates policy and invokes
   nothing; `sideEffects` on the report is its own proof of that, and the
   UI shows the service's words rather than a promise of its own. */

/** Whether a step is certain to run, or depends on run-time data. */
export type Reachability = 'certain' | 'conditional' | 'unreachable';

/** What kind of effect a node has, as the service classifies it. */
export type NodeClass = 'pure' | 'control' | 'intelligence' | 'aura-internal' | 'governed';

export interface PolicyEvaluation {
  decision: 'auto-execute' | 'ask-user' | 'require-approval' | 'deny';
  /** Why, in plain language. */
  reason: string;
  /** Which rule produced it: `risk-default:low`, `override`, … */
  rule: string;
  risk: CapabilityRisk;
}

export interface PlannedStep {
  order: number;
  nodeId: string;
  type: string;
  label: string;
  nodeClass: NodeClass;
  reachability: Reachability;
  depth: number;
  capabilityId?: string;
  capabilityName?: string;
  risk?: string;
  irreversible?: boolean;
  /** The Fabric's pre-flight answer. Absent when the node causes no effect. */
  policy?: PolicyEvaluation;
  wouldAskHuman?: boolean;
  wouldBeDenied?: boolean;
  /** Human phrase for the action, built from unresolved config. */
  describes?: string;
  /** Why the arguments could not be planned, when they could not. */
  planError?: string;
  maxIterations?: number;
  needsNetwork?: boolean;
  secretsUsed?: string[];
}

export interface ValidationFinding {
  level: 'error' | 'warning' | 'advice';
  layer: 'schema' | 'graph' | 'policy' | 'secrets';
  message: string;
  nodeId?: string;
}

export interface WorkflowValidationReport {
  valid: boolean;
  findings: ValidationFinding[];
  envelope: AuthorityEnvelope;
  secretsReferenced: string[];
  secretsMissing: string[];
  requiresReview: boolean;
}

export interface DryRunReport {
  workflowId: string;
  workflowName: string;
  projectId: string;
  at: string;
  validation: WorkflowValidationReport;
  envelope: AuthorityEnvelope;
  plan: PlannedStep[];
  approvalsRequired: { nodeId: string; capabilityId: string; reason: string; rule: string }[];
  /** Non-empty means this run cannot finish as written. */
  denials: { nodeId: string; capabilityId: string; reason: string; rule: string }[];
  wouldRunUnattended: boolean;
  offlineCapable: boolean;
  secretsRequired: string[];
  secretsMissing: string[];
  grants: { read: boolean; write: boolean; execute: boolean; autonomous: boolean };
  /**
   * The service's own proof of inertness. Displayed verbatim — the UI
   * never asserts "nothing happened" on its own authority.
   */
  sideEffects: { invocations: 0; policyEvaluations: number; note: string };
}

/* ── agent contract (GET /agent/bounds · GET /agent/tools) ────────
   Both computed server-side on purpose: a client that decided either for
   itself would be deciding authority, and its answer would stop matching
   what the runtime enforces. */

export interface AgentBoundsContract {
  maxIterations: number;
  timeoutMs: number;
  maxTokens: number;
  tools: string[];
  maxConsecutiveFailures: number;
}

export interface AgentToolsResult {
  /** Capability ids an agent in this workflow may actually request. */
  allowed: string[];
  /** Everything refused, with the service's own reason. Never swallowed. */
  refused: { capabilityId: string; reason: string }[];
  envelope: AuthorityEnvelope;
  /** The tool descriptions the model would be given. */
  describe: { name: string; description: string; input: { name: string; type: string; required: boolean; description: string }[] }[];
}

/* ── versions (GET/POST /workflows/:id/versions) ──────────────────── */

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  number: number;
  name: string;
  createdAt: string;
  createdBy: string;
  note?: string;
  graphHash: string;
  nodeCount: number;
  restoredFrom?: string;
}

export interface WorkflowVersion extends WorkflowVersionSummary {
  description: string;
  nodes: WfNode[];
  edges: WfEdge[];
}

/* ── runs (GET /workflows/:id/runs) ───────────────────────────────── */

export type RunState =
  | 'queued' | 'running' | 'awaiting-approval'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';

export type NodeState =
  | 'queued' | 'running' | 'awaiting-approval' | 'succeeded'
  | 'failed' | 'denied' | 'skipped' | 'cancelled' | 'timed-out';

/**
 * A pointer from a run into the Capability Fabric's audit trail. A
 * reference on purpose — the audit trail stays the single authority on
 * what an invocation was and whether it worked.
 */
export interface EvidenceRef {
  invocationId: string;
  capabilityId: string;
  outcome: string;
  decision: string;
  decisionRule: string;
  risk: string;
  /** Null when the capability has no mechanical check. */
  verified: boolean | null;
  approvalId?: string;
  nodeId?: string;
  at: string;
  durationMs: number;
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
  output?: { text: string; data?: unknown; files?: string[]; port?: string; truncated?: boolean };
  attempts: number;
  evidence: EvidenceRef[];
  approval?: { requestId: string; capabilityId: string; requestedAt: string; summary: string };
  /**
   * The agent ledger, for an agent node.
   *
   * Persisted on the run because a trace is meaningless outside the run
   * that produced it. The service types it `unknown` so its run module
   * need not depend on the agent module; the shape is `AgentTrace` from
   * `screens/workflows/agent/types`, narrowed at the one place it is read.
   */
  agentTrace?: unknown;
}

export type RunTriggerKind = 'manual' | 'webhook' | 'automation' | 'mission' | 'resume';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  versionId: string;
  workflowName: string;
  projectId: string;
  projectPath: string;
  state: RunState;
  trigger: { kind: RunTriggerKind } & Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  ms: number;
  error?: string;
  nodes: Record<string, NodeRunRecord>;
  vars: Record<string, string>;
  inputs: Record<string, string>;
  outputs: { nodeId: string; title: string; text: string }[];
  evidence: EvidenceRef[];
  resumable: boolean;
  notResumableReason?: string;
  /**
   * The run that picked this one up — the back link of a resume chain.
   *
   * A resume is a NEW run, deliberately: a run executes one version, has
   * one wall clock, and owns one partition of the audit trail. So one
   * logical execution is one or more records, chained.
   *
   * Its presence is what makes a parked run stop being *pending*. The
   * `state` is left at `awaiting-approval` because that is still the
   * honest description of how this leg ended — so any list of "waiting for
   * you" work must exclude superseded runs by this field rather than by
   * state. See `docs/AGENT_RESUME_SEMANTICS.md`.
   */
  supersededBy?: string;
  supersededAt?: string;
  log: { at: string; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string }[];
}


export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  versionId: string;
  workflowName: string;
  projectId: string;
  state: RunState;
  trigger: RunTriggerKind;
  createdAt: string;
  finishedAt?: string;
  ms: number;
  nodeCount: number;
  succeededCount: number;
  failedCount: number;
  evidenceCount: number;
  approvalCount: number;
  resumable: boolean;
  error?: string;
  /** Set when another run continued this one. See `WorkflowRun.supersededBy`. */
  supersededBy?: string;
}


/* ── Context Fabric ───────────────────────────────────────────────
   Mirrors `@aura/ai-service`'s context contract. Declared here, like
   every other service shape in this file, because the renderer is a
   separate compilation unit from the node service and does not import
   it. The service remains the authority; this is its wire shape. */

/** fresh = current · stale = the repo moved · unknown = never established. */
export type ContextFreshness = 'fresh' | 'stale' | 'unknown';

export interface ContextSection<T> {
  value: T | null;
  freshness: ContextFreshness;
  generatedAt: string | null;
  reason?: string;
}

export type ContextSurface =
  | 'general' | 'coding' | 'debugging' | 'architecture'
  | 'git' | 'testing' | 'mission' | 'planning' | 'review';

export type CapabilityAvailability = 'available' | 'approval' | 'not-drivable' | 'unavailable';

export interface ContextView {
  contractVersion: 1;
  contextVersion: number | null;
  composedAt: string;
  surface: ContextSurface;
  freshness: ContextFreshness;
  project: {
    id: string; name: string; root: string; type: string;
    language: string; mounted: boolean; lastOpenedAt: string | null;
  };
  repository: ContextSection<{
    identity: { name: string; purpose: string; repositoryType: string; primaryLanguage: string; architectureStyle: string; frameworks: string[]; entryPoints: string[] } | null;
    modules: { name: string; path: string; fileCount: number; description: string }[];
    totalFiles: number | null;
    entryPoints: string[];
    profile: { architectureStyle: string; designPatterns: string[]; keyDecisions: string[] } | null;
    health: { score: { overall: number } } | null;
  }>;
  changes: ContextSection<{ velocity: number; hotspots: { file: string; score: number; reason: string }[]; patterns: string[] }>;
  git: ContextSection<{ branch: string; dirty: boolean; changedFiles: number; recentCommits: { hash: string; date: string; subject: string }[] }>;
  environment: ContextSection<{ os: string; arch: string; tools: { id: string; name: string; capabilities: string[]; version: string | null; internal: boolean }[]; providedCapabilities: string[] }>;
  capabilities: ContextSection<{ id: string; name: string; risk: string; availability: CapabilityAvailability; rule?: string; reason?: string }[]>;
  missions: ContextSection<{ id: string; text: string; createdAt: string; category: string; status: string | null; taskCount: number; completedTasks: number; approved: boolean }[]>;
  activity: ContextSection<{ at: string; capabilityId: string; actor: string; nodeId?: string; outcome: string; decision: string }[]>;
  constraints: { id: string; text: string }[];
}

export interface ContextUnavailable {
  contractVersion: 1;
  status: 'unavailable';
  projectId: string;
  reason: string;
}

export const contextUnavailable = (r: ContextView | ContextUnavailable): r is ContextUnavailable =>
  (r as ContextUnavailable).status === 'unavailable';

const jget = <T>(p: string): Promise<T> => fetch(BASE + p).then((r) => r.json() as Promise<T>);
const jsend = <T>(method: string, p: string, body?: unknown): Promise<T> =>
  fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<T>);
const jpost = <T>(p: string, body: unknown): Promise<T> => jsend<T>('POST', p, body);

/**
 * Read one workflow run's SSE stream.
 *
 * Shared by `runWorkflow` and `resumeWorkflowRun` because a resume emits
 * exactly the same events a run does — the whole point of the service's
 * design is that a resumed run is not a different kind of thing.
 *
 * Never throws: a transport failure is delivered as a terminal `done`
 * event, so a caller that only handles events cannot be left hanging.
 */
async function streamRun(
  url: string,
  body: unknown,
  onEvent: (e: WfRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    onEvent({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message || 'Service unreachable' });
    return;
  }
  if (!res.body) { onEvent({ type: 'done', status: 'failed', ms: 0, error: 'No stream body' }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
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
}

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
  codeAction: (req: CodeActionRequest) => jpost<CodeActionResponse>('/code/action', req),

  /* BYOAK providers */
  getProviders: () => jget<ProvidersResult>('/providers'),
  connectProvider: (providerId: string, apiKey: string) => jpost<{ ok: boolean; fingerprint?: string; models?: { id: string; name: string }[]; error?: string }>('/providers/connect', { providerId, apiKey }),
  disconnectProvider: (providerId: string) => jpost<{ ok: boolean }>('/providers/disconnect', { providerId }),
  switchProvider: (providerId: string, model?: string) => jpost<{ ok: boolean; status: ProviderStatus; error?: string }>('/providers/switch', { providerId, model }),
  discoverModels: (providerId: string, apiKey: string) => jpost<{ models: { id: string; name: string }[] }>(`/providers/models`, { providerId, apiKey }),

  /* projects */
  listProjects: () => jget<{ projects: ProjectRecord[]; current: ProjectRecord | null }>('/projects'),
  addProject: (path: string, name?: string) => jpost<{ project: ProjectRecord; profile: ProjectProfile } | { error: string }>('/projects', { path, name }),
  openProject: (id: string) => jpost<{ project: ProjectRecord; profile: ProjectProfile; status: IndexStatus } | { error: string }>(`/projects/${id}/open`, {}),
  renameProject: (id: string, name: string) => jsend<ProjectRecord>('PATCH', `/projects/${id}`, { name }),
  favoriteProject: (id: string, favorite: boolean) => jsend<ProjectRecord>('PATCH', `/projects/${id}`, { favorite }),
  removeProject: (id: string) => jsend<{ ok: boolean }>('DELETE', `/projects/${id}`),
  profile: (id: string) => jget<ProjectProfile>(`/projects/${id}/profile`),
  indexStatus: () => jget<IndexStatus>('/index'),

  /* context fabric — read-only, always explicitly project-scoped */
  contextView: (id: string, surface: ContextSurface = 'general') =>
    jget<ContextView | ContextUnavailable>(`/projects/${id}/context?surface=${surface}`),
  /** The rendered agent contract for a project. Never composed in the UI. */
  contextContract: (id: string, surface: ContextSurface = 'general') =>
    jget<{ projectId: string; surface: ContextSurface; contract: string } | { error: string }>(
      `/projects/${id}/context/contract?surface=${surface}`,
    ),

  /* graph + retrieval */
  graph: () => jget<GraphView>('/graph'),
  knowledgeGraph: (id: string) => jget<KnowledgeGraph>(`/projects/${id}/graph`),
  projectIntelligence: (id: string) => jget<ProjectIntelligence>(`/projects/${id}/intelligence`),
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
  /** What this workflow is permitted to do, computed by the service from
   *  its own capability manifest. The renderer never derives risk. */
  workflowEnvelope: (id: string) =>
    jget<{ envelope: AuthorityEnvelope; diff: EnvelopeDiff | null }>(`/workflows/${id}/envelope`),

  /**
   * What this workflow would do, without doing any of it.
   *
   * The service plans the graph, asks the policy engine about every
   * governed step and invokes nothing. Throws nothing on a bad request —
   * the caller checks for `error` in the body.
   */
  dryRunWorkflow: (id: string, input: { projectId?: string; inputs?: Record<string, string>; versionId?: string } = {}) =>
    jpost<DryRunReport | { error: string }>(`/workflows/${id}/dry-run`, input),

  /** Schema, graph, policy and secret findings for the saved definition. */
  validateWorkflow: (id: string) => jget<WorkflowValidationReport | { error: string }>(`/workflows/${id}/validate`),

  /** The defaults a new agent node starts from, and the ceilings the
   *  runtime clamps every configuration to. */
  agentBounds: () => jget<{ defaults: AgentBoundsContract; ceilings: AgentBoundsContract }>('/agent/bounds'),

  /**
   * Which tools an agent inside this workflow could actually be given.
   *
   * With nothing requested the service reports what the workflow's own
   * envelope could offer — the selectable set. With a request list it
   * reports which survive and why the rest do not.
   */
  agentTools: (workflowId: string, requested?: string[]) => {
    const q = new URLSearchParams({ workflowId });
    if (requested?.length) q.set('requested', requested.join(','));
    return jget<AgentToolsResult | { error: string }>(`/agent/tools?${q.toString()}`);
  },

  /* versions — history is append-only; restoring publishes a new one */
  workflowVersions: (id: string) => jget<{ versions: WorkflowVersionSummary[] }>(`/workflows/${id}/versions`),
  workflowVersion: (id: string, versionId: string) => jget<WorkflowVersion>(`/workflows/${id}/versions/${versionId}`),
  publishWorkflowVersion: (id: string, note?: string) => jpost<WorkflowVersion>(`/workflows/${id}/versions`, { note }),
  restoreWorkflowVersion: (id: string, versionId: string) =>
    jpost<WorkflowVersion | { error: string }>(`/workflows/${id}/versions/${versionId}/restore`, {}),

  /* runs — persisted by the service, so history survives this window */
  workflowRuns: (id: string) => jget<{ runs: WorkflowRunSummary[] }>(`/workflows/${id}/runs`),
  workflowRun: (id: string, runId: string) => jget<WorkflowRun>(`/workflows/${id}/runs/${runId}`),
  /**
   * Every leg of one logical execution, oldest first.
   *
   * Navigable from either end — hand it any leg and it walks back to the
   * head and forward to the tail. This is how a UI renders one execution
   * from several records without stitching ids together itself.
   */
  workflowRunChain: (id: string, runId: string) =>
    jget<{ chain: WorkflowRunSummary[] }>(`/workflows/${id}/runs/${runId}/chain`),

  cancelWorkflowRun: (id: string, runId: string) =>
    jpost<{ cancelled: boolean }>(`/workflows/${id}/runs/${runId}/cancel`, {}),

  ensureWorkflowWebhook: (id: string) => jpost<{ token: string; path: string } | { error: string }>(`/workflows/${id}/webhook-token`, {}),
  rotateWorkflowWebhook: (id: string) => jpost<{ token: string; path: string } | { error: string }>(`/workflows/${id}/webhook-token`, { rotate: true }),

  /** Pick a stopped run up where it left off. Same event shape as a run. */
  async resumeWorkflowRun(
    id: string,
    runId: string,
    onEvent: (e: WfRunEvent) => void,
    signal?: AbortSignal,
    approvedCapabilities?: string[],
  ): Promise<void> {
    return streamRun(`${BASE}/workflows/${id}/runs/${runId}/resume`, { approvedCapabilities }, onEvent, signal);
  },

  async runWorkflow(id: string, inputs: Record<string, string>, onEvent: (e: WfRunEvent) => void, signal?: AbortSignal): Promise<void> {
    return streamRun(`${BASE}/workflows/${id}/run`, { inputs }, onEvent, signal);
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
