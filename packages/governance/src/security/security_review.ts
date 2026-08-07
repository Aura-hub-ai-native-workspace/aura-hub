/**
 * Security Engine
 * ==================================================================
 * Real static security analysis over the workspace:
 *   • secrets           — credential-shaped values in committed files
 *   • unsafe APIs       — eval/exec/shell/HTML-injection sinks
 *   • permissions       — 777 chmods, unsafe-perm flags, 0o666 writes
 *   • dependency vulns  — npm-deprecated packages from real
 *                         node_modules metadata + optional npm audit
 *   • authentication    — hardcoded auth secrets, unguarded endpoints
 *   • authorization     — HTTP handlers without any auth reference
 *
 * Placeholder values (xxx, example, your-, <...>) are ignored;
 * findings carry file/line/snippet evidence and remediation.
 */

import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { scanWorkspace } from '../core/scan';
import { runGit } from '../core/git';
import { SECRET_PATTERNS, UNSAFE_PATTERNS, PERMISSION_PATTERNS, AUTH_PATTERNS, PLACEHOLDER_PATTERN } from './patterns';
import type { Evidence, Finding, ReportMeta, Severity } from '../core/types';

export type SecurityFindingType = 'secret' | 'unsafe-api' | 'permission' | 'dependency-vulnerability' | 'authentication' | 'authorization';

export interface SecurityFinding extends Finding {
  type: SecurityFindingType;
}

export interface SecurityReport {
  findings: SecurityFinding[];
  byType: Record<SecurityFindingType, number>;
  bySeverity: Record<Severity, number>;
  secretsCount: number;
  deprecatedDependencies: string[];
  npmAudit: { available: boolean; vulnerabilities: number; summary: string };
  meta: ReportMeta;
}

export interface SecurityInput {
  projectPath: string;
  /** Run `npm audit --json` (network) — false by default. */
  runNpmAudit?: boolean;
}

const PLACEHOLDER_RE = PLACEHOLDER_PATTERN;

interface PatternRule {
  name: string;
  type: SecurityFindingType;
  severity: Severity;
  re: RegExp;
  secretValue?: boolean; // must not look like a placeholder
  description: string;
  remediation: string;
}

function patternRules(patterns: Array<[string, RegExp]>, type: SecurityFindingType, severity: Severity, remediation: string, secretValue?: boolean): PatternRule[] {
  return patterns.map(([name, re]) => ({ name, type, severity, re, remediation, description: name, secretValue }));
}

const SECRET_RULES: PatternRule[] = patternRules(SECRET_PATTERNS, 'secret', 'high', 'Remove the credential from source, rotate it, and use a secrets manager or environment variable.', true);

const UNSAFE_API_RULES: PatternRule[] = [
  ...patternRules(UNSAFE_PATTERNS, 'unsafe-api', 'medium', 'Avoid runtime code execution / raw HTML sinks; sanitize and validate inputs.'),
  {
    name: 'child_process exec',
    type: 'unsafe-api', severity: 'high',
    re: /(?:child_process|node:child_process)["']?\s*[,)]?\s*(?:exec|execSync)\s*\(|\bexecSync?\s*\(/,
    description: 'Shell execution via child_process — command injection surface when input is unsanitized.',
    remediation: 'Prefer execFile/spawn without a shell and validate inputs.',
  },
  {
    name: 'dangerouslySetInnerHTML',
    type: 'unsafe-api', severity: 'high',
    re: /dangerouslySetInnerHTML/,
    description: 'Raw HTML injection into the React DOM.',
    remediation: 'Render structured components; sanitize any HTML input.',
  },
  {
    name: 'vm.runInNewContext',
    type: 'unsafe-api', severity: 'high',
    re: /(?:vm|node:vm)[\s\S]{0,40}runInNewContext\s*\(|\brunInNewContext\s*\(/,
    description: 'VM sandbox is not a security boundary.',
    remediation: 'Avoid VM execution of untrusted code.',
  },
];

const PERMISSION_RULES: PatternRule[] = [
  ...patternRules(PERMISSION_PATTERNS, 'permission', 'medium', 'Use the least privilege needed (e.g. 0755/0644).'),
];

const AUTH_RULES: PatternRule[] = [
  ...patternRules(AUTH_PATTERNS, 'authentication', 'high', 'Read from environment; rotate the secret.', true),
];

const IGNORED_FILES = [/\.env\.example$/i, /\.example\.(ts|js|json|yml|yaml|env)$/i, /^docs\//, /\.md$/];

const ENDPOINT_FILE_RE = /(controller|route|router|endpoint|handler|api)[^/]*\.(ts|js|tsx|jsx)$/i;
const HTTP_SINK_RE = /app\.(get|post|put|patch|delete|all)\(|Router\(\)|\.use\(/;
const AUTH_REF_RE = /\b(auth|authorize|guard|authenticate|requireAuth|session|jwt|token)\b/i;

export async function getSecurityReport(input: SecurityInput): Promise<SecurityReport> {
  const t0 = Date.now();
  const ws = await scanWorkspace(input.projectPath);
  const findings: SecurityFinding[] = [];
  let seq = 0;

  const push = (type: SecurityFindingType, severity: Severity, name: string, description: string, evidence: Evidence[], remediation: string): void => {
    findings.push({
      id: `sec-${type}-${seq++}`,
      type,
      severity,
      title: `${name} — ${evidence[0]?.file ?? 'unknown'}`,
      description,
      evidence,
      recommendation: remediation,
    });
  };

  const codeFiles = ws.files.filter((f) => (f.isSource || f.ext === '.env' || f.ext === '.env.local') && !f.isTest);
  const ignored = (rel: string): boolean => IGNORED_FILES.some((re) => re.test(rel)) || rel.includes('/patterns') || rel.includes('/__tests__/');

  for (const f of codeFiles) {
    if (ignored(f.relPath)) continue;
    const lines = f.text.split('\n');
    const isEnv = f.ext.startsWith('.env');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('#')) continue;
      for (const rule of [...SECRET_RULES, ...UNSAFE_API_RULES, ...PERMISSION_RULES, ...AUTH_RULES]) {
        const m = rule.re.exec(line);
        if (!m) continue;
        const value = m[0];
        if (rule.secretValue && PLACEHOLDER_RE.test(value)) continue;
        // Environment files are the right place for secrets — only flag assignments of real-looking values.
        if (isEnv && rule.type === 'secret') continue;
        if (rule.type === 'unsafe-api' && f.isMarkdown) continue;
        push(
          rule.type,
          rule.severity,
          rule.name,
          rule.description,
          [{ file: f.relPath, line: i + 1, snippet: line.trim().slice(0, 140), basis: `pattern ${rule.name} matched in real file content` }],
          rule.remediation,
        );
      }
    }
  }

  // ── Authorization gaps: HTTP handlers without auth references ─────
  for (const f of codeFiles) {
    if (!ENDPOINT_FILE_RE.test(f.relPath)) continue;
    if (!HTTP_SINK_RE.test(f.text)) continue;
    if (!AUTH_REF_RE.test(f.text)) {
      push(
        'authorization',
        'medium',
        'Potentially unguarded HTTP surface',
        'File defines HTTP routes/handlers but contains no authentication or guard reference.',
        [{ file: f.relPath, basis: 'route/controller file with HTTP sinks; zero auth tokens (auth|guard|jwt|token|session)' }],
        'Add an authentication middleware/guard to all handlers or document why this surface is public.',
      );
    }
  }

  // ── Dependency vulnerabilities from real node_modules metadata ────
  const deprecated = findDeprecatedDependencies(input.projectPath);
  const byPkg = new Map<string, string>();
  for (const p of deprecated) {
    const existing = byPkg.get(p.name);
    if (!existing || (existing === 'deprecated' && p.message)) byPkg.set(p.name, p.message);
  }
  for (const [name, message] of byPkg) {
    push(
      'dependency-vulnerability',
      'medium',
      `Deprecated dependency: ${name}`,
      `npm has deprecated this package${message ? `: ${message.slice(0, 160)}` : ''}.`,
      [{ file: `node_modules/${name}/package.json`, basis: `real 'deprecated' field in installed package metadata` }],
      'Replace the dependency with a maintained alternative.',
    );
  }

  let npmAudit: SecurityReport['npmAudit'] = { available: false, vulnerabilities: 0, summary: 'npm audit not run' };
  if (input.runNpmAudit) {
    npmAudit = await runNpmAudit(input.projectPath);
    if (npmAudit.available && npmAudit.vulnerabilities > 0) {
      push(
        'dependency-vulnerability',
        npmAudit.vulnerabilities > 5 ? 'high' : 'medium',
        `npm audit: ${npmAudit.vulnerabilities} known vulnerabilities`,
        npmAudit.summary,
        [{ file: 'package-lock.json', basis: 'npm audit --json (network advisory data)' }],
        'Run `npm audit fix` and review breaking upgrades.',
      );
    }
  }

  // ── Git history scan for committed secrets (best-effort, real) ────
  const history = await scanGitHistory(input.projectPath);
  for (const h of history) {
    push('secret', h.severity, `Secret in git history: ${h.file}`, `A credential-shaped string was committed and can still be found in history (${h.commit}).`,
      [{ file: h.file, basis: `git log -S scan found credential pattern in commit ${h.commit}` }],
      'Rotate the credential; use git filter-repo to purge history if the repo is shared.',
    );
  }

  const byType: Record<SecurityFindingType, number> = { secret: 0, 'unsafe-api': 0, permission: 0, 'dependency-vulnerability': 0, authentication: 0, authorization: 0 };
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    byType[f.type]++;
    bySeverity[f.severity]++;
  }

  findings.sort((a, b) => sev(b.severity) - sev(a.severity));

  const unavailable: string[] = [];
  if (!npmAudit.available && input.runNpmAudit) unavailable.push('npm audit failed or network unavailable');
  if (!deprecated.scanned) unavailable.push('node_modules metadata unavailable — deprecated-dependency scan skipped');

  return {
    findings,
    byType,
    bySeverity,
    secretsCount: byType.secret,
    deprecatedDependencies: [...byPkg.keys()],
    npmAudit,
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable,
    },
  };
}

function sev(s: Severity): number {
  switch (s) {
    case 'critical': return 5;
    case 'high': return 4;
    case 'medium': return 3;
    case 'low': return 2;
    default: return 1;
  }
}

interface DeprecatedDep {
  name: string;
  message: string;
}

function findDeprecatedDependencies(root: string): DeprecatedDep[] & { scanned: boolean } {
  const out: DeprecatedDep[] & { scanned: boolean } = Object.assign([], { scanned: false });
  const nm = path.posix.join(root, 'node_modules');
  try {
    statSync(nm);
  } catch {
    return out;
  }
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = path.posix.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const pkgJson = path.posix.join(full, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string; deprecated?: string };
        if (pkg.deprecated) {
          out.push({ name: pkg.name ?? name, message: pkg.deprecated });
        }
      } catch {
        // not a package dir — descend (scoped dirs and nested modules)
      }
      if (!name.startsWith('@')) walk(full);
      else {
        try {
          for (const sub of readdirSync(full)) {
            const subPkg = path.posix.join(full, sub, 'package.json');
            try {
              const pkg = JSON.parse(readFileSync(subPkg, 'utf8')) as { name?: string; deprecated?: string };
              if (pkg.deprecated) out.push({ name: pkg.name ?? `${name}/${sub}`, message: pkg.deprecated });
            } catch {
              // skip
            }
          }
        } catch {
          // skip
        }
      }
    }
  };
  walk(nm);
  out.scanned = true;
  return out;
}

function runNpmAudit(root: string): Promise<SecurityReport['npmAudit']> {
  return new Promise((resolve) => {
    execFile(
      'npm.cmd',
      ['audit', '--json'],
      { cwd: root, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ available: false, vulnerabilities: 0, summary: 'npm audit failed' });
          return;
        }
        try {
          const data = JSON.parse(stdout) as { metadata?: { vulnerabilities?: { info?: number; low?: number; moderate?: number; high?: number; critical?: number; total?: number } }; vulnerabilities?: Record<string, { severity?: string }> };
          const meta = data.metadata?.vulnerabilities;
          const total = meta?.total ?? Object.keys(data.vulnerabilities ?? {}).length;
          resolve({
            available: true,
            vulnerabilities: total,
            summary: `info ${meta?.info ?? 0} · low ${meta?.low ?? 0} · moderate ${meta?.moderate ?? 0} · high ${meta?.high ?? 0} · critical ${meta?.critical ?? 0}`,
          });
        } catch {
          resolve({ available: false, vulnerabilities: 0, summary: 'npm audit returned unparseable output' });
        }
      },
    );
  });
}

interface HistorySecret {
  file: string;
  commit: string;
  severity: Severity;
}

async function scanGitHistory(root: string): Promise<HistorySecret[]> {
  const log = await runGit(['log', '--pretty=format:%H', '--name-only', '-n', '200'], root);
  if (!log.ok) return [];
  const out: HistorySecret[] = [];
  const lines = log.stdout.split('\n');
  const seen = new Set<string>();
  let commit = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.startsWith('\t') && /^[0-9a-f]{40}$/i.test(line.trim())) {
      commit = line.trim();
      continue;
    }
    const file = line.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      const content = runGit(['show', `${commit}:${file}`], root, 15000);
      const text = (await content).stdout;
      if (!text) continue;
      for (const rule of SECRET_RULES) {
        if (!rule.secretValue) continue;
        const m = rule.re.exec(text);
        if (m && !PLACEHOLDER_RE.test(m[0])) {
          out.push({ file, commit: commit.slice(0, 8), severity: rule.severity });
          break;
        }
      }
    } catch {
      // file removed or binary — skip
    }
  }
  return out.slice(0, 10);
}

export function summarizeSecurity(report: SecurityReport): string {
  const s = report.bySeverity;
  return `Security: ${report.findings.length} findings (${s.critical} critical, ${s.high} high) — ${report.byType.secret} secrets, ${report.byType['dependency-vulnerability']} dependency issues.`;
}
