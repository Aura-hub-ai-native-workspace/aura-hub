/**
 * DiagnosisStore — persistent local diagnosis records. One JSON file
 * per diagnosis under ~/.aura/diagnosis/<projectId>/<id>.json (AURA_HOME
 * aware), written atomically — exact mirror of `workflow/store.ts`'s
 * pattern.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { genId } from '../workflow/types';
import type { DiagnosisRecord, DiagnosisSummary } from './types';

const dir = (projectId: string) => {
  const d = homePath('diagnosis', projectId);
  mkdirSync(d, { recursive: true });
  return d;
};
const fileOf = (projectId: string, id: string) => path.join(dir(projectId), `${id}.json`);

export class DiagnosisStore {
  list(projectId: string): DiagnosisSummary[] {
    const out: DiagnosisSummary[] = [];
    for (const f of readdirSync(dir(projectId))) {
      if (!f.endsWith('.json')) continue;
      const rec = readJsonFile<DiagnosisRecord | null>(path.join(dir(projectId), f), null);
      if (!rec?.id) continue;
      out.push({ id: rec.id, projectId: rec.projectId, filePath: rec.filePath, createdAt: rec.createdAt, category: rec.classification.category, decision: rec.decision });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(projectId: string, id: string): DiagnosisRecord | null {
    return readJsonFile<DiagnosisRecord | null>(fileOf(projectId, id), null);
  }

  create(projectId: string, partial: Omit<DiagnosisRecord, 'id' | 'createdAt' | 'projectId'>): DiagnosisRecord {
    const rec: DiagnosisRecord = { ...partial, id: genId('diag'), projectId, createdAt: new Date().toISOString() };
    writeJsonFile(fileOf(projectId, rec.id), rec);
    return rec;
  }

  save(projectId: string, rec: DiagnosisRecord): DiagnosisRecord {
    writeJsonFile(fileOf(projectId, rec.id), rec);
    return rec;
  }

  patch(projectId: string, id: string, partial: Partial<DiagnosisRecord>): DiagnosisRecord | null {
    const existing = this.get(projectId, id);
    if (!existing) return null;
    const rec: DiagnosisRecord = { ...existing, ...partial, id, projectId, createdAt: existing.createdAt };
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
