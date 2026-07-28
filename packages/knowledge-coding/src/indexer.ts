/**
 * CodingIndexer — turns real files into a searchable index.
 * ==================================================================
 * Full and incremental indexing over the real filesystem. The document
 * pipeline per file: detect language → read safely → extract metadata →
 * build document → chunk → store (with checksum, mtime, path, language).
 *
 * Incremental indexing diffs the persisted manifest against the current
 * filesystem to detect ADDED / MODIFIED / DELETED files and only touches
 * what changed. Reports progress; supports cancellation.
 */

import path from 'node:path';
import { abortError } from './abort';
import { chunkDocument } from './chunker';
import { detectKind, detectLanguage } from './languages';
import { readFileSafe, type ReadResult } from './reader';
import { WorkspaceScanner } from './scanner';
import type { IgnoreRules } from './ignore';
import type { JsonKnowledgeStore } from './store/indexStore';
import type {
  CodeDocument,
  FileError,
  IndexDelta,
  IndexOptions,
  IndexStats,
  ScanEntry,
} from './types';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError('Indexing cancelled');
}

function buildDocument(entry: ScanEntry, read: ReadResult, projectRoot: string, now: number): CodeDocument {
  const name = path.basename(entry.relPath);
  const ext = path.extname(name);
  const language = read.binary ? 'binary' : detectLanguage(name, ext);
  const kind = read.binary ? 'binary' : detectKind(name, language);
  return {
    id: entry.relPath,
    absPath: entry.absPath,
    relPath: entry.relPath,
    projectRoot,
    name,
    ext,
    language,
    kind,
    size: entry.size,
    checksum: read.checksum,
    modifiedMs: entry.modifiedMs,
    indexedMs: now,
    lines: read.lines,
    truncated: read.truncated,
    binary: read.binary,
    metadata: { bytesRead: read.bytesRead },
  };
}

interface Accum {
  files: number;
  chunks: number;
  bytes: number;
  binaries: number;
  errors: FileError[];
  byLanguage: Record<string, number>;
}

export class CodingIndexer {
  constructor(
    private readonly store: JsonKnowledgeStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Index (or re-index) one file into the store. Returns chunk count or null on error. */
  private async indexFile(
    entry: ScanEntry,
    root: string,
    rules: IgnoreRules,
    acc: Accum,
  ): Promise<{ doc: CodeDocument } | null> {
    const read = await readFileSafe(entry.absPath, rules.maxFileBytes);
    if (!read.ok) {
      acc.errors.push({ relPath: entry.relPath, code: read.error?.code ?? 'EREAD', message: read.error?.message ?? 'read failed' });
      return null;
    }
    const doc = buildDocument(entry, read, root, this.now());
    const chunks = !read.binary && read.text && read.text.trim().length > 0 ? chunkDocument(doc, read.text) : [];
    this.store.upsertDocument(doc, chunks);

    acc.files++;
    acc.chunks += chunks.length;
    acc.bytes += read.bytesRead;
    if (read.binary) acc.binaries++;
    acc.byLanguage[doc.language] = (acc.byLanguage[doc.language] ?? 0) + 1;
    return { doc };
  }

  /** Full index — (re)build the entire index from the filesystem. */
  async fullIndex(root: string, rules: IgnoreRules, opts: IndexOptions = {}): Promise<IndexStats> {
    const start = this.now();
    const scanner = new WorkspaceScanner(rules);
    const scan = await scanner.scan(root, { onProgress: opts.onProgress, signal: opts.signal });

    const acc: Accum = { files: 0, chunks: 0, bytes: 0, binaries: 0, errors: [...scan.errors], byLanguage: {} };
    const seen = new Set<string>();

    let i = 0;
    for (const entry of scan.entries) {
      throwIfAborted(opts.signal);
      opts.onProgress?.({ phase: 'index', processed: ++i, total: scan.entries.length, path: entry.relPath });
      await this.indexFile(entry, root, rules, acc);
      seen.add(entry.relPath);
    }

    // Drop anything previously indexed that no longer exists.
    for (const rel of [...this.store.manifest().keys()]) if (!seen.has(rel)) this.store.removeDocumentByPath(rel);

    opts.onProgress?.({ phase: 'persist', processed: acc.files });
    await this.store.save();
    opts.onProgress?.({ phase: 'done', processed: acc.files });

    return { ...acc, skipped: scan.skipped, durationMs: this.now() - start };
  }

  /** Incremental index — only touch added / modified / deleted files. */
  async incremental(root: string, rules: IgnoreRules, opts: IndexOptions = {}): Promise<IndexDelta> {
    const start = this.now();
    const scanner = new WorkspaceScanner(rules);
    const scan = await scanner.scan(root, { onProgress: opts.onProgress, signal: opts.signal });
    const manifest = this.store.manifest();

    const acc: Accum = { files: 0, chunks: 0, bytes: 0, binaries: 0, errors: [...scan.errors], byLanguage: {} };
    let added = 0;
    let modified = 0;
    let unchanged = 0;
    const seen = new Set<string>();

    let i = 0;
    for (const entry of scan.entries) {
      throwIfAborted(opts.signal);
      seen.add(entry.relPath);
      opts.onProgress?.({ phase: 'index', processed: ++i, total: scan.entries.length, path: entry.relPath });

      const rec = manifest.get(entry.relPath);
      // Fast path: identical size + mtime → assume unchanged, skip read.
      if (rec && rec.size === entry.size && rec.modifiedMs === entry.modifiedMs) {
        unchanged++;
        continue;
      }

      const read = await readFileSafe(entry.absPath, rules.maxFileBytes);
      if (!read.ok) {
        acc.errors.push({ relPath: entry.relPath, code: read.error?.code ?? 'EREAD', message: read.error?.message ?? 'read failed' });
        continue;
      }
      // Content-identical (e.g. touched): refresh mtime in manifest, no re-index.
      if (rec && rec.checksum === read.checksum) {
        rec.modifiedMs = entry.modifiedMs;
        unchanged++;
        continue;
      }

      const doc = buildDocument(entry, read, root, this.now());
      const chunks = !read.binary && read.text && read.text.trim().length > 0 ? chunkDocument(doc, read.text) : [];
      this.store.upsertDocument(doc, chunks);
      acc.files++;
      acc.chunks += chunks.length;
      acc.bytes += read.bytesRead;
      if (read.binary) acc.binaries++;
      acc.byLanguage[doc.language] = (acc.byLanguage[doc.language] ?? 0) + 1;
      if (rec) modified++;
      else added++;
    }

    // Deletions: manifest entries no longer on disk.
    let deleted = 0;
    for (const rel of [...manifest.keys()]) {
      if (!seen.has(rel)) {
        this.store.removeDocumentByPath(rel);
        deleted++;
      }
    }

    opts.onProgress?.({ phase: 'persist', processed: acc.files });
    await this.store.save();
    opts.onProgress?.({ phase: 'done', processed: acc.files });

    return {
      added,
      modified,
      deleted,
      unchanged,
      stats: { ...acc, skipped: scan.skipped, durationMs: this.now() - start },
    };
  }
}
