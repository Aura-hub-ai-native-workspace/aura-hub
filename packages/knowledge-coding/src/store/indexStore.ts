/**
 * KnowledgeStore — the real local index on disk.
 * ==================================================================
 * Persists documents, chunks, the file manifest (for incremental
 * indexing) and the inverted index to a directory (default
 * `<root>/.aura-index`). Writes are atomic (tmp + rename). This is a
 * real store — nothing is mocked.
 *
 * It is defined behind the `KnowledgeStore` interface so a future vector
 * index becomes an ADDITIONAL store/backend the engine composes, without
 * replacing this keyword store or any calling code.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvertedIndex } from './invertedIndex';
import type { CodeChunk, CodeDocument, FileKind, LanguageId } from '../types';

const SCHEMA_VERSION = 1;

export interface FileRecord {
  relPath: string;
  checksum: string;
  modifiedMs: number;
  size: number;
  language: LanguageId;
  kind: FileKind;
  docId: string;
  chunkIds: string[];
}

export interface KnowledgeStore {
  readonly root: string;
  readonly index: InvertedIndex;
  load(): Promise<boolean>;
  save(): Promise<void>;
  upsertDocument(doc: CodeDocument, chunks: CodeChunk[]): void;
  removeDocumentByPath(relPath: string): boolean;
  getDocument(docId: string): CodeDocument | undefined;
  getDocumentByPath(relPath: string): CodeDocument | undefined;
  getChunk(chunkId: string): CodeChunk | undefined;
  documentChunks(docId: string): CodeChunk[];
  neighborChunks(chunkId: string, radius: number): CodeChunk[];
  manifest(): Map<string, FileRecord>;
  allDocuments(): CodeDocument[];
  stats(): { documents: number; chunks: number };
}

export class JsonKnowledgeStore implements KnowledgeStore {
  index = new InvertedIndex();
  private readonly dir: string;
  private documents = new Map<string, CodeDocument>();
  private chunks = new Map<string, CodeChunk>();
  private byPath = new Map<string, string>(); // relPath → docId
  private files = new Map<string, FileRecord>(); // relPath → record
  private docChunks = new Map<string, string[]>(); // docId → ordered chunkIds

  constructor(readonly root: string, indexDir = '.aura-index') {
    this.dir = path.isAbsolute(indexDir) ? indexDir : path.join(path.resolve(root), indexDir);
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  async load(): Promise<boolean> {
    try {
      const meta = JSON.parse(await readFile(this.file('meta.json'), 'utf8'));
      if (meta.version !== SCHEMA_VERSION) return false;
      const [docs, chunks, files, index] = await Promise.all([
        readFile(this.file('documents.json'), 'utf8'),
        readFile(this.file('chunks.json'), 'utf8'),
        readFile(this.file('manifest.json'), 'utf8'),
        readFile(this.file('index.json'), 'utf8'),
      ]);
      for (const d of JSON.parse(docs) as CodeDocument[]) {
        this.documents.set(d.id, d);
        this.byPath.set(d.relPath, d.id);
      }
      for (const c of JSON.parse(chunks) as CodeChunk[]) {
        this.chunks.set(c.id, c);
        const arr = this.docChunks.get(c.documentId) ?? [];
        arr.push(c.id);
        this.docChunks.set(c.documentId, arr);
      }
      for (const [, arr] of this.docChunks) arr.sort((a, b) => ordinalOf(a) - ordinalOf(b));
      for (const f of JSON.parse(files) as FileRecord[]) this.files.set(f.relPath, f);
      this.index = InvertedIndex.fromJSON(JSON.parse(index));
      return true;
    } catch {
      return false;
    }
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
      writeAtomic('documents.json', [...this.documents.values()]),
      writeAtomic('chunks.json', [...this.chunks.values()]),
      writeAtomic('manifest.json', [...this.files.values()]),
      writeAtomic('index.json', this.index.toJSON()),
    ]);
  }

  upsertDocument(doc: CodeDocument, chunks: CodeChunk[]): void {
    this.removeDocumentByPath(doc.relPath);
    this.documents.set(doc.id, doc);
    this.byPath.set(doc.relPath, doc.id);
    const ids: string[] = [];
    for (const c of chunks) {
      this.chunks.set(c.id, c);
      this.index.add(c.id, `${c.text}\n${c.symbols.join(' ')}\n${doc.name}`);
      ids.push(c.id);
    }
    ids.sort((a, b) => ordinalOf(a) - ordinalOf(b));
    this.docChunks.set(doc.id, ids);
    this.files.set(doc.relPath, {
      relPath: doc.relPath, checksum: doc.checksum, modifiedMs: doc.modifiedMs, size: doc.size,
      language: doc.language, kind: doc.kind, docId: doc.id, chunkIds: ids,
    });
  }

  removeDocumentByPath(relPath: string): boolean {
    const docId = this.byPath.get(relPath);
    if (!docId) return false;
    for (const cid of this.docChunks.get(docId) ?? []) {
      this.index.remove(cid);
      this.chunks.delete(cid);
    }
    this.docChunks.delete(docId);
    this.documents.delete(docId);
    this.byPath.delete(relPath);
    this.files.delete(relPath);
    return true;
  }

  getDocument(docId: string): CodeDocument | undefined {
    return this.documents.get(docId);
  }
  getDocumentByPath(relPath: string): CodeDocument | undefined {
    const id = this.byPath.get(relPath);
    return id ? this.documents.get(id) : undefined;
  }
  getChunk(chunkId: string): CodeChunk | undefined {
    return this.chunks.get(chunkId);
  }
  documentChunks(docId: string): CodeChunk[] {
    return (this.docChunks.get(docId) ?? []).map((id) => this.chunks.get(id)).filter(Boolean) as CodeChunk[];
  }
  neighborChunks(chunkId: string, radius: number): CodeChunk[] {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return [];
    const ids = this.docChunks.get(chunk.documentId) ?? [];
    const pos = ids.indexOf(chunkId);
    if (pos < 0) return [];
    const out: CodeChunk[] = [];
    for (let d = 1; d <= radius; d++) {
      const before = this.chunks.get(ids[pos - d]);
      const after = this.chunks.get(ids[pos + d]);
      if (before) out.push(before);
      if (after) out.push(after);
    }
    return out;
  }
  manifest(): Map<string, FileRecord> {
    return this.files;
  }
  allDocuments(): CodeDocument[] {
    return [...this.documents.values()];
  }
  stats(): { documents: number; chunks: number } {
    return { documents: this.documents.size, chunks: this.chunks.size };
  }
}

function ordinalOf(chunkId: string): number {
  const i = chunkId.lastIndexOf('#');
  return i >= 0 ? Number(chunkId.slice(i + 1)) : 0;
}
