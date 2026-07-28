/**
 * Multi-Repository Intelligence
 * ==================================================================
 * Manages intelligence across multiple repositories:
 * - Workspace graph (relationships between repos)
 * - Cross-repository dependency tracking
 * - Shared patterns across repos
 * - Repository groupings
 */

import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import type { ProjectIdentity } from './types';

const WORKSPACE_FILE = homePath('workspace', 'graph.json');

export interface WorkspaceRepository {
  id: string;
  path: string;
  name: string;
  type: string;
  primaryLanguage: string;
  frameworks: string[];
  lastIndexed: string;
}

export interface RepositoryDependency {
  source: string;
  target: string;
  type: 'npm' | 'import' | 'api' | 'shared' | 'monorepo';
  strength: number; // 0-1
}

export interface WorkspaceGraph {
  repositories: WorkspaceRepository[];
  dependencies: RepositoryDependency[];
  groups: RepositoryGroup[];
  generatedAt: string;
}

export interface RepositoryGroup {
  name: string;
  description: string;
  repositoryIds: string[];
}

/**
 * Load the workspace graph.
 */
export function loadWorkspaceGraph(): WorkspaceGraph | null {
  return readJsonFile<WorkspaceGraph | null>(WORKSPACE_FILE, null);
}

/**
 * Save the workspace graph.
 */
export function saveWorkspaceGraph(graph: WorkspaceGraph): void {
  writeJsonFile(WORKSPACE_FILE, graph);
}

/**
 * Add or update a repository in the workspace graph.
 */
export function upsertRepository(
  id: string,
  root: string,
  identity: ProjectIdentity | null,
): WorkspaceGraph {
  const graph = loadWorkspaceGraph() ?? {
    repositories: [],
    dependencies: [],
    groups: [],
    generatedAt: new Date().toISOString(),
  };

  const existing = graph.repositories.findIndex(r => r.id === id);
  const repo: WorkspaceRepository = {
    id,
    path: root,
    name: identity?.name ?? path.basename(root),
    type: identity?.repositoryType ?? 'unknown',
    primaryLanguage: identity?.primaryLanguage ?? 'unknown',
    frameworks: identity?.frameworks ?? [],
    lastIndexed: new Date().toISOString(),
  };

  if (existing >= 0) {
    graph.repositories[existing] = repo;
  } else {
    graph.repositories.push(repo);
  }

  graph.generatedAt = new Date().toISOString();
  saveWorkspaceGraph(graph);
  return graph;
}

/**
 * Remove a repository from the workspace graph.
 */
export function removeRepository(id: string): WorkspaceGraph | null {
  const graph = loadWorkspaceGraph();
  if (!graph) return null;

  graph.repositories = graph.repositories.filter(r => r.id !== id);
  graph.dependencies = graph.dependencies.filter(d => d.source !== id && d.target !== id);
  graph.groups.forEach(g => {
    g.repositoryIds = g.repositoryIds.filter(rid => rid !== id);
  });

  graph.generatedAt = new Date().toISOString();
  saveWorkspaceGraph(graph);
  return graph;
}

/**
 * Detect dependencies between repositories based on shared patterns.
 */
export function detectCrossRepoDependencies(
  graph: WorkspaceGraph,
): RepositoryDependency[] {
  const deps: RepositoryDependency[] = [];

  // Detect monorepo relationships
  for (let i = 0; i < graph.repositories.length; i++) {
    for (let j = i + 1; j < graph.repositories.length; j++) {
      const a = graph.repositories[i];
      const b = graph.repositories[j];

      // Check if paths indicate monorepo relationship
      if (a.path.startsWith(path.dirname(b.path)) || b.path.startsWith(path.dirname(a.path))) {
        deps.push({
          source: a.id,
          target: b.id,
          type: 'monorepo',
          strength: 0.8,
        });
      }

      // Check for shared frameworks
      const sharedFrameworks = a.frameworks.filter(f => b.frameworks.includes(f));
      if (sharedFrameworks.length > 0) {
        deps.push({
          source: a.id,
          target: b.id,
          type: 'shared',
          strength: sharedFrameworks.length * 0.2,
        });
      }
    }
  }

  return deps;
}

/**
 * Find repositories in the workspace that match certain criteria.
 */
export function findRepositories(
  criteria: {
    type?: string;
    primaryLanguage?: string;
    framework?: string;
  },
): WorkspaceRepository[] {
  const graph = loadWorkspaceGraph();
  if (!graph) return [];

  return graph.repositories.filter(repo => {
    if (criteria.type && repo.type !== criteria.type) return false;
    if (criteria.primaryLanguage && repo.primaryLanguage !== criteria.primaryLanguage) return false;
    if (criteria.framework && !repo.frameworks.includes(criteria.framework)) return false;
    return true;
  });
}

/**
 * Get all dependencies for a specific repository.
 */
export function getRepositoryDependencies(
  repositoryId: string,
): { incoming: RepositoryDependency[]; outgoing: RepositoryDependency[] } {
  const graph = loadWorkspaceGraph();
  if (!graph) return { incoming: [], outgoing: [] };

  return {
    incoming: graph.dependencies.filter(d => d.target === repositoryId),
    outgoing: graph.dependencies.filter(d => d.source === repositoryId),
  };
}

/**
 * Create a group of related repositories.
 */
export function createRepositoryGroup(
  name: string,
  description: string,
  repositoryIds: string[],
): WorkspaceGraph | null {
  const graph = loadWorkspaceGraph();
  if (!graph) return null;

  // Check if group already exists
  const existing = graph.groups.find(g => g.name === name);
  if (existing) {
    existing.description = description;
    existing.repositoryIds = repositoryIds;
  } else {
    graph.groups.push({ name, description, repositoryIds });
  }

  graph.generatedAt = new Date().toISOString();
  saveWorkspaceGraph(graph);
  return graph;
}

/**
 * Get workspace statistics.
 */
export function getWorkspaceStats(): {
  totalRepositories: number;
  totalDependencies: number;
  totalGroups: number;
  languageDistribution: Record<string, number>;
  frameworkDistribution: Record<string, number>;
} {
  const graph = loadWorkspaceGraph();
  if (!graph) {
    return {
      totalRepositories: 0,
      totalDependencies: 0,
      totalGroups: 0,
      languageDistribution: {},
      frameworkDistribution: {},
    };
  }

  const languageDistribution: Record<string, number> = {};
  const frameworkDistribution: Record<string, number> = {};

  for (const repo of graph.repositories) {
    languageDistribution[repo.primaryLanguage] = (languageDistribution[repo.primaryLanguage] ?? 0) + 1;
    for (const fw of repo.frameworks) {
      frameworkDistribution[fw] = (frameworkDistribution[fw] ?? 0) + 1;
    }
  }

  return {
    totalRepositories: graph.repositories.length,
    totalDependencies: graph.dependencies.length,
    totalGroups: graph.groups.length,
    languageDistribution,
    frameworkDistribution,
  };
}
