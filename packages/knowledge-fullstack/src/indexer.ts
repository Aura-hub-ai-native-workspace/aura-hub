/**
 * FullStackIndexer — real filesystem → project graph.
 * ==================================================================
 * REUSES the frozen Coding Knowledge Engine's scanner, ignore rules and
 * safe reader (no re-implementation), then runs the extractor registry
 * per file and re-links the whole graph. Full and incremental modes,
 * with progress + cancellation. Relations are recomputed on every run,
 * so the graph is always consistent after an incremental update.
 */

import {
  IgnoreRules,
  WorkspaceScanner,
  detectKind,
  detectLanguage,
  readFileSafe,
} from '@aura/knowledge-coding';
import path from 'node:path';
import type { ExtractorRegistry } from './extract/registry';
import type { SourceFile } from './extract/extractor';
import type { RelationLinker } from './link/linker';
import type { ProjectGraphStore } from './graph/graphStore';
import type { AnalyzeStats, GraphDelta } from './types';

export interface AnalyzeOptions {
  ignore?: ConstructorParameters<typeof IgnoreRules>[0];
  onProgress?: (p: { phase: string; processed: number; total?: number; path?: string }) => void;
  signal?: AbortSignal;
}

function abortError(message: string): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export class FullStackIndexer {
  constructor(
    private readonly store: ProjectGraphStore,
    private readonly registry: ExtractorRegistry,
    private readonly linker: RelationLinker,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async buildFile(entry: { absPath: string; relPath: string; size: number; modifiedMs: number }, rules: IgnoreRules) {
    const read = await readFileSafe(entry.absPath, rules.maxFileBytes);
    if (!read.ok) return { error: { relPath: entry.relPath, code: read.error?.code ?? 'EREAD', message: read.error?.message ?? 'read failed' } };
    if (read.binary || !read.text) return { skip: true, checksum: read.checksum };
    const name = path.basename(entry.relPath);
    const ext = path.extname(name);
    const file: SourceFile = {
      relPath: entry.relPath, absPath: entry.absPath, name, ext,
      language: detectLanguage(name, ext), kind: detectKind(name, detectLanguage(name, ext)),
      text: read.text, size: entry.size, checksum: read.checksum, modifiedMs: entry.modifiedMs,
    };
    return { file };
  }

  private relink(): void {
    this.linker && this.store.setRelations(this.linker.link(this.store.allEntities()));
    this.store.rebuildIndexes();
  }

  async analyze(root: string, rules: IgnoreRules, opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
    const start = this.now();
    const scanner = new WorkspaceScanner(rules);
    const scan = await scanner.scan(root, { onProgress: opts.onProgress as never, signal: opts.signal });

    const errors: AnalyzeStats['errors'] = [...scan.errors];
    const byKind: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    let files = 0;
    let bytes = 0;
    let entityCount = 0;
    const seen = new Set<string>();

    let i = 0;
    for (const entry of scan.entries) {
      if (opts.signal?.aborted) throw abortError('Analysis cancelled');
      opts.onProgress?.({ phase: 'analyze', processed: ++i, total: scan.entries.length, path: entry.relPath });
      const built = await this.buildFile(entry, rules);
      seen.add(entry.relPath);
      if ('error' in built && built.error) { errors.push(built.error); continue; }
      if (!('file' in built) || !built.file) continue;
      const file = built.file;
      const entities = this.registry.run(file);
      this.store.setFileEntities(file.relPath, { checksum: file.checksum, modifiedMs: file.modifiedMs, size: file.size }, entities);
      files++;
      bytes += file.size;
      entityCount += entities.length;
      for (const e of entities) { byKind[e.kind] = (byKind[e.kind] ?? 0) + 1; byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1; }
    }

    for (const rel of [...this.store.manifest().keys()]) if (!seen.has(rel)) this.store.removeFile(rel);

    opts.onProgress?.({ phase: 'link', processed: entityCount });
    this.relink();
    opts.onProgress?.({ phase: 'persist', processed: files });
    await this.store.save();
    opts.onProgress?.({ phase: 'done', processed: files });

    return { files, entities: this.store.stats().entities, relations: this.store.stats().relations, bytes, skipped: scan.skipped, errors, durationMs: this.now() - start, byKind, byLayer };
  }

  async update(root: string, rules: IgnoreRules, opts: AnalyzeOptions = {}): Promise<GraphDelta> {
    const start = this.now();
    const before = this.store.stats();
    const scanner = new WorkspaceScanner(rules);
    const scan = await scanner.scan(root, { onProgress: opts.onProgress as never, signal: opts.signal });
    const manifest = this.store.manifest();
    const errors: GraphDelta['errors'] = [...scan.errors];

    let filesAdded = 0;
    let filesModified = 0;
    let filesUnchanged = 0;
    const seen = new Set<string>();

    let i = 0;
    for (const entry of scan.entries) {
      if (opts.signal?.aborted) throw abortError('Update cancelled');
      seen.add(entry.relPath);
      opts.onProgress?.({ phase: 'analyze', processed: ++i, total: scan.entries.length, path: entry.relPath });
      const rec = manifest.get(entry.relPath);
      if (rec && rec.size === entry.size && rec.modifiedMs === entry.modifiedMs) { filesUnchanged++; continue; }

      const built = await this.buildFile(entry, rules);
      if ('error' in built && built.error) { errors.push(built.error); continue; }
      // Binary/skip: refresh manifest metadata if content-identical.
      if ('skip' in built && built.skip) {
        if (rec && rec.checksum === built.checksum) { rec.modifiedMs = entry.modifiedMs; rec.size = entry.size; filesUnchanged++; }
        continue;
      }
      if (!('file' in built) || !built.file) continue;
      const file = built.file;
      if (rec && rec.checksum === file.checksum) { rec.modifiedMs = entry.modifiedMs; rec.size = entry.size; filesUnchanged++; continue; }
      const entities = this.registry.run(file);
      this.store.setFileEntities(file.relPath, { checksum: file.checksum, modifiedMs: file.modifiedMs, size: file.size }, entities);
      if (rec) filesModified++; else filesAdded++;
    }

    let filesDeleted = 0;
    for (const rel of [...manifest.keys()]) if (!seen.has(rel)) { this.store.removeFile(rel); filesDeleted++; }

    opts.onProgress?.({ phase: 'link', processed: 0 });
    this.relink();
    opts.onProgress?.({ phase: 'persist', processed: 0 });
    await this.store.save();
    opts.onProgress?.({ phase: 'done', processed: 0 });

    const after = this.store.stats();
    return {
      filesAdded, filesModified, filesDeleted, filesUnchanged,
      entitiesBefore: before.entities, entitiesAfter: after.entities,
      relationsBefore: before.relations, relationsAfter: after.relations,
      durationMs: this.now() - start, errors,
    };
  }
}
