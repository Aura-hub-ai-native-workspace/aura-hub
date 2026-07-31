/**
 * Memory Store
 * ==================================================================
 * Provides persistent storage for engineering memories.
 */

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../utils/persist';
import type { ProjectId, BaseMemoryRecord } from '../types';
import { generateId } from '../utils/idGenerator';

const MEMORY_DIR = (projectId: string) => homePath('engineering-memory', projectId);
const MEMORY_FILE = (projectId: string, id: string) => path.join(MEMORY_DIR(projectId), `${id}.json`);

/** Memory Store */
export class MemoryStore {
  constructor(private readonly projectId: ProjectId) {}

  create(record: Omit<BaseMemoryRecord, 'id' | 'timestamp'>): BaseMemoryRecord {
    const id = generateId('emem');
    const now = new Date().toISOString();
    
    const fullRecord: BaseMemoryRecord = {
      ...record,
      id,
      timestamp: now,
    };
    
    this.ensureDirectory();
    writeJsonFile(MEMORY_FILE(this.projectId, id), fullRecord);
    return fullRecord;
  }

  get(id: string): BaseMemoryRecord | null {
    const filePath = MEMORY_FILE(this.projectId, id);
    if (!existsSync(filePath)) return null;
    return readJsonFile<BaseMemoryRecord | null>(filePath, null);
  }

  list(): BaseMemoryRecord[] {
    const dir = MEMORY_DIR(this.projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => readJsonFile<BaseMemoryRecord | null>(path.join(dir, file), null))
      .filter(Boolean) as BaseMemoryRecord[];
  }

  query(): BaseMemoryRecord[] {
    return this.list();
  }

  search(query: string): BaseMemoryRecord[] {
    if (!query) return this.list();
    const lowerQuery = query.toLowerCase();
    return this.list().filter(record => 
      record.summary.toLowerCase().includes(lowerQuery) ||
      record.detailedRecord.toLowerCase().includes(lowerQuery) ||
      record.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  getByMission(missionId: string): BaseMemoryRecord[] {
    return this.list().filter(r => r.relatedMissionId === missionId);
  }

  getByDiagnosis(diagnosisId: string): BaseMemoryRecord[] {
    return this.list().filter(r => r.relatedDiagnosisId === diagnosisId);
  }

  getByFiles(files: string[]): BaseMemoryRecord[] {
    return this.list().filter(r => files.some(f => r.relatedFiles.includes(f)));
  }

  getBySymbols(symbols: string[]): BaseMemoryRecord[] {
    return this.list().filter(r => symbols.some(s => r.relatedSymbols.includes(s)));
  }

  getStats() {
    const all = this.list();
    return {
      projectId: this.projectId,
      totalMemories: all.length,
    };
  }

  private ensureDirectory(): void {
    mkdirSync(MEMORY_DIR(this.projectId), { recursive: true });
  }
}
