/**
 * signals — Mission Control Stage 3, Project Analysis. 100%
 * deterministic, zero model calls. Composes real signals already
 * computed elsewhere in this app (the repository Health Engine, the
 * architecture-layer extractor, Change Intelligence's hotspot
 * detector) plus real, freshly-run, bounded scans this stage owns
 * (git status/history, technical debt markers, a pattern-based
 * security scan, dependency pinning) — Mission Control never invents
 * a new numeric simulator; every signal here is either real-computed
 * or honestly reported unavailable.
 *
 * Note on `hotspots`/`changeVelocity`: Change Intelligence's log is a
 * single global file (`~/.aura/changes/log.json`), not scoped per
 * project — the same real, pre-existing limitation every other screen
 * in this app that surfaces this signal already lives with.
 */
import { loadRepositoryHealth } from '../intelligence/healthEngine';
import type { WorkspaceManager } from '../workspace';
import { scanSecurityFindings, scanTechnicalDebt, summarizeDependencies } from './codeScan';
import { gatherGitStatus, gatherRecentCommits } from './gitSignals';
import type { MissionSignals } from './types';

export async function gatherMissionSignals(manager: WorkspaceManager, projectId: string, projectPath: string, excludeMissionId?: string): Promise<MissionSignals> {
  // Calling projectIntelligence() first ensures the health report is
  // generated (and cached to disk) as a side effect if it doesn't exist yet.
  const intel = manager.projectIntelligence(projectId);
  const health = loadRepositoryHealth(projectId);

  const [gitStatus, recentCommits] = await Promise.all([
    gatherGitStatus(projectPath),
    gatherRecentCommits(projectPath),
  ]);
  const { markers: technicalDebt } = scanTechnicalDebt(projectPath);
  const { findings: securityFindings } = scanSecurityFindings(projectPath);
  const dependencySummary = summarizeDependencies(projectPath);
  const openMissions = manager.missions.list(projectId)
    .filter((m) => m.id !== excludeMissionId && m.approval.status !== 'rejected');

  return {
    health: health?.score ?? null,
    healthIssues: health?.issues ?? [],
    architectureLayers: manager.resolveArchitectureLayers(projectId).layers,
    hotspots: intel?.change.hotspots ?? [],
    changeVelocity: intel?.change.velocity ?? 0,
    verificationScore: intel?.verification.overallScore ?? 0,
    verificationRecommendations: intel?.verification.recommendations ?? [],
    securityFindings,
    buildStatus: { available: false, reason: 'Mission planning does not execute the project build — run it manually to verify.' },
    gitStatus,
    recentCommits,
    technicalDebt,
    openMissions,
    dependencySummary,
  };
}
