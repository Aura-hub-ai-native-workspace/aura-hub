/**
 * auditStore — the governed action trail, on disk.
 * ==================================================================
 * Same mechanism as `approvalStore.ts` and `policyStore.ts`: the shared
 * AURA config home, no new database, no second persistence system.
 *
 *   ~/.aura/fabric-audit.jsonl        (AURA_HOME aware)
 *
 * **JSON Lines, appended, never rewritten.** That is the whole design
 * argument. An audit record is a statement about something that already
 * happened; a store that rewrote the file on every write could lose or
 * silently alter earlier records, and an audit trail that can be edited
 * by the thing it audits is not an audit trail. Appending one line per
 * record means a crash mid-write can cost at most the record being
 * written, and never a record already on disk.
 *
 * The file is trimmed only when it exceeds `MAX_RECORDS` by a wide
 * margin, and trimming drops the OLDEST records — bounded growth without
 * ever discarding recent history. `docs/WORKSPACE_2_PHASE1_AUDIT.md`
 * finding S-2 is what this file closes.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditPersistence, AuditRecord } from '@aura/capability-fabric';
import { homePath } from '../persist';

/** How many records are kept. A desktop app's trail, not a data lake. */
const MAX_RECORDS = 5000;
/** Trim only when meaningfully over, so appends stay O(1) in the common case. */
const TRIM_TRIGGER = MAX_RECORDS + 1000;

const FILE = () => homePath('fabric-audit.jsonl');

/** A record is only usable if it can still answer the audit question. */
function usable(value: unknown): value is AuditRecord {
  const r = value as AuditRecord | null;
  return Boolean(
    r && typeof r === 'object'
    && typeof r.invocationId === 'string' && r.invocationId
    && typeof r.capabilityId === 'string' && r.capabilityId
    && typeof r.at === 'string' && r.at,
  );
}

function readAll(file: string): AuditRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // A truncated final line from an interrupted append is skipped, not
      // fatal. Losing the last record is the intended failure mode; losing
      // the file because of it is not.
      if (usable(parsed)) out.push(parsed);
    } catch { /* skip an unparseable line rather than discard the trail */ }
  }
  return out;
}

export function createAuditStore(): AuditPersistence {
  let sinceTrim = 0;

  return {
    load() {
      const all = readAll(FILE());
      return all.length > MAX_RECORDS ? all.slice(-MAX_RECORDS) : all;
    },

    append(record) {
      const file = FILE();
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      sinceTrim += 1;
      // Amortised: only ever counts appends made by this process, so a
      // long-lived session trims once per thousand records rather than
      // re-reading the file on every write.
      if (sinceTrim < 1000) return;
      sinceTrim = 0;
      const all = readAll(file);
      if (all.length <= TRIM_TRIGGER) return;
      const kept = all.slice(-MAX_RECORDS);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
      renameSync(tmp, file);
    },
  };
}

export function auditFilePath(): string {
  return FILE();
}
