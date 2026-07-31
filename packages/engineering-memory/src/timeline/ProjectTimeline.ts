/**
 * Project Timeline
 * ==================================================================
 * Maintains chronological record of engineering events.
 */

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../utils/persist';
import type { ProjectId, FilePath, SymbolId, TimelineEvent } from '../types';
import { generateTimelineId } from '../utils/idGenerator';

const TIMELINE_DIR = (projectId: string) => homePath('engineering-memory', projectId, 'timeline');
const TIMELINE_FILE = (projectId: string, id: string) => path.join(TIMELINE_DIR(projectId), `${id}.json`);

/** Project Timeline */
export class ProjectTimeline {
  recordEvent(projectId: ProjectId, data: {
    type: string;
    entityId: string;
    entityType: 'mission' | 'diagnosis' | 'patch' | 'decision' | 'knowledge' | 'review';
    summary: string;
    details: string;
    relatedFiles?: FilePath[];
    relatedSymbols?: SymbolId[];
    durationMinutes?: number;
    outcome?: 'success' | 'failure' | 'partial' | 'pending' | 'unknown';
  }): TimelineEvent {
    const id = generateTimelineId();
    const now = new Date().toISOString();
    
    const event: TimelineEvent = {
      id,
      projectId,
      timestamp: now,
      type: data.type,
      entityId: data.entityId,
      entityType: data.entityType,
      summary: data.summary,
      details: data.details,
      relatedFiles: data.relatedFiles ?? [],
      relatedSymbols: data.relatedSymbols ?? [],
      durationMinutes: data.durationMinutes,
      outcome: data.outcome,
    };
    
    this.ensureDirectory(projectId);
    writeJsonFile(TIMELINE_FILE(projectId, id), event);
    return event;
  }

  getTimeline(projectId: ProjectId): TimelineEvent[] {
    const dir = TIMELINE_DIR(projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => readJsonFile<TimelineEvent | null>(path.join(dir, file), null))
      .filter(Boolean) as TimelineEvent[];
  }

  private ensureDirectory(projectId: ProjectId): void {
    mkdirSync(TIMELINE_DIR(projectId), { recursive: true });
  }
}

export const projectTimeline = new ProjectTimeline();
