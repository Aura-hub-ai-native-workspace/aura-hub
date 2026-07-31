/**
 * MissionStore — persistent local mission records. One JSON file per
 * mission under ~/.aura/missions/<projectId>/<id>.json (AURA_HOME
 * aware), written atomically — exact mirror of `workflow/store.ts` and
 * `diagnosis/store.ts`'s pattern.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { genId } from '../workflow/types';
import type { MissionRecord, MissionSummary } from './types';
import { MissionExecutionEngine } from './execution/engine';

const dir = (projectId: string) => {
  const d = homePath('missions', projectId);
  mkdirSync(d, { recursive: true });
  return d;
};
const fileOf = (projectId: string, id: string) => path.join(dir(projectId), `${id}.json`);

/** Engine instance with no-op side effects — used only to hydrate reads. */
const hydrationEngine = new MissionExecutionEngine({
  runTask: async () => ({ ok: false, error: 'read-only hydrate' }),
  persist: () => undefined,
});

function hydrate(rec: MissionRecord | null): MissionRecord | null {
  if (!rec) return null;
  hydrationEngine.hydrate(rec);
  hydrationEngine.refreshStatus(rec);
  return rec;
}

export class MissionStore {
  list(projectId: string): MissionSummary[] {
    const out: MissionSummary[] = [];
    for (const f of readdirSync(dir(projectId))) {
      if (!f.endsWith('.json')) continue;
      const rec = hydrate(readJsonFile<MissionRecord | null>(path.join(dir(projectId), f), null));
      if (!rec?.id) continue;
      out.push({
        id: rec.id, projectId: rec.projectId, text: rec.text, createdAt: rec.createdAt,
        category: rec.classification?.category ?? 'unknown',
        goalCount: rec.goalGraph?.goals.length ?? 0, taskCount: rec.goalGraph?.tasks.length ?? 0,
        approval: rec.approval,
        qualityOverall: rec.quality?.overall ?? null,
        execution: rec.execution ?? null,
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(projectId: string, id: string): MissionRecord | null {
    return hydrate(readJsonFile<MissionRecord | null>(fileOf(projectId, id), null));
  }

  create(projectId: string, partial: Omit<MissionRecord, 'id' | 'createdAt' | 'projectId'>): MissionRecord {
    const rec: MissionRecord = { ...partial, id: genId('mission'), projectId, createdAt: new Date().toISOString() };
    writeJsonFile(fileOf(projectId, rec.id), rec);
    return rec;
  }

  save(projectId: string, rec: MissionRecord): MissionRecord {
    writeJsonFile(fileOf(projectId, rec.id), rec);
    return rec;
  }

  patch(projectId: string, id: string, partial: Partial<MissionRecord>): MissionRecord | null {
    const existing = this.get(projectId, id);
    if (!existing) return null;
    const rec: MissionRecord = { ...existing, ...partial, id, projectId, createdAt: existing.createdAt };
    writeJsonFile(fileOf(projectId, id), rec);
    return rec;
  }

  remove(projectId: string, id: string): boolean {
    try {
      rmSync(fileOf(projectId, id));
      return true;
    } catch {
      return false;
    }
  }
}
