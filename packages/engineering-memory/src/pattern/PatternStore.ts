/**
 * Pattern Store
 * ==================================================================
 * Persistent storage for pattern records.
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile } from '../utils/persist';

const PATTERN_DIR = (projectId: string) => homePath('engineering-memory', projectId, 'patterns');

/** Pattern Store */
export class PatternStore {
  list(projectId: string): any[] {
    const dir = PATTERN_DIR(projectId);
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'stats.json')
      .map(file => {
        try {
          return readJsonFile<any>(path.join(dir, file), null);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  getProjectStats(projectId: string): any {
    return { projectId, totalPatterns: this.list(projectId).length };
  }

  static getOverallStats(): any {
    return { totalProjects: 0, totalPatterns: 0 };
  }
}
