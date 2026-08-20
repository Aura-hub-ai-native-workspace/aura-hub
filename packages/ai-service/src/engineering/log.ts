/**
 * EngineeringLog — the single engineering-event store.
 * ==================================================================
 * Reads and writes through `@aura/engineering-memory`, which already
 * owns per-project persistence under `<AURA_HOME>/engineering-memory/`.
 * This class adds three things that store does not have and that the
 * browser store did:
 *
 *   • **Dedupe.** The same real event always maps to one key, so a
 *     reconcile pass that re-observes a completed mission records it
 *     once, across restarts included.
 *   • **A workspace scope.** Events with no project (a provider switch)
 *     have somewhere to live.
 *   • **A read cache.** `MemoryStore.list()` is one file read per
 *     record; the Learning Engine reads the whole project on every
 *     analysis. The cache is a cache — writes go through to disk
 *     immediately and the cache is updated from the write, never
 *     instead of it.
 */

import { engineeringMemory, type BaseMemoryRecord } from '@aura/engineering-memory';
import fs from 'node:fs';
import path from 'node:path';
import { homePath } from '../persist';
import {
  WORKSPACE_SCOPE, asEvent, toRecord,
  type EngineeringEvent, type EngineeringEventInput,
} from './events';

function scopeOf(projectId: string | null): string {
  return projectId ?? WORKSPACE_SCOPE;
}

export class EngineeringLog {
  /** scope → events, newest first. Invalidated only by this class's writes. */
  private cache = new Map<string, EngineeringEvent[]>();

  private loadScope(scope: string): EngineeringEvent[] {
    const cached = this.cache.get(scope);
    if (cached) return cached;
    const records: BaseMemoryRecord[] = engineeringMemory.queryProject(scope);
    const events = records
      .map(asEvent)
      .sort((a, b) => b.at.localeCompare(a.at));
    this.cache.set(scope, events);
    return events;
  }

  /**
   * Events for a project, or — with `null` — the whole workspace:
   * every project's events plus the workspace-global ones.
   */
  list(projectId: string | null | undefined, projectIds: string[] = []): EngineeringEvent[] {
    if (projectId) return this.loadScope(projectId);
    const scopes = [WORKSPACE_SCOPE, ...projectIds];
    const seen = new Set<string>();
    const out: EngineeringEvent[] = [];
    for (const scope of scopes) {
      for (const e of this.loadScope(scope)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Record an event unless its dedupe key already fired.
   *
   * Returns null on a duplicate — the caller learns nothing was written,
   * which is what lets a reconcile loop run every 30 seconds without
   * inventing history.
   */
  record(input: EngineeringEventInput): EngineeringEvent | null {
    const scope = scopeOf(input.projectId);
    const existing = this.loadScope(scope);
    if (existing.some((e) => e.dedupe === input.dedupe)) return null;

    const payload = toRecord(input);
    const { timestamp, ...rest } = payload;
    const created = engineeringMemory.create(rest);
    // `MemoryStore.create()` stamps `timestamp` itself. An event that
    // carries its own `at` (a reconciled past event) keeps it, and the
    // record on disk is corrected to match rather than the two diverging.
    const stored: BaseMemoryRecord = timestamp ? { ...created, timestamp } : created;
    if (timestamp) rewriteTimestamp(scope, stored);

    const event = asEvent(stored);
    this.cache.set(scope, [event, ...existing].sort((a, b) => b.at.localeCompare(a.at)));
    return event;
  }

  /** Drop every cached scope. The next read comes from disk. */
  invalidate(): void { this.cache.clear(); }

  /**
   * Delete a scope's events, on disk and in the cache.
   *
   * The log is append-only for the SYSTEM — nothing the service writes
   * ever rewrites a record. This is the person's own delete: they added
   * the events by working, and "clear my engineering memory" has to
   * actually clear it, or the button is a lie. `null` clears the
   * workspace-global scope only; a project id clears that project.
   */
  purge(projectId: string | null): number {
    const scope = scopeOf(projectId);
    const dir = homePath('engineering-memory', scope);
    let removed = 0;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try { fs.unlinkSync(path.join(dir, file)); removed += 1; } catch { /* already gone */ }
      }
    } catch {
      // No directory means nothing was ever recorded for this scope.
    }
    this.cache.delete(scope);
    return removed;
  }

  /** Number of events in a scope, without materialising them for a caller. */
  count(projectId: string | null): number {
    return this.loadScope(scopeOf(projectId)).length;
  }

  /**
   * Find the one event carrying a dedupe key, across a set of scopes.
   * Used by the agent to answer "did I already record this outcome?".
   */
  findByDedupe(dedupe: string, projectId: string | null, projectIds: string[] = []): EngineeringEvent | null {
    return this.list(projectId, projectIds).find((e) => e.dedupe === dedupe) ?? null;
  }
}

/**
 * Correct a just-created record's timestamp on disk.
 *
 * `MemoryStore` has no update method, so the file is rewritten through
 * the same atomic write it was created with. Done only for an event that
 * explicitly supplied `at` — everything else keeps the store's own stamp
 * and this never runs.
 */
function rewriteTimestamp(scope: string, record: BaseMemoryRecord): void {
  try {
    // `@aura/engineering-memory` writes under the same AURA_HOME this
    // service uses (its persist util is a copy of `persist.ts`), so the
    // path is derivable here without the store growing an update method
    // that only one caller would ever use.
    const file = path.join(homePath('engineering-memory', scope), `${record.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // The record exists with the store's timestamp. That is a slightly
    // wrong time on one record, not a lost event.
  }
}

/** The process-wide log. One store, one cache, one dedupe namespace. */
export const engineeringLog = new EngineeringLog();
