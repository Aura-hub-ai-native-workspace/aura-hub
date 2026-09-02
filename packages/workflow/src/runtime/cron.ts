/**
 * Cron — a tiny 5/6-field cron parser and next-fire-time calculator.
 * ==================================================================
 * Pure computation: no I/O, no timers, no subprocess spawning. The
 * TriggerScheduler calls `nextFire(cron, after)` to get the next
 * timestamp, then schedules a timeout for that moment.
 *
 * Supports the same syntax as the Phase 1+2 validator:
 *   - 5 fields: minute hour day-of-month month day-of-week
 *   - 6 fields: second minute hour day-of-month month day-of-week
 *   - `*`  — any value
 *   - `n`  — a single number
 *   - `a-b` — a range
 *   - `a/b` — a step (from a, every b)
 *   - `a-b/c` — a stepped range
 *   - `a,b,c` — a comma list of any of the above
 *
 * Day-of-week: 0 and 7 both mean Sunday (matching standard cron).
 */

export interface CronField {
  /** 0=second(optional), 1=minute, 2=hour, 3=dom, 4=month, 5=dow */
  index: number;
  min: number;
  max: number;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],  // second (optional 6th field)
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 7],   // day of week (0=Sun, 7=Sun)
];

/** Parse a single field (`*`, `n`, `a-b`, `a/b`, `a-b/c`, `a,b,c`). */
function parseField(raw: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = /^(.+?)\/(\d+)$/.exec(trimmed);
    const base = stepMatch ? stepMatch[1]! : trimmed;
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    if (!step || step < 1) return new Set();
    if (base === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
    if (rangeMatch) {
      let lo = parseInt(rangeMatch[1]!, 10);
      let hi = parseInt(rangeMatch[2]!, 10);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let i = lo; i <= hi; i += step) values.add(i);
      continue;
    }
    const n = parseInt(base, 10);
    if (Number.isFinite(n)) values.add(n);
    else return new Set();
  }
  for (const v of values) {
    if (v < min || v > max) return new Set();
  }
  // Normalise DOW: 7 → 0 (both mean Sunday).
  if (max === 7 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return values;
}

export interface ParsedCron {
  second: Set<number>;
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  hasSeconds: boolean;
}

/** Parse a cron expression into field sets. Returns null on invalid. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const hasSeconds = fields.length === 6;
  const ranges = FIELD_RANGES;
  const second = hasSeconds ? parseField(fields[0]!, ranges[0][0], ranges[0][1]) : new Set([0]);
  const minute = parseField(fields[hasSeconds ? 1 : 0]!, ranges[1][0], ranges[1][1]);
  const hour = parseField(fields[hasSeconds ? 2 : 1]!, ranges[2][0], ranges[2][1]);
  const dom = parseField(fields[hasSeconds ? 3 : 2]!, ranges[3][0], ranges[3][1]);
  const month = parseField(fields[hasSeconds ? 4 : 3]!, ranges[4][0], ranges[4][1]);
  const dow = parseField(fields[hasSeconds ? 5 : 4]!, ranges[5][0], ranges[5][1]);
  if (!minute.size || !hour.size || !dom.size || !month.size || !dow.size || (hasSeconds && !second.size)) return null;
  return { second, minute, hour, dom, month, dow, hasSeconds };
}

function matches(d: Date, pc: ParsedCron): boolean {
  return (
    pc.second.has(d.getSeconds()) &&
    pc.minute.has(d.getMinutes()) &&
    pc.hour.has(d.getHours()) &&
    pc.dom.has(d.getDate()) &&
    pc.month.has(d.getMonth() + 1) &&
    pc.dow.has(d.getDay())
  );
}

/**
 * Same match, but reading the wall clock from the instant's UTC fields —
 * the tz scan stores wall clock as-if-UTC, so its getUTC* fields are the
 * target timezone's wall clock regardless of the system timezone.
 */
function matchesTz(d: Date, pc: ParsedCron): boolean {
  return (
    pc.second.has(d.getUTCSeconds()) &&
    pc.minute.has(d.getUTCMinutes()) &&
    pc.hour.has(d.getUTCHours()) &&
    pc.dom.has(d.getUTCDate()) &&
    pc.month.has(d.getUTCMonth() + 1) &&
    pc.dow.has(d.getUTCDay())
  );
}

/**
 * The timezone offset (UTC − local, in ms) at one instant.
 * Uses Intl.DateTimeFormat so DST rules come from the ICU database.
 * Throws RangeError for an unknown timezone — callers return null.
 */
function tzOffsetMs(tz: string, instant: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(instant));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const hour = get('hour') === 24 ? 0 : get('hour'); // some ICU builds emit 24:xx for midnight
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - instant;
}

/**
 * The instants at which one wall-clock minute exists in `tz`.
 * - 0 instants: the minute is skipped by a spring-forward (DST gap) —
 *   cron semantics: it simply never fires that day.
 * - 1 instant: normal.
 * - 2 instants: the minute repeats during a fall-back — both fire
 *   (standard cron runs the job at each occurrence).
 * Convergence: interpret the wall minute as if it were UTC, read the
 * offset there, shift once, and re-check; a second differing offset
 * means the minute is skipped. The repeated case is detected by the
 * offset one hour after the converged instant.
 */
function wallInstants(wall: Date, tz: string): Date[] {
  const probe = wall.getTime(); // wall clock stored as-if-UTC
  const o1 = tzOffsetMs(tz, probe);
  const i1 = probe - o1;
  const o2 = tzOffsetMs(tz, i1);
  if (o2 === o1) {
    const second = o2 === tzOffsetMs(tz, i1 + 3_600_000) ? [] : [new Date(i1 + 3_600_000)];
    return [new Date(i1), ...second];
  }
  const i2 = probe - o2;
  if (tzOffsetMs(tz, i2) === o2) return [new Date(i2)];
  return [];
}

/**
 * The wall-clock components of an instant in `tz`, encoded as a Date
 * whose UTC fields are that wall clock (system-tz independent).
 */
function wallClock(instant: number, tz: string): Date {
  const wall = new Date(instant + tzOffsetMs(tz, instant));
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()));
}

/**
 * Compute the next fire time at or after `after` (exclusive), in `tz`.
 * Brute-force with a bounded scan — cron has at most one fire per
 * minute, so a 2-year scan covers any valid expression.
 */
export function nextFire(parsed: ParsedCron, after: Date = new Date(), timeZone?: string): Date | null {
  if (timeZone) {
    let startWall: Date;
    try {
      startWall = wallClock(after.getTime(), timeZone);
    } catch {
      return null; // unknown timezone
    }
    if (parsed.hasSeconds) {
      startWall.setUTCMilliseconds(0);
      startWall.setUTCSeconds(startWall.getUTCSeconds() + 1);
    } else {
      startWall.setUTCMilliseconds(0);
      startWall.setUTCSeconds(0);
      startWall.setUTCMinutes(startWall.getUTCMinutes() + 1);
    }
    const limitInstant = after.getTime() + 2 * 366 * 24 * 3_600_000;
    let wallLimit: Date;
    try {
      wallLimit = wallClock(limitInstant, timeZone);
    } catch {
      return null;
    }
    const cursor = new Date(startWall);
    while (cursor < wallLimit) {
      if (matchesTz(cursor, parsed)) {
        for (const instant of wallInstants(cursor, timeZone)) {
          if (instant.getTime() > after.getTime()) return instant;
        }
      }
      if (parsed.hasSeconds) cursor.setUTCSeconds(cursor.getUTCSeconds() + 1);
      else cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    return null;
  }
  const start = new Date(after);
  if (parsed.hasSeconds) {
    start.setMilliseconds(0);
    start.setSeconds(start.getSeconds() + 1);
  } else {
    start.setMilliseconds(0);
    start.setSeconds(0);
    start.setMinutes(start.getMinutes() + 1);
  }
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 2);
  const cursor = new Date(start);
  while (cursor < limit) {
    if (matches(cursor, parsed)) return cursor;
    if (parsed.hasSeconds) {
      cursor.setSeconds(cursor.getSeconds() + 1);
    } else {
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
  }
  return null;
}

/** Convenience: parse + nextFire in one call. */
export function nextCronFire(expr: string, after?: Date, timeZone?: string): Date | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  return nextFire(parsed, after, timeZone);
}
