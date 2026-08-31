/**
 * Repository Intelligence Engine
 * ==================================================================
 * AURA's core intelligence layer. Everything here executes BEFORE
 * any provider is called. Providers receive pre-assembled context.
 *
 * Pipeline:
 *   User → Intent Classification → Repository Identity → Repository Memory
 *   → Knowledge Graph → Module Summaries → Smart Retrieval
 *   → Context Assembly → Token Budget → LLM Provider
 *
 * This engine is provider-agnostic. It works identically with the built-in
 * AURA Runtime and any bring-your-own-key provider.
 */

import type { ProjectProfile } from '../profile';
import type {
  ProjectIdentity, RepositoryIntent, RepositorySummary,
  RepositoryProfile, ProjectGlossary, RepositoryHealth,
  RepositoryIntentType, PrioritizedDocument,
} from './types';

import { generateIdentity, loadIdentity, saveIdentity, identityNeedsRegeneration } from './identity';
import { classifyRepositoryIntent } from './repositoryIntent';
import { generateRepositorySummary, loadRepositorySummary } from './moduleSummarizer';
import { prioritizeDocuments } from './documentPriority';
import { assembleContext, type AssembledContext, type ContextAssemblerInput } from './contextAssembler';
import { buildGlossary, loadGlossary } from './glossary';
import { generateRepositoryHealth, loadRepositoryHealth } from './healthEngine';
import { buildRepositoryProfile, loadRepositoryProfile } from './repositoryMemory';
import { detectChanges, updateIndexState, hasChanges, LazyFileLoader } from './performance';
import { generateVerificationReport, loadVerificationReport, type VerificationReport } from './verification';
import {
  loadWorkspaceGraph, saveWorkspaceGraph, upsertRepository, removeRepository,
  detectCrossRepoDependencies, findRepositories, getRepositoryDependencies,
  createRepositoryGroup, getWorkspaceStats, type WorkspaceGraph, type WorkspaceRepository,
} from './workspace';
import {
  buildModuleHierarchy, detectEntryPoints, buildDependencyGraph, mapApiSurface,
  findUsages, type ModuleNode, type DependencyGraph, type EntryPoint, type ApiSurface,
} from './architecture';
import {
  loadChangeLog, saveChangeLog, recordChange, analyzeChangePatterns,
  calculateChangeImpact, getChangeVelocity, detectHotspots, generateChangeReport,
  type ChangeLog, type ChangeEntry, type ChangePattern, type ChangeImpact,
} from './changeIntelligence';
import {
  loadPersonality, savePersonality, detectPersonality, type RepositoryPersonality,
} from './personality';
import {
  loadVersionHistory, saveVersionHistory, createVersion, getCurrentVersion,
  getVersion, compareVersions, rollbackToVersion, generateArtifactHash,
  getVersionStats, type IndexVersion, type VersionHistory,
} from './versioning';
import {
  loadCrossRepoGraph, saveCrossRepoGraph, buildCrossRepoGraph,
  findPath, getGraphStats, type CrossRepoGraph, type CrossRepoEdge, type RepositoryCluster,
} from './crossRepo';
import {
  validateArchitecture, DEFAULT_RULES, type ValidationResult, type ValidationRule,
} from './validation';
import {
  readFile, searchCode, getProjectInfo, listFiles, getDirectoryTree,
  fileExists, getFileInfo, type AgentContext, type FileContent, type SearchResult, type ProjectInfo,
} from './agentApis';
import fs from 'node:fs';

export type {
  ProjectIdentity, RepositoryIntent, RepositorySummary, RepositoryProfile,
  ProjectGlossary, RepositoryHealth, AssembledContext, VerificationReport,
  WorkspaceGraph, WorkspaceRepository, ModuleNode, DependencyGraph, EntryPoint,
  ApiSurface, ChangeLog, ChangeEntry, ChangePattern, ChangeImpact, RepositoryPersonality,
  IndexVersion, VersionHistory, CrossRepoGraph, CrossRepoEdge, RepositoryCluster,
  ValidationResult, ValidationRule, AgentContext, FileContent, SearchResult, ProjectInfo,
};
export type { RepositoryIntentType };
export type { IndexResult } from './performance';
export {
  detectChanges, updateIndexState, hasChanges, LazyFileLoader,
  generateVerificationReport, loadVerificationReport,
  loadWorkspaceGraph, saveWorkspaceGraph, upsertRepository, removeRepository,
  detectCrossRepoDependencies, findRepositories, getRepositoryDependencies,
  createRepositoryGroup, getWorkspaceStats,
  buildModuleHierarchy, detectEntryPoints, buildDependencyGraph, mapApiSurface, findUsages,
  loadChangeLog, saveChangeLog, recordChange, analyzeChangePatterns,
  calculateChangeImpact, getChangeVelocity, detectHotspots, generateChangeReport,
  loadPersonality, savePersonality, detectPersonality,
  loadVersionHistory, saveVersionHistory, createVersion, getCurrentVersion,
  getVersion, compareVersions, rollbackToVersion, generateArtifactHash, getVersionStats,
  loadCrossRepoGraph, saveCrossRepoGraph, buildCrossRepoGraph, findPath, getGraphStats,
  validateArchitecture, DEFAULT_RULES,
  readFile, searchCode, getProjectInfo, listFiles, getDirectoryTree, fileExists, getFileInfo,
};

export interface IntelligenceEngineResult {
  intent: RepositoryIntent;
  identity: ProjectIdentity | null;
  summary: RepositorySummary | null;
  profile: RepositoryProfile | null;
  glossary: ProjectGlossary | null;
  health: RepositoryHealth | null;
  prioritizedDocs: PrioritizedDocument[];
  context: AssembledContext;
  usedIdentity: boolean;
  usedSummary: boolean;
}

/**
 * Check if cached data is stale by comparing generation time against
 * repository file modification times. Returns true if regeneration needed.
 *
 * Exported because the Context Fabric reports freshness to downstream
 * agents and must apply the SAME rule this engine uses to decide whether
 * to regenerate. Two staleness rules would let the Fabric report "fresh"
 * for an artifact the engine considers expired.
 */
export function isCacheStale(generatedAt: string, projectRoot: string, maxAgeMs: number = 3600000): boolean {
  const genTime = new Date(generatedAt).getTime();
  if (Date.now() - genTime > maxAgeMs) return true;

  // Check if any source file changed since generation
  try {
    const stats = fs.statSync(projectRoot);
    if (stats.mtimeMs > genTime) return true;
  } catch { /* ignore */ }

  return false;
}

/**
 * Run the full intelligence pipeline for a user query.
 * Returns assembled context ready for any LLM provider.
 */
export function runIntelligencePipeline(
  projectId: string,
  projectRoot: string,
  query: string,
  projectProfile: ProjectProfile | null,
  codingContext: string,
  graphContext: string,
  memoryContext: string,
  retrievedFiles: string[],
): IntelligenceEngineResult {
  // 1. Classify intent
  const intent = classifyRepositoryIntent(query);

  // 2. Load or generate identity
  let identity = loadIdentity(projectId);
  let usedIdentity = !!identity;
  if (!identity && projectProfile) {
    identity = generateIdentity(projectId, projectRoot, {
      frameworks: projectProfile.frameworks,
      has: projectProfile.has,
    });
    saveIdentity(identity);
    usedIdentity = true;
  } else if (identity && identityNeedsRegeneration(projectId, projectRoot) && projectProfile) {
    identity = generateIdentity(projectId, projectRoot, {
      frameworks: projectProfile.frameworks,
      has: projectProfile.has,
    });
    saveIdentity(identity);
  }

  // 3. Load or generate repository summary (with staleness check)
  let summary = loadRepositorySummary(projectId);
  let usedSummary = !!summary;
  if (!summary || (summary.generatedAt && isCacheStale(summary.generatedAt, projectRoot))) {
    summary = generateRepositorySummary(projectId, projectRoot, identity ? {
      name: identity.name,
      purpose: identity.purpose,
      mainModules: identity.mainModules,
    } : undefined);
    usedSummary = true;
  }

  // 4. Load or generate repository profile (memory) with staleness check
  let profile = loadRepositoryProfile(projectId);
  if (!profile || (profile.generatedAt && isCacheStale(profile.generatedAt, projectRoot))) {
    profile = buildRepositoryProfile(projectId, projectRoot);
  }

  // 5. Load or generate glossary with staleness check
  let glossary = loadGlossary(projectId);
  if (!glossary || (glossary.generatedAt && isCacheStale(glossary.generatedAt, projectRoot))) {
    glossary = buildGlossary(projectId, projectRoot);
  }

  // 6. Load or generate health with staleness check
  let health = loadRepositoryHealth(projectId);
  if (!health || (health.generatedAt && isCacheStale(health.generatedAt, projectRoot))) {
    health = generateRepositoryHealth(projectId, projectRoot, identity, summary);
  }

  // 7. Prioritize documents based on intent
  const prioritizedDocs = prioritizeDocuments(projectRoot, intent.type, projectProfile?.importantFiles);

  // 8. Assemble context
  const contextInput: ContextAssemblerInput = {
    intent,
    identity,
    summary,
    profile,
    glossary,
    health,
    prioritizedDocs,
    codingContext,
    graphContext,
    memoryContext,
    retrievedFiles,
  };
  const context = assembleContext(contextInput);

  return {
    intent,
    identity,
    summary,
    profile,
    glossary,
    health,
    prioritizedDocs,
    context,
    usedIdentity,
    usedSummary,
  };
}

/* ── Group A engines — wired: run the full intelligence surface ─────── */

export interface ProjectIntelligenceReport {
  verification: VerificationReport;
  architecture: { hierarchy: ModuleNode; dependencies: DependencyGraph; entryPoints: EntryPoint[]; apiSurface: ApiSurface };
  personality: RepositoryPersonality;
  validation: ValidationResult;
  change: { report: string; patterns: ChangePattern[]; hotspots: { file: string; score: number; reason: string }[]; velocity: number };
  versions: { totalVersions: number; currentVersion: number; oldestVersion: string | null; newestVersion: string | null; current: IndexVersion | null };
  agent: { info: ProjectInfo; tree: Record<string, unknown> };
  performance: { hasChanges: boolean; changed: number; added: number; removed: number; totalIndexed: number };
}

/** Record a version snapshot only when the repository's understanding changed. */
function snapshotVersionIfChanged(projectId: string, fingerprintSource: unknown, fileCount: number): void {
  const fingerprint = generateArtifactHash(JSON.stringify(fingerprintSource ?? {}));
  const current = getCurrentVersion(projectId);
  if (current && current.artifactHashes.understanding === fingerprint) return;
  createVersion(projectId, { understanding: fingerprint }, {
    fileCount,
    totalTokens: 0,
    lastIndexed: new Date().toISOString(),
  });
}

/**
 * Run every per-project Group A engine against a real project and return
 * one bundle: verification, architecture, personality, validation, change
 * intelligence, versioning, agent APIs and performance/change-detection.
 */
export function runProjectIntelligence(projectId: string, root: string): ProjectIntelligenceReport {
  const identity = loadIdentity(projectId);
  const summary = loadRepositorySummary(projectId);
  const profile = loadRepositoryProfile(projectId);
  const glossary = loadGlossary(projectId);
  const health = loadRepositoryHealth(projectId);

  const verification = generateVerificationReport(projectId, root, identity, summary, health, profile, glossary);
  const architecture = {
    hierarchy: buildModuleHierarchy(root),
    dependencies: buildDependencyGraph(root),
    entryPoints: detectEntryPoints(root, identity),
    apiSurface: mapApiSurface(root),
  };
  const personality = detectPersonality(projectId, root, identity, profile, glossary);
  const validation = validateArchitecture(root, identity, profile);

  const log = loadChangeLog();
  const change = log
    ? { report: generateChangeReport(log), patterns: analyzeChangePatterns(log), hotspots: detectHotspots(log), velocity: getChangeVelocity(log) }
    : { report: 'No change history recorded yet.', patterns: [] as ChangePattern[], hotspots: [] as { file: string; score: number; reason: string }[], velocity: 0 };

  snapshotVersionIfChanged(projectId, { identity, summary }, summary?.totalFiles ?? 0);
  const versions = { ...getVersionStats(projectId), current: getCurrentVersion(projectId) };

  const agent = { info: getProjectInfo({ projectId, root, identity, summary, profile, glossary }), tree: getDirectoryTree(root) };

  const p = detectChanges(projectId, root);
  const performance = { hasChanges: hasChanges(projectId, root), changed: p.changed.length, added: p.added.length, removed: p.removed.length, totalIndexed: p.totalIndexed };

  return { verification, architecture, personality, validation, change, versions, agent, performance };
}

export interface WorkspaceIntelligenceReport {
  stats: ReturnType<typeof getWorkspaceStats>;
  repositories: WorkspaceRepository[];
  crossRepo: ReturnType<typeof getGraphStats> | null;
}

/** Register every known project into the workspace graph and analyze it. */
export function runWorkspaceIntelligence(repos: { id: string; root: string }[]): WorkspaceIntelligenceReport {
  for (const r of repos) upsertRepository(r.id, r.root, loadIdentity(r.id));
  const graph = loadWorkspaceGraph();
  const cross = graph ? buildCrossRepoGraph(graph) : null;
  return {
    stats: getWorkspaceStats(),
    repositories: graph?.repositories ?? [],
    crossRepo: cross ? getGraphStats(cross) : null,
  };
}
