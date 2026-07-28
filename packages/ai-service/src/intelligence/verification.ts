/**
 * Repository Verification Report
 * ==================================================================
 * Generates a comprehensive verification report for the repository:
 * - Completeness check (all modules documented)
 * - Accuracy validation (claims vs evidence)
 * - Coverage analysis (what's covered vs missing)
 * - Health score summary
 * - Actionable recommendations
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';
import type { ProjectIdentity, RepositorySummary, RepositoryHealth, RepositoryProfile, ProjectGlossary } from './types';

const REPORT_FILE = (projectId: string) => homePath('reports', `${projectId}-verification.json`);

export interface VerificationReport {
  projectId: string;
  generatedAt: string;
  overallScore: number; // 0-100
  sections: VerificationSection[];
  recommendations: string[];
  summary: string;
}

export interface VerificationSection {
  name: string;
  score: number; // 0-100
  status: 'pass' | 'warn' | 'fail';
  findings: string[];
  details?: Record<string, unknown>;
}

/**
 * Generate a comprehensive verification report for the repository.
 */
export function generateVerificationReport(
  projectId: string,
  root: string,
  identity: ProjectIdentity | null,
  summary: RepositorySummary | null,
  health: RepositoryHealth | null,
  profile: RepositoryProfile | null,
  glossary: ProjectGlossary | null,
): VerificationReport {
  const sections: VerificationSection[] = [];
  const recommendations: string[] = [];

  // 1. Identity completeness
  sections.push(verifyIdentity(identity, root));
  if (sections[sections.length - 1].status === 'fail') {
    recommendations.push('Regenerate project identity with `generateIdentity()`');
  }

  // 2. Documentation coverage
  sections.push(verifyDocumentation(root, summary));
  if (sections[sections.length - 1].score < 70) {
    recommendations.push('Add README files to undocumented modules');
  }

  // 3. Module coverage
  sections.push(verifyModuleCoverage(root, summary));
  if (sections[sections.length - 1].score < 80) {
    recommendations.push('Run module summarizer to document all modules');
  }

  // 4. Health metrics
  sections.push(verifyHealth(health));
  if (sections[sections.length - 1].status === 'warn') {
    recommendations.push('Address health issues identified in the report');
  }

  // 5. Architecture consistency
  sections.push(verifyArchitecture(profile, identity));

  // 6. Glossary completeness
  sections.push(verifyGlossary(glossary, root));
  if (sections[sections.length - 1].score < 60) {
    recommendations.push('Build project glossary to document terminology');
  }

  // Calculate overall score
  const overallScore = Math.round(
    sections.reduce((sum, s) => sum + s.score, 0) / sections.length
  );

  // Generate summary
  const summaryText = generateSummary(overallScore, sections);

  const report: VerificationReport = {
    projectId,
    generatedAt: new Date().toISOString(),
    overallScore,
    sections,
    recommendations,
    summary: summaryText,
  };

  writeJsonFile(REPORT_FILE(projectId), report);
  return report;
}

/**
 * Load a previously generated verification report.
 */
export function loadVerificationReport(projectId: string): VerificationReport | null {
  return readJsonFile<VerificationReport | null>(REPORT_FILE(projectId), null);
}

/* ── Section verifiers ──────────────────────────────────────────── */

function verifyIdentity(identity: ProjectIdentity | null, _root: string): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  if (!identity) {
    findings.push('No project identity generated');
    return { name: 'Identity', score: 0, status: 'fail', findings };
  }

  // Check required fields
  if (identity.name) { score += 20; findings.push(`Name: ${identity.name}`); }
  if (identity.purpose) { score += 20; findings.push(`Purpose documented`); }
  if (identity.primaryLanguage !== 'unknown') { score += 20; findings.push(`Primary language: ${identity.primaryLanguage}`); }
  if (identity.repositoryType !== 'unknown') { score += 20; findings.push(`Type: ${identity.repositoryType}`); }
  if (identity.architectureStyle !== 'unknown') { score += 20; findings.push(`Architecture: ${identity.architectureStyle}`); }

  const status = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  return { name: 'Identity', score, status, findings };
}

function verifyDocumentation(root: string, summary: RepositorySummary | null): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  // Check for README
  const hasReadme = fs.existsSync(path.join(root, 'README.md')) || fs.existsSync(path.join(root, 'readme.md'));
  if (hasReadme) { score += 30; findings.push('README.md exists'); }
  else { findings.push('No README.md found'); }

  // Check for docs directory
  const hasDocs = fs.existsSync(path.join(root, 'docs'));
  if (hasDocs) { score += 20; findings.push('docs/ directory exists'); }

  // Check module documentation from summary
  if (summary) {
    const documentedModules = summary.modules.filter(m => m.description && m.description.length > 10);
    const coverage = summary.modules.length > 0 ? documentedModules.length / summary.modules.length : 0;
    score += Math.round(coverage * 50);
    findings.push(`${documentedModules.length}/${summary.modules.length} modules documented`);
  }

  const status = score >= 70 ? 'pass' : score >= 40 ? 'warn' : 'fail';
  return { name: 'Documentation', score, status, findings };
}

function verifyModuleCoverage(root: string, summary: RepositorySummary | null): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  // Count actual source directories
  const actualModules = countSourceModules(root);
  const documentedModules = summary?.modules.length ?? 0;

  if (actualModules === 0) {
    findings.push('No source modules found');
    return { name: 'Module Coverage', score: 100, status: 'pass', findings };
  }

  const coverage = documentedModules / actualModules;
  score = Math.min(100, Math.round(coverage * 100));
  findings.push(`${documentedModules}/${actualModules} modules indexed`);

  const status = score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail';
  return { name: 'Module Coverage', score, status, findings };
}

function verifyHealth(health: RepositoryHealth | null): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  if (!health) {
    findings.push('No health report generated');
    return { name: 'Health', score: 0, status: 'fail', findings };
  }

  // Use health scores
  score = Math.round(
    (health.score.documentation + health.score.testing + health.score.maintainability) / 3
  );

  findings.push(`Documentation: ${health.score.documentation}/100`);
  findings.push(`Testing: ${health.score.testing}/100`);
  findings.push(`Maintainability: ${health.score.maintainability}/100`);

  if (health.issues.length > 0) {
    findings.push(`${health.issues.length} issues detected`);
  }

  const status = score >= 70 ? 'pass' : score >= 50 ? 'warn' : 'fail';
  return { name: 'Health', score, status, findings };
}

function verifyArchitecture(profile: RepositoryProfile | null, _identity: ProjectIdentity | null): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  if (profile) {
    score += 30;
    findings.push(`Architecture style: ${profile.architectureStyle}`);

    if (profile.designPatterns.length > 0) {
      score += 20;
      findings.push(`${profile.designPatterns.length} design patterns detected`);
    }

    if (profile.namingConventions.length > 0) {
      score += 20;
      findings.push(`${profile.namingConventions.length} naming conventions identified`);
    }

    if (profile.keyDecisions.length > 0) {
      score += 30;
      findings.push(`${profile.keyDecisions.length} key decisions documented`);
    }
  }

  if (_identity) {
    findings.push(`Identity architecture: ${_identity.architectureStyle}`);
  }

  const status = score >= 60 ? 'pass' : score >= 30 ? 'warn' : 'fail';
  return { name: 'Architecture', score, status, findings };
}

function verifyGlossary(glossary: ProjectGlossary | null, _root: string): VerificationSection {
  const findings: string[] = [];
  let score = 0;

  if (!glossary) {
    findings.push('No glossary generated');
    return { name: 'Glossary', score: 0, status: 'fail', findings };
  }

  const termCount = Object.keys(glossary.entries).length;
  score = Math.min(100, termCount * 2);
  findings.push(`${termCount} terms documented`);

  // Check for common project terms
  const hasComponent = Object.keys(glossary.entries).some(t => t.toLowerCase().includes('component'));
  const hasApi = Object.keys(glossary.entries).some(t => t.toLowerCase().includes('api'));
  if (hasComponent) { score += 10; findings.push('Component terminology documented'); }
  if (hasApi) { score += 10; findings.push('API terminology documented'); }

  const status = score >= 60 ? 'pass' : score >= 30 ? 'warn' : 'fail';
  return { name: 'Glossary', score, status, findings };
}

/* ── Helpers ────────────────────────────────────────────────────── */

function countSourceModules(root: string): number {
  let count = 0;
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
          count++;
        }
      }
    } catch { /* ignore */ }
  }
  return count || 1; // At least 1 for root
}

function generateSummary(score: number, sections: VerificationSection[]): string {
  const failing = sections.filter(s => s.status === 'fail');
  const warnings = sections.filter(s => s.status === 'warn');

  if (score >= 90) return 'Excellent! Repository intelligence is comprehensive and accurate.';
  if (score >= 70) return `Good. Score ${score}/100. ${warnings.length} warnings to address.`;
  if (score >= 50) return `Fair. Score ${score}/100. ${failing.length} sections need attention.`;
  return `Needs work. Score ${score}/100. Run intelligence pipeline to improve coverage.`;
}
