/**
 * @aura/governance — Engineering Governance Platform
 * ==================================================================
 * Continuously protects AURA from architectural decay: architecture
 * health, technical debt, security review, documentation drift, quality
 * gates, engineering audits, scorecard, project insights and the
 * Architecture Council. Consumes only public APIs of the Knowledge
 * Fabric and shared platform packages. Every report is derived from
 * real project analysis — no fabricated metrics.
 */

// Architecture Health Engine
export {
  getArchitectureHealth,
  defaultLayerRules,
  DEFAULT_THRESHOLDS,
  layerOf,
  severityRank,
  summarizeArchitecture,
  toScore100,
  type ArchitectureHealthReport,
  type ArchitectureFinding,
  type ArchitectureInput,
  type ArchitectureMetrics,
  type LayerRule,
  type ArchitectureThresholds,
} from './architecture/architecture_governance';

// Technical Debt Engine
export {
  getTechnicalDebt,
  DEFAULT_DEBT_THRESHOLDS,
  summarizeDebt,
  type TechnicalDebtReport,
  type DebtItem,
  type DebtInput,
  type DebtCategory,
  type DebtThresholds,
} from './debt/technical_debt_engine';

// Security Engine
export {
  getSecurityReport,
  summarizeSecurity,
  type SecurityReport,
  type SecurityFinding,
  type SecurityInput,
  type SecurityFindingType,
} from './security/security_review';

// Shared security patterns
export { SECRET_PATTERNS, UNSAFE_PATTERNS, PERMISSION_PATTERNS, AUTH_PATTERNS, PLACEHOLDER_PATTERN } from './security/patterns';

// Documentation Governance
export {
  getDocumentationHealth,
  summarizeDocs,
  type DocumentationHealthReport,
  type DocIssue,
  type DocInput,
  type DocIssueType,
} from './docs/documentation_governance';

// Engineering Scorecard
export {
  getEngineeringScorecard,
  summarizeScorecard,
  type EngineeringScorecard,
  type ScorecardDimension,
  type ScoreDimension,
  type ScorecardInput,
} from './health/engineering_health_engine';

// Release Readiness
export {
  getReleaseReadiness,
  type ReleaseReadinessReport,
  type ReleaseInput,
  type ReadinessDimension,
  type ReadinessDimensionResult,
} from './release/release_readiness';

// Quality Gates
export {
  getQualityReport,
  type QualityReport,
  type QualityInput,
  type GateResult,
  type GateName,
  type GateStatus,
} from './quality/quality_gates';

// Engineering Audits
export {
  getEngineeringAudit,
  summarizeAudit,
  type EngineeringAuditReport,
  type AuditInput,
  type AuditScope,
  type AuditSnapshot,
  type TopRisk,
} from './audit/engineering_audit';

// Project Insights
export {
  getProjectInsights,
  summarizeInsights,
  type ProjectInsightsReport,
  type Insight,
  type InsightsInput,
  type InsightType,
} from './insights/project_insights';

// Architecture Council
export {
  getArchitectureCouncil,
  summarizeCouncil,
  DEFAULT_SUBSYSTEMS,
  type ArchitectureCouncilReport,
  type CouncilReview,
  type CouncilInput,
  type CouncilMetrics,
} from './council/architecture_council';

// Public APIs
export {
  createGovernanceEngine,
  GovernanceEngine,
  type GovernanceEngineOptions,
} from './api/public_apis';

// Core shared types
export type { Evidence, Finding, ReportMeta, Score, ScorePart, Severity } from './core/types';
