/**
 * Engineering Memory Platform — Core Types
 * ==================================================================
 * This file defines the foundational types for the entire Engineering Memory Platform.
 */

// ============================================================================
// BASE TYPES
// ============================================================================

/** Unique identifier */
export type MemoryId = string;
/** Project identifier */
export type ProjectId = string;
/** Mission identifier */
export type MissionId = string;
/** Diagnosis identifier */
export type DiagnosisId = string;
/** Patch identifier */
export type PatchId = string;
/** Decision identifier */
export type DecisionId = string;
/** Bug identifier */
export type BugId = string;
/** Symbol identifier */
export type SymbolId = string;
/** File path */
export type FilePath = string;
/** ISO 8601 timestamp */
export type Timestamp = string;

// ============================================================================
// CATEGORIES AND LEVELS
// ============================================================================

/** Categories of engineering memories */
export type MemoryCategory =
  | 'mission-created'
  | 'mission-completed'
  | 'mission-failed'
  | 'diagnosis-created'
  | 'diagnosis-accepted'
  | 'diagnosis-rejected'
  | 'patch-accepted'
  | 'patch-rejected'
  | 'architecture-decision'
  | 'review-decision'
  | 'knowledge-update'
  | 'documentation-update'
  | 'code-change';

/** Importance levels */
export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** Confidence levels */
export type ConfidenceLevel = 'certain' | 'high' | 'medium' | 'low' | 'unknown';
/** Outcome types */
export type OutcomeType = 'success' | 'failure' | 'partial' | 'pending' | 'unknown';

// ============================================================================
// ENGINEERING DOMAINS
// ============================================================================

/** Engineering domains */
export type EngineeringDomain =
  | 'authentication'
  | 'authorization'
  | 'backend'
  | 'frontend'
  | 'networking'
  | 'database'
  | 'security'
  | 'performance'
  | 'testing'
  | 'documentation'
  | 'architecture'
  | 'devops'
  | 'build'
  | 'monitoring'
  | 'api-design'
  | 'data-modeling';

// ============================================================================
// BUG AND ARCHITECTURE TYPES
// ============================================================================

/** Bug type classification */
export type BugType =
  | 'null-pointer'
  | 'type-error'
  | 'logic-error'
  | 'race-condition'
  | 'memory-leak'
  | 'performance'
  | 'security'
  | 'build-error'
  | 'test-failure'
  | 'integration-issue'
  | 'configuration-error'
  | 'api-contract'
  | 'data-corruption'
  | 'unknown';

/** Architecture layer */
export type ArchitectureLayer =
  | 'presentation'
  | 'application'
  | 'domain'
  | 'infrastructure'
  | 'database'
  | 'external'
  | 'build'
  | 'test';

// ============================================================================
// PATTERN TYPES
// ============================================================================

/** Pattern identifier */
export type PatternId = string;
/** Types of engineering patterns */
export type PatternType =
  | 'null-pointer-fix'
  | 'architecture-violation'
  | 'dependency-cycle'
  | 'performance-bottleneck'
  | 'security-finding'
  | 'review-comment'
  | 'code-smell'
  | 'test-failure'
  | 'build-error'
  | 'api-change';

// ============================================================================
// REFERENCE TYPES
// ============================================================================

/** Reference to another memory or external resource */
export interface MemoryReference {
  type: 'memory' | 'document' | 'issue' | 'commit' | 'pr' | 'url';
  id: string;
  description?: string;
}

// ============================================================================
// BASE RECORDS (simplified for now)
// ============================================================================

/** Base memory record */
export interface BaseMemoryRecord {
  id: MemoryId;
  projectId: ProjectId;
  timestamp: Timestamp;
  category: MemoryCategory;
  importance: ImportanceLevel;
  confidence: ConfidenceLevel;
  relatedFiles: FilePath[];
  relatedSymbols: SymbolId[];
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  tags: string[];
  summary: string;
  detailedRecord: string;
  references: MemoryReference[];
}

/** Decision alternative */
export interface DecisionAlternative {
  id: string;
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  complexity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
}

/** Decision record */
export interface DecisionRecord {
  id: DecisionId;
  projectId: ProjectId;
  timestamp: Timestamp;
  problem: string;
  alternatives: DecisionAlternative[];
  chosenSolution: DecisionAlternative;
  rejectedSolutions: DecisionAlternative[];
  reasoning: string;
  tradeoffs: string[];
  expectedOutcome: string;
  actualOutcome?: string;
  affectedComponents: FilePath[];
  affectedSymbols: SymbolId[];
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  confidence: ConfidenceLevel;
  importance: ImportanceLevel;
  tags: string[];
  relatedMemoryIds: MemoryId[];
}

/** Bug record */
export interface BugRecord {
  id: BugId;
  projectId: ProjectId;
  timestamp: Timestamp;
  bugType: BugType;
  rootCause: string;
  symptoms: string[];
  evidence: string[];
  fixStrategy: string;
  risk: ImportanceLevel;
  files: FilePath[];
  architectureLayer: ArchitectureLayer;
  confidence: ConfidenceLevel;
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  relatedPatchId?: PatchId;
  tags: string[];
  relatedMemoryIds: MemoryId[];
  isFixed: boolean;
  fixVerification?: string;
}

/** Mission memory record */
export interface MissionMemoryRecord {
  id: MissionId;
  projectId: ProjectId;
  timestamp: Timestamp;
  intent: string;
  outcome: OutcomeType;
  durationMinutes: number;
  confidence: ConfidenceLevel;
  importance: ImportanceLevel;
  tags: string[];
  relatedMemoryIds: MemoryId[];
}

/** Timeline event */
export interface TimelineEvent {
  id: string;
  projectId: ProjectId;
  timestamp: Timestamp;
  type: string;
  entityId: string;
  entityType: 'mission' | 'diagnosis' | 'patch' | 'decision' | 'knowledge' | 'review';
  summary: string;
  details: string;
  relatedFiles: FilePath[];
  relatedSymbols: SymbolId[];
  durationMinutes?: number;
  outcome?: OutcomeType;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/** Nullable type */
export type Nullable<T> = T | null;
/** Optional type */
export type Optional<T> = T | undefined;
/** Partial by keys */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
