/**
 * AI Index Versioning
 * ==================================================================
 * Manages versioned AI indexes for repositories:
 * - Version tracking for intelligence artifacts
 * - Incremental index updates
 * - Rollback capability
 * - Cross-repository index synchronization
 */

import { homePath, readJsonFile, writeJsonFile } from '../persist';

const VERSION_FILE = (projectId: string) => homePath('versions', `${projectId}.json`);

export interface IndexVersion {
  version: number;
  timestamp: string;
  artifactHashes: Record<string, string>; // artifact type → hash
  metadata: {
    fileCount: number;
    totalTokens: number;
    lastIndexed: string;
  };
}

export interface VersionHistory {
  projectId: string;
  versions: IndexVersion[];
  current: number;
}

/**
 * Load version history for a project.
 */
export function loadVersionHistory(projectId: string): VersionHistory | null {
  return readJsonFile<VersionHistory | null>(VERSION_FILE(projectId), null);
}

/**
 * Save version history.
 */
export function saveVersionHistory(history: VersionHistory): void {
  writeJsonFile(VERSION_FILE(history.projectId), history);
}

/**
 * Create a new index version.
 */
export function createVersion(
  projectId: string,
  artifactHashes: Record<string, string>,
  metadata: IndexVersion['metadata'],
): IndexVersion {
  const history = loadVersionHistory(projectId) ?? {
    projectId,
    versions: [],
    current: 0,
  };

  const newVersion: IndexVersion = {
    version: history.versions.length + 1,
    timestamp: new Date().toISOString(),
    artifactHashes,
    metadata,
  };

  history.versions.push(newVersion);
  history.current = newVersion.version;

  // Keep last 20 versions
  if (history.versions.length > 20) {
    history.versions = history.versions.slice(-20);
  }

  saveVersionHistory(history);
  return newVersion;
}

/**
 * Get current version.
 */
export function getCurrentVersion(projectId: string): IndexVersion | null {
  const history = loadVersionHistory(projectId);
  if (!history || history.versions.length === 0) return null;
  return history.versions[history.current - 1] ?? null;
}

/**
 * Get a specific version.
 */
export function getVersion(projectId: string, version: number): IndexVersion | null {
  const history = loadVersionHistory(projectId);
  if (!history) return null;
  return history.versions.find(v => v.version === version) ?? null;
}

/**
 * Compare two versions to detect changes.
 */
export function compareVersions(
  projectId: string,
  v1: number,
  v2: number,
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const version1 = getVersion(projectId, v1);
  const version2 = getVersion(projectId, v2);

  if (!version1 || !version2) return { added: [], removed: [], changed: [] };

  const artifacts1 = new Set(Object.keys(version1.artifactHashes));
  const artifacts2 = new Set(Object.keys(version2.artifactHashes));

  const added = [...artifacts2].filter(a => !artifacts1.has(a));
  const removed = [...artifacts1].filter(a => !artifacts2.has(a));
  const changed = [...artifacts1].filter(a =>
    artifacts2.has(a) && version1.artifactHashes[a] !== version2.artifactHashes[a]
  );

  return { added, removed, changed };
}

/**
 * Rollback to a previous version.
 */
export function rollbackToVersion(
  projectId: string,
  targetVersion: number,
): IndexVersion | null {
  const history = loadVersionHistory(projectId);
  if (!history) return null;

  const target = history.versions.find(v => v.version === targetVersion);
  if (!target) return null;

  history.current = targetVersion;
  saveVersionHistory(history);
  return target;
}

/**
 * Generate a simple hash for an artifact.
 */
export function generateArtifactHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Get version statistics.
 */
export function getVersionStats(projectId: string): {
  totalVersions: number;
  currentVersion: number;
  oldestVersion: string | null;
  newestVersion: string | null;
} {
  const history = loadVersionHistory(projectId);
  if (!history || history.versions.length === 0) {
    return { totalVersions: 0, currentVersion: 0, oldestVersion: null, newestVersion: null };
  }

  return {
    totalVersions: history.versions.length,
    currentVersion: history.current,
    oldestVersion: history.versions[0]?.timestamp ?? null,
    newestVersion: history.versions[history.versions.length - 1]?.timestamp ?? null,
  };
}
