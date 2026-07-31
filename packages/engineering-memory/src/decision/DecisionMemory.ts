/**
 * Decision Memory
 * ==================================================================
 * Stores engineering decisions for future reference.
 */

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../utils/persist';
import type { ProjectId, MissionId, DiagnosisId, FilePath, ImportanceLevel, ConfidenceLevel, DecisionRecord, DecisionAlternative } from '../types';
import { generateDecisionId } from '../utils/idGenerator';

const DECISION_DIR = (projectId: string) => homePath('engineering-memory', projectId, 'decisions');
const DECISION_FILE = (projectId: string, id: string) => path.join(DECISION_DIR(projectId), `${id}.json`);

/** Decision Memory */
export class DecisionMemory {
  createDecision(projectId: ProjectId, data: {
    problem: string;
    alternatives: DecisionAlternative[];
    chosenSolution: DecisionAlternative;
    rejectedSolutions: DecisionAlternative[];
    reasoning: string;
    tradeoffs: string[];
    expectedOutcome: string;
    affectedComponents: FilePath[];
    affectedSymbols?: string[];
    relatedMissionId?: MissionId;
    relatedDiagnosisId?: DiagnosisId;
    tags?: string[];
    confidence?: ConfidenceLevel;
    importance?: ImportanceLevel;
  }): DecisionRecord {
    const id = generateDecisionId();
    const now = new Date().toISOString();
    
    const record: DecisionRecord = {
      id,
      projectId,
      timestamp: now,
      problem: data.problem,
      alternatives: data.alternatives,
      chosenSolution: data.chosenSolution,
      rejectedSolutions: data.rejectedSolutions,
      reasoning: data.reasoning,
      tradeoffs: data.tradeoffs,
      expectedOutcome: data.expectedOutcome,
      affectedComponents: data.affectedComponents,
      affectedSymbols: data.affectedSymbols ?? [],
      relatedMissionId: data.relatedMissionId,
      relatedDiagnosisId: data.relatedDiagnosisId,
      confidence: data.confidence ?? 'medium',
      importance: data.importance ?? 'high',
      tags: data.tags ?? [],
      relatedMemoryIds: [],
    };
    
    this.ensureDirectory(projectId);
    writeJsonFile(DECISION_FILE(projectId, id), record);
    return record;
  }

  getDecision(projectId: ProjectId, decisionId: string): DecisionRecord | null {
    const filePath = DECISION_FILE(projectId, decisionId);
    if (!existsSync(filePath)) return null;
    return readJsonFile<DecisionRecord | null>(filePath, null);
  }

  listDecisions(projectId: ProjectId): DecisionRecord[] {
    const dir = DECISION_DIR(projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => readJsonFile<DecisionRecord | null>(path.join(dir, file), null))
      .filter(Boolean) as DecisionRecord[];
  }

  private ensureDirectory(projectId: ProjectId): void {
    mkdirSync(DECISION_DIR(projectId), { recursive: true });
  }

  getAllProjectIds(): ProjectId[] {
    const baseDir = homePath('engineering-memory');
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir).filter(dir => {
      const decisionsDir = path.join(baseDir, dir, 'decisions');
      return existsSync(decisionsDir) && readdirSync(decisionsDir).length > 0;
    });
  }
}

export const decisionMemory = new DecisionMemory();
