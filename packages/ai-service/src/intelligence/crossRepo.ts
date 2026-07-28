/**
 * Cross-Repository Graph
 * ==================================================================
 * Manages relationships between multiple repositories:
 * - Dependency graphs
 * - Shared code detection
 * - API contracts
 * - Monorepo relationships
 */

import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import type { WorkspaceGraph, WorkspaceRepository } from './workspace';

const CROSS_REPO_FILE = homePath('cross-repo', 'graph.json');

export interface CrossRepoGraph {
  repositories: WorkspaceRepository[];
  edges: CrossRepoEdge[];
  clusters: RepositoryCluster[];
  generatedAt: string;
}

export interface CrossRepoEdge {
  source: string;
  target: string;
  type: 'dependency' | 'shared-code' | 'api-contract' | 'monorepo' | 'circular';
  weight: number; // 0-1
  metadata?: Record<string, unknown>;
}

export interface RepositoryCluster {
  id: string;
  name: string;
  repositoryIds: string[];
  relationship: string;
}

/**
 * Load the cross-repository graph.
 */
export function loadCrossRepoGraph(): CrossRepoGraph | null {
  return readJsonFile<CrossRepoGraph | null>(CROSS_REPO_FILE, null);
}

/**
 * Save the cross-repository graph.
 */
export function saveCrossRepoGraph(graph: CrossRepoGraph): void {
  writeJsonFile(CROSS_REPO_FILE, graph);
}

/**
 * Build a cross-repository graph from workspace data.
 */
export function buildCrossRepoGraph(workspace: WorkspaceGraph): CrossRepoGraph {
  const edges: CrossRepoEdge[] = [];
  const clusters: RepositoryCluster[] = [];

  // Convert workspace dependencies to cross-repo edges
  for (const dep of workspace.dependencies) {
    edges.push({
      source: dep.source,
      target: dep.target,
      type: dep.type as CrossRepoEdge['type'],
      weight: dep.strength,
    });
  }

  // Detect shared code patterns
  const sharedCodeEdges = detectSharedCode(workspace);
  edges.push(...sharedCodeEdges);

  // Detect monorepo clusters
  const monorepoCluster = detectMonorepoCluster(workspace);
  if (monorepoCluster) {
    clusters.push(monorepoCluster);
  }

  // Detect language clusters
  const languageClusters = detectLanguageClusters(workspace);
  clusters.push(...languageClusters);

  const graph: CrossRepoGraph = {
    repositories: workspace.repositories,
    edges,
    clusters,
    generatedAt: new Date().toISOString(),
  };

  saveCrossRepoGraph(graph);
  return graph;
}

/**
 * Detect shared code between repositories.
 */
function detectSharedCode(workspace: WorkspaceGraph): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  // Simple heuristic: repos with same name patterns likely share code
  for (let i = 0; i < workspace.repositories.length; i++) {
    for (let j = i + 1; j < workspace.repositories.length; j++) {
      const a = workspace.repositories[i];
      const b = workspace.repositories[j];

      // Check for shared naming patterns
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();

      if (aName.includes(bName) || bName.includes(aName)) {
        edges.push({
          source: a.id,
          target: b.id,
          type: 'shared-code',
          weight: 0.5,
          metadata: { reason: 'name-similarity' },
        });
      }
    }
  }

  return edges;
}

/**
 * Detect monorepo clusters.
 */
function detectMonorepoCluster(workspace: WorkspaceGraph): RepositoryCluster | null {
  // Group repos by parent directory
  const parentGroups = new Map<string, string[]>();

  for (const repo of workspace.repositories) {
    const parent = path.dirname(repo.path);
    const existing = parentGroups.get(parent) ?? [];
    existing.push(repo.id);
    parentGroups.set(parent, existing);
  }

  // Find largest group
  let largestGroup: string[] = [];
  for (const group of parentGroups.values()) {
    if (group.length > largestGroup.length) {
      largestGroup = group;
    }
  }

  if (largestGroup.length < 2) return null;

  return {
    id: 'monorepo',
    name: 'Monorepo',
    repositoryIds: largestGroup,
    relationship: 'monorepo',
  };
}

/**
 * Detect language-based clusters.
 */
function detectLanguageClusters(workspace: WorkspaceGraph): RepositoryCluster[] {
  const clusters: RepositoryCluster[] = [];
  const langGroups = new Map<string, string[]>();

  for (const repo of workspace.repositories) {
    const existing = langGroups.get(repo.primaryLanguage) ?? [];
    existing.push(repo.id);
    langGroups.set(repo.primaryLanguage, existing);
  }

  for (const [lang, repoIds] of langGroups) {
    if (repoIds.length >= 2) {
      clusters.push({
        id: `lang-${lang.toLowerCase()}`,
        name: `${lang} Repositories`,
        repositoryIds: repoIds,
        relationship: 'same-language',
      });
    }
  }

  return clusters;
}

/**
 * Find paths between two repositories.
 */
export function findPath(
  graph: CrossRepoGraph,
  source: string,
  target: string,
): string[] | null {
  const visited = new Set<string>();
  const queue: string[][] = [[source]];

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];

    if (current === target) return path;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of graph.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push([...path, edge.target]);
      }
      if (edge.target === current && !visited.has(edge.source)) {
        queue.push([...path, edge.source]);
      }
    }
  }

  return null;
}

/**
 * Get graph statistics.
 */
export function getGraphStats(graph: CrossRepoGraph): {
  totalRepositories: number;
  totalEdges: number;
  totalClusters: number;
  edgeTypes: Record<string, number>;
  averageConnectivity: number;
} {
  const edgeTypes: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgeTypes[edge.type] = (edgeTypes[edge.type] ?? 0) + 1;
  }

  const connectivity = graph.repositories.map(r => {
    return graph.edges.filter(e => e.source === r.id || e.target === r.id).length;
  });

  const averageConnectivity = connectivity.length > 0
    ? connectivity.reduce((a, b) => a + b, 0) / connectivity.length
    : 0;

  return {
    totalRepositories: graph.repositories.length,
    totalEdges: graph.edges.length,
    totalClusters: graph.clusters.length,
    edgeTypes,
    averageConnectivity,
  };
}
