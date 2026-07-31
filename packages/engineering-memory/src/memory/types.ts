/**
 * Engineering Memory Module — Types
 * ==================================================================
 * This file defines the types specific to the Engineering Memory subsystem.
 */

import type { MemoryId, ProjectId, MissionId, DiagnosisId, FilePath, SymbolId, MemoryCategory, ImportanceLevel, ConfidenceLevel, MemoryReference } from '../types';

/** Engineering memory record */
export interface EngineeringMemoryRecord {
  id: MemoryId;
  projectId: ProjectId;
  timestamp: string;
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
  metadata: MemoryMetadata;
}

/** Metadata for memory records */
export interface MemoryMetadata {
  source: string;
  version: number;
  [key: string]: unknown;
}

/** Memory filter */
export interface MemoryFilter {
  projectIds?: ProjectId[];
  categories?: MemoryCategory[];
  importanceLevels?: ImportanceLevel[];
  confidenceLevels?: ConfidenceLevel[];
  tags?: string[];
  relatedFiles?: FilePath[];
  relatedSymbols?: SymbolId[];
  relatedMissionIds?: MissionId[];
  relatedDiagnosisIds?: DiagnosisId[];
  sources?: string[];
  dateRange?: { start?: string; end?: string };
  textSearch?: string;
}

/** Memory query options */
export interface MemoryQueryOptions {
  filter?: MemoryFilter;
  sort?: { field: 'timestamp' | 'importance' | 'confidence' | 'summary'; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

/** Project memory stats */
export interface ProjectMemoryStats {
  projectId: ProjectId;
  totalMemories: number;
}

/** Memory statistics */
export interface MemoryStatistics {
  totalProjects: number;
  totalMemories: number;
}

/** Memory event */
export interface MemoryEvent {
  type: 'created' | 'updated' | 'deleted' | 'linked' | 'unlinked';
  memoryId: MemoryId;
  projectId: ProjectId;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** Memory event listener */
export type MemoryEventListener = (event: MemoryEvent) => void;

/** Memory index */
export interface MemoryIndex {
  byProject: Map<ProjectId, Set<MemoryId>>;
  byCategory: Map<MemoryCategory, Set<MemoryId>>;
  byImportance: Map<ImportanceLevel, Set<MemoryId>>;
  byConfidence: Map<ConfidenceLevel, Set<MemoryId>>;
  byTag: Map<string, Set<MemoryId>>;
  byFile: Map<FilePath, Set<MemoryId>>;
  bySymbol: Map<SymbolId, Set<MemoryId>>;
  entries: Map<MemoryId, MemoryIndexEntry>;
}

/** Memory index entry */
export interface MemoryIndexEntry {
  memoryId: MemoryId;
  projectId: ProjectId;
  category: MemoryCategory;
  importance: ImportanceLevel;
  confidence: ConfidenceLevel;
  tags: string[];
  relatedFiles: FilePath[];
  relatedSymbols: SymbolId[];
  timestamp: string;
  summary: string;
  tokens: Set<string>;
}
