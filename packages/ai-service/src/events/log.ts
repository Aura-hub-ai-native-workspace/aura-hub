/**
 * DurableEventLog — an append-only, segmented, replayable JSONL log.
 * ==================================================================
 * The spine's storage. Deliberately the dumbest thing that is actually
 * durable: one line of JSON per event, appended to an open file
 * descriptor, `fsync`'d before `append()` returns.
 *
 * Why segments rather than one growing file
 * -----------------------------------------
 * A single file must either grow forever or be rewritten to trim it, and
 * rewriting an append-only log in place is how append-only logs stop
 * being append-only. Segments make retention a `unlink()` of the oldest
 * whole file: nothing already written is ever modified, and the exact
 * boundary of what survives is knowable (`earliest()`).
 *
 * File layout under `<AURA_HOME>/events/`:
 *
 *   seg-00000000000001.jsonl   ← records 1..N
 *   seg-00000000000512.jsonl   ← records 512..M   (active)
 *
 * The number in the name is the first `seq` the segment contains, so the
 * set of files alone tells you the whole index without reading them.
 *
 * Crash behaviour: a torn final line (power loss mid-write) is skipped on
 * read and truncated on the next open, because a half-written record is
 * not a record. Everything before it is intact by construction.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homePath } from '../persist';
import type { AuraEvent, EventInput, ReplayResult, TopicFilter } from './types';
import { matchesFilter } from './types';

const SEGMENT_PREFIX = 'seg-';
const SEGMENT_SUFFIX = '.jsonl';
/** Pad width for the start-seq in a filename, so lexical order = numeric order. */
const SEQ_WIDTH = 14;

export interface EventLogOptions {
  /** Directory holding the segments. Defaults to `<AURA_HOME>/events`. */
  dir?: string;
  /** Roll to a new segment once the active one passes this many bytes. */
  maxSegmentBytes?: number;
  /** Keep at most this many segments. The oldest are unlinked first. */
  maxSegments?: number;
  /**
   * `fsync` after every append.
   *
   * True (the default) is what makes "durable" a claim rather than a
   * hope: without it an event is in the page cache, and a power loss
   * takes the approval request with it. Tests that write thousands of
   * synthetic events turn it off deliberately and say so.
   */
  fsync?: boolean;
}

function segmentName(startSeq: number): string {
  return `${SEGMENT_PREFIX}${String(startSeq).padStart(SEQ_WIDTH, '0')}${SEGMENT_SUFFIX}`;
}

function startSeqOf(file: string): number | null {
  if (!file.startsWith(SEGMENT_PREFIX) || !file.endsWith(SEGMENT_SUFFIX)) return null;
  const digits = file.slice(SEGMENT_PREFIX.length, file.length - SEGMENT_SUFFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Parse one JSONL line into an event, or null when it is not one.
 *
 * Returning null rather than throwing is the point: a torn tail must not
 * make the whole log unreadable, and a log that refuses to open is worse
 * than a log missing its last record.
 */
function parseLine(line: string): AuraEvent | null {
  if (!line) return null;
  try {
    const value = JSON.parse(line) as Partial<AuraEvent>;
    if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1) return null;
    if (typeof value.type !== 'string' || typeof value.topic !== 'string') return null;
    if (typeof value.at !== 'string' || typeof value.id !== 'string') return null;
    return value as AuraEvent;
  } catch {
    return null;
  }
}

export class DurableEventLog {
  private readonly dir: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private readonly doFsync: boolean;

  /** Ascending start-seq of every segment currently on disk. */
  private segments: number[] = [];
  private activeFd: number | null = null;
  private activeStart = 1;
  private activeBytes = 0;
  private lastSeq = 0;

  constructor(options: EventLogOptions = {}) {
    this.dir = options.dir ?? homePath('events');
    this.maxSegmentBytes = options.maxSegmentBytes ?? 4 * 1024 * 1024;
    this.maxSegments = Math.max(1, options.maxSegments ?? 8);
    this.doFsync = options.fsync !== false;
    fs.mkdirSync(this.dir, { recursive: true });
    this.recover();
  }

  /* ── recovery ─────────────────────────────────────────────────── */

  private recover(): void {
    const files = fs.readdirSync(this.dir)
      .map((f) => ({ f, start: startSeqOf(f) }))
      .filter((e): e is { f: string; start: number } => e.start !== null)
      .sort((a, b) => a.start - b.start);

    this.segments = files.map((e) => e.start);

    if (!this.segments.length) {
      this.activeStart = 1;
      this.lastSeq = 0;
      this.activeBytes = 0;
      return;
    }

    const last = this.segments[this.segments.length - 1];
    const file = path.join(this.dir, segmentName(last));
    const raw = fs.readFileSync(file, 'utf8');
    // Everything up to (and including) the last newline is a whole record.
    // A trailing fragment is a torn write; drop it and shorten the file so
    // the next append does not produce one valid line glued to a stub.
    const lastNewline = raw.lastIndexOf('\n');
    const whole = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
    if (whole.length !== raw.length) fs.truncateSync(file, Buffer.byteLength(whole));

    let highest = last - 1;
    for (const line of whole.split('\n')) {
      const evt = parseLine(line);
      if (evt) highest = Math.max(highest, evt.seq);
    }
    this.activeStart = last;
    this.activeBytes = Buffer.byteLength(whole);
    this.lastSeq = highest;
  }

  private openActive(): number {
    if (this.activeFd !== null) return this.activeFd;
    const file = path.join(this.dir, segmentName(this.activeStart));
    this.activeFd = fs.openSync(file, 'a');
    if (!this.segments.includes(this.activeStart)) this.segments.push(this.activeStart);
    this.segments.sort((a, b) => a - b);
    return this.activeFd;
  }

  private roll(nextStart: number): void {
    if (this.activeFd !== null) { fs.closeSync(this.activeFd); this.activeFd = null; }
    this.activeStart = nextStart;
    this.activeBytes = 0;
    this.openActive();
    this.prune();
  }

  /** Retention: unlink whole segments from the front, never edit one. */
  private prune(): void {
    while (this.segments.length > this.maxSegments) {
      const oldest = this.segments.shift();
      if (oldest === undefined) return;
      // Never unlink the segment currently open for append.
      if (oldest === this.activeStart) { this.segments.unshift(oldest); return; }
      try { fs.unlinkSync(path.join(this.dir, segmentName(oldest))); } catch { /* already gone */ }
    }
  }

  /* ── writing ──────────────────────────────────────────────────── */

  append<P>(input: EventInput<P>): AuraEvent<P> {
    const seq = this.lastSeq + 1;
    const event: AuraEvent<P> = {
      seq,
      id: crypto.randomUUID(),
      at: input.at ?? new Date().toISOString(),
      topic: input.topic,
      type: input.type,
      projectId: input.projectId ?? null,
      payload: input.payload,
    };
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);

    if (this.activeBytes > 0 && this.activeBytes + bytes > this.maxSegmentBytes) this.roll(seq);

    const fd = this.openActive();
    fs.writeSync(fd, line);
    if (this.doFsync) {
      try { fs.fsyncSync(fd); } catch { /* some filesystems refuse fsync on append-only handles */ }
    }
    this.activeBytes += bytes;
    this.lastSeq = seq;
    return event;
  }

  /* ── reading ──────────────────────────────────────────────────── */

  /** Highest seq ever written. 0 on an empty log. */
  head(): number { return this.lastSeq; }

  /** Lowest seq still retained. `head() + 1` when the log is empty. */
  earliest(): number {
    if (!this.segments.length) return this.lastSeq + 1;
    const first = this.segments[0];
    const file = path.join(this.dir, segmentName(first));
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        const evt = parseLine(line);
        if (evt) return evt.seq;
      }
    } catch { /* segment vanished under us */ }
    return first;
  }

  /**
   * Every retained record with `seq > after`, in order.
   *
   * `after` is exclusive so a reader can pass back the last id it saw —
   * which is exactly what an SSE `Last-Event-ID` is — with no off-by-one
   * at the call site.
   */
  replay(after: number, filter: TopicFilter = '*', limit = 5000): ReplayResult {
    const earliest = this.earliest();
    const head = this.lastSeq;
    const events: AuraEvent[] = [];
    // A reader asking from before the log starts has lost records. Asking
    // from 0 on a pruned log is the ordinary "I am new" case and is also
    // truncated — saying so is the difference between a gap and a lie.
    const truncated = head > 0 && after + 1 < earliest;

    for (const start of this.segments) {
      // Segments are ordered and disjoint; one whose successor starts at or
      // below `after + 1` cannot contain anything wanted.
      const next = this.segments[this.segments.indexOf(start) + 1];
      if (next !== undefined && next <= after + 1) continue;
      let raw: string;
      try { raw = fs.readFileSync(path.join(this.dir, segmentName(start)), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const evt = parseLine(line);
        if (!evt || evt.seq <= after) continue;
        if (!matchesFilter(filter, evt.topic)) continue;
        events.push(evt);
        if (events.length >= limit) return { events, truncated, earliest, head };
      }
    }
    return { events, truncated, earliest, head };
  }

  close(): void {
    if (this.activeFd !== null) { fs.closeSync(this.activeFd); this.activeFd = null; }
  }
}
