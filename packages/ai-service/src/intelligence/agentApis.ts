/**
 * Agent Foundation APIs
 * ==================================================================
 * Core APIs for AI agents to interact with the repository:
 * - Read file contents
 * - Search code
 * - Get project context
 * - Execute commands
 * - Manage workspace
 */

import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS, LANG_BY_EXT } from './constants';
import type { ProjectIdentity, RepositorySummary, RepositoryProfile, ProjectGlossary } from './types';

export interface AgentContext {
  projectId: string;
  root: string;
  identity: ProjectIdentity | null;
  summary: RepositorySummary | null;
  profile: RepositoryProfile | null;
  glossary: ProjectGlossary | null;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
  lastModified: string;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  context: string;
}

export interface ProjectInfo {
  name: string;
  description: string;
  language: string;
  frameworks: string[];
  entryPoints: string[];
  modules: string[];
}

/**
 * Read a file's contents.
 */
export function readFile(root: string, filePath: string): FileContent | null {
  const fullPath = path.resolve(root, filePath);

  // Security check - prevent path traversal
  if (!fullPath.startsWith(root)) {
    return null;
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const stat = fs.statSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();

    return {
      path: path.relative(root, fullPath),
      content,
      language: LANG_BY_EXT[ext] ?? 'unknown',
      size: stat.size,
      lastModified: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Search for a pattern in the codebase.
 */
export function searchCode(
  root: string,
  pattern: string,
  options: {
    maxResults?: number;
    filePattern?: string;
    caseSensitive?: boolean;
  } = {},
): SearchResult[] {
  const { maxResults = 50, filePattern, caseSensitive = false } = options;
  const results: SearchResult[] = [];
  const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');

  const scanFile = (filePath: string) => {
    if (results.length >= maxResults) return;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    const relPath = path.relative(root, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;

      if (regex.test(lines[i])) {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const context = lines.slice(start, end).join('\n');

        results.push({
          file: relPath,
          line: i + 1,
          content: lines[i].trim(),
          context,
        });
      }

      // Reset regex lastIndex
      regex.lastIndex = 0;
    }
  };

  const scanDir = (dir: string) => {
    if (results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;

      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(full);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (filePattern && !e.name.match(filePattern)) continue;
        if (LANG_BY_EXT[ext]) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);
  return results;
}

/**
 * Get project information.
 */
export function getProjectInfo(context: AgentContext): ProjectInfo {
  return {
    name: context.identity?.name ?? path.basename(context.root),
    description: context.identity?.purpose ?? context.identity?.description ?? '',
    language: context.identity?.primaryLanguage ?? 'unknown',
    frameworks: context.identity?.frameworks ?? [],
    entryPoints: context.identity?.entryPoints ?? [],
    modules: context.summary?.modules.map(m => m.name) ?? [],
  };
}

/**
 * List files in a directory.
 */
export function listFiles(
  root: string,
  dirPath: string = '.',
  options: {
    recursive?: boolean;
    maxDepth?: number;
    filePattern?: string;
  } = {},
): string[] {
  const { recursive = false, maxDepth = 3, filePattern } = options;
  const files: string[] = [];
  const fullPath = path.resolve(root, dirPath);

  // Security check
  if (!fullPath.startsWith(root)) {
    return [];
  }

  const scanDir = (dir: string, depth: number) => {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;

      const full = path.join(dir, e.name);
      const relPath = path.relative(root, full);

      if (e.isDirectory()) {
        files.push(`${relPath}/`);
        if (recursive) {
          scanDir(full, depth + 1);
        }
      } else {
        if (filePattern && !e.name.match(filePattern)) continue;
        files.push(relPath);
      }
    }
  };

  scanDir(fullPath, 0);
  return files;
}

/**
 * Get directory structure as a tree.
 */
export function getDirectoryTree(
  root: string,
  dirPath: string = '.',
  maxDepth: number = 3,
): Record<string, unknown> {
  const fullPath = path.resolve(root, dirPath);

  // Security check
  if (!fullPath.startsWith(root)) {
    return {};
  }

  const scanDir = (dir: string, depth: number): Record<string, unknown> => {
    if (depth > maxDepth) return {};

    const result: Record<string, unknown> = {};
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return {};
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;

      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        result[`${e.name}/`] = scanDir(full, depth + 1);
      } else {
        result[e.name] = null;
      }
    }

    return result;
  };

  return scanDir(fullPath, 0);
}

/**
 * Check if a file exists.
 */
export function fileExists(root: string, filePath: string): boolean {
  const fullPath = path.resolve(root, filePath);

  // Security check
  if (!fullPath.startsWith(root)) {
    return false;
  }

  return fs.existsSync(fullPath);
}

/**
 * Get file statistics.
 */
export function getFileInfo(root: string, filePath: string): {
  exists: boolean;
  size?: number;
  lastModified?: string;
  isDirectory?: boolean;
} {
  const fullPath = path.resolve(root, filePath);

  // Security check
  if (!fullPath.startsWith(root)) {
    return { exists: false };
  }

  try {
    const stat = fs.statSync(fullPath);
    return {
      exists: true,
      size: stat.size,
      lastModified: stat.mtime.toISOString(),
      isDirectory: stat.isDirectory(),
    };
  } catch {
    return { exists: false };
  }
}
