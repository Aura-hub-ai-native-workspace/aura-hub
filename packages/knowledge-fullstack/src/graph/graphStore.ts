/**
 * ProjectGraphStore — the persistent system graph.
 * ==================================================================
 * Holds typed entities, the relationships derived from them, and the
 * adjacency needed to traverse cross-layer chains. Entities are the
 * source of truth (extracted per file, incrementally); relations are a
 * pure function of entities and are recomputed on every index/update,
 * so the graph is always consistent.
 *
 * Persistence mirrors the frozen Coding engine's store (atomic JSON,
 * `.aura-fullstack/`). Entity keyword search reuses the frozen engine's
 * InvertedIndex — no new search stack, no vectors.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvertedIndex, tokenize } from '@aura/knowledge-coding';
import type { Entity, GraphStats, Relation } from '../types';

const SCHEMA_VERSION = 1;

export interface FileRecord {
  relPath: string;
  checksum: string;
  modifiedMs: number;
  size: number;
  entityIds: string[];
}

export class ProjectGraphStore {
  readonly root: string;
  private readonly dir: string;
  private entities = new Map<string, Entity>();
  private relations = new Map<string, Relation>();
  private outAdj = new Map<string, Set<string>>(); // entityId → relationIds
  private inAdj = new Map<string, Set<string>>();
  private files = new Map<string, FileRecord>();
  private nameIndex = new Map<string, Set<string>>(); // lower name → entityIds
  private keyword = new InvertedIndex();

  constructor(root: string, indexDir = '.aura-fullstack') {
    this.root = path.resolve(root);
    this.dir = path.isAbsolute(indexDir) ? indexDir : path.join(this.root, indexDir);
  }

  /* ── Mutation (entities) ─────────────────────────────────────────── */

  setFileEntities(relPath: string, meta: { checksum: string; modifiedMs: number; size: number }, entities: Entity[]): void {
    this.removeFile(relPath);
    const ids: string[] = [];
    for (const e of entities) {
      this.entities.set(e.id, e);
      ids.push(e.id);
    }
    this.files.set(relPath, { relPath, checksum: meta.checksum, modifiedMs: meta.modifiedMs, size: meta.size, entityIds: ids });
  }

  removeFile(relPath: string): boolean {
    const rec = this.files.get(relPath);
    if (!rec) return false;
    for (const id of rec.entityIds) this.entities.delete(id);
    this.files.delete(relPath);
    return true;
  }

  /* ── Relations (recomputed wholesale by the linker) ──────────────── */

  setRelations(relations: Relation[]): void {
    this.relations.clear();
    this.outAdj.clear();
    this.inAdj.clear();
    for (const r of relations) {
      if (!this.entities.has(r.from) || !this.entities.has(r.to)) continue; // drop dangling
      this.relations.set(r.id, r);
      (this.outAdj.get(r.from) ?? this.outAdj.set(r.from, new Set()).get(r.from)!).add(r.id);
      (this.inAdj.get(r.to) ?? this.inAdj.set(r.to, new Set()).get(r.to)!).add(r.id);
    }
  }

  /** Rebuild the name + keyword indexes from current entities. */
  rebuildIndexes(): void {
    this.nameIndex.clear();
    this.keyword = new InvertedIndex();
    for (const e of this.entities.values()) {
      const lname = e.name.toLowerCase();
      (this.nameIndex.get(lname) ?? this.nameIndex.set(lname, new Set()).get(lname)!).add(e.id);
      this.keyword.add(e.id, this.searchText(e));
    }
  }

  private searchText(e: Entity): string {
    const meta = Object.values(e.metadata)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join(' ');
    const arrays = Object.values(e.metadata)
      .filter((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'))
      .flat()
      .join(' ');
    return `${e.name} ${e.kind} ${e.layer} ${e.summary ?? ''} ${e.relPath} ${meta} ${arrays} ${e.snippet ?? ''}`;
  }

  /* ── Access ──────────────────────────────────────────────────────── */

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }
  allEntities(): Entity[] {
    return [...this.entities.values()];
  }
  allRelations(): Relation[] {
    return [...this.relations.values()];
  }
  entitiesByName(name: string): Entity[] {
    return [...(this.nameIndex.get(name.toLowerCase()) ?? [])].map((id) => this.entities.get(id)!).filter(Boolean);
  }
  keywordSearch(text: string, k: number) {
    return this.keyword.search(tokenize(text), new Set(['exact', 'prefix', 'fuzzy'] as const), 2).slice(0, k);
  }
  outRelations(id: string): Relation[] {
    return [...(this.outAdj.get(id) ?? [])].map((rid) => this.relations.get(rid)!).filter(Boolean);
  }
  inRelations(id: string): Relation[] {
    return [...(this.inAdj.get(id) ?? [])].map((rid) => this.relations.get(rid)!).filter(Boolean);
  }
  manifest(): Map<string, FileRecord> {
    return this.files;
  }

  stats(): GraphStats {
    const byKind: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const byRelation: Record<string, number> = {};
    for (const e of this.entities.values()) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    }
    for (const r of this.relations.values()) byRelation[r.kind] = (byRelation[r.kind] ?? 0) + 1;
    return { entities: this.entities.size, relations: this.relations.size, files: this.files.size, byKind, byLayer, byRelation };
  }

  /* ── Persistence ─────────────────────────────────────────────────── */

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const writeAtomic = async (name: string, data: unknown) => {
      const tmp = this.file(`${name}.tmp`);
      await writeFile(tmp, JSON.stringify(data), 'utf8');
      await rename(tmp, this.file(name));
    };
    await Promise.all([
      writeAtomic('meta.json', { version: SCHEMA_VERSION, root: this.root, updatedMs: Date.now() }),
      writeAtomic('entities.json', [...this.entities.values()]),
      writeAtomic('relations.json', [...this.relations.values()]),
      writeAtomic('files.json', [...this.files.values()]),
    ]);
  }

  async load(): Promise<boolean> {
    try {
      const meta = JSON.parse(await readFile(this.file('meta.json'), 'utf8'));
      if (meta.version !== SCHEMA_VERSION) return false;
      const [ents, rels, files] = await Promise.all([
        readFile(this.file('entities.json'), 'utf8'),
        readFile(this.file('relations.json'), 'utf8'),
        readFile(this.file('files.json'), 'utf8'),
      ]);
      for (const e of JSON.parse(ents) as Entity[]) this.entities.set(e.id, e);
      for (const f of JSON.parse(files) as FileRecord[]) this.files.set(f.relPath, f);
      this.rebuildIndexes();
      this.setRelations(JSON.parse(rels) as Relation[]);
      return true;
    } catch {
      return false;
    }
  }
}
