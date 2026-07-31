/**
 * Public APIs — the governance platform's integration surface.
 * ==================================================================
 * Modular entry points for every governance capability. Each function
 * runs real analysis over the given project path and returns the
 * corresponding report. A `GovernanceEngine` class provides shared
 * caching and one-call access to every report type.
 */

import { getArchitectureHealth, type ArchitectureHealthReport, type ArchitectureInput } from '../architecture/architecture_governance';
import { getTechnicalDebt, type TechnicalDebtReport, type DebtInput } from '../debt/technical_debt_engine';
import { getSecurityReport, type SecurityReport, type SecurityInput } from '../security/security_review';
import { getDocumentationHealth, type DocumentationHealthReport, type DocInput } from '../docs/documentation_governance';
import { getEngineeringScorecard, type EngineeringScorecard, type ScorecardInput } from '../health/engineering_health_engine';
import { getReleaseReadiness, type ReleaseReadinessReport, type ReleaseInput } from '../release/release_readiness';
import { getQualityReport, type QualityReport, type QualityInput } from '../quality/quality_gates';
import { getEngineeringAudit, type EngineeringAuditReport, type AuditInput, type AuditScope } from '../audit/engineering_audit';
import { getProjectInsights, type ProjectInsightsReport, type InsightsInput } from '../insights/project_insights';
import { getArchitectureCouncil, type ArchitectureCouncilReport, type CouncilInput } from '../council/architecture_council';

export { getArchitectureHealth };
export { getTechnicalDebt };
export { getSecurityReport };
export { getDocumentationHealth };
export { getEngineeringScorecard };
export { getReleaseReadiness };
export { getQualityReport };
export { getEngineeringAudit };
export { getProjectInsights };
export { getArchitectureCouncil };

export type {
  ArchitectureHealthReport,
  TechnicalDebtReport,
  SecurityReport,
  DocumentationHealthReport,
  EngineeringScorecard,
  ReleaseReadinessReport,
  QualityReport,
  EngineeringAuditReport,
  ProjectInsightsReport,
  ArchitectureCouncilReport,
  AuditScope,
};

export interface GovernanceEngineOptions {
  /** Cache analysis results in memory keyed by (root, report). Default true. */
  cache?: boolean;
}

type ReportName =
  | 'architecture'
  | 'debt'
  | 'security'
  | 'documentation'
  | 'scorecard'
  | 'release'
  | 'quality'
  | 'audit'
  | 'insights'
  | 'council';

interface CacheEntry {
  at: number;
  value: unknown;
}

const TTL_MS = 60_000;

export class GovernanceEngine {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly useCache: boolean;

  constructor(opts: GovernanceEngineOptions = {}) {
    this.useCache = opts.cache ?? true;
  }

  async analyze<T>(name: ReportName, root: string, fn: () => Promise<T>): Promise<T> {
    const key = `${root}|${name}`;
    if (this.useCache) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    }
    const value = await fn();
    if (this.useCache) this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  getArchitectureHealth(input: ArchitectureInput): Promise<ArchitectureHealthReport> {
    return this.analyze('architecture', input.projectPath, () => getArchitectureHealth(input));
  }

  getTechnicalDebt(input: DebtInput): Promise<TechnicalDebtReport> {
    return this.analyze('debt', input.projectPath, () => getTechnicalDebt(input));
  }

  getSecurityReport(input: SecurityInput): Promise<SecurityReport> {
    return this.analyze('security', input.projectPath, () => getSecurityReport(input));
  }

  getDocumentationHealth(input: DocInput): Promise<DocumentationHealthReport> {
    return this.analyze('documentation', input.projectPath, () => getDocumentationHealth(input));
  }

  getEngineeringScorecard(input: ScorecardInput): Promise<EngineeringScorecard> {
    return this.analyze('scorecard', input.projectPath, () => getEngineeringScorecard(input));
  }

  getReleaseReadiness(input: ReleaseInput): Promise<ReleaseReadinessReport> {
    return this.analyze('release', input.projectPath, () => getReleaseReadiness(input));
  }

  getQualityReport(input: QualityInput): Promise<QualityReport> {
    return this.analyze('quality', input.projectPath, () => getQualityReport(input));
  }

  getEngineeringAudit(input: AuditInput): Promise<EngineeringAuditReport> {
    return this.analyze('audit', input.projectPath, () => getEngineeringAudit(input));
  }

  getProjectInsights(input: InsightsInput): Promise<ProjectInsightsReport> {
    return this.analyze('insights', input.projectPath, () => getProjectInsights(input));
  }

  getArchitectureCouncil(input: CouncilInput): Promise<ArchitectureCouncilReport> {
    return this.analyze('council', input.projectPath, () => getArchitectureCouncil(input));
  }

  clear(): void {
    this.cache.clear();
  }
}

export function createGovernanceEngine(opts?: GovernanceEngineOptions): GovernanceEngine {
  return new GovernanceEngine(opts);
}
