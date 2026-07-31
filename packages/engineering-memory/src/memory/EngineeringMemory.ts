/**
 * Engineering Memory
 * ==================================================================
 * Main API for engineering memory operations.
 */

import type { ProjectId, MissionId, DiagnosisId, FilePath, ImportanceLevel, ConfidenceLevel, BaseMemoryRecord, MemoryReference } from '../types';
import { MemoryStore } from './MemoryStore';

/** Engineering Memory */
export class EngineeringMemory {
  private stores: Map<ProjectId, MemoryStore> = new Map();

  private getStore(projectId: ProjectId): MemoryStore {
    if (!this.stores.has(projectId)) {
      this.stores.set(projectId, new MemoryStore(projectId));
    }
    return this.stores.get(projectId)!;
  }

  create(record: Omit<BaseMemoryRecord, 'id' | 'timestamp'>): BaseMemoryRecord {
    const store = this.getStore(record.projectId);
    return store.create(record);
  }

  createMissionCreated(projectId: ProjectId, data: {
    missionId: MissionId;
    intent: string;
    relatedFiles?: FilePath[];
    relatedSymbols?: string[];
    tags?: string[];
    summary?: string;
    detailedRecord?: string;
    references?: MemoryReference[];
    importance?: ImportanceLevel;
    confidence?: ConfidenceLevel;
  }): BaseMemoryRecord {
    return this.create({
      projectId,
      category: 'mission-created',
      relatedMissionId: data.missionId,
      relatedFiles: data.relatedFiles ?? [],
      relatedSymbols: data.relatedSymbols ?? [],
      tags: data.tags ?? ['mission'],
      summary: data.summary ?? `Mission created: ${data.intent.slice(0, 100)}`,
      detailedRecord: data.detailedRecord ?? `Mission created with intent: ${data.intent}`,
      references: data.references ?? [],
      importance: data.importance ?? 'medium',
      confidence: data.confidence ?? 'medium',
    });
  }

  createMissionCompleted(projectId: ProjectId, data: {
    missionId: MissionId;
    outcome: 'success' | 'failure' | 'partial';
    durationMinutes: number;
    goalsCompleted: number;
    goalsTotal: number;
    relatedFiles?: FilePath[];
    relatedSymbols?: string[];
    tags?: string[];
    summary?: string;
    detailedRecord?: string;
    references?: MemoryReference[];
    importance?: ImportanceLevel;
    confidence?: ConfidenceLevel;
  }): BaseMemoryRecord {
    return this.create({
      projectId,
      category: 'mission-completed',
      relatedMissionId: data.missionId,
      relatedFiles: data.relatedFiles ?? [],
      relatedSymbols: data.relatedSymbols ?? [],
      tags: data.tags ?? ['mission', data.outcome],
      summary: data.summary ?? `Mission ${data.outcome}: ${data.goalsCompleted}/${data.goalsTotal} goals`,
      detailedRecord: data.detailedRecord ?? 
        `Mission completed with outcome: ${data.outcome}. Duration: ${data.durationMinutes} minutes.`,
      references: data.references ?? [],
      importance: data.importance ?? (data.outcome === 'failure' ? 'high' : 'medium'),
      confidence: data.confidence ?? 'high',
    });
  }

  queryProject(projectId: ProjectId): BaseMemoryRecord[] {
    return this.getStore(projectId).list();
  }

  searchAll(query: string): BaseMemoryRecord[] {
    const allProjects = Array.from(this.stores.keys());
    const results: BaseMemoryRecord[] = [];
    for (const projectId of allProjects) {
      results.push(...this.getStore(projectId).search(query));
    }
    return results;
  }

  getByMission(missionId: MissionId): BaseMemoryRecord[] {
    const allProjects = Array.from(this.stores.keys());
    const results: BaseMemoryRecord[] = [];
    for (const projectId of allProjects) {
      results.push(...this.getStore(projectId).getByMission(missionId));
    }
    return results;
  }

  getByDiagnosis(diagnosisId: DiagnosisId): BaseMemoryRecord[] {
    const allProjects = Array.from(this.stores.keys());
    const results: BaseMemoryRecord[] = [];
    for (const projectId of allProjects) {
      results.push(...this.getStore(projectId).getByDiagnosis(diagnosisId));
    }
    return results;
  }

  getProjectStats(projectId: ProjectId) {
    return this.getStore(projectId).getStats();
  }

  getOverallStats() {
    const allProjects = Array.from(this.stores.keys());
    let total = 0;
    for (const projectId of allProjects) {
      const stats = this.getStore(projectId).getStats();
      total += stats.totalMemories;
    }
    return { totalProjects: allProjects.length, totalMemories: total };
  }

  clearAll(): void {
    this.stores.clear();
  }
}

export const engineeringMemory = new EngineeringMemory();
