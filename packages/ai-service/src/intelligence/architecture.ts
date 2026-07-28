/**
 * Architecture Explorer
 * ==================================================================
 * Provides deep architecture understanding:
 * - Module hierarchy visualization
 * - Dependency flow analysis
 * - Entry point detection
 * - API surface mapping
 * - Code navigation (find usages, call chains)
 */

import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS, LANG_BY_EXT } from './constants';
import type { ProjectIdentity } from './types';

export interface ModuleNode {
  name: string;
  path: string;
  type: 'module' | 'file' | 'directory';
  language?: string;
  children: ModuleNode[];
  size?: number;
  complexity?: 'low' | 'medium' | 'high';
}

export interface DependencyGraph {
  nodes: { id: string; label: string; type: string }[];
  edges: { source: string; target: string; type: string }[];
}

export interface EntryPoint {
  file: string;
  type: 'main' | 'cli' | 'server' | 'worker' | 'test' | 'config';
  description: string;
}

export interface ApiSurface {
  endpoints: ApiEndpoint[];
  classes: ApiClass[];
  functions: ApiFunction[];
}

export interface ApiEndpoint {
  path: string;
  method: string;
  file: string;
  description?: string;
}

export interface ApiClass {
  name: string;
  file: string;
  methods: string[];
  extends?: string;
}

export interface ApiFunction {
  name: string;
  file: string;
  parameters: string[];
  exported: boolean;
}

/**
 * Build a module hierarchy tree from the repository.
 */
export function buildModuleHierarchy(root: string, maxDepth: number = 5): ModuleNode {
  return buildNode(root, root, 'directory', 0, maxDepth);
}

function buildNode(
  root: string,
  fullPath: string,
  type: 'module' | 'file' | 'directory',
  depth: number,
  maxDepth: number,
): ModuleNode {
  const relPath = path.relative(root, fullPath);
  const name = path.basename(fullPath);

  const node: ModuleNode = {
    name,
    path: relPath,
    type,
    children: [],
  };

  if (type !== 'directory' || depth >= maxDepth) {
    return node;
  }

  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const childPath = path.join(fullPath, e.name);
      const childType = e.isDirectory() ? 'directory' : 'file';
      node.children.push(buildNode(root, childPath, childType, depth + 1, maxDepth));
    }
  } catch { /* ignore */ }

  return node;
}

/**
 * Detect entry points in the repository.
 */
export function detectEntryPoints(root: string, _identity: ProjectIdentity | null): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];

  // Check package.json for main/bin
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) {
        entryPoints.push({
          file: pkg.main,
          type: 'main',
          description: 'Main entry point',
        });
      }
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? { cli: pkg.bin } : pkg.bin;
        for (const [name, file] of Object.entries(bins)) {
          entryPoints.push({
            file: file as string,
            type: 'cli',
            description: `CLI command: ${name}`,
          });
        }
      }
      if (pkg.scripts?.start) {
        entryPoints.push({
          file: pkg.scripts.start,
          type: 'server',
          description: 'Start script',
        });
      }
    } catch { /* ignore */ }
  }

  // Check for common entry files
  const commonEntries = [
    { file: 'index.ts', type: 'main' as const, description: 'TypeScript entry' },
    { file: 'index.js', type: 'main' as const, description: 'JavaScript entry' },
    { file: 'main.ts', type: 'main' as const, description: 'Main TypeScript' },
    { file: 'main.py', type: 'main' as const, description: 'Python entry' },
    { file: 'app.py', type: 'server' as const, description: 'Python app' },
    { file: 'server.ts', type: 'server' as const, description: 'Server entry' },
    { file: 'worker.ts', type: 'worker' as const, description: 'Worker entry' },
  ];

  for (const entry of commonEntries) {
    if (fs.existsSync(path.join(root, entry.file))) {
      entryPoints.push(entry);
    }
  }

  // Check src/ directory
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    for (const entry of commonEntries) {
      const srcFile = path.join(srcDir, entry.file);
      if (fs.existsSync(srcFile)) {
        entryPoints.push({
          ...entry,
          file: `src/${entry.file}`,
        });
      }
    }
  }

  return entryPoints;
}

/**
 * Build a dependency graph from imports/requires.
 */
export function buildDependencyGraph(root: string): DependencyGraph {
  const nodes: DependencyGraph['nodes'] = [];
  const edges: DependencyGraph['edges'] = [];
  const processed = new Set<string>();

  const scanFile = (filePath: string) => {
    if (processed.has(filePath)) return;
    processed.add(filePath);

    const relPath = path.relative(root, filePath);
    const fileNode = {
      id: relPath,
      label: path.basename(filePath),
      type: 'file',
    };
    nodes.push(fileNode);

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    // Extract imports
    const importRegex = /(?:import|from|require)\s+.*?['"](.+?)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('.')) {
        // Local import
        const resolved = path.resolve(path.dirname(filePath), importPath);
        edges.push({
          source: relPath,
          target: path.relative(root, resolved),
          type: 'local',
        });
      } else if (importPath.startsWith('@') || !importPath.startsWith('.')) {
        // External package
        const pkgName = importPath.startsWith('@')
          ? importPath.split('/').slice(0, 2).join('/')
          : importPath.split('/')[0];
        edges.push({
          source: relPath,
          target: pkgName,
          type: 'external',
        });
      }
    }
  };

  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(full);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (LANG_BY_EXT[ext]) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);
  return { nodes, edges };
}

/**
 * Map the API surface of the repository.
 */
export function mapApiSurface(root: string): ApiSurface {
  const endpoints: ApiEndpoint[] = [];
  const classes: ApiClass[] = [];
  const functions: ApiFunction[] = [];

  const scanFile = (filePath: string) => {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const relPath = path.relative(root, filePath);

    // Extract exported functions
    const funcRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      functions.push({
        name: match[1],
        file: relPath,
        parameters: match[2].split(',').map(p => p.trim()).filter(Boolean),
        exported: true,
      });
    }

    // Extract exported classes
    const classRegex = /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const methods: string[] = [];

      // Extract methods (simplified)
      const methodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
      let methodMatch;
      while ((methodMatch = methodRegex.exec(content)) !== null) {
        if (methodMatch[1] !== 'constructor' && methodMatch[1] !== className) {
          methods.push(methodMatch[1]);
        }
      }

      classes.push({
        name: className,
        file: relPath,
        methods,
        extends: match[2],
      });
    }

    // Extract API routes (Express/Koa/Fastify patterns)
    const routeRegex = /(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = routeRegex.exec(content)) !== null) {
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: relPath,
      });
    }
  };

  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(full);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (['.ts', '.js', '.py', '.go', '.java'].includes(ext)) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);
  return { endpoints, classes, functions };
}

/**
 * Find usages of a specific symbol across the codebase.
 */
export function findUsages(root: string, symbolName: string): { file: string; line: number; context: string }[] {
  const usages: { file: string; line: number; context: string }[] = [];

  const scanFile = (filePath: string) => {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    const relPath = path.relative(root, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(symbolName)) {
        usages.push({
          file: relPath,
          line: i + 1,
          context: lines[i].trim(),
        });
      }
    }
  };

  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(full);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (LANG_BY_EXT[ext]) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);
  return usages;
}
