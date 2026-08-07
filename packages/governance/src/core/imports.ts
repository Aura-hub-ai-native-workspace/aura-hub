/**
 * Import graph — real module dependency analysis.
 * ==================================================================
 * Parses ES import/export-from/require/import() statements from every
 * scanned source file, resolves them against the real workspace layout
 * (relative paths + workspace package names), and builds a module graph
 * used by the architecture, debt and insights engines.
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { ScannedFile, ScannedWorkspace, PackageInfo } from './scan';

export interface ModuleNode {
  relPath: string;
  file: ScannedFile;
  /** Resolved internal targets (relPaths). */
  imports: string[];
  /** Resolved internal importers (relPaths). */
  importers: string[];
  /** Raw specifiers that did not resolve to an internal file. */
  external: string[];
  /** Specifiers resolved into another workspace package. */
  packageImports: string[];
}

export interface ModuleGraph {
  nodes: Map<string, ModuleNode>;
  files: ScannedFile[];
}

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import[\s\S]*?from\s+|import\s+|export\s*\{[\s\S]*?\}\s*from\s+|export\s+\*\s*from\s+)(['"])([^'"]+)\1/g;
const REQUIRE_RE = /(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

export function parseImportSpecifiers(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[2];
    if (spec.startsWith('node:')) continue;
    out.add(spec);
  }
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text)) !== null) {
    const spec = m[2];
    if (spec.startsWith('node:')) continue;
    out.add(spec);
  }
  return [...out];
}

function stripQuery(spec: string): string {
  const q = spec.indexOf('?');
  return q >= 0 ? spec.slice(0, q) : spec;
}

function tryResolve(baseDir: string, spec: string): string | null {
  const clean = stripQuery(spec);
  if (!clean.startsWith('.')) return null;
  const target = path.posix.normalize(path.posix.join(baseDir, clean));
  for (const ext of CODE_EXTS) {
    if (hasFile(target + ext)) return target + ext;
  }
  for (const idx of INDEX_FILES) {
    if (hasFile(path.posix.join(target, idx))) return path.posix.join(target, idx);
  }
  return null;
}

// Cache of filesystem probes (avoid duplicate stat/access calls).
const probeCache = new Map<string, boolean>();
function hasFile(p: string): boolean {
  if (probeCache.has(p)) return probeCache.get(p)!;
  let hit = false;
  try {
    hit = existsSync(p) && statSync(p).isFile();
  } catch {
    hit = false;
  }
  probeCache.set(p, hit);
  return hit;
}

export interface GraphBuildOptions {
  signal?: AbortSignal;
}

export function buildModuleGraph(ws: ScannedWorkspace, packages: PackageInfo[], opts: GraphBuildOptions = {}): ModuleGraph {
  const sourceFiles = ws.files.filter((f) => f.isSource);
  const nodes = new Map<string, ModuleNode>();

  const packageIndex = new Map<string, string>(); // package name → relDir
  for (const p of packages) packageIndex.set(p.name, p.relDir === '.' ? '' : p.relDir);

  const specifierToRel = (file: ScannedFile, spec: string): string | null => {
    const dir = path.posix.dirname(file.relPath);
    const rel = tryResolve(dir, spec);
    if (rel && ws.byRelPath.has(rel)) return rel;
    return null;
  };

  for (const file of sourceFiles) {
    if (opts.signal?.aborted) break;
    const specs = parseImportSpecifiers(file.text);
    const node: ModuleNode = {
      relPath: file.relPath,
      file,
      imports: [],
      importers: [],
      external: [],
      packageImports: [],
    };
    for (const spec of specs) {
      const rel = specifierToRel(file, spec);
      if (rel) {
        node.imports.push(rel);
        continue;
      }
      const clean = stripQuery(spec);
      const pkgName = matchPackageName(clean, packageIndex);
      if (pkgName) {
        node.packageImports.push(pkgName);
        const pkgRelDir = packageIndex.get(pkgName)!;
        const sub = clean.slice(pkgName.length).replace(/^\//, '');
        const resolved = resolvePackageSub(pkgRelDir, sub, ws.byRelPath);
        if (resolved) node.imports.push(resolved);
      } else {
        node.external.push(clean);
      }
    }
    nodes.set(file.relPath, node);
  }

  // Backfill importers.
  for (const node of nodes.values()) {
    for (const target of node.imports) {
      const t = nodes.get(target);
      if (t) t.importers.push(node.relPath);
    }
  }

  return { nodes, files: sourceFiles };
}

function matchPackageName(spec: string, packageIndex: Map<string, string>): string | null {
  if (packageIndex.has(spec)) return spec;
  // scoped subpath: @aura/foo/bar → @aura/foo
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length >= 2) {
      const scoped = `${parts[0]}/${parts[1]}`;
      if (packageIndex.has(scoped)) return scoped;
    }
  }
  // unscoped subpath: react-dom/... → react-dom (external anyway)
  return null;
}

function resolvePackageSub(pkgRelDir: string, sub: string, byRelPath: Map<string, ScannedFile>): string | null {
  const base = pkgRelDir ? `${pkgRelDir}/` : '';
  if (!sub) {
    for (const idx of INDEX_FILES) {
      const p = `${base}src/${idx}`;
      if (byRelPath.has(p)) return p;
      const p2 = `${base}${idx}`;
      if (byRelPath.has(p2)) return p2;
    }
    return null;
  }
  for (const ext of CODE_EXTS) {
    const p = `${base}src/${sub}${ext}`;
    if (byRelPath.has(p)) return p;
  }
  const pIndex = `${base}src/${sub}/index.ts`;
  if (byRelPath.has(pIndex)) return pIndex;
  const pIndexX = `${base}src/${sub}/index.tsx`;
  if (byRelPath.has(pIndexX)) return pIndexX;
  return null;
}

export function clearGraphProbeCache(): void {
  probeCache.clear();
}
