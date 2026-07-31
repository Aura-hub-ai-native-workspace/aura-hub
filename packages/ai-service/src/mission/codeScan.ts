/**
 * codeScan — Mission Control's Stage 3 real, bounded, textual scans:
 * technical debt markers, a pattern-based secret scan, and a real
 * dependency-pinning summary. Reuses `diagnosis/repoScan.ts`'s
 * ignore-rule-respecting file walk rather than re-implementing one.
 *
 * Explicitly NOT a security audit or a static-analysis tool — these
 * are grep-shaped, disclosed as such wherever they're rendered, and
 * exist only to ground mission planning in real (if partial) evidence
 * rather than nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanSourceFiles } from '../diagnosis/repoScan';
import type { DependencySummary, SecurityFinding, TechnicalDebtMarker } from './types';

const DEBT_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s]/;
const DEBT_SCAN_FILE_CAP = 200;
const DEBT_MARKER_CAP = 60;

export function scanTechnicalDebt(projectPath: string): { markers: TechnicalDebtMarker[]; capHit: boolean } {
  const { files, capHit } = scanSourceFiles(projectPath, DEBT_SCAN_FILE_CAP);
  const markers: TechnicalDebtMarker[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(DEBT_RE);
      if (!m) continue;
      markers.push({ marker: m[1].toUpperCase() as TechnicalDebtMarker['marker'], file: f.relPath, line: i + 1, text: lines[i].trim().slice(0, 160) });
      if (markers.length >= DEBT_MARKER_CAP) return { markers, capHit: true };
    }
  }
  return { markers, capHit };
}

const SECRET_PATTERNS: { label: string; re: RegExp; severity: 'high' | 'medium' }[] = [
  { label: 'AWS access key', re: /AKIA[0-9A-Z]{16}/, severity: 'high' },
  { label: 'private key block', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, severity: 'high' },
  { label: 'API key assignment', re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, severity: 'medium' },
  { label: 'hardcoded password assignment', re: /\bpassword\s*[:=]\s*['"][^'"]{4,}['"]/i, severity: 'medium' },
];
const SECURITY_SCAN_FILE_CAP = 200;
const SECURITY_FINDING_CAP = 40;

export function scanSecurityFindings(projectPath: string): { findings: SecurityFinding[]; capHit: boolean } {
  const { files, capHit } = scanSourceFiles(projectPath, SECURITY_SCAN_FILE_CAP);
  const findings: SecurityFinding[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of SECRET_PATTERNS) {
        if (!p.re.test(lines[i])) continue;
        findings.push({ pattern: p.label, file: f.relPath, line: i + 1, snippet: lines[i].trim().slice(0, 120), severity: p.severity });
        if (findings.length >= SECURITY_FINDING_CAP) return { findings, capHit: true };
      }
    }
  }
  return { findings, capHit };
}

export function summarizeDependencies(projectPath: string): DependencySummary {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const versions = Object.values({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    const pinnedExact = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v)).length;
    return { total: versions.length, pinnedExact, looseRange: versions.length - pinnedExact };
  } catch {
    return { total: 0, pinnedExact: 0, looseRange: 0 };
  }
}
