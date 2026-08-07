/**
 * Engineering Audits
 * ==================================================================
 * Daily / weekly / release / architecture audits, every one derived
 * from real engine output (scorecard + architecture + security + debt
 * + docs). Snapshots are persisted under `<root>/.aura/governance/`
 * so "new technical debt since the last audit" is measured against
 * actual previous runs — never fabricated.
 */

import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { getEngineeringScorecard, type EngineeringScorecard } from '../health/engineering_health_engine';
import { getArchitectureHealth, type ArchitectureHealthReport } from '../architecture/architecture_governance';
import { getSecurityReport, type SecurityReport } from '../security/security_review';
import { getTechnicalDebt, type TechnicalDebtReport } from '../debt/technical_debt_engine';
import { getDocumentationHealth, type DocumentationHealthReport } from '../docs/documentation_governance';
import { getReleaseReadiness, type ReleaseReadinessReport } from '../release/release_readiness';
import { getGitChurn, type GitChurn } from '../core/git';
import type { ReportMeta } from '../core/types';

export type AuditScope = 'daily' | 'weekly' | 'release' | 'architecture';

export interface AuditSnapshot {
  scope: AuditScope;
  at: string;
  overallHealth: number;
  debtItems: number;
  highDebt: number;
  securityFindings: number;
  archFindings: number;
  docIssues: number;
}

export interface TopRisk {
  title: string;
  detail: string;
  file?: string;
  source: 'architecture' | 'security' | 'debt' | 'docs';
}

export interface EngineeringAuditReport {
  scope: AuditScope;
  period: string;
  overallHealth: number;
  grade: string;
  topRisks: TopRisk[];
  newDebt: { added: number; itemTitles: string[] };
  architectureChanges: string[];
  securityFindings: string[];
  documentationChanges: string[];
  recommendations: string[];
  snapshot: AuditSnapshot;
  previousSnapshot: AuditSnapshot | null;
  meta: ReportMeta;
}

export interface AuditInput {
  projectPath: string;
  scope?: AuditScope;
  runNpmAudit?: boolean;
  maxBuilds?: number;
}

export async function getEngineeringAudit(input: AuditInput): Promise<EngineeringAuditReport> {
  const t0 = Date.now();
  const scope = input.scope ?? 'daily';
  const root = path.resolve(input.projectPath);

  const scorecard = await getEngineeringScorecard({ projectPath: root, runNpmAudit: input.runNpmAudit });
  const arch = await getArchitectureHealth({ projectPath: root });
  const sec = await getSecurityReport({ projectPath: root, runNpmAudit: input.runNpmAudit });
  const debt = await getTechnicalDebt({ projectPath: root });
  const docs = await getDocumentationHealth({ projectPath: root });
  const churn = await getGitChurn(root, scope === 'weekly' ? 14 : scope === 'daily' ? 2 : 30);

  const snapshot: AuditSnapshot = {
    scope,
    at: new Date().toISOString(),
    overallHealth: scorecard.overall.value,
    debtItems: debt.totalItems,
    highDebt: debt.bySeverity.high + debt.bySeverity.critical,
    securityFindings: sec.findings.length,
    archFindings: arch.findings.length,
    docIssues: docs.issues.length,
  };

  const previous = loadPreviousSnapshot(root, scope);
  persistSnapshot(root, scope, snapshot);

  // ── Top risks (real findings only) ────────────────────────────────
  const topRisks: TopRisk[] = [];
  for (const f of sec.findings.slice(0, 3)) {
    topRisks.push({ title: `Security: ${f.title}`, detail: f.description, file: f.evidence[0]?.file, source: 'security' });
  }
  for (const f of arch.findings.slice(0, 3)) {
    topRisks.push({ title: `Architecture: ${f.title}`, detail: f.description, file: f.evidence[0]?.file, source: 'architecture' });
  }
  for (const f of debt.items.slice(0, 3)) {
    topRisks.push({ title: `Debt: ${f.title}`, detail: f.description, file: f.evidence[0]?.file, source: 'debt' });
  }
  for (const f of docs.issues.slice(0, 2)) {
    topRisks.push({ title: `Docs: ${f.title}`, detail: f.description, file: f.evidence[0]?.file, source: 'docs' });
  }

  // ── New technical debt vs previous snapshot ───────────────────────
  const newDebt: { added: number; itemTitles: string[] } = { added: 0, itemTitles: [] };
  if (previous) {
    const delta = debt.totalItems - previous.debtItems;
    newDebt.added = Math.max(0, delta);
    if (delta > 0) newDebt.itemTitles = debt.items.slice(0, Math.min(5, delta)).map((i) => i.title);
  }

  // ── Changes (git-derived, real) ───────────────────────────────────
  const architectureChanges = churn.available
    ? [...churn.byModule.entries()]
        .filter(([, v]) => v.changes > 1)
        .sort((a, b) => b[1].changes - a[1].changes)
        .slice(0, 5)
        .map(([mod, v]) => `${mod}: ${v.changes} change${v.changes === 1 ? '' : 's'} (+${v.added}/-${v.deleted} lines)`)
    : ['git history unavailable'];

  const securityFindings = sec.findings.slice(0, 5).map((f) => `${f.severity.toUpperCase()}: ${f.title}`);

  const documentationChanges = churn.available
    ? [...churn.byFile.entries()]
        .filter(([file]) => /\.(md|mdx)$/.test(file))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file, n]) => `${file} (${n} change${n === 1 ? '' : 's'})`)
    : [];

  // ── Recommendations (grounded in the real findings) ───────────────
  const recommendations: string[] = [];
  if (scorecard.overall.value < 70) recommendations.push(`Overall health is ${scorecard.overall.grade} (${scorecard.overall.value}/100) — improve before shipping.`);
  if (sec.bySeverity.critical + sec.bySeverity.high > 0) recommendations.push(`Resolve ${sec.bySeverity.critical + sec.bySeverity.high} high/critical security findings first.`);
  if (arch.metrics.cycles > 0) recommendations.push(`Break the ${arch.metrics.cycles} dependency cycle(s) — see architecture report.`);
  if (debt.bySeverity.high > 0) recommendations.push(`Pay down ${debt.bySeverity.high} high-severity debt items (FIXMEs/large functions).`);
  if (churn.available) {
    const hottest = [...churn.byModule.entries()].sort((a, b) => b[1].changes - a[1].changes)[0];
    if (hottest) recommendations.push(`Module '${hottest[0]}' received the most changes (${hottest[1].changes}) — consider a stability review.`);
  }
  if (recommendations.length === 0) recommendations.push('No blockers identified by this audit.');

  // ── Scope-specific additions ──────────────────────────────────────
  if (scope === 'release') {
    const release = await getReleaseReadiness({ projectPath: root, maxBuilds: input.maxBuilds ?? 0, runNpmAudit: input.runNpmAudit });
    recommendations.unshift(`Release readiness: ${release.overallScore}/100 (${release.grade}) — ${release.blockers.length ? `blockers: ${release.blockers.join('; ')}` : 'no blockers.'}`);
  }
  if (scope === 'architecture') {
    recommendations.unshift(`Architecture health: ${arch.grade} (${arch.overall.value}/100) — ${arch.metrics.cycles} cycles, ${arch.metrics.layerViolations} layer violations, ${arch.metrics.unusedModules} unused modules.`);
  }

  return {
    scope,
    period: scope === 'daily' ? 'last 24h' : scope === 'weekly' ? 'last 7 days' : scope === 'release' ? 'release window' : 'architecture review',
    overallHealth: scorecard.overall.value,
    grade: scorecard.overall.grade,
    topRisks,
    newDebt,
    architectureChanges,
    securityFindings,
    documentationChanges,
    recommendations,
    snapshot,
    previousSnapshot: previous,
    meta: {
      root,
      analyzedFiles: scorecard.meta.analyzedFiles,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: [...scorecard.meta.unavailable, ...sec.meta.unavailable, ...(churn.available ? [] : ['git history unavailable — change insights skipped'])],
    },
  };
}

function snapshotDir(root: string): string {
  return path.posix.join(root, '.aura', 'governance', 'audits');
}

function snapshotFile(root: string, scope: AuditScope): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.posix.join(snapshotDir(root), `${scope}-${date}.json`);
}

function loadPreviousSnapshot(root: string, scope: AuditScope): AuditSnapshot | null {
  try {
    const dir = snapshotDir(root);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.startsWith(`${scope}-`) && f.endsWith('.json')).sort();
    const current = snapshotFile(root, scope).split(/[\\/]/).pop()!;
    const candidates = files.filter((f) => f !== current);
    if (candidates.length === 0) return null;
    const last = candidates[candidates.length - 1];
    const raw = readFileSync(path.posix.join(dir, last), 'utf8');
    return JSON.parse(raw) as AuditSnapshot;
  } catch {
    return null;
  }
}

function persistSnapshot(root: string, scope: AuditScope, snapshot: AuditSnapshot): void {
  try {
    mkdirSync(snapshotDir(root), { recursive: true });
    writeFileSync(snapshotFile(root, scope), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch {
    // snapshots are best-effort; the report itself remains valid
  }
}

export function summarizeAudit(report: EngineeringAuditReport): string {
  return `${report.scope} audit: health ${report.overallHealth}/100 (${report.grade}) — ${report.topRisks.length} top risks, ${report.newDebt.added} new debt item(s), ${report.recommendations.length} recommendation(s).`;
}

// Re-export the engine types so consumers can rely on one import path.
export type { EngineeringScorecard, ArchitectureHealthReport, SecurityReport, TechnicalDebtReport, DocumentationHealthReport, ReleaseReadinessReport, GitChurn };
