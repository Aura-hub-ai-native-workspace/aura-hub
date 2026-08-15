/**
 * composeContextView — the Context Fabric's composition layer.
 * ==================================================================
 * Turns the systems that already own project facts into one bounded
 * `ContextView`. It reads; it never writes, never scans the repository
 * itself, and never becomes the authority for anything it reports.
 *
 * ── Why the caller supplies live state ───────────────────────────────
 * Node presence, missions, approvals and the provider are LIVE service
 * state owned by `server.ts`/`WorkspaceManager`. If this module reached
 * for them itself it would need its own scanner, its own store handles
 * and its own provider lookup — three duplicate authorities acquired by
 * accident. They arrive as `ContextSources` instead, so composition stays
 * a pure projection of state someone else already owns.
 *
 * What this module DOES read directly is only already-persisted, per-project
 * intelligence on disk (identity, summary, version) plus git — both cheap,
 * both derived, neither an authority this module competes with.
 *
 * ── Cost ────────────────────────────────────────────────────────────
 * One `detectChanges` tree diff (Phase A: ~15ms on a 600-file repo) plus
 * two short `git` calls. It never triggers re-indexing: a stale view is
 * reported AS stale and the user refreshes through the existing
 * re-index path. Composing context must never silently start a scan.
 */

import os from 'node:os';
import type { ProjectRecord } from '../projects';
import type { ProjectProfile } from '../profile';
import type { MissionSummary } from '../mission/types';
import { loadIdentity } from '../intelligence/identity';
import { loadRepositorySummary } from '../intelligence/moduleSummarizer';
import { detectChanges, isArtifactStale, type IndexResult } from '../intelligence/performance';
import { getCurrentVersion } from '../intelligence/versioning';
import { gatherGitStatus, gatherRecentCommits } from '../mission/gitSignals';
import type {
  ContextView, ContextFreshness, RepositoryContext, GitContext,
  EnvironmentContext, ToolsContext, AgentsContext, MissionContext,
  ActivityContext, ContextConstraint, EnvironmentNodeRef, AgentRef,
} from './types';

/* ── Bounds. A ContextView is a briefing, not an inventory. ────────── */
const MAX_MODULES = 12;
const MAX_PRESENT_NODES = 40;
const MAX_MISSING_CAPABILITIES = 12;
const MAX_COMMITS = 5;
const MAX_ACTIVITY = 12;

/** A node as the environment scanner reports it. */
export interface ContextNodeRef {
  id: string;
  name: string;
  capabilities: string[];
  binary?: string;
  version?: string | null;
}

/**
 * Live service state the caller must supply. Everything here is owned by an
 * existing authority; this module only projects it.
 */
export interface ContextSources {
  /** THE canonical project, resolved from the caller's activeProjectId. */
  project: ProjectRecord;
  /** Which project the service currently has mounted (pipeline authority). */
  mountedProjectId: string | null;
  /** The project's derived profile, when the project is mounted. */
  profile: ProjectProfile | null;
  /** Nodes that answered a probe — from `scanEnvironment`, never re-probed here. */
  presentNodes: ContextNodeRef[];
  /** Capability ids something present provides. */
  providedCapabilities: string[];
  /** Every capability id the catalogue knows about. */
  knownCapabilities: string[];
  /** Size of the node catalogue, for an honest "N of M present". */
  catalogueSize: number;
  /** When the environment was last scanned. */
  scannedAt: string | null;
  /** Missions for THIS project — the existing MissionStore list projection. */
  missions: MissionSummary[];
  /** Approval requests currently awaiting a human, from the approval store. */
  pendingApprovals: number;
  /**
   * The connected provider. The caller passes id/model/connected ONLY —
   * never a key, never a fingerprint. See `assertNoSecrets` below.
   */
  provider: { id: string | null; connected: boolean; model: string | null };
  /** Coding-agent binaries AURA has a verified invocation for. */
  drivableAgentBinaries: string[];
  /** Recent activity, already projected by the caller from its own sources. */
  activity: ActivityContext['events'];
  /**
   * A tree diff already taken this request.
   *
   * Composing a view and running the intelligence pipeline both need the
   * same answer to "what changed?", and in one Ask AURA request they used
   * to walk the same tree twice. Supplying it here shares the ONE
   * observation. Composition still never rebases the baseline — that
   * remains the pipeline's job, so composing context stays read-only.
   */
  changes?: IndexResult;
}

/* ── Freshness ────────────────────────────────────────────────────── */

/**
 * Freshness is about the UNDERSTANDING, not the view. `generatedAt` is the
 * oldest artifact timestamp we have, because a view is only as current as
 * its stalest input — reporting the newest would overstate it.
 */
function composeFreshness(
  projectId: string,
  root: string,
  identityAt: string | null,
  summaryAt: string | null,
  precomputed?: IndexResult,
): { freshness: ContextFreshness; changes: IndexResult } {
  const changes = precomputed ?? detectChanges(projectId, root);

  const stamps = [identityAt, summaryAt].filter((s): s is string => !!s);
  if (stamps.length === 0) {
    return {
      changes,
      freshness: {
        state: 'unknown',
        generatedAt: null,
        reason: 'AURA has not analysed this project yet, so there is nothing to be current or out of date.',
        changedFiles: changes.changed.length,
        addedFiles: changes.added.length,
        removedFiles: changes.removed.length,
        truncated: changes.truncated,
      },
    };
  }

  const oldest = stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const stale = isArtifactStale(oldest, changes);

  const parts: string[] = [];
  if (changes.changed.length) parts.push(`${changes.changed.length} file${changes.changed.length === 1 ? '' : 's'} changed`);
  if (changes.added.length) parts.push(`${changes.added.length} added`);
  if (changes.removed.length) parts.push(`${changes.removed.length} removed`);

  return {
    changes,
    freshness: {
      state: stale ? 'stale' : 'fresh',
      generatedAt: oldest,
      reason: stale
        ? (parts.length
          ? `${parts.join(', ')} since AURA last analysed this project.`
          : 'The project changed since AURA last analysed it.')
        : null,
      changedFiles: changes.changed.length,
      addedFiles: changes.added.length,
      removedFiles: changes.removed.length,
      truncated: changes.truncated,
    },
  };
}

/* ── Sections ─────────────────────────────────────────────────────── */

function composeRepository(
  identity: ReturnType<typeof loadIdentity>,
  summary: ReturnType<typeof loadRepositorySummary>,
  profile: ProjectProfile | null,
): RepositoryContext {
  const intelligence = identity && summary ? 'ready' : identity || summary ? 'partial' : 'absent';
  return {
    purpose: identity?.purpose ?? null,
    repositoryType: identity?.repositoryType ?? null,
    architectureStyle: identity?.architectureStyle ?? null,
    primaryLanguage: identity?.primaryLanguage ?? profile?.primaryLanguage ?? null,
    secondaryLanguages: identity?.secondaryLanguages ?? [],
    frameworks: identity?.frameworks ?? profile?.frameworks ?? [],
    buildSystem: identity?.buildSystem ?? null,
    packageManager: profile?.packageManager ?? null,
    mainModules: identity?.mainModules ?? [],
    entryPoints: identity?.entryPoints ?? [],
    fileCount: summary?.totalFiles ?? profile?.fileCount ?? null,
    modules: (summary?.modules ?? []).slice(0, MAX_MODULES).map((m) => ({
      name: m.name, path: m.path, description: m.description,
    })),
    intelligence,
  };
}

async function composeGit(root: string): Promise<GitContext> {
  const status = await gatherGitStatus(root);
  if (!status.available) {
    return { available: false, branch: null, dirty: null, changedFiles: null, recentCommits: [], reason: status.reason };
  }
  const commits = await gatherRecentCommits(root, MAX_COMMITS);
  return {
    available: true,
    branch: status.branch,
    dirty: status.dirty,
    changedFiles: status.changedFiles,
    recentCommits: commits.map((c) => ({ hash: c.hash, subject: c.subject, date: c.date })),
    reason: null,
  };
}

function composeEnvironment(s: ContextSources): EnvironmentContext {
  const present: EnvironmentNodeRef[] = s.presentNodes
    .slice(0, MAX_PRESENT_NODES)
    .map((n) => ({ id: n.id, name: n.name, version: n.version ?? null }));
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    shell: process.env.SHELL ?? null,
    presentNodes: present,
    presentCount: s.presentNodes.length,
    catalogueCount: s.catalogueSize,
    scannedAt: s.scannedAt,
  };
}

function composeTools(s: ContextSources): ToolsContext {
  const have = new Set(s.providedCapabilities);
  return {
    available: [...have].sort(),
    missing: s.knownCapabilities.filter((c) => !have.has(c)).slice(0, MAX_MISSING_CAPABILITIES),
  };
}

function composeAgents(s: ContextSources): AgentsContext {
  const drivable = new Set(s.drivableAgentBinaries);
  const codingAgents: AgentRef[] = s.presentNodes
    .filter((n) => n.capabilities.includes('coding-agent'))
    .map((n) => ({
      id: n.id,
      name: n.name,
      version: n.version ?? null,
      // Present but undrivable is reported as such — never omitted, or the
      // user would think AURA can delegate to a tool it cannot actually run.
      drivable: !!n.binary && drivable.has(n.binary),
    }));
  return { codingAgents, provider: s.provider };
}

function composeMission(s: ContextSources): MissionContext {
  const mine = s.missions.filter((m) => m.projectId === s.project.id);
  const sorted = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const top = sorted[0];
  return {
    active: top
      ? {
        id: top.id,
        text: top.text,
        // Execution status when the mission got that far, otherwise the
        // approval state — both are the mission system's own vocabulary,
        // never a status invented here.
        status: top.execution?.status ?? top.approval?.status ?? 'planning',
        createdAt: top.createdAt,
      }
      : null,
    total: mine.length,
    pendingApprovals: s.pendingApprovals,
  };
}

/**
 * Constraints worth telling a human or a model BEFORE it acts. Derived, not
 * authored: each one corresponds to a real condition in this view.
 */
function composeConstraints(view: {
  freshness: ContextFreshness;
  git: GitContext;
  agents: AgentsContext;
  project: { mounted: boolean };
}): ContextConstraint[] {
  const out: ContextConstraint[] = [];
  if (view.freshness.state === 'stale') {
    out.push({ id: 'stale-understanding', text: 'AURA\'s understanding of this project is out of date. Re-index before relying on the repository summary.' });
  }
  if (view.freshness.state === 'unknown') {
    out.push({ id: 'no-understanding', text: 'This project has not been analysed yet. Repository facts are unavailable rather than empty.' });
  }
  if (view.freshness.truncated) {
    out.push({ id: 'scan-truncated', text: 'The file scan hit its cap, so change counts describe part of the tree, not all of it.' });
  }
  if (!view.project.mounted) {
    out.push({ id: 'not-mounted', text: 'This project is not currently mounted in the service, so live index status is unavailable.' });
  }
  if (view.git.available && view.git.dirty) {
    out.push({ id: 'dirty-tree', text: `The working tree has ${view.git.changedFiles} uncommitted change(s). Existing work must not be reverted or overwritten.` });
  }
  if (!view.agents.provider.connected) {
    out.push({ id: 'no-provider', text: 'No AI provider is connected, so reasoning capabilities are unavailable.' });
  }
  return out;
}

/**
 * Defence in depth against a credential reaching a prompt or a panel.
 *
 * The provider section is built from a caller-supplied triple that should
 * never contain a key, but "should never" is not a guarantee when a future
 * caller edits the shape. Anything that looks like a secret is dropped
 * loudly rather than forwarded quietly.
 */
function assertNoSecrets(provider: AgentsContext['provider']): AgentsContext['provider'] {
  const suspicious = /(^|[^a-z])(sk|api[_-]?key|token|secret|bearer)([^a-z]|$)/i;
  const bad = (v: string | null) => !!v && (suspicious.test(v) || v.length > 64);
  return {
    id: bad(provider.id) ? null : provider.id,
    connected: provider.connected,
    model: bad(provider.model) ? null : provider.model,
  };
}

/* ── The composer ─────────────────────────────────────────────────── */

export async function composeContextView(sources: ContextSources): Promise<ContextView> {
  const t0 = performance.now();
  const { project } = sources;

  // Per-project artifacts, keyed by the canonical project id. Reading them
  // by any other id is what would let one project's context describe another.
  const identity = loadIdentity(project.id);
  const summary = loadRepositorySummary(project.id);
  const version = getCurrentVersion(project.id);

  const { freshness } = composeFreshness(
    project.id,
    project.path,
    identity?.generatedAt ?? null,
    summary?.generatedAt ?? null,
    sources.changes,
  );

  const git = await composeGit(project.path);
  const agents = composeAgents(sources);
  agents.provider = assertNoSecrets(agents.provider);

  const projectSection = {
    id: project.id,
    name: project.name,
    root: project.path,
    type: project.type,
    language: project.language,
    mounted: sources.mountedProjectId === project.id,
  };

  return {
    contextVersion: version?.version ?? 0,
    generatedAt: new Date().toISOString(),
    freshness,
    project: projectSection,
    repository: composeRepository(identity, summary, sources.profile),
    git,
    environment: composeEnvironment(sources),
    tools: composeTools(sources),
    agents,
    mission: composeMission(sources),
    activity: { events: sources.activity.slice(0, MAX_ACTIVITY) },
    constraints: composeConstraints({ freshness, git, agents, project: projectSection }),
    buildMs: Math.round(performance.now() - t0),
  };
}
