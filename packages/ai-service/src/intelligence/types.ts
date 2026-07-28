/**
 * Repository Intelligence Engine — Core Types
 * ==================================================================
 * The vocabulary for AURA's repository understanding layer.
 * Everything here is provider-agnostic. LLMs receive pre-assembled context.
 */

/* ── Project Identity ────────────────────────────────────────────── */

export type RepositoryType =
  | 'operating-system'
  | 'kernel'
  | 'compiler'
  | 'database'
  | 'library'
  | 'cli'
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'infrastructure'
  | 'ai-framework'
  | 'mobile'
  | 'desktop'
  | 'game'
  | 'embedded'
  | 'unknown';

export type Platform =
  | 'web'
  | 'node'
  | 'browser'
  | 'ios'
  | 'android'
  | 'linux'
  | 'darwin'
  | 'windows'
  | 'embedded'
  | 'wasm'
  // Native / bare-metal targets (kernels, firmware, OS images).
  | 'x86_64'
  | 'x86'
  | 'arm'
  | 'arm64'
  | 'riscv'
  | 'uefi'
  | 'bare-metal'
  | 'native';

export type ArchitectureStyle =
  | 'monolithic'
  | 'microkernel'
  | 'microservices'
  | 'layered'
  | 'event-driven'
  | 'plugin-based'
  | 'monolith'
  | 'serverless'
  | 'monorepo'
  | 'mvc'
  | 'plugin'
  | 'unknown';

export interface ProjectIdentity {
  id: string;
  name: string;
  purpose: string;
  repositoryType: RepositoryType;
  primaryLanguage: string;
  secondaryLanguages: string[];
  buildSystem: string | null;
  frameworks: string[];
  platforms: Platform[];
  architectureStyle: ArchitectureStyle;
  mainModules: string[];
  entryPoints: string[];
  status: 'active' | 'archived' | 'experimental' | 'unknown';
  description: string;
  technologyStack: string[];
  generatedAt: string;
  fingerprint: string;
}

/* ── Repository Intent ───────────────────────────────────────────── */

export type RepositoryIntentType =
  | 'project_overview'
  | 'architecture'
  | 'module_explanation'
  | 'function_explanation'
  | 'bug_fix'
  | 'debugging'
  | 'refactoring'
  | 'code_search'
  | 'api_reference'
  | 'dependency'
  | 'build_system'
  | 'documentation'
  | 'design'
  | 'security'
  | 'performance'
  | 'testing'
  | 'unknown';

export interface RetrievalStrategy {
  /** Ordered list of knowledge sources to query. */
  sources: string[];
  /** Maximum tokens to allocate. */
  tokenBudget: number;
  /** Whether to include raw source code. */
  includeSource: boolean;
  /** Whether to include graph relationships. */
  includeGraph: boolean;
  /** Whether to include memory items. */
  includeMemory: boolean;
}

export interface RepositoryIntent {
  type: RepositoryIntentType;
  confidence: number;
  entities: string[];
  retrievalStrategy: RetrievalStrategy;
}

/* ── Module Summary ──────────────────────────────────────────────── */

export interface ModuleSummary {
  name: string;
  path: string;
  description: string;
  capabilities: string[];
  fileCount: number;
  primaryLanguage: string;
  keyFiles: string[];
  dependencies: string[];
  childModules: string[];
}

export interface RepositorySummary {
  projectName: string;
  purpose: string;
  modules: ModuleSummary[];
  totalFiles: number;
  generatedAt: string;
}

/* ── Document Priority ───────────────────────────────────────────── */

export type DocumentPriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface PrioritizedDocument {
  path: string;
  priority: DocumentPriority;
  kind: 'readme' | 'project' | 'vision' | 'architecture' | 'design' | 'module_summary' | 'graph' | 'source' | 'config' | 'test';
  title: string;
}

/* ── Repository Memory ───────────────────────────────────────────── */

export interface RepositoryProfile {
  architectureStyle: string;
  designPatterns: string[];
  namingConventions: string[];
  moduleStructure: string[];
  dependencies: string[];
  keyDecisions: string[];
  generatedAt: string;
}

/* ── Confidence ──────────────────────────────────────────────────── */

export type ConfidenceLevel = 'documented' | 'inferred' | 'uncertain';

export interface ConfidenceMark {
  level: ConfidenceLevel;
  evidence: string;
  source?: string;
}

/* ── Glossary ────────────────────────────────────────────────────── */

export interface GlossaryEntry {
  term: string;
  definition: string;
  domain: string;
  source: string;
}

export interface ProjectGlossary {
  entries: Record<string, GlossaryEntry>;
  generatedAt: string;
}

/* ── Repository Health ───────────────────────────────────────────── */

export interface HealthScore {
  overall: number;
  documentation: number;
  architecture: number;
  testing: number;
  dependencies: number;
  maintainability: number;
}

export interface HealthIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
  file?: string;
}

export interface RepositoryHealth {
  score: HealthScore;
  issues: HealthIssue[];
  metrics: {
    totalFiles: number;
    documentedModules: number;
    totalModules: number;
    testFiles: number;
    deadCodeEstimate: number;
    orphanModules: number;
    missingDocs: string[];
    unreferencedApis: string[];
  };
  generatedAt: string;
}
