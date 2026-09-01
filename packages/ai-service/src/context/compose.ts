/**
 * AURA Context Fabric — composition
 * ==================================================================
 * This is a FACADE. It computes no repository understanding of its own.
 * Every value it returns is projected from an authority that already
 * owns that fact:
 *
 *   identity, modules, profile, health   → intelligence/*  (loaders only)
 *   context version                      → intelligence/versioning.ts
 *   staleness rule                       → intelligence/index.ts isCacheStale
 *   change intelligence                  → intelligence/changeIntelligence.ts
 *   git                                  → mission/gitSignals.ts (read-only)
 *   project root / identity              → projects.ts ProjectRegistry
 *   environment                          → the caller's last observed scan
 *   capabilities                         → @aura/capability-fabric
 *   missions                             → mission/store.ts MissionStore
 *   activity                             → CapabilityFabric.audit()
 *
 * Three hard rules, enforced by construction:
 *
 *   1. **One project.** Composition takes one project id, resolves it
 *      through the registry, and derives every section from that
 *      project's own root. Facts that cannot be attributed to it are
 *      reported `unknown` rather than borrowed from elsewhere.
 *
 *   2. **Read-only.** Nothing here writes, spawns, mounts, indexes or
 *      snapshots. It calls `load*` and `get*`, never `generate*`,
 *      `save*` or `createVersion`. Composing context can never change
 *      what the context describes.
 *
 *   3. **No rescans.** The environment is supplied by the caller from
 *      the scan it already performed. Staleness uses one `stat` (the
 *      engine's own rule), not a repository walk.
 */

import os from 'node:os';
import path from 'node:path';

import type { ProjectRegistry } from '../projects';
import type { MissionStore } from '../mission/store';
import { loadProfile } from '../profile';

import { loadIdentity, identityNeedsRegeneration } from '../intelligence/identity';
import { loadRepositorySummary } from '../intelligence/moduleSummarizer';
import { loadRepositoryProfile } from '../intelligence/repositoryMemory';
import { loadRepositoryHealth } from '../intelligence/healthEngine';
import { getCurrentVersion } from '../intelligence/versioning';
import { isCacheStale } from '../intelligence';
import {
  loadChangeLog, analyzeChangePatterns, getChangeVelocity, detectHotspots,
  type ChangeLog,
} from '../intelligence/changeIntelligence';
import { gatherGitStatus, gatherRecentCommits } from '../mission/gitSignals';

import {
  CAPABILITY_MANIFEST,
  type CapabilityFabric,
  type InvocationContext,
} from '@aura/capability-fabric';

import type {
  ContextActivity, ContextCapability, CapabilityAvailability,
  ContextChanges, ContextConstraint, ContextEnvironment, ContextGit,
  ContextMission, ContextProject, ContextRepository, ContextResult,
  ContextSurface, Freshness, Section,
} from './types';

/* ══════════════════════════════════════════════════════════════════
   Input ports — what the caller must already have observed
   ══════════════════════════════════════════════════════════════════ */

/**
 * The environment as the caller last measured it. Supplied rather than
 * scanned: `server.ts` already holds the result of the one environment
 * scanner, and composing context must never trigger a second scan.
 */
export interface EnvironmentSnapshot {
  scannedAt: string | null;
  /** Present nodes in catalogue order. */
  nodes: { id: string; name: string; capabilities: string[]; version?: string; internal?: boolean }[];
  providedCapabilities: string[];
}

export interface ContextSources {
  registry: ProjectRegistry;
  missions: MissionStore;
  /** The project the pipeline currently has mounted, if any. Never changed here. */
  mountedProjectId: string | null;
  /** Null when the Fabric is not attached — capabilities then read `unknown`. */
  fabric: CapabilityFabric | null;
  /** Null when nothing has been scanned yet — environment then reads `unknown`. */
  environment: EnvironmentSnapshot | null;
}

export interface ComposeOptions {
  surface?: ContextSurface;
  /**
   * A git snapshot the caller already took. Supplied to avoid re-reading
   * the same repository twice in one request.
   */
  git?: ContextGit | null;
  /** Skip the git read entirely (git then reads `unknown`). */
  includeGit?: boolean;
  /** How many audit records to project. Bounded to keep the view compact. */
  activityLimit?: number;
  /** How many missions to project. */
  missionLimit?: number;
}

/* ══════════════════════════════════════════════════════════════════
   Freshness helpers
   ══════════════════════════════════════════════════════════════════ */

const unknown = <T>(reason: string): Section<T> =>
  ({ value: null, freshness: 'unknown', generatedAt: null, reason });

/**
 * Grade an artifact using the engine's OWN staleness rule, so the Fabric
 * can never call something fresh that the engine would regenerate.
 */
function grade(generatedAt: string | null | undefined, root: string): SectionGrade {
  if (!generatedAt) return { freshness: 'unknown', generatedAt: null, reason: 'never computed' };
  return isCacheStale(generatedAt, root)
    ? { freshness: 'stale', generatedAt, reason: 'the repository changed after this was computed' }
    : { freshness: 'fresh', generatedAt };
}

interface SectionGrade {
  freshness: Freshness;
  generatedAt: string | null;
  reason?: string;
}

/** The worst of several gradings — a view is only as fresh as its weakest known part. */
function worst(grades: Freshness[]): Freshness {
  if (grades.includes('stale')) return 'stale';
  if (grades.includes('fresh')) return 'fresh';
  return 'unknown';
}

/* ══════════════════════════════════════════════════════════════════
   Section projections
   ══════════════════════════════════════════════════════════════════ */

/** L0/L1/L2 — identity, modules, architecture profile, health scores. */
function projectRepository(projectId: string, root: string): Section<ContextRepository> {
  const identity = loadIdentity(projectId);
  const summary = loadRepositorySummary(projectId);
  const profile = loadRepositoryProfile(projectId);
  const health = loadRepositoryHealth(projectId);

  if (!identity && !summary && !profile && !health) {
    return unknown('the repository has not been indexed yet');
  }

  // Identity has its own regeneration test — prefer it over the generic
  // timestamp rule, because it is the check the engine actually applies.
  const identityStale = identity ? identityNeedsRegeneration(projectId, root) : false;
  const grades: SectionGrade[] = [
    identity
      ? (identityStale
          ? { freshness: 'stale', generatedAt: identity.generatedAt, reason: 'the project fingerprint changed' }
          : { freshness: 'fresh', generatedAt: identity.generatedAt })
      : { freshness: 'unknown', generatedAt: null, reason: 'identity never computed' },
    grade(summary?.generatedAt, root),
    grade(profile?.generatedAt, root),
    grade(health?.generatedAt, root),
  ];

  const newest = grades
    .map((g) => g.generatedAt)
    .filter((t): t is string => !!t)
    .sort()
    .pop() ?? null;

  const value: ContextRepository = {
    identity,
    // Modules are reduced to orientation only. The full summary can be
    // hundreds of entries; an agent needs to know the shape, then look.
    modules: (summary?.modules ?? []).slice(0, 24).map((m) => ({
      name: m.name,
      path: m.path,
      fileCount: m.fileCount,
      description: m.description,
    })),
    totalFiles: summary?.totalFiles ?? null,
    entryPoints: identity?.entryPoints ?? [],
    profile,
    health: health ? { score: health.score } : null,
  };

  const stale = grades.filter((g) => g.freshness === 'stale');
  return {
    value,
    freshness: worst(grades.map((g) => g.freshness)),
    generatedAt: newest,
    reason: stale.length ? stale[0].reason : undefined,
  };
}

/**
 * L3 — change intelligence, scoped to this project.
 *
 * The change log is a single workspace-wide file whose entries carry a
 * file path but no project id. Attribution is therefore by path prefix.
 * When entries exist but none are absolute paths they cannot be
 * attributed to any project, and this reports `unknown` rather than
 * silently lending another project's history to this one.
 */
function projectChanges(root: string): Section<ContextChanges> {
  const log = loadChangeLog();
  if (!log) return unknown('no change history has been recorded');

  const attributable = log.entries.filter((e) => path.isAbsolute(e.file));
  if (log.entries.length > 0 && attributable.length === 0) {
    return unknown('recorded changes carry no absolute path, so they cannot be attributed to this project');
  }

  const scopedEntries = attributable.filter(
    (e) => e.file === root || e.file.startsWith(root + path.sep),
  );
  // Re-run the existing analysers over the project-scoped slice, so the
  // maths stays owned by changeIntelligence.ts rather than copied here.
  const scoped: ChangeLog = { entries: scopedEntries, patterns: [], generatedAt: log.generatedAt };

  return {
    value: {
      velocity: getChangeVelocity(scoped),
      hotspots: detectHotspots(scoped).slice(0, 8),
      patterns: analyzeChangePatterns(scoped).slice(0, 6).map((p) => p.pattern),
    },
    freshness: 'fresh',
    generatedAt: log.generatedAt,
  };
}

/** L4 — git, read through the existing read-only signal gatherers. */
async function projectGit(root: string): Promise<Section<ContextGit>> {
  const status = await gatherGitStatus(root);
  const at = new Date().toISOString();
  if (!status.available) {
    return { value: null, freshness: 'unknown', generatedAt: null, reason: status.reason };
  }
  const recentCommits = await gatherRecentCommits(root, 5);
  return {
    value: {
      branch: status.branch,
      dirty: status.dirty,
      changedFiles: status.changedFiles,
      recentCommits,
    },
    // Git is read live at composition time, so it is fresh by construction.
    freshness: 'fresh',
    generatedAt: at,
  };
}

/** L4 — the machine, from the caller's already-observed scan. */
function projectEnvironment(snapshot: EnvironmentSnapshot | null): Section<ContextEnvironment> {
  if (!snapshot || !snapshot.scannedAt) {
    return unknown('the environment has not been scanned yet');
  }
  return {
    value: {
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      // Version is the probe's own output. No credential, token or
      // environment variable is read here — only what a `--version` said.
      tools: snapshot.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        capabilities: n.capabilities,
        version: n.version ?? null,
        internal: n.internal ?? false,
      })),
      providedCapabilities: [...snapshot.providedCapabilities].sort(),
    },
    freshness: 'fresh',
    generatedAt: snapshot.scannedAt,
  };
}

/**
 * L4 — what can actually be done right now.
 *
 * Read straight from the Capability Fabric: the manifest for the list,
 * `isSupported` for whether an executor exists, and `evaluate` for the
 * real policy decision including node routing. No capability registry is
 * duplicated and nothing is executed.
 */
function projectCapabilities(
  fabric: CapabilityFabric | null,
  projectId: string,
  root: string,
): Section<ContextCapability[]> {
  if (!fabric) return unknown('the capability fabric is not attached to this service');

  const context: InvocationContext = {
    actor: { kind: 'system', id: 'context-fabric' },
    projectId,
    cwd: root,
  };

  const value: ContextCapability[] = CAPABILITY_MANIFEST.map((cap) => {
    if (!fabric.isSupported(cap.id)) {
      return {
        id: cap.id, name: cap.name, risk: cap.risk,
        availability: 'not-drivable' as CapabilityAvailability,
        reason: 'no executor is registered for this capability',
      };
    }

    const evaluation = fabric.evaluate(cap.id, context);
    if (!evaluation) {
      return {
        id: cap.id, name: cap.name, risk: cap.risk,
        availability: 'unavailable' as CapabilityAvailability,
        reason: 'the fabric does not describe this capability',
      };
    }

    let availability: CapabilityAvailability;
    if (evaluation.decision === 'deny') {
      // `node-unsupported` is the honest "installed but AURA cannot drive
      // it" case — e.g. a catalogued coding agent with no verified
      // non-interactive invocation. It is not the same as absent, and the
      // difference decides whether "install it" is useful advice.
      availability = evaluation.rule === 'node-unsupported' ? 'not-drivable' : 'unavailable';
    } else if (evaluation.decision === 'auto-execute') {
      availability = 'available';
    } else {
      availability = 'approval';
    }

    return {
      id: cap.id,
      name: cap.name,
      risk: cap.risk,
      availability,
      rule: evaluation.rule,
      reason: evaluation.reason,
    };
  });

  return { value, freshness: 'fresh', generatedAt: new Date().toISOString() };
}

/**
 * L4 — missions, from the one MissionStore.
 *
 * Reports execution-level status only. The mission model has no per-task
 * RUNNING state, so no task is ever described as "working" — the count of
 * genuinely completed tasks is reported instead.
 */
function projectMissions(missions: MissionStore, projectId: string, limit: number): Section<ContextMission[]> {
  let list;
  try {
    list = missions.list(projectId);
  } catch {
    return unknown('the mission store could not be read');
  }

  const value: ContextMission[] = list.slice(0, limit).map((m) => ({
    id: m.id,
    text: m.text,
    createdAt: m.createdAt,
    category: m.category,
    status: m.execution?.status ?? null,
    taskCount: m.taskCount,
    completedTasks: countCompleted(missions, projectId, m.id),
    approved: m.approval?.status === 'approved',
  }));

  return { value, freshness: 'fresh', generatedAt: new Date().toISOString() };
}

/** Terminal task states only. `proposed` is not progress; it is a question. */
function countCompleted(missions: MissionStore, projectId: string, missionId: string): number {
  const record = missions.get(projectId, missionId);
  const tasks = record?.goalGraph?.tasks ?? [];
  return tasks.filter((t) => t.status === 'accepted' || t.status === 'done').length;
}

/**
 * L4 — recent activity, projected from the Capability Fabric's audit
 * trail. This is a read of the existing authority; no activity record is
 * created, copied or persisted here.
 *
 * The trail is in-memory and therefore covers this service process only.
 * That limit is reported honestly rather than papered over: an empty
 * trail after a restart is `fresh` and empty, because the authority
 * genuinely holds nothing.
 */
function projectActivity(
  fabric: CapabilityFabric | null,
  projectId: string,
  limit: number,
): Section<ContextActivity[]> {
  if (!fabric) return unknown('the capability fabric is not attached to this service');

  const value = fabric.audit()
    .filter((r) => r.projectId === projectId)
    .slice(-limit)
    .reverse()
    .map((r) => ({
      at: r.at,
      capabilityId: r.capabilityId,
      actor: r.actor.kind,
      nodeId: r.executedNodeId ?? r.nodeId,
      outcome: r.outcome,
      decision: r.decision,
    }));

  return { value, freshness: 'fresh', generatedAt: new Date().toISOString() };
}

/**
 * Constraints an agent must obey. Each one is derived from an observed
 * fact, not from advice: the root comes from the registry, the approval
 * rule from the policy floors that genuinely exist, and the uncommitted
 * -work warning only appears when git actually reports a dirty tree.
 */
function projectConstraints(project: ContextProject, git: ContextGit | null, freshness: Freshness): ContextConstraint[] {
  const out: ContextConstraint[] = [
    {
      id: 'project-boundary',
      text: `All work belongs to the project "${project.name}" rooted at ${project.root}. Do not read or modify files outside this root.`,
    },
    {
      id: 'governed-execution',
      text: 'Execution is governed by the AURA Capability Fabric. High-risk capabilities require explicit human approval and cannot be self-authorized.',
    },
    {
      id: 'no-fabrication',
      text: 'The facts in this context were computed by AURA. Where a section is marked unknown, treat it as not established — do not substitute an assumption.',
    },
  ];

  if (git?.dirty) {
    out.push({
      id: 'uncommitted-work',
      text: `The working tree has ${git.changedFiles} uncommitted change(s) on branch "${git.branch}". Never reset, clean, stash, checkout over or discard this work.`,
    });
  }

  if (freshness === 'stale') {
    out.push({
      id: 'stale-context',
      text: 'Part of this context is stale: the repository changed after it was computed. Verify against the files before relying on the affected sections.',
    });
  }

  return out;
}

/* ══════════════════════════════════════════════════════════════════
   The composer
   ══════════════════════════════════════════════════════════════════ */

/**
 * Compose one project's `ContextView`.
 *
 * Resolves the project through the registry — the single project
 * authority — and never mounts, opens or touches it. An unresolvable id
 * yields an explicit `unavailable` result so a caller can never read
 * "no such project" as "an empty project".
 */
export async function composeContextView(
  projectId: string,
  sources: ContextSources,
  options: ComposeOptions = {},
): Promise<ContextResult> {
  const record = sources.registry.get(projectId);
  if (!record) {
    return { contractVersion: 1, status: 'unavailable', projectId, reason: `no project is registered with id "${projectId}"` };
  }

  const root = record.path;
  const profile = loadProfile(projectId);

  const project: ContextProject = {
    id: record.id,
    name: record.name,
    root,
    type: profile?.type ?? record.type,
    language: profile?.primaryLanguage ?? record.language,
    mounted: sources.mountedProjectId === record.id,
    lastOpenedAt: record.lastOpenedAt,
  };

  const surface = options.surface ?? 'general';
  const includeGit = options.includeGit ?? true;

  const repository = projectRepository(projectId, root);
  const changes = projectChanges(root);
  const environment = projectEnvironment(sources.environment);
  const capabilities = projectCapabilities(sources.fabric, projectId, root);
  const missions = projectMissions(sources.missions, projectId, options.missionLimit ?? 5);
  const activity = projectActivity(sources.fabric, projectId, options.activityLimit ?? 10);

  const git: Section<ContextGit> = options.git
    ? { value: options.git, freshness: 'fresh', generatedAt: new Date().toISOString() }
    : includeGit
      ? await projectGit(root)
      : unknown('git was not read for this request');

  /**
   * Overall freshness IS the repository understanding's freshness.
   *
   * Not a blend: live reads (git, capabilities, missions, activity) are
   * fresh by construction and would mask an unindexed project behind a
   * confident headline. And it is not the worst of everything either —
   * the workspace-wide change log is normally empty, which would pin
   * every project to `unknown` forever and make the signal useless.
   *
   * The repository artifacts are exactly what `contextVersion` snapshots,
   * so the two always describe the same thing.
   */
  const freshness: Freshness = repository.freshness;

  const version = getCurrentVersion(projectId);

  return {
    contractVersion: 1,
    contextVersion: version?.version ?? null,
    composedAt: new Date().toISOString(),
    surface,
    freshness,
    project,
    repository,
    changes,
    git,
    environment,
    capabilities,
    missions,
    activity,
    constraints: projectConstraints(project, git.value, freshness),
  };
}
