/**
 * AURA Context Fabric — the contract
 * ==================================================================
 * A `ContextView` is ONE project's understanding, at ONE moment, in a
 * shape that every downstream surface (Ask AURA, the Workspace context
 * panel, a delegated CLI agent) can consume without re-deriving it.
 *
 * This module defines vocabulary only. It computes nothing.
 *
 * Two rules govern every field here:
 *
 *   1. **Unknown is not empty.** A section that was never computed is
 *      `unknown`; a section that was computed and found nothing is
 *      `fresh` with an empty payload. Collapsing the two would let an
 *      agent read "no recent commits" when the truth is "nobody looked".
 *
 *   2. **Nothing is invented.** Every value is projected from an
 *      existing authority — Repository Intelligence, the project
 *      registry, the environment scan, the Capability Fabric, the
 *      MissionStore, the audit trail. Where an authority cannot answer,
 *      the field is `unknown` and says why.
 *
 * The Context Fabric is READ-ONLY. Nothing in this vocabulary describes
 * a mutation, and nothing that consumes it may perform one.
 */

import type {
  ProjectIdentity,
  RepositoryHealth,
  RepositoryIntentType,
  RepositoryProfile,
} from '../intelligence/types';

/* ══════════════════════════════════════════════════════════════════
   Freshness
   ══════════════════════════════════════════════════════════════════ */

/**
 * How much a reader may trust a section.
 *
 *   fresh   — computed, and nothing has changed since
 *   stale   — computed, but the repository moved underneath it
 *   unknown — never computed, or the authority could not answer
 *
 * `unknown` must never be rendered as `fresh`. A downstream agent that
 * mistakes "not looked at" for "current" is the precise failure this
 * three-state model exists to prevent.
 */
export type Freshness = 'fresh' | 'stale' | 'unknown';

/** One section's provenance, carried beside its payload. */
export interface SectionMeta {
  freshness: Freshness;
  /** When the underlying authority last produced this. */
  generatedAt: string | null;
  /** Why it is stale or unknown. Absent when fresh. */
  reason?: string;
}

/** A section that may legitimately have no answer yet. */
export interface Section<T> extends SectionMeta {
  value: T | null;
}

/* ══════════════════════════════════════════════════════════════════
   Layers — the existing intelligence hierarchy, exposed
   ══════════════════════════════════════════════════════════════════ */

/**
 * L0 — identity. Tiny, always attempted, cheap enough to always carry.
 * Projected from `intelligence/identity.ts` + the project registry.
 */
export interface ContextProject {
  id: string;
  name: string;
  /** Absolute path from the registry. Never guessed. */
  root: string;
  /** Registry-detected coarse type; `identity` refines it when present. */
  type: string;
  language: string;
  /** True when this project is the one the pipeline currently has mounted. */
  mounted: boolean;
  lastOpenedAt: string | null;
}

/** L1/L2 — repository structure and architecture. */
export interface ContextRepository {
  /** From `intelligence/identity.ts`. */
  identity: ProjectIdentity | null;
  /** From `intelligence/moduleSummarizer.ts`, reduced to names + counts. */
  modules: { name: string; path: string; fileCount: number; description: string }[];
  totalFiles: number | null;
  entryPoints: string[];
  /** From `intelligence/repositoryMemory.ts`. */
  profile: RepositoryProfile | null;
  /** From `intelligence/healthEngine.ts`. Scores only — never the full issue list. */
  health: Pick<RepositoryHealth, 'score'> | null;
}

/** L3 — change intelligence. What moved recently and where the risk sits. */
export interface ContextChanges {
  velocity: number;
  hotspots: { file: string; score: number; reason: string }[];
  patterns: string[];
}

/** L4 — current operational state: git, environment, capabilities, missions. */
export interface ContextGit {
  branch: string;
  dirty: boolean;
  changedFiles: number;
  recentCommits: { hash: string; date: string; subject: string }[];
}

/**
 * A tool AURA measured on this machine. Version comes from the probe;
 * credentials never appear here in any form.
 */
export interface ContextTool {
  id: string;
  name: string;
  /** Node capabilities this tool provides, e.g. `coding-agent`. */
  capabilities: string[];
  version: string | null;
  /**
   * True for AURA's own subsystems (catalogue `transport: 'internal'`),
   * false for programs on the machine. An agent must not read "Mission
   * Control" as an executable it could invoke like `git`.
   */
  internal: boolean;
}

export interface ContextEnvironment {
  os: string;
  arch: string;
  /** Present nodes, in catalogue order — the routing tie-break order. */
  tools: ContextTool[];
  /** Node capabilities provided by at least one present tool. */
  providedCapabilities: string[];
}

/**
 * Why a capability can or cannot be used right now.
 *
 *   available     — routable and executable today
 *   approval      — routable, but policy gates it on a human
 *   not-drivable  — a node provides it, but AURA cannot drive that node
 *   unavailable   — nothing present provides what it needs
 */
export type CapabilityAvailability = 'available' | 'approval' | 'not-drivable' | 'unavailable';

export interface ContextCapability {
  id: string;
  name: string;
  risk: 'low' | 'medium' | 'high';
  availability: CapabilityAvailability;
  /** The policy engine's own rule name, when it spoke. Never paraphrased. */
  rule?: string;
  /** Why it is unavailable or gated, in the authority's own words. */
  reason?: string;
}

/**
 * Mission projection. Deliberately narrow: the mission model has no
 * per-task RUNNING state (see the Master Handoff §9), so this reports
 * only what `MissionExecution.status` genuinely knows and leaves the
 * rest `unknown` rather than inventing "working".
 */
export interface ContextMission {
  id: string;
  text: string;
  createdAt: string;
  category: string;
  /** Execution-level status. `null` when the mission never produced a plan. */
  status: string | null;
  taskCount: number;
  /** Tasks in a terminal accepted/done state. */
  completedTasks: number;
  approved: boolean;
}

/**
 * One recorded thing that happened, projected from the Capability
 * Fabric's audit trail. Never a duplicate store — this is a read.
 */
export interface ContextActivity {
  at: string;
  /** The capability that ran. */
  capabilityId: string;
  /** Who asked: `human`, `agent`, `system`. */
  actor: string;
  /** The node that actually did the work, when attributable. */
  nodeId?: string;
  outcome: string;
  decision: string;
}

/**
 * A rule the consuming agent must obey. These are facts about how AURA
 * governs work, not advice — they are rendered into the agent contract
 * verbatim so an agent cannot claim it was not told.
 */
export interface ContextConstraint {
  id: string;
  text: string;
}

/* ══════════════════════════════════════════════════════════════════
   Surfaces — the existing intent vocabulary, not a new one
   ══════════════════════════════════════════════════════════════════ */

/**
 * Which slice of understanding a caller wants. Each surface maps onto a
 * `RepositoryIntentType` already understood by
 * `intelligence/contextAssembler.ts`, so this introduces no second
 * intent system — it is a caller-facing alias for the existing one.
 */
export type ContextSurface =
  | 'general'
  | 'coding'
  | 'debugging'
  | 'architecture'
  | 'git'
  | 'testing'
  | 'mission'
  | 'planning'
  | 'review';

/** Surface → the existing repository intent. One-way, total, explicit. */
export const SURFACE_INTENT: Record<ContextSurface, RepositoryIntentType> = {
  general: 'project_overview',
  coding: 'code_search',
  debugging: 'debugging',
  architecture: 'architecture',
  git: 'project_overview',
  testing: 'testing',
  mission: 'project_overview',
  planning: 'architecture',
  review: 'refactoring',
};

/* ══════════════════════════════════════════════════════════════════
   The view
   ══════════════════════════════════════════════════════════════════ */

/**
 * Everything AURA knows about ONE project, right now, with the
 * provenance of each part attached.
 *
 * A `ContextView` never mixes projects. Composition takes exactly one
 * project id and every section is derived from that project alone.
 */
export interface ContextView {
  /** Contract version of this shape itself — bump on a breaking change. */
  contractVersion: 1;
  /**
   * The project's context version, from `intelligence/versioning.ts`.
   * `null` when no snapshot has ever been taken — never a fabricated 0.
   */
  contextVersion: number | null;
  /** When this view was composed. */
  composedAt: string;
  /** Which slice was requested. */
  surface: ContextSurface;
  /** The worst freshness across all known sections. */
  freshness: Freshness;

  project: ContextProject;
  repository: Section<ContextRepository>;
  changes: Section<ContextChanges>;
  git: Section<ContextGit>;
  environment: Section<ContextEnvironment>;
  capabilities: Section<ContextCapability[]>;
  missions: Section<ContextMission[]>;
  activity: Section<ContextActivity[]>;
  constraints: ContextConstraint[];
}

/**
 * A project that could not be resolved. Returned instead of a view so a
 * caller can never mistake "no such project" for "an empty project".
 */
export interface ContextUnavailable {
  contractVersion: 1;
  status: 'unavailable';
  projectId: string;
  reason: string;
}

export type ContextResult = ContextView | ContextUnavailable;

export function isUnavailable(r: ContextResult): r is ContextUnavailable {
  return (r as ContextUnavailable).status === 'unavailable';
}
