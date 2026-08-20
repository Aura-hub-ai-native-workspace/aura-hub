/**
 * events — ONE engineering-event model, on the service side.
 * ==================================================================
 * There were two. `@aura/engineering-memory` stored `BaseMemoryRecord`
 * on disk in the service, and `apps/desktop/src/ops/memoryStore.ts`
 * stored a richer, incompatible `EngineeringMemory` in the browser's
 * `localStorage` — where it could not be read by the mission engine, the
 * agent, or anything else that runs where the work happens, and where it
 * died with the profile.
 *
 * This file is the reconciliation. `EngineeringEvent` is the richer
 * model — it kept the fields that were actually load-bearing for the
 * Learning Engine (`user`, `source`, `layer`, `dedupe`) — and it is
 * **stored as a `BaseMemoryRecord`**, in the store that already exists.
 * There is no second persistence layer and no second directory: the
 * extra fields ride in `tags`, which `BaseMemoryRecord` already has and
 * which `EngineeringSearch` already indexes.
 *
 * Round-tripping is exact for every field, and `fromRecord()` returns
 * null for a record that was not written by this mapping — the mission
 * and diagnosis engines write `BaseMemoryRecord`s directly, and those
 * are surfaced through `derivedEvent()` rather than being mangled into
 * a shape they were never written in.
 */

import type { BaseMemoryRecord, ImportanceLevel, MemoryCategory as RecordCategory } from '@aura/engineering-memory';

export type EventCategory =
  | 'architecture' | 'code' | 'mission' | 'diagnosis'
  | 'documentation' | 'review' | 'decision' | 'learning';

export type EventImportance = 'critical' | 'high' | 'medium' | 'low';

/** The acting principal — events record *who* did the thing. */
export type EventUser = 'human' | 'ai' | 'system';

export type EventSource =
  | 'editor' | 'ai-action' | 'mission' | 'diagnosis' | 'bug-bot'
  | 'conversation' | 'memory-item' | 'provider' | 'system';

export interface EngineeringEvent {
  id: string;
  /** Null = workspace-global (e.g. a provider decision). */
  projectId: string | null;
  at: string;
  category: EventCategory;
  importance: EventImportance;
  title: string;
  summary: string;
  /** Why this happened / the reasoning behind it. */
  reason: string;
  user: EventUser;
  files: string[];
  symbols: string[];
  layer: string | null;
  dependencies: string[];
  missionId: string | null;
  diagnosisId: string | null;
  source: EventSource;
  /** Stable key — the same real event always maps to one key. */
  dedupe: string;
}

export interface EngineeringEventInput {
  projectId: string | null;
  at?: string;
  category: EventCategory;
  importance: EventImportance;
  title: string;
  summary: string;
  reason?: string;
  user?: EventUser;
  files?: string[];
  symbols?: string[];
  layer?: string | null;
  dependencies?: string[];
  missionId?: string | null;
  diagnosisId?: string | null;
  source: EventSource;
  dedupe: string;
}

/**
 * Project id used on disk for workspace-global events.
 *
 * `BaseMemoryRecord.projectId` is a required string and the store keys
 * directories by it, so "no project" needs a name. The leading underscore
 * cannot collide with a real project id, which are slugs.
 */
export const WORKSPACE_SCOPE = '_workspace';

/* ── tag encoding ──────────────────────────────────────────────── */

const TAG = {
  category: 'aura:category:',
  user: 'aura:user:',
  source: 'aura:source:',
  layer: 'aura:layer:',
  dedupe: 'aura:dedupe:',
  dependency: 'aura:dep:',
  title: 'aura:title:',
  global: 'aura:workspace-global',
} as const;

function tagValue(tags: string[], prefix: string): string | null {
  const found = tags.find((t) => t.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/** The `BaseMemoryRecord` category each event category is stored under. */
const RECORD_CATEGORY: Record<EventCategory, RecordCategory> = {
  architecture: 'architecture-decision',
  code: 'code-change',
  mission: 'mission-created',
  diagnosis: 'diagnosis-created',
  documentation: 'documentation-update',
  review: 'review-decision',
  decision: 'architecture-decision',
  learning: 'knowledge-update',
};

/** `BaseMemoryRecord.importance` has an extra `info` level; events do not. */
function toRecordImportance(importance: EventImportance): ImportanceLevel {
  return importance;
}

function fromRecordImportance(level: ImportanceLevel): EventImportance {
  return level === 'info' ? 'low' : level;
}

export function toRecord(input: EngineeringEventInput): Omit<BaseMemoryRecord, 'id' | 'timestamp'> & { timestamp?: string } {
  const files = input.files ?? [];
  const dependencies = input.dependencies ?? [];
  return {
    projectId: input.projectId ?? WORKSPACE_SCOPE,
    category: RECORD_CATEGORY[input.category],
    importance: toRecordImportance(input.importance),
    confidence: 'high',
    relatedFiles: files,
    relatedSymbols: input.symbols ?? [],
    ...(input.missionId ? { relatedMissionId: input.missionId } : {}),
    ...(input.diagnosisId ? { relatedDiagnosisId: input.diagnosisId } : {}),
    tags: [
      `${TAG.category}${input.category}`,
      `${TAG.user}${input.user ?? 'system'}`,
      `${TAG.source}${input.source}`,
      `${TAG.dedupe}${input.dedupe}`,
      `${TAG.title}${input.title}`,
      ...(input.layer ? [`${TAG.layer}${input.layer}`] : []),
      ...dependencies.map((d) => `${TAG.dependency}${d}`),
      ...(input.projectId === null ? [TAG.global] : []),
    ],
    summary: input.summary,
    // `reason` is the "why", and it is the whole point of an engineering
    // memory rather than a log line. Stored as the record's detail.
    detailedRecord: input.reason ?? '',
    references: [],
    ...(input.at ? { timestamp: input.at } : {}),
  };
}

/**
 * Read a record back as an event, or null when it was not one of ours.
 *
 * A record with no `aura:category:` tag was written by the mission or
 * diagnosis engine directly; it is a real memory but not this shape, and
 * `derivedEvent()` is how it is surfaced instead.
 */
export function fromRecord(record: BaseMemoryRecord): EngineeringEvent | null {
  const category = tagValue(record.tags ?? [], TAG.category) as EventCategory | null;
  if (!category) return null;
  const isGlobal = (record.tags ?? []).includes(TAG.global);
  return {
    id: record.id,
    projectId: isGlobal ? null : record.projectId,
    at: record.timestamp,
    category,
    importance: fromRecordImportance(record.importance),
    title: tagValue(record.tags ?? [], TAG.title) ?? record.summary,
    summary: record.summary,
    reason: record.detailedRecord ?? '',
    user: (tagValue(record.tags ?? [], TAG.user) as EventUser | null) ?? 'system',
    files: record.relatedFiles ?? [],
    symbols: record.relatedSymbols ?? [],
    layer: tagValue(record.tags ?? [], TAG.layer),
    dependencies: (record.tags ?? []).filter((t) => t.startsWith(TAG.dependency)).map((t) => t.slice(TAG.dependency.length)),
    missionId: record.relatedMissionId ?? null,
    diagnosisId: record.relatedDiagnosisId ?? null,
    source: (tagValue(record.tags ?? [], TAG.source) as EventSource | null) ?? 'system',
    dedupe: tagValue(record.tags ?? [], TAG.dedupe) ?? record.id,
  };
}

/** The `aura:dedupe:` key of a record, without materialising the event. */
export function dedupeKeyOf(record: BaseMemoryRecord): string | null {
  return tagValue(record.tags ?? [], TAG.dedupe);
}

/**
 * A record written by another engine, projected into the event shape.
 *
 * These are real memories the mission and diagnosis engines already
 * write (`mission-created`, `diagnosis-accepted`, …). Surfacing them is
 * what stops the Learning Engine from seeing half the history — and
 * projecting them explicitly, rather than pretending they round-trip,
 * keeps `fromRecord()` honest about what it can and cannot reverse.
 */
const DERIVED_CATEGORY: Record<RecordCategory, EventCategory> = {
  'mission-created': 'mission',
  'mission-completed': 'mission',
  'mission-failed': 'mission',
  'diagnosis-created': 'diagnosis',
  'diagnosis-accepted': 'diagnosis',
  'diagnosis-rejected': 'diagnosis',
  'patch-accepted': 'code',
  'patch-rejected': 'review',
  'architecture-decision': 'decision',
  'review-decision': 'review',
  'knowledge-update': 'learning',
  'documentation-update': 'documentation',
  'code-change': 'code',
};

export function derivedEvent(record: BaseMemoryRecord): EngineeringEvent {
  return {
    id: record.id,
    projectId: record.projectId === WORKSPACE_SCOPE ? null : record.projectId,
    at: record.timestamp,
    category: DERIVED_CATEGORY[record.category] ?? 'learning',
    importance: fromRecordImportance(record.importance),
    title: record.summary,
    summary: record.summary,
    reason: record.detailedRecord ?? '',
    // Written by an engine, not by a person and not by a model.
    user: 'system',
    files: record.relatedFiles ?? [],
    symbols: record.relatedSymbols ?? [],
    layer: null,
    dependencies: [],
    missionId: record.relatedMissionId ?? null,
    diagnosisId: record.relatedDiagnosisId ?? null,
    source: record.category.startsWith('mission') ? 'mission' : record.category.startsWith('diagnosis') ? 'diagnosis' : 'system',
    dedupe: `record:${record.id}`,
  };
}

/** Read a record as an event either way, preferring the exact reversal. */
export function asEvent(record: BaseMemoryRecord): EngineeringEvent {
  return fromRecord(record) ?? derivedEvent(record);
}

/* ── deterministic importance (real signals, never random) ─────── */

export function importanceOf(
  category: EventCategory,
  opts: { event?: string; critical?: boolean; user?: EventUser } = {},
): EventImportance {
  if (opts.critical) return 'critical';
  switch (category) {
    case 'review': return 'high';
    case 'decision': return 'high';
    case 'diagnosis': return opts.event === 'accepted' || opts.event === 'rejected' ? 'high' : 'medium';
    case 'mission': return opts.event === 'failed' ? 'critical' : opts.event === 'completed' ? 'high' : 'medium';
    case 'code': return opts.user === 'ai' ? 'high' : 'low';
    case 'documentation': return 'medium';
    case 'architecture': return 'high';
    case 'learning': return 'medium';
    default: return 'medium';
  }
}
