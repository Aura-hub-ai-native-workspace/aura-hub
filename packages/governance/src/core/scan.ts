/**
 * Workspace scan — real filesystem traversal via the frozen Coding
 * Knowledge Engine's scanner (public API). Feeds every governance
 * engine with ground-truth file content.
 */

import path from 'node:path';
import { IgnoreRules, WorkspaceScanner, readFileSafe } from '@aura/knowledge-coding';

export interface ScannedFile {
  relPath: string;
  absPath: string;
  ext: string;
  name: string;
  dir: string;
  text: string;
  lines: number;
  size: number;
  isTest: boolean;
  isSource: boolean;
  isMarkdown: boolean;
  isJson: boolean;
  isPackageJson: boolean;
}

export interface ScannedWorkspace {
  root: string;
  files: ScannedFile[];
  byRelPath: Map<string, ScannedFile>;
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const TEST_MARKERS = [
  /\.(test|spec)\./i,
  /__tests__\//,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/i,
];

export function isTestPath(relPath: string): boolean {
  return TEST_MARKERS.some((m) => m.test(relPath));
}

export function isSourcePath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return false;
  const base = path.basename(relPath);
  if (base.endsWith('.d.ts')) return false;
  return true;
}

export async function scanWorkspace(root: string, opts: { signal?: AbortSignal } = {}): Promise<ScannedWorkspace> {
  const absRoot = path.resolve(root);
  const rules = new IgnoreRules({
    directories: ['.aura', '.aura-index'],
  });
  const scanner = new WorkspaceScanner(rules);
  const scan = await scanner.scan(absRoot, { signal: opts.signal });

  const files: ScannedFile[] = [];
  for (const entry of scan.entries) {
    const name = path.posix.basename(entry.relPath);
    if (!rules.allowFile(name, entry.relPath)) continue;
    const ext = path.extname(name).toLowerCase();
    const isTextCandidate = SOURCE_EXTS.has(ext) || ext === '.md' || ext === '.mdx' || ext === '.json' || ext === '.yml' || ext === '.yaml' || ext === '.toml';
    if (!isTextCandidate) continue;
    const read = await readFileSafe(entry.absPath, rules.maxFileBytes);
    if (!read.ok || read.binary || !read.text) continue;
    const relPath = entry.relPath.split(path.sep).join('/');
    files.push({
      relPath,
      absPath: entry.absPath,
      ext,
      name,
      dir: path.posix.dirname(relPath),
      text: read.text,
      lines: read.lines,
      size: entry.size,
      isTest: isTestPath(relPath),
      isSource: isSourcePath(relPath),
      isMarkdown: ext === '.md' || ext === '.mdx',
      isJson: ext === '.json',
      isPackageJson: name === 'package.json',
    });
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    root: absRoot,
    files,
    byRelPath: new Map(files.map((f) => [f.relPath, f])),
  };
}

export interface PackageInfo {
  dir: string;
  relDir: string;
  name: string;
  hasReadme: boolean;
  hasTsconfig: boolean;
  hasSrcDir: boolean;
  hasTests: boolean;
  testFiles: number;
  sourceFiles: number;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  scripts: Record<string, string>;
  main: string | undefined;
  exports: unknown;
}

export function findPackages(ws: ScannedWorkspace): PackageInfo[] {
  const packages: PackageInfo[] = [];
  for (const f of ws.files) {
    if (!f.isPackageJson) continue;
    let name: string | undefined;
    try {
      name = (JSON.parse(f.text) as { name?: string }).name;
    } catch {
      name = undefined;
    }
    if (!name) continue;
    const relDir = path.posix.dirname(f.relPath);
    const dirPrefix = relDir === '.' ? '' : `${relDir}/`;
    const readme = ws.byRelPath.get(`${dirPrefix}README.md`) ?? ws.byRelPath.get(`${dirPrefix}readme.md`);
    const srcDir = ws.files.find((x) => x.relPath.startsWith(`${dirPrefix}src/`) || x.relPath === `${dirPrefix}src/index.ts`);
    const testFiles = ws.files.filter((x) => x.isTest && x.relPath.startsWith(dirPrefix)).length;
    const sourceFiles = ws.files.filter((x) => x.isSource && !x.isTest && x.relPath.startsWith(dirPrefix)).length;
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; scripts?: Record<string, string>; main?: string; exports?: unknown };
    try {
      parsed = JSON.parse(f.text) as typeof parsed;
    } catch {
      parsed = {};
    }
    packages.push({
      dir: path.posix.join(ws.root, relDir),
      relDir,
      name,
      hasReadme: Boolean(readme),
      hasTsconfig: ws.files.some((x) => x.relPath === `${dirPrefix}tsconfig.json`),
      hasSrcDir: Boolean(srcDir),
      hasTests: testFiles > 0,
      testFiles,
      sourceFiles,
      dependencies: parsed.dependencies ?? {},
      devDependencies: parsed.devDependencies ?? {},
      peerDependencies: parsed.peerDependencies ?? {},
      scripts: parsed.scripts ?? {},
      main: parsed.main,
      exports: parsed.exports,
    });
  }
  return packages.sort((a, b) => a.relDir.localeCompare(b.relDir));
}
