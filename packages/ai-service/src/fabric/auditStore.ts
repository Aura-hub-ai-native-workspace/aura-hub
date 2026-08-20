/**
 * auditStore — the governance record, on disk.
 * ==================================================================
 * The Fabric produced a complete audit record for every decision and
 * every execution, and kept it in `private auditLog: AuditRecord[] = []`.
 * Nothing wrote it anywhere. A governed system whose governance record
 * evaporates when the process exits cannot be audited: the question
 * "what did AURA do yesterday, and who said it could?" had no answer
 * that survived a restart.
 *
 *   ~/.aura/fabric-audit.jsonl              (AURA_HOME overrides the home)
 *   ~/.aura/fabric-audit.<seq>.jsonl        rotated segments, oldest first
 *
 * ── Why JSONL, and why one line at a time ────────────────────────────
 * The rest of the config home is whole-file JSON with atomic
 * write-then-rename (`persist.ts`). That is right for a document that is
 * replaced; it is wrong for a log that is appended, because rewriting the
 * whole file on every record turns an append into O(n) and gives a crash
 * a window in which the entire history is the thing being rewritten.
 * One record per line, appended, means a torn write can cost at most the
 * record being written — and {@link verifyAuditChain} reports exactly
 * that rather than hiding it.
 *
 * ── Why fsync ────────────────────────────────────────────────────────
 * The record is only useful if it outlives the event it describes. An
 * append that is still in the page cache when the machine loses power
 * describes an action that may well have happened. Each append is
 * therefore opened, written, fsynced and closed. That costs a syscall
 * round-trip per record, which is affordable precisely because these are
 * governance decisions, not telemetry — AURA writes one per invocation,
 * not one per frame.
 *
 * ── Why a hash chain ─────────────────────────────────────────────────
 * Append-only is a convention, not a property: anything that can write
 * the file can rewrite it. Each line carries the hash of the line before
 * it, so removing a record, reordering two, or editing one in place all
 * break the chain at a detectable point. This is TAMPER-EVIDENT, not
 * tamper-proof, and the difference matters: a process running as the user
 * can rewrite the whole chain from any point forward. What it cannot do
 * is change one line and leave the rest intact.
 *
 * The chain spans rotation. A rotated segment ends with a hash that the
 * next segment's first line names as its predecessor, so the history is
 * one chain stored in several files rather than several chains.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditRecord } from '@aura/capability-fabric';
import { configHome, homePath } from '../persist';

/**
 * Rotate once the active file passes this size.
 *
 * Overridable because the number is an operational choice, not a
 * correctness one: an operator keeping a long history wants it larger, and
 * a verification suite proving that the chain spans rotation needs it
 * small enough to reach without writing eight megabytes. Anything
 * unparsable or non-positive falls back to the default rather than
 * disabling rotation.
 */
const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
function maxSegmentBytes(): number {
  const raw = Number(process.env.AURA_AUDIT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SEGMENT_BYTES;
}

/** How many past records the Fabric's in-memory view is seeded with. */
export const AUDIT_SEED_LIMIT = 500;

const BASENAME = 'fabric-audit';
const ACTIVE = () => homePath(`${BASENAME}.jsonl`);

/** Segment names sort as numbers because the sequence is zero-padded. */
const segmentName = (lastSeq: number) => `${BASENAME}.${String(lastSeq).padStart(12, '0')}.jsonl`;

/**
 * One line of the journal.
 *
 * The record is nested rather than spread so that a field added to
 * `AuditRecord` later can never collide with the envelope, and so the
 * hash covers exactly the record as the Fabric produced it.
 */
export interface AuditEntry {
  /** Monotonic, gapless across the whole history including rotations. */
  seq: number;
  /** `hash` of the previous entry; the genesis entry names GENESIS. */
  prevHash: string;
  /** sha256 over seq, prevHash and the canonical record. */
  hash: string;
  record: AuditRecord;
}

/** What the first entry links to. Naming it makes a truncated head visible. */
const GENESIS = 'genesis';

/**
 * Canonical JSON: object keys sorted, so two structurally identical
 * records hash identically regardless of the order the Fabric happened to
 * build them in. Without this, the chain would break on a refactor that
 * only moved a property.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function hashOf(seq: number, prevHash: string, record: AuditRecord): string {
  return crypto.createHash('sha256')
    .update(`${seq}\n${prevHash}\n${canonical(record)}`)
    .digest('hex');
}

/* ── reading ─────────────────────────────────────────────────────── */

/** Rotated segments, oldest first, followed by the active file. */
function segmentFiles(): string[] {
  const home = configHome();
  let names: string[] = [];
  try {
    names = fs.readdirSync(home)
      .filter((n) => n.startsWith(`${BASENAME}.`) && n.endsWith('.jsonl') && n !== `${BASENAME}.jsonl`)
      .sort();
  } catch { /* no home yet — no history */ }
  const files = names.map((n) => path.join(home, n));
  if (fs.existsSync(ACTIVE())) files.push(ACTIVE());
  return files;
}

/**
 * Parse one file's entries.
 *
 * A line that will not parse is DROPPED and counted, never silently
 * skipped: a torn final write is expected after a crash, and the chain
 * check reports it as a break rather than pretending the file is whole.
 */
function readEntries(file: string): { entries: AuditEntry[]; unparsable: number } {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { entries: [], unparsable: 0 }; }
  const entries: AuditEntry[] = [];
  let unparsable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditEntry;
      if (typeof parsed?.seq === 'number' && typeof parsed?.hash === 'string' && parsed.record) {
        entries.push(parsed);
      } else {
        unparsable += 1;
      }
    } catch {
      unparsable += 1;
    }
  }
  return { entries, unparsable };
}

/** Every entry ever written, oldest first. */
export function readAuditEntries(): AuditEntry[] {
  return segmentFiles().flatMap((f) => readEntries(f).entries);
}

/**
 * The most recent `limit` records, oldest first — the shape the Fabric's
 * in-memory log has, so a restart can be seeded without reordering.
 */
export function readAuditRecords(limit = AUDIT_SEED_LIMIT): AuditRecord[] {
  const entries = readAuditEntries();
  return entries.slice(Math.max(0, entries.length - limit)).map((e) => e.record);
}

export function auditFilePath(): string {
  return ACTIVE();
}

/* ── appending ───────────────────────────────────────────────────── */

/**
 * Tail state, cached so a busy service does not re-read the journal on
 * every append. It is recovered from disk on first use and then only ever
 * advanced by this module, which is the single writer.
 */
let tail: { seq: number; hash: string } | null = null;

function loadTail(): { seq: number; hash: string } {
  if (tail) return tail;
  const entries = readAuditEntries();
  const last = entries[entries.length - 1];
  tail = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
  return tail;
}

/**
 * Rotate when the active file has grown past the cap.
 *
 * Named for the last sequence it contains, so the segment ordering is the
 * chain ordering and no separate index is needed. Rotation happens AFTER
 * the append, never before: a record is never held back waiting for a
 * rename, and a crash during the rename leaves the record already durable
 * in one file or the other.
 */
function rotateIfNeeded(lastSeq: number): void {
  const active = ACTIVE();
  let size = 0;
  try { size = fs.statSync(active).size; } catch { return; }
  if (size < maxSegmentBytes()) return;
  const target = path.join(configHome(), segmentName(lastSeq));
  try { fs.renameSync(active, target); } catch { /* keep appending rather than lose records */ }
}

/**
 * Append one record and return the entry that was written.
 *
 * Failure to write is reported by returning null rather than throwing:
 * this is called from inside the Fabric's settle path, and an
 * unwritable disk must not turn a completed action into an exception
 * that unwinds past the code recording it. The caller decides.
 */
export function appendAudit(record: AuditRecord): AuditEntry | null {
  const prev = loadTail();
  const seq = prev.seq + 1;
  const entry: AuditEntry = { seq, prevHash: prev.hash, hash: hashOf(seq, prev.hash, record), record };

  let fd: number | null = null;
  try {
    configHome();                              // ensure the directory exists
    fd = fs.openSync(ACTIVE(), 'a');
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);                          // durable before we call it recorded
  } catch {
    return null;                               // tail is not advanced — the chain stays consistent
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }

  tail = { seq, hash: entry.hash };
  rotateIfNeeded(seq);
  return entry;
}

/* ── verification ────────────────────────────────────────────────── */

export interface AuditChainReport {
  ok: boolean;
  /** How many entries were checked. */
  entries: number;
  /** Files the history spans, oldest first. */
  segments: string[];
  /**
   * The first break found, or null. `seq` is the entry the break was
   * detected AT — for a deletion that is the entry after the missing one.
   */
  brokenAt: { seq: number; reason: string } | null;
  /** Lines that would not parse — a torn write, or an edit. */
  unparsable: number;
}

/**
 * Walk the whole history and check that it is the chain it claims to be.
 *
 * Three things are checked, and they fail differently on purpose:
 *   - the sequence is gapless          → a deleted record
 *   - each `prevHash` names its parent → a reordered or spliced record
 *   - each `hash` recomputes           → an edited record
 */
export function verifyAuditChain(): AuditChainReport {
  const segments = segmentFiles();
  const report: AuditChainReport = { ok: true, entries: 0, segments, brokenAt: null, unparsable: 0 };

  let expectedSeq = 1;
  let expectedPrev = GENESIS;

  for (const file of segments) {
    const { entries, unparsable } = readEntries(file);
    report.unparsable += unparsable;
    for (const entry of entries) {
      report.entries += 1;
      const fail = (reason: string) => {
        if (report.ok) { report.ok = false; report.brokenAt = { seq: entry.seq, reason }; }
      };
      if (entry.seq !== expectedSeq) fail(`expected seq ${expectedSeq}, found ${entry.seq}`);
      if (entry.prevHash !== expectedPrev) fail('prevHash does not name the preceding entry');
      if (hashOf(entry.seq, entry.prevHash, entry.record) !== entry.hash) fail('record does not match its hash');
      expectedSeq = entry.seq + 1;
      expectedPrev = entry.hash;
    }
  }

  if (report.unparsable > 0 && report.ok) {
    report.ok = false;
    report.brokenAt = { seq: expectedSeq - 1, reason: `${report.unparsable} unreadable line(s)` };
  }
  return report;
}

/**
 * Forget the cached tail. Tests that point AURA_HOME somewhere new need
 * this; nothing in the running service does, because the home does not
 * change under a live process.
 */
export function resetAuditStoreCache(): void {
  tail = null;
}
