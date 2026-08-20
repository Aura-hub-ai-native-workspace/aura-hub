/**
 * Unified memory - four tiers behind one API.
 * ==================================================================
 * Five stores existed, mutually unaware, of which exactly two ever
 * reached a model:
 *
 *   ProjectMemory              ~/.aura/memory/<id>.json        reached
 *   ProjectConversations       ~/.aura/conversations/<id>.json reached, slice(-8)
 *   @aura/engineering-memory   ~/.aura/engineering-memory/**   WRITE-ONLY
 *   desktop ops/memoryStore    browser localStorage            never
 *   retrieval MemoryHierarchy  in-memory                       zero importers
 *
 * The third one is the interesting failure. `@aura/engineering-memory`
 * already has the right schema for semantic memory - `importance`,
 * `confidence`, `relatedFiles`, `relatedSymbols`, categories - and AURA
 * has been faithfully writing to it since it was built. Nothing ever
 * read it back into a prompt. Wiring it is the highest value-per-line
 * change available in this area, and it is done here.
 *
 * -- The four tiers ---------------------------------------------------
 *
 *   working     this turn. Volatile, never persisted, cleared when the
 *               turn ends. Holds what the current exchange established
 *               and nothing else.
 *
 *   episodic    what happened. `ProjectMemory` - conversations,
 *               decisions, corrections, pins. Kept as-is: it is the
 *               right store for events, and it already reaches a prompt.
 *
 *   semantic    what is true. `@aura/engineering-memory`. Promoted from
 *               write-only to a first-class recall source.
 *
 *   procedural  how to do things HERE. Derived from the Fabric's audit
 *               journal, NOT authored: which capabilities actually
 *               succeed on this project, which node performed them, and
 *               which ones policy consistently sends to a human. Nobody
 *               writes procedural memory; it is what the record shows.
 *
 * -- What this module is not ------------------------------------------
 * It is not a sixth store. It owns no files and no state beyond the
 * working tier's per-turn map. Each tier remains the authority for its
 * own records; this is the one API that can ask all four at once and
 * hand the answer to the composer as `ContextItem`s with their
 * provenance intact.
 */

import type { AuditRecord } from '@aura/capability-fabric';
import { engineeringMemory, type BaseMemoryRecord } from '@aura/engineering-memory';
import { ProjectMemory, type MemoryItem } from './memory';
import type { ContextItem } from './context/item';
import { fromMemory, fromAuraFact } from './context/item';

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

/**
 * One recalled record, normalised across the tiers.
 *
 * `confidence` is null when the tier does not model it. That is a real
 * distinction: the episodic store records that something happened, not
 * how sure AURA is that it is still true.
 */
export interface UnifiedMemoryRecord {
  tier: MemoryTier;
  id: string;
  at: string;
  title: string;
  body: string;
  /** 0..1 where the tier models it. Null where it does not. */
  confidence: number | null;
  /** Recall score within this tier. Higher is better. */
  score: number;
  /** Why this record was recalled. Never empty. */
  reason: string;
  relatedFiles: string[];
  /** Which concrete store answered. */
  store: string;
}

/** Importance and confidence in `@aura/engineering-memory` are ordinal words. */
const CONFIDENCE_VALUE: Record<string, number> = {
  unknown: 0.2, low: 0.35, medium: 0.5, high: 0.75, certain: 1,
};
const IMPORTANCE_VALUE: Record<string, number> = {
  info: 0.15, low: 0.3, medium: 0.5, high: 0.8, critical: 1,
};

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'how', 'what', 'where', 'does', 'do', 'this', 'that', 'with', 'it', 'be']);
const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

function overlap(query: Set<string>, text: string): { hits: string[]; count: number } {
  const kw = words(text);
  const hits: string[] = [];
  for (const w of query) if (kw.has(w)) hits.push(w);
  return { hits, count: hits.length };
}

/* -- Procedural derivation -------------------------------------------- */

/**
 * A procedural fact, derived from what the journal shows actually
 * happened. Never authored: if the record does not support it, it is not
 * a procedural fact, and AURA says nothing rather than guessing at how
 * this machine behaves.
 */
export interface ProceduralFact {
  capabilityId: string;
  attempts: number;
  succeeded: number;
  /** Nodes observed performing it, most frequent first. */
  nodes: string[];
  /** True when EVERY observed attempt needed a human. */
  alwaysNeedsApproval: boolean;
  /** The policy rule most often cited for this capability. */
  usualRule: string | null;
  lastAt: string;
  /** Median observed duration, in ms. */
  typicalMs: number;
}

/**
 * Fold an audit journal into procedural facts for one project.
 *
 * Deliberately arithmetic only. Two attempts are not a pattern, so
 * `MIN_OBSERVATIONS` gates what is reported at all - a single success is
 * an anecdote, and presenting it as "how things are done here" is how a
 * model learns a superstition.
 */
export const MIN_OBSERVATIONS = 3;

export function deriveProcedural(records: readonly AuditRecord[], projectId: string | null): ProceduralFact[] {
  const byCap = new Map<string, AuditRecord[]>();
  for (const r of records) {
    if (projectId && r.projectId && r.projectId !== projectId) continue;
    const list = byCap.get(r.capabilityId) ?? [];
    list.push(r);
    byCap.set(r.capabilityId, list);
  }

  const out: ProceduralFact[] = [];
  for (const [capabilityId, rs] of byCap) {
    if (rs.length < MIN_OBSERVATIONS) continue;
    /* `awaiting-approval` is parked, not run; `unsupported` never
       reached an executor. Neither has a meaningful duration, so both
       are excluded from the timing sample rather than counted as fast. */
    const executed = rs.filter((r) => r.outcome !== 'awaiting-approval' && r.outcome !== 'unsupported');
    const succeeded = rs.filter((r) => r.outcome === 'succeeded').length;

    const nodeCount = new Map<string, number>();
    for (const r of rs) if (r.nodeId) nodeCount.set(r.nodeId, (nodeCount.get(r.nodeId) ?? 0) + 1);

    const ruleCount = new Map<string, number>();
    for (const r of rs) if (r.decisionRule) ruleCount.set(r.decisionRule, (ruleCount.get(r.decisionRule) ?? 0) + 1);

    const durations = executed.map((r) => r.durationMs).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
    const typicalMs = durations.length ? durations[Math.floor(durations.length / 2)] : 0;

    out.push({
      capabilityId,
      attempts: rs.length,
      succeeded,
      nodes: [...nodeCount.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      alwaysNeedsApproval: rs.every((r) => r.decision === 'require-approval' || r.decision === 'ask-user'),
      usualRule: [...ruleCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      lastAt: rs.map((r) => r.at).sort().at(-1) ?? new Date().toISOString(),
      typicalMs,
    });
  }
  return out.sort((a, b) => b.attempts - a.attempts);
}

function proceduralSentence(f: ProceduralFact): string {
  const bits = [`${f.capabilityId}: ${f.succeeded}/${f.attempts} attempts succeeded here`];
  if (f.nodes.length) bits.push(`usually via ${f.nodes[0]}`);
  if (f.alwaysNeedsApproval) bits.push('always requires a human decision on this machine');
  if (f.usualRule) bits.push(`policy rule "${f.usualRule}"`);
  if (f.typicalMs > 0) bits.push(`typically ${f.typicalMs}ms`);
  return bits.join('; ') + '.';
}

/* -- The one API ------------------------------------------------------ */

export interface UnifiedMemoryDeps {
  /**
   * The Fabric's audit journal. A function rather than an array so the
   * procedural tier reads the CURRENT journal at recall time, and so
   * this module never holds a stale copy of somebody else's authority.
   */
  audit?: () => readonly AuditRecord[];
}

export interface RecallOptions {
  /** Per-tier cap. Ranking happens within a tier, never across them. */
  limitPerTier?: number;
  tiers?: readonly MemoryTier[];
}

const ALL_TIERS: MemoryTier[] = ['working', 'episodic', 'semantic', 'procedural'];

export class UnifiedMemory {
  private readonly episodic: ProjectMemory;
  /** The working tier. Volatile by construction: a field, not a file. */
  private readonly working = new Map<string, { at: string; title: string; body: string }>();

  constructor(
    private readonly projectId: string,
    private readonly deps: UnifiedMemoryDeps = {},
    episodic?: ProjectMemory,
  ) {
    /* The episodic store is injected when the caller already has one
       mounted, so this does not become a second reader of the same file
       with its own copy of the array. */
    this.episodic = episodic ?? new ProjectMemory(projectId);
  }

  /* -- working tier -------------------------------------------------- */

  /** Note something the CURRENT turn established. Not persisted. */
  note(key: string, title: string, body: string): void {
    this.working.set(key, { at: new Date().toISOString(), title, body });
  }

  /** End of turn. The working tier does not survive it. */
  clearWorking(): void {
    this.working.clear();
  }

  /* -- writes ------------------------------------------------------- */

  /**
   * Write to the tier that owns the fact.
   *
   * There is no `remember(tier)` for `procedural`: procedural memory is
   * derived from the journal and cannot be authored. A caller that wants
   * to assert "this is how we do it here" is asserting something the
   * record does not show, and the whole point of sourcing it from the
   * journal is that it cannot.
   */
  remember(
    tier: 'episodic' | 'semantic',
    input: { title: string; body: string; kind?: MemoryItem['kind']; relatedFiles?: string[]; importance?: BaseMemoryRecord['importance']; confidence?: BaseMemoryRecord['confidence']; tags?: string[] },
  ): void {
    if (tier === 'episodic') {
      this.episodic.add({ kind: input.kind ?? 'learning', title: input.title, body: input.body });
      return;
    }
    engineeringMemory.create({
      projectId: this.projectId,
      /* `knowledge-update` is this store's category for "something is
         now known that was not". There is no `insight` category, and
         adding one would change a shared vocabulary from here, which is
         not this module's to change. */
      category: 'knowledge-update',
      importance: input.importance ?? 'medium',
      confidence: input.confidence ?? 'medium',
      relatedFiles: input.relatedFiles ?? [],
      relatedSymbols: [],
      tags: input.tags ?? [],
      summary: input.title,
      detailedRecord: input.body,
      references: [],
    });
  }

  /* -- recall -------------------------------------------------------- */

  /** Ask all four tiers at once. */
  recall(query: string, opts: RecallOptions = {}): UnifiedMemoryRecord[] {
    const limit = opts.limitPerTier ?? 4;
    const tiers = opts.tiers ?? ALL_TIERS;
    const q = words(query);
    const out: UnifiedMemoryRecord[] = [];

    if (tiers.includes('working')) {
      for (const [key, w] of this.working) {
        out.push({
          tier: 'working', id: `working:${key}`, at: w.at, title: w.title, body: w.body,
          confidence: null, score: 1, reason: 'established earlier in this turn',
          relatedFiles: [], store: 'working-set',
        });
      }
    }

    if (tiers.includes('episodic')) {
      for (const item of this.episodic.recall(query, limit)) {
        const { hits } = overlap(q, `${item.title} ${item.body}`);
        out.push({
          tier: 'episodic', id: item.id, at: item.at, title: item.title, body: item.body,
          confidence: null, score: hits.length + (item.pinned ? 0.5 : 0),
          reason: item.pinned
            ? `pinned ${item.kind} in this project's history`
            : `recorded ${item.kind} matching ${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}`,
          relatedFiles: [], store: 'project-memory',
        });
      }
    }

    if (tiers.includes('semantic')) {
      /* The store that was write-only until now. `queryProject` returns
         this project's records; ranking is keyword overlap weighted by
         the store's OWN importance and confidence fields, which is
         exactly why promoting this store is worth doing - it is the only
         tier that already models how much a fact should count. */
      let records: BaseMemoryRecord[] = [];
      try {
        records = engineeringMemory.queryProject(this.projectId);
      } catch {
        records = [];
      }
      const scored = records.map((r) => {
        const text = `${r.summary} ${r.detailedRecord} ${r.tags.join(' ')} ${r.relatedFiles.join(' ')}`;
        const { hits, count } = overlap(q, text);
        const importance = IMPORTANCE_VALUE[String(r.importance)] ?? 0.5;
        const confidence = CONFIDENCE_VALUE[String(r.confidence)] ?? 0.5;
        return { r, hits, score: count * (0.5 + importance) * (0.5 + confidence), importance, confidence };
      }).filter((s) => s.hits.length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      for (const s of scored) {
        out.push({
          tier: 'semantic', id: s.r.id, at: s.r.timestamp, title: s.r.summary, body: s.r.detailedRecord,
          confidence: s.confidence, score: s.score,
          reason: `${s.r.category} recorded with ${s.r.importance} importance and ${s.r.confidence} confidence, matching ${s.hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}`,
          relatedFiles: s.r.relatedFiles, store: 'engineering-memory',
        });
      }
    }

    if (tiers.includes('procedural') && this.deps.audit) {
      const facts = deriveProcedural(this.deps.audit(), this.projectId);
      const scored = facts.map((f) => {
        const { hits, count } = overlap(q, f.capabilityId.replace(/[._]/g, ' '));
        return { f, hits, count };
      }).sort((a, b) => (b.count - a.count) || (b.f.attempts - a.f.attempts))
        .slice(0, limit);

      for (const s of scored) {
        out.push({
          tier: 'procedural', id: `proc:${s.f.capabilityId}`, at: s.f.lastAt,
          title: `How ${s.f.capabilityId} behaves on this machine`,
          body: proceduralSentence(s.f),
          confidence: Math.min(1, s.f.attempts / 10),
          score: s.count + s.f.attempts / 100,
          reason: s.count > 0
            ? `derived from ${s.f.attempts} journal entries matching ${s.hits.map((h) => `"${h}"`).join(', ')}`
            : `derived from ${s.f.attempts} journal entries for a capability used often here`,
          relatedFiles: [], store: 'fabric-audit-journal',
        });
      }
    }

    return out;
  }

  /**
   * Recall, converted at the boundary into context items.
   *
   * This is the only place memory crosses into the prompt, so it is the
   * only place that assigns trust and sensitivity to a memory record.
   *
   *   episodic / semantic  are `untrusted`. AURA stored them, but what
   *                        it stored is quoted from files, tool output
   *                        and conversations it did not author.
   *
   *   working              is `untrusted` for the same reason.
   *
   *   procedural           is `trusted`. It is not text at all - it is
   *                        arithmetic over AURA's own journal, rendered
   *                        into a sentence by this module. There is no
   *                        attacker-controlled string in it.
   */
  contextItems(query: string, opts: RecallOptions = {}): ContextItem[] {
    return this.recall(query, opts).map((r) => {
      if (r.tier === 'procedural') {
        return fromAuraFact({
          kind: 'event',
          value: `${r.title}\n${r.body}`,
          locator: `aura://procedural/${r.id}`,
          driver: r.store,
          observedAt: r.at,
          relevance: { score: r.score, reason: r.reason },
        });
      }
      return fromMemory({
        id: `${r.tier}://${r.id}`,
        body: `[${r.tier}] ${r.title}\n${r.body}`,
        store: r.store,
        observedAt: r.at,
        confidence: r.confidence,
        relevance: { score: r.score, reason: r.reason },
      });
    });
  }

  /** What each tier holds right now. For diagnostics and the UI. */
  stats(): Record<MemoryTier, number> {
    let semantic = 0;
    try {
      semantic = engineeringMemory.queryProject(this.projectId).length;
    } catch {
      semantic = 0;
    }
    return {
      working: this.working.size,
      episodic: this.episodic.stats().total,
      semantic,
      procedural: this.deps.audit ? deriveProcedural(this.deps.audit(), this.projectId).length : 0,
    };
  }
}
