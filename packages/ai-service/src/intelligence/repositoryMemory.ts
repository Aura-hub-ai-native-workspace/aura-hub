/**
 * Repository Memory
 * ==================================================================
 * Each project owns persistent AI memory about its architecture,
 * patterns, conventions, and key decisions. Do NOT rediscover the
 * repository every request — reuse the memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';
import type { RepositoryProfile, ArchitectureStyle } from './types';

const PROFILE_FILE = (projectId: string) => homePath('repo-profile', `${projectId}.json`);

/* ── Pattern detection ───────────────────────────────────────────── */

function detectDesignPatterns(root: string): string[] {
  const patterns = new Set<string>();

  // Check for common patterns in source files
  const scan = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'].includes(ext)) continue;

      try {
        const content = fs.readFileSync(full, 'utf8').slice(0, 20000);
        if (/\bSingleton\b|getInstance\s*\(/.test(content)) patterns.add('Singleton');
        if (/\bFactory\b|create[A-Z]\w+\(/.test(content)) patterns.add('Factory');
        if (/\bStrategy\b|Strategy\s*\{/.test(content)) patterns.add('Strategy');
        if (/\bObserver\b|\.on\(|\.emit\(|EventEmitter/.test(content)) patterns.add('Observer');
        if (/\bAdapter\b|Adapter\s*\{/.test(content)) patterns.add('Adapter');
        if (/\bDecorator\b|@\w+\s*\n\s*(?:class|function|method)/.test(content)) patterns.add('Decorator');
        if (/\bMiddleware\b|middleware/i.test(full)) patterns.add('Middleware');
        if (/Repository\b/.test(content) && /interface|class/.test(content)) patterns.add('Repository');
        if (/Service\b/.test(content) && /interface|class/.test(content)) patterns.add('Service');
        if (/Controller\b/.test(content) && /interface|class/.test(content)) patterns.add('Controller');
      } catch { /* ignore */ }
    }
  };

  scan(root, 0);
  return [...patterns];
}

/* ── Naming conventions ──────────────────────────────────────────── */

function detectNamingConventions(root: string): string[] {
  const conventions: string[] = [];
  const sampleFiles: string[] = [];

  // Collect sample file names
  const collect = (dir: string, depth: number) => {
    if (depth > 3 || sampleFiles.length >= 100) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) { collect(path.join(dir, e.name), depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'].includes(ext)) {
        sampleFiles.push(e.name);
      }
    }
  };

  collect(root, 0);

  if (sampleFiles.length === 0) return conventions;

  // Detect file naming patterns
  const camelCase = sampleFiles.filter(f => /^[a-z][a-zA-Z0-9]*\.[a-z]+$/.test(f));
  const PascalCase = sampleFiles.filter(f => /^[A-Z][a-zA-Z0-9]*\.[a-z]+$/.test(f));
  const kebabCase = sampleFiles.filter(f => /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z]+$/.test(f));
  const snakeCase = sampleFiles.filter(f => /^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z]+$/.test(f));

  const total = sampleFiles.length;
  if (camelCase.length > total * 0.3) conventions.push('camelCase file names');
  if (PascalCase.length > total * 0.3) conventions.push('PascalCase file names (components/classes)');
  if (kebabCase.length > total * 0.3) conventions.push('kebab-case file names');
  if (snakeCase.length > total * 0.3) conventions.push('snake_case file names');

  return conventions;
}

/* ── Module structure ────────────────────────────────────────────── */

function detectModuleStructure(root: string): string[] {
  const structure: string[] = [];
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
          structure.push(e.name);
        }
      }
    } catch { /* ignore */ }
  }
  return structure.slice(0, 20);
}

/* ── Dependency analysis ─────────────────────────────────────────── */

function analyzeDependencies(root: string): string[] {
  const deps: string[] = [];
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies).slice(0, 20));
    } catch { /* ignore */ }
  }
  return deps;
}

/* ── Architecture style detection ─────────────────────────────────── */

function detectArchitectureStyle(root: string): ArchitectureStyle {
  const structure = new Set<string>();
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
        structure.add(e.name.toLowerCase());
      }
    }
  } catch { /* ignore */ }

  // Monorepo: packages/, apps/, libs/ directories
  if (structure.has('packages') || structure.has('apps') || structure.has('libs')) return 'monorepo';
  // Microkernel: plugin/ or extensions/ dirs
  if (structure.has('plugins') || structure.has('extensions') || structure.has('addons')) return 'microkernel';
  // Event-driven: event/ or events/ or handlers/ dirs
  if (structure.has('events') || structure.has('handlers') || structure.has('listeners')) return 'event-driven';
  // Layered: src/ with typical layer subdirs
  if (structure.has('src')) {
    const srcDirs = new Set<string>();
    try {
      for (const e of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
        if (e.isDirectory()) srcDirs.add(e.name.toLowerCase());
      }
    } catch { /* ignore */ }
    if (srcDirs.has('controllers') || srcDirs.has('services') || srcDirs.has('repositories')) return 'layered';
    if (srcDirs.has('routes') || srcDirs.has('middleware')) return 'mvc';
  }
  // Microservices: services/ or svc/ dirs
  if (structure.has('services') || structure.has('svc') || structure.has('microservices')) return 'microservices';
  // Plugin architecture: similar to microkernel
  if (structure.has('modules') && structure.has('core')) return 'plugin';
  // Monolithic: single large src/ with no clear separation
  if (structure.has('src') && !structure.has('packages')) return 'monolith';

  return 'unknown';
}

/* ── Key decisions extraction ────────────────────────────────────── */

function extractKeyDecisions(root: string): string[] {
  const decisions: string[] = [];

  // Check ADR (Architecture Decision Record) directory
  const adrDirs = ['docs/adr', 'adr', 'docs/decisions', 'decisions'];
  for (const dir of adrDirs) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) {
      try {
        for (const f of fs.readdirSync(full)) {
          if (f.endsWith('.md')) {
            const content = fs.readFileSync(path.join(full, f), 'utf8').slice(0, 500);
            const title = content.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '');
            decisions.push(title);
          }
        }
      } catch { /* ignore */ }
    }
  }

  return decisions.slice(0, 10);
}

/* ── Public API ──────────────────────────────────────────────────── */

export function buildRepositoryProfile(projectId: string, root: string): RepositoryProfile {
  const profile: RepositoryProfile = {
    architectureStyle: detectArchitectureStyle(root),
    designPatterns: detectDesignPatterns(root),
    namingConventions: detectNamingConventions(root),
    moduleStructure: detectModuleStructure(root),
    dependencies: analyzeDependencies(root),
    keyDecisions: extractKeyDecisions(root),
    generatedAt: new Date().toISOString(),
  };

  writeJsonFile(PROFILE_FILE(projectId), profile);
  return profile;
}

export function loadRepositoryProfile(projectId: string): RepositoryProfile | null {
  return readJsonFile<RepositoryProfile | null>(PROFILE_FILE(projectId), null);
}
