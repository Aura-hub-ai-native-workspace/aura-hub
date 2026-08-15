/**
 * ContextView — AURA's canonical read model of "what do we know about the
 * project we are working on right now?"
 * ==================================================================
 * WHAT THIS IS
 * ------------------------------------------------------------------
 * One bounded, normalized answer, composed from the systems that already
 * own each fact. Every Workspace surface — the Context panel, Ask AURA,
 * and later any agent — reads THIS, so they cannot disagree about the
 * project, and a user never has to re-explain their repository.
 *
 * WHAT THIS IS NOT
 * ------------------------------------------------------------------
 * It is not an authority. It owns no facts and persists nothing. Each
 * field is a projection of a system that remains the single authority for
 * it:
 *
 *   project        ← ProjectRegistry            (projects.ts)
 *   repository     ← Repository Intelligence    (intelligence/*)
 *   freshness      ← the per-project index diff (intelligence/performance.ts)
 *   git            ← mission/gitSignals.ts
 *   environment    ← scanEnvironment            (environment.ts)
 *   tools          ← the node catalogue + Capability Fabric
 *   mission        ← MissionStore               (mission/store.ts)
 *   agents         ← the node catalogue + provider registry
 *
 * If a fact is wrong, it is wrong at its authority — never fix it here.
 * Adding a field that no existing system owns is the signal that a new
 * authority is being smuggled in through the read model.
 *
 * BOUNDEDNESS
 * ------------------------------------------------------------------
 * This is deliberately NOT "everything we could collect". A ContextView is
 * meant to be small enough to hand to a model or render in a panel without
 * further filtering, so every list here is capped at its source. The
 * caps live in compose.ts as named constants, not scattered magic numbers.
 */

/* ── Freshness ───────────────────────────────────────────────────── */

/**
 * Whether the understanding behind this view still describes the tree.
 *
 * `unknown` is a real answer, not a failure: it means AURA has not yet
 * derived understanding for this project (nothing indexed), so it is
 * neither current nor out of date. It must never be shown as "fresh".
 */
export type FreshnessState = 'fresh' | 'stale' | 'unknown';

export interface ContextFreshness {
  state: FreshnessState;
  /** When the underlying intelligence artifacts were generated. */
  generatedAt: string | null;
  /** Plain-language reason for `stale`/`unknown`. Null when fresh. */
  reason: string | null;
  /** File deltas since the artifacts were generated (Phase A index diff). */
  changedFiles: number;
  addedFiles: number;
  removedFiles: number;
  /**
   * True when the file scan hit its cap, so the deltas describe a prefix of
   * the tree rather than the tree. Surfaced rather than hidden: a silently
   * truncated scan reads as "nothing changed".
   */
  truncated: boolean;
}

/* ── Sections ────────────────────────────────────────────────────── */

export interface ProjectContext {
  id: string;
  name: string;
  root: string;
  type: string;
  language: string;
  /**
   * Whether the service currently has THIS project mounted. False means the
   * view was composed for a project the backend is not indexing, which is
   * legitimate but worth knowing before trusting `repository`.
   */
  mounted: boolean;
}

export interface RepositoryModule {
  name: string;
  path: string;
  description: string;
}

export interface RepositoryContext {
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
  modules: RepositoryModule[];
  /**
   * How much understanding exists.
   *   ready   — identity AND a module summary are available
   *   partial — one of them is
   *   absent  — neither; the project has not been analysed yet
   */
  intelligence: 'ready' | 'partial' | 'absent';
}

export interface GitCommit {
  hash: string;
  subject: string;
  date: string;
}

/**
 * `available: false` is normal (not a git repo, git not installed) and
 * carries the reason rather than an empty branch that reads as "no branch".
 */
export interface GitContext {
  available: boolean;
  branch: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
  recentCommits: GitCommit[];
  reason: string | null;
}

export interface EnvironmentNodeRef {
  id: string;
  name: string;
  version: string | null;
}

export interface EnvironmentContext {
  os: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  shell: string | null;
  /** Nodes that answered a probe on this machine. Capped. */
  presentNodes: EnvironmentNodeRef[];
  presentCount: number;
  catalogueCount: number;
  /** When the environment was last scanned. Null means never this session. */
  scannedAt: string | null;
}

export interface ToolsContext {
  /** Capability ids something present can actually provide. */
  available: string[];
  /**
   * Capability ids the catalogue knows about but nothing present provides.
   * Capped — this is a prompt for the user, not an inventory.
   */
  missing: string[];
}

export interface AgentRef {
  id: string;
  name: string;
  version: string | null;
  /**
   * Whether AURA has a verified non-interactive invocation for it. A present
   * coding agent AURA cannot drive is reported present and NOT drivable,
   * never quietly omitted.
   */
  drivable: boolean;
}

export interface AgentsContext {
  codingAgents: AgentRef[];
  /**
   * The connected model provider. NEVER the key or any part of it — only
   * whether one is configured. See the redaction note in compose.ts.
   */
  provider: { id: string | null; connected: boolean; model: string | null };
}

export interface MissionRef {
  id: string;
  text: string;
  status: string;
  createdAt: string;
}

export interface MissionContext {
  /** The most recent mission for this project, if any. */
  active: MissionRef | null;
  total: number;
  pendingApprovals: number;
}

export interface ActivityEvent {
  at: string;
  kind: string;
  summary: string;
}

export interface ActivityContext {
  events: ActivityEvent[];
}

export interface ContextConstraint {
  id: string;
  text: string;
}

/* ── The view ────────────────────────────────────────────────────── */

export interface ContextView {
  /**
   * The project's index version, from the existing versioning engine
   * (intelligence/versioning.ts). It moves only when AURA's understanding
   * changes, so an unchanged number across two views is meaningful.
   */
  contextVersion: number;
  /** When THIS view was composed (not when the understanding was derived). */
  generatedAt: string;
  freshness: ContextFreshness;

  project: ProjectContext;
  repository: RepositoryContext;
  git: GitContext;
  environment: EnvironmentContext;
  tools: ToolsContext;
  agents: AgentsContext;
  mission: MissionContext;
  activity: ActivityContext;
  constraints: ContextConstraint[];

  /** Wall-clock cost of composing this view, in ms. */
  buildMs: number;
}
