/**
 * Project memory — the first real, persistent memory system.
 * ==================================================================
 * Every project has its own memory store on disk (`<home>/memory/<id>.json`)
 * that survives restarts. Memory holds real events the user or the AI
 * produced: important conversations, decisions, generated/accepted/
 * rejected answers, corrections, pinned knowledge and learning history.
 *
 * Recalled memory is folded into answers by the intelligence pipeline's
 * context assembler (see intelligence/contextAssembler.ts).
 */

import { homePath, readJsonFile, writeJsonFile } from './persist';

export type MemoryKind =
  | 'conversation'
  | 'decision'
  | 'code'
  | 'accepted'
  | 'rejected'
  | 'correction'
  | 'pinned'
  | 'learning';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  pinned: boolean;
  at: string;
}

const FILE = (projectId: string) => homePath('memory', `${projectId}.json`);
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'how', 'what', 'where', 'does', 'do', 'this', 'that', 'with', 'it', 'be']);

function keywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export class ProjectMemory {
  private items: MemoryItem[];

  constructor(private readonly projectId: string) {
    this.items = readJsonFile<MemoryItem[]>(FILE(projectId), []);
  }

  private save(): void {
    writeJsonFile(FILE(this.projectId), this.items);
  }

  list(): MemoryItem[] {
    // Pinned first, then most recent.
    return [...this.items].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.at.localeCompare(a.at);
    });
  }

  stats(): { total: number; pinned: number; decisions: number; corrections: number } {
    return {
      total: this.items.length,
      pinned: this.items.filter((i) => i.pinned).length,
      decisions: this.items.filter((i) => i.kind === 'decision').length,
      corrections: this.items.filter((i) => i.kind === 'correction').length,
    };
  }

  add(input: { kind: MemoryKind; title: string; body: string; pinned?: boolean }): MemoryItem {
    const item: MemoryItem = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind: input.kind,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 4000),
      pinned: input.pinned ?? input.kind === 'pinned',
      at: new Date().toISOString(),
    };
    this.items.push(item);
    this.save();
    return item;
  }

  setPinned(id: string, pinned: boolean): MemoryItem | undefined {
    const item = this.items.find((i) => i.id === id);
    if (!item) return undefined;
    item.pinned = pinned;
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Recall the memory items most relevant to a query. Pinned items are
   * always eligible; others must share a keyword with the query. Ranking
   * is keyword overlap + a pin bonus. No fabrication — returns [] when the
   * store is empty.
   */
  recall(query: string, limit = 4): MemoryItem[] {
    if (!this.items.length) return [];
    const q = keywords(query);
    const scored = this.items.map((item) => {
      const kw = keywords(`${item.title} ${item.body}`);
      let overlap = 0;
      for (const w of q) if (kw.has(w)) overlap++;
      const score = overlap + (item.pinned ? 0.5 : 0);
      return { item, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.item);
  }
}
