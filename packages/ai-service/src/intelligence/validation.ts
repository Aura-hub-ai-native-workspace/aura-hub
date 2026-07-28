/**
 * Architecture Validation
 * ==================================================================
 * Validates repository architecture against best practices:
 * - Module structure validation
 * - Dependency direction checks
 * - API design validation
 * - Code organization rules
 */

import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS } from './constants';
import type { ProjectIdentity, RepositoryProfile } from './types';

export interface ValidationResult {
  valid: boolean;
  score: number; // 0-100
  violations: ValidationViolation[];
  warnings: ValidationWarning[];
  passedRules: string[];
}

export interface ValidationViolation {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationWarning {
  rule: string;
  message: string;
  suggestion: string;
}

export interface ValidationRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check: (root: string, identity: ProjectIdentity | null, profile: RepositoryProfile | null) => ValidationViolation[];
}

/**
 * Default validation rules.
 */
export const DEFAULT_RULES: ValidationRule[] = [
  {
    id: 'no-circular-deps',
    name: 'No Circular Dependencies',
    description: 'Modules should not have circular dependencies',
    severity: 'error',
    check: (root) => checkCircularDependencies(root),
  },
  {
    id: 'entry-point-exists',
    name: 'Entry Point Exists',
    description: 'Project should have a clear entry point',
    severity: 'error',
    check: (root) => checkEntryPointExists(root),
  },
  {
    id: 'readme-exists',
    name: 'README Exists',
    description: 'Project should have a README file',
    severity: 'warning',
    check: (root) => checkReadmeExists(root),
  },
  {
    id: 'src-directory-structure',
    name: 'Source Directory Structure',
    description: 'Source code should be organized in src/ or similar',
    severity: 'info',
    check: (root) => checkSourceStructure(root),
  },
  {
    id: 'test-coverage',
    name: 'Test Coverage',
    description: 'Project should have test files',
    severity: 'warning',
    check: (root) => checkTestCoverage(root),
  },
  {
    id: 'dependency-direction',
    name: 'Dependency Direction',
    description: 'Dependencies should flow downward (core → utils)',
    severity: 'warning',
    check: (root) => checkDependencyDirection(root),
  },
];

/**
 * Validate repository architecture.
 */
export function validateArchitecture(
  root: string,
  identity: ProjectIdentity | null,
  profile: RepositoryProfile | null,
  rules: ValidationRule[] = DEFAULT_RULES,
): ValidationResult {
  const violations: ValidationViolation[] = [];
  const warnings: ValidationWarning[] = [];
  const passedRules: string[] = [];

  for (const rule of rules) {
    const ruleViolations = rule.check(root, identity, profile);
    if (ruleViolations.length === 0) {
      passedRules.push(rule.id);
    } else {
      for (const v of ruleViolations) {
        if (v.severity === 'error') {
          violations.push(v);
        } else {
          warnings.push({
            rule: v.rule,
            message: v.message,
            suggestion: `Fix: ${v.message}`,
          });
        }
      }
    }
  }

  const score = Math.round((passedRules.length / rules.length) * 100);
  const valid = violations.length === 0;

  return { valid, score, violations, warnings, passedRules };
}

/* ── Rule implementations ───────────────────────────────────────── */

function checkCircularDependencies(root: string): ValidationViolation[] {
  // Simplified circular dependency check
  const violations: ValidationViolation[] = [];
  const importMap = new Map<string, Set<string>>();

  const scanFile = (filePath: string) => {
    const relPath = path.relative(root, filePath);
    const imports = new Set<string>();

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const importRegex = /(?:import|from)\s+.*?['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const resolved = path.resolve(path.dirname(filePath), match[1]);
      imports.add(path.relative(root, resolved));
    }

    importMap.set(relPath, imports);
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
        if (['.ts', '.js'].includes(ext)) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);

  // Check for cycles (simplified DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const hasCycle = (node: string): boolean => {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    const imports = importMap.get(node) ?? new Set();
    for (const imp of imports) {
      if (hasCycle(imp)) return true;
    }

    inStack.delete(node);
    return false;
  };

  for (const node of importMap.keys()) {
    if (hasCycle(node)) {
      violations.push({
        rule: 'no-circular-deps',
        severity: 'error',
        message: `Circular dependency detected involving ${node}`,
        file: node,
      });
      break; // Report first cycle found
    }
  }

  return violations;
}

function checkEntryPointExists(root: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const entryFiles = ['index.ts', 'index.js', 'main.ts', 'main.py', 'app.py', 'server.ts'];

  const hasEntry = entryFiles.some(f =>
    fs.existsSync(path.join(root, f)) ||
    fs.existsSync(path.join(root, 'src', f))
  );

  if (!hasEntry) {
    // Check package.json
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (!pkg.main && !pkg.bin) {
          violations.push({
            rule: 'entry-point-exists',
            severity: 'error',
            message: 'No entry point found in package.json or file system',
          });
        }
      } catch {
        violations.push({
          rule: 'entry-point-exists',
          severity: 'error',
          message: 'Cannot read package.json',
        });
      }
    } else {
      violations.push({
        rule: 'entry-point-exists',
        severity: 'error',
        message: 'No entry point file found',
      });
    }
  }

  return violations;
}

function checkReadmeExists(root: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const hasReadme = fs.existsSync(path.join(root, 'README.md')) ||
    fs.existsSync(path.join(root, 'readme.md')) ||
    fs.existsSync(path.join(root, 'README'));

  if (!hasReadme) {
    violations.push({
      rule: 'readme-exists',
      severity: 'warning',
      message: 'No README file found',
    });
  }

  return violations;
}

function checkSourceStructure(root: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const hasSrc = fs.existsSync(path.join(root, 'src'));
  const hasLib = fs.existsSync(path.join(root, 'lib'));
  const hasApp = fs.existsSync(path.join(root, 'app'));

  if (!hasSrc && !hasLib && !hasApp) {
    // Check if source files are in root
    const rootFiles = fs.readdirSync(root).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.ts', '.js', '.py', '.go'].includes(ext);
    });

    if (rootFiles.length > 5) {
      violations.push({
        rule: 'src-directory-structure',
        severity: 'info',
        message: 'Consider organizing source files in src/ directory',
      });
    }
  }

  return violations;
}

function checkTestCoverage(root: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  let testFiles = 0;

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
        if (e.name.includes('.test.') || e.name.includes('.spec.') || e.name.includes('_test.')) {
          testFiles++;
        }
      }
    }
  };

  scanDir(root);

  if (testFiles === 0) {
    violations.push({
      rule: 'test-coverage',
      severity: 'warning',
      message: 'No test files found',
    });
  }

  return violations;
}

function checkDependencyDirection(root: string): ValidationViolation[] {
  // Simplified check - would need full dependency graph for proper validation
  const violations: ValidationViolation[] = [];

  // Check if utils/core directories import from higher-level directories
  const utilsDir = path.join(root, 'utils');
  const appDir = path.join(root, 'app');

  if (fs.existsSync(utilsDir) && fs.existsSync(appDir)) {
    // Utils should not import from app
    const scanDir = (dir: string): boolean => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }

      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (scanDir(full)) return true;
        } else {
          let content: string;
          try {
            content = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          if (content.includes("from '../app'") || content.includes('from "../app"')) {
            return true;
          }
        }
      }
      return false;
    };

    if (scanDir(utilsDir)) {
      violations.push({
        rule: 'dependency-direction',
        severity: 'warning',
        message: 'utils/ should not import from app/',
      });
    }
  }

  return violations;
}
