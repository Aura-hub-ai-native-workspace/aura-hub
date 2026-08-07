/**
 * Mission Memory
 * ==================================================================
 * Stores mission records for future reference.
 */

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../utils/persist';
import type { ProjectId, MissionId, ImportanceLevel, ConfidenceLevel, MissionMemoryRecord, OutcomeType } from '../types';
import { generateId } from '../utils/idGenerator';

const MISSION_DIR = (projectId: string) => homePath('engineering-memory', projectId, 'missions');
const MISSION_FILE = (projectId: string, id: MissionId) => path.join(MISSION_DIR(projectId), `${id}.json`);

/** Mission Memory */
export class MissionMemory {
  createMission(projectId: ProjectId, data: {
    intent: string;
    outcome: OutcomeType;
    durationMinutes: number;
    confidence?: ConfidenceLevel;
    importance?: ImportanceLevel;
    tags?: string[];
  }): MissionMemoryRecord {
    const id = generateId('mission');
    const now = new Date().toISOString();
    
    const record: MissionMemoryRecord = {
      id,
      projectId,
      timestamp: now,
      intent: data.intent,
      outcome: data.outcome,
      durationMinutes: data.durationMinutes,
      confidence: data.confidence ?? 'medium',
      importance: data.importance ?? 'medium',
      tags: data.tags ?? [],
      relatedMemoryIds: [],
    };
    
    this.ensureDirectory(projectId);
    writeJsonFile(MISSION_FILE(projectId, id), record);
    return record;
  }

  getMission(projectId: ProjectId, missionId: MissionId): MissionMemoryRecord | null {
    const filePath = MISSION_FILE(projectId, missionId);
    if (!existsSync(filePath)) return null;
    return readJsonFile<MissionMemoryRecord | null>(filePath, null);
  }

  listMissions(projectId: ProjectId): MissionMemoryRecord[] {
    const dir = MISSION_DIR(projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => readJsonFile<MissionMemoryRecord | null>(path.join(dir, file), null))
      .filter(Boolean) as MissionMemoryRecord[];
  }

  private ensureDirectory(projectId: ProjectId): void {
    mkdirSync(MISSION_DIR(projectId), { recursive: true });
  }

  getAllProjectIds(): ProjectId[] {
    const baseDir = homePath('engineering-memory');
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir).filter(dir => {
      const missionsDir = path.join(baseDir, dir, 'missions');
      return existsSync(missionsDir) && readdirSync(missionsDir).length > 0;
    });
  }
}

export const missionMemory = new MissionMemory();
