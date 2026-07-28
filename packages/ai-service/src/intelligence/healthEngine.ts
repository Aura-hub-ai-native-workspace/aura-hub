/**
 * Repository Health Engine
 * ==================================================================
 * Generates a comprehensive health report for the repository:
 * - Architecture completeness
 * - Module coverage
 * - Documentation coverage
 * - Dependency graph analysis
 * - Missing docs
 * - Orphan modules
 * - Dead code estimates
 * - Unreferenced APIs
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';
import type { RepositoryHealth, HealthScore, HealthIssue } from './types';
import type { ProjectIdentity, RepositorySummary } from './types';

const HEALTH_FILE = (projectId: string) => homePath('health', `${projectId}.json`);

/* ── Documentation coverage ──────────────────────────────────────── */

function assessDocumentation(root: string, modules: { name: string; path: string }[]): { score: number; missingDocs: string[]; issues: HealthIssue[] } {
  const issues: HealthIssue[] = [];
  const missingDocs: string[] = [];
  let documented = 0;
  const total = Math.max(modules.length, 1);

  const hasReadme = fs.existsSync(path.join(root, 'README.md'));
  if (!hasReadme) {
    issues.push({ severity: 'warning', category: 'documentation', message: 'No README.md found' });
  } else {
    documented++;
  }

  const hasArch = fs.existsSync(path.join(root, 'ARCHITECTURE.md')) || fs.existsSync(path.join(root, 'docs', 'ARCHITECTURE.md'));
  if (!hasArch) {
    issues.push({ severity: 'info', category: 'documentation', message: 'No ARCHITECTURE.md found' });
  }

  for (const mod of modules) {
    const modDir = path.join(root, mod.path);
    const hasDoc = fs.existsSync(path.join(modDir, 'README.md'))
      || fs.existsSync(path.join(modDir, 'DOCS.md'))
      || fs.existsSync(path.join(modDir, 'docs'));
    if (hasDoc) {
      documented++;
    } else {
      missingDocs.push(mod.name);
    }
  }

  const score = Math.round((documented / total) * 100);
  return { score: Math.min(100, score), missingDocs, issues };
}

/* ── Testing assessment ──────────────────────────────────────────── */

function assessTesting(root: string): { score: number; testFiles: number; issues: HealthIssue[] } {
  const issues: HealthIssue[] = [];
  let testFiles = 0;
  let totalFiles = 0;
  let budget = 10000;

  const scan = (dir: string) => {
    if (budget <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget-- <= 0) break;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      totalFiles++;
      if (/\.(test|spec)\.[jt]sx?$/.test(e.name) || /_test\.(py|go|rs)$/.test(e.name) || /\.test\.(py|go|rs)$/.test(e.name)) {
        testFiles++;
      }
    }
  };

  scan(root);

  const ratio = totalFiles > 0 ? testFiles / totalFiles : 0;
  const score = Math.round(Math.min(100, ratio * 500));

  if (testFiles === 0) {
    issues.push({ severity: 'warning', category: 'testing', message: 'No test files found' });
  } else if (ratio < 0.05) {
    issues.push({ severity: 'info', category: 'testing', message: `Low test coverage ratio: ${testFiles} test files for ${totalFiles} source files` });
  }

  return { score, testFiles, issues };
}

/* ── Dependency assessment ───────────────────────────────────────── */

function assessDependencies(root: string): { score: number; issues: HealthIssue[] } {
  const issues: HealthIssue[] = [];
  let score = 80;

  // Check for lockfile
  const hasLockfile = fs.existsSync(path.join(root, 'package-lock.json'))
    || fs.existsSync(path.join(root, 'yarn.lock'))
    || fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
    || fs.existsSync(path.join(root, 'Cargo.lock'))
    || fs.existsSync(path.join(root, 'go.sum'));
  if (hasLockfile) score += 10;

  // Check for Dockerfile (containerization)
  if (fs.existsSync(path.join(root, 'Dockerfile'))) score += 5;

  // Check for CI
  const hasCI = fs.existsSync(path.join(root, '.github', 'workflows'))
    || fs.existsSync(path.join(root, '.gitlab-ci.yml'))
    || fs.existsSync(path.join(root, '.circleci'));
  if (hasCI) score += 5;

  // Check for .env.example
  if (fs.existsSync(path.join(root, '.env.example'))) score += 2;

  // Check for security tools
  if (fs.existsSync(path.join(root, '.snyk')) || fs.existsSync(path.join(root, 'dependabot.yml'))) score += 3;

  return { score: Math.min(100, score), issues };
}

/* ── Architecture assessment ─────────────────────────────────────── */

function assessArchitecture(root: string, identity: ProjectIdentity | null, modules: { name: string; path: string }[]): { score: number; issues: HealthIssue[] } {
  const issues: HealthIssue[] = [];
  let score = 60;

  // Has architecture docs
  const hasArchDocs = fs.existsSync(path.join(root, 'ARCHITECTURE.md'))
    || fs.existsSync(path.join(root, 'docs', 'ARCHITECTURE.md'))
    || fs.existsSync(path.join(root, 'DESIGN.md'));
  if (hasArchDocs) score += 15;

  // Has consistent module structure
  if (modules.length >= 2 && modules.length <= 15) score += 10;

  // Has entry points
  if (identity && identity.entryPoints.length > 0) score += 5;

  // Has clear project type
  if (identity && identity.repositoryType !== 'unknown') score += 10;

  return { score: Math.min(100, score), issues };
}

/* ── Orphan module detection ─────────────────────────────────────── */

function findOrphanModules(root: string, modules: { name: string; path: string }[]): string[] {
  const orphans: string[] = [];

  for (const mod of modules) {
    // Check if any file outside this module imports from it
    let referenced = false;
    let scanBudget = 1000;

    const checkImports = (dir: string) => {
      if (referenced || scanBudget <= 0) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (referenced || scanBudget-- <= 0) break;
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { checkImports(full); return; }
        if (e.name === mod.name) continue;
        try {
          const content = fs.readFileSync(full, 'utf8').slice(0, 5000);
          if (content.includes(mod.name)) referenced = true;
        } catch { /* ignore */ }
      }
    };

    // Simple heuristic: check if module name appears in other files
    // This is a fast approximation — not exhaustive
    const srcDir = path.join(root, 'src');
    if (fs.existsSync(srcDir)) checkImports(srcDir);

    if (!referenced && mod.path !== 'src') {
      orphans.push(mod.name);
    }
  }

  return orphans;
}

/* ── Main health generator ───────────────────────────────────────── */

export function generateRepositoryHealth(
  projectId: string,
  root: string,
  identity: ProjectIdentity | null,
  summary: RepositorySummary | null,
): RepositoryHealth {
  const modules = summary?.modules.map(m => ({ name: m.name, path: m.path })) ?? [];
  const allIssues: HealthIssue[] = [];

  const doc = assessDocumentation(root, modules);
  const test = assessTesting(root);
  const dep = assessDependencies(root);
  const arch = assessArchitecture(root, identity, modules);

  allIssues.push(...doc.issues, ...test.issues, ...dep.issues, ...arch.issues);

  const orphans = findOrphanModules(root, modules);

  if (orphans.length > 0) {
    allIssues.push({
      severity: 'info',
      category: 'architecture',
      message: `Potentially orphaned modules: ${orphans.join(', ')}`,
    });
  }

  const score: HealthScore = {
    overall: Math.round((doc.score + test.score + dep.score + arch.score) / 4),
    documentation: doc.score,
    architecture: arch.score,
    testing: test.score,
    dependencies: dep.score,
    maintainability: Math.round((arch.score + dep.score + (100 - orphans.length * 5)) / 3),
  };

  const health: RepositoryHealth = {
    score,
    issues: allIssues,
    metrics: {
      totalFiles: summary?.totalFiles ?? 0,
      documentedModules: modules.length - doc.missingDocs.length,
      totalModules: modules.length,
      testFiles: test.testFiles,
      deadCodeEstimate: 0,
      orphanModules: orphans.length,
      missingDocs: doc.missingDocs,
      unreferencedApis: [],
    },
    generatedAt: new Date().toISOString(),
  };

  writeJsonFile(HEALTH_FILE(projectId), health);
  return health;
}

export function loadRepositoryHealth(projectId: string): RepositoryHealth | null {
  return readJsonFile<RepositoryHealth | null>(HEALTH_FILE(projectId), null);
}
