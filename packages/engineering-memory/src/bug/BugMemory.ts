/**
 * Bug Memory
 * ==================================================================
 * Stores bug diagnoses and outcomes for future reference.
 */

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../utils/persist';
import type { ProjectId, MissionId, DiagnosisId, FilePath, ImportanceLevel, ConfidenceLevel, BugRecord, BugType, ArchitectureLayer } from '../types';
import { generateBugId } from '../utils/idGenerator';

const BUG_DIR = (projectId: string) => homePath('engineering-memory', projectId, 'bugs');
const BUG_FILE = (projectId: string, id: string) => path.join(BUG_DIR(projectId), `${id}.json`);

/** Bug Memory */
export class BugMemory {
  createBug(projectId: ProjectId, data: {
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
    relatedPatchId?: string;
    tags?: string[];
    isFixed?: boolean;
    fixVerification?: string;
  }): BugRecord {
    const id = generateBugId();
    const now = new Date().toISOString();
    
    const record: BugRecord = {
      id,
      projectId,
      timestamp: now,
      bugType: data.bugType,
      rootCause: data.rootCause,
      symptoms: data.symptoms,
      evidence: data.evidence,
      fixStrategy: data.fixStrategy,
      risk: data.risk,
      files: data.files,
      architectureLayer: data.architectureLayer,
      confidence: data.confidence,
      relatedMissionId: data.relatedMissionId,
      relatedDiagnosisId: data.relatedDiagnosisId,
      relatedPatchId: data.relatedPatchId,
      tags: data.tags ?? [],
      relatedMemoryIds: [],
      isFixed: data.isFixed ?? false,
      fixVerification: data.fixVerification,
    };
    
    this.ensureDirectory(projectId);
    writeJsonFile(BUG_FILE(projectId, id), record);
    return record;
  }

  getBug(projectId: ProjectId, bugId: string): BugRecord | null {
    const filePath = BUG_FILE(projectId, bugId);
    if (!existsSync(filePath)) return null;
    return readJsonFile<BugRecord | null>(filePath, null);
  }

  listBugs(projectId: ProjectId): BugRecord[] {
    const dir = BUG_DIR(projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => readJsonFile<BugRecord | null>(path.join(dir, file), null))
      .filter(Boolean) as BugRecord[];
  }

  private ensureDirectory(projectId: ProjectId): void {
    mkdirSync(BUG_DIR(projectId), { recursive: true });
  }

  getAllProjectIds(): ProjectId[] {
    const baseDir = homePath('engineering-memory');
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir).filter(dir => {
      const bugsDir = path.join(baseDir, dir, 'bugs');
      return existsSync(bugsDir) && readdirSync(bugsDir).length > 0;
    });
  }
}

export const bugMemory = new BugMemory();
