/**
 * schedule — cron for a desktop app, with an honest catch-up policy.
 * ==================================================================
 * A five-field cron expression (`minute hour day-of-month month
 * day-of-week`) and one function that answers "when does this next fire
 * after this instant". No dependency: the grammar below is small, fully
 * specified, and a scheduler is exactly the kind of thing that should not
 * be a supply-chain surface.
 *
 * ── What is deliberately NOT here ──────────────────────────────────
 * Seconds, `@reboot`, `L`/`W`/`#` day modifiers and timezone databases.
 * Each is a real cron feature and each is a real source of subtle
 * wrongness. An expression using one is REJECTED with a reason rather
 * than silently reinterpreted — a schedule that runs at a time the user
 * did not ask for is worse than a schedule that refuses to be created.
 *
 * Times are local. A desktop automation that says "every morning at 9"
 * means the user's 9am, and pretending otherwise to gain UTC purity would
 * make every schedule wrong twice a year in the other direction.
 */

export interface CronField {
  /** Values this field matches, sorted. */
  values: number[];
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  /** True when both day fields are restricted — cron ORs them in that case. */
  bothDaysRestricted: boolean;
}

export type CronParse = { ok: true; cron: ParsedCron } | { ok: false; error: string };

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function named(token: string, kind: string): string {
  const lower = token.toLowerCase();
  if (kind === 'month') {
    const i = MONTH_NAMES.indexOf(lower);
    if (i >= 0) return String(i + 1);
  }
  if (kind === 'dayOfWeek') {
    const i = DAY_TOKENS.indexOf(lower);
    if (i >= 0) return String(i);
  }
  return token;
}

/** One field: a star, `a`, `a-b`, a star-slash-step, `a-b/n`, or a comma list of those. */
function parseField(raw: string, kind: keyof typeof RANGES): CronField | string {
  const [min, max] = RANGES[kind];
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) return `"${raw}" has an empty entry`;

    const [rangePart, stepPart] = token.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return `"${token}" has an invalid step`;
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((x) => Number(named(x.trim(), kind)));
      if (!Number.isInteger(a) || !Number.isInteger(b)) return `"${token}" is not a valid range`;
      lo = a; hi = b;
    } else {
      const v = Number(named(rangePart.trim(), kind));
      if (!Number.isInteger(v)) return `"${token}" is not a number`;
      lo = v; hi = v;
    }

    if (lo < min || hi > max || lo > hi) return `"${token}" is outside ${min}-${max} for ${kind}`;
    for (let v = lo; v <= hi; v += step) values.add(kind === 'dayOfWeek' && v === 7 ? 0 : v);
  }

  return { values: [...values].sort((a, b) => a - b) };
}

export function parseCron(expression: string): CronParse {
  const raw = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  if (/@reboot/i.test(raw)) {
    return { ok: false, error: '@reboot is not supported — a desktop app starting is not a schedule.' };
  }
  if (/[LW#]/.test(raw)) {
    return { ok: false, error: 'L, W and # day modifiers are not supported. Use explicit day numbers.' };
  }
  const fields = raw.split(/\s+/);
  if (fields.length === 6) {
    return { ok: false, error: 'Six fields look like a seconds-precision cron. AURA schedules to the minute — drop the seconds field.' };
  }
  if (fields.length !== 5) {
    return { ok: false, error: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.` };
  }

  const kinds: (keyof typeof RANGES)[] = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];
  const parsed: Partial<ParsedCron> = {};
  for (let i = 0; i < 5; i++) {
    const field = parseField(fields[i], kinds[i]);
    if (typeof field === 'string') return { ok: false, error: field };
    (parsed as Record<string, CronField>)[kinds[i]] = field;
  }

  return {
    ok: true,
    cron: {
      ...(parsed as ParsedCron),
      // Standard cron semantics: when BOTH day-of-month and day-of-week are
      // restricted, a day matches if EITHER does. Getting this backwards is
      // the classic cron bug, so it is computed once and named.
      bothDaysRestricted: fields[2] !== '*' && fields[4] !== '*',
    },
  };
}

/** How far ahead `nextAfter` will search before giving up. */
const MAX_SEARCH_DAYS = 366 * 4;

/**
 * The first instant strictly after `from` that matches.
 *
 * Minute-resolution and bounded: an expression that can never match (29
 * February in a non-leap century, say) returns null after a bounded search
 * rather than spinning. Returning null is a real answer the caller reports,
 * not a failure it hides.
 */
export function nextAfter(cron: ParsedCron, from: Date): Date | null {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const limit = new Date(from.getTime() + MAX_SEARCH_DAYS * 86_400_000);
  while (t <= limit) {
    if (!cron.month.values.includes(t.getMonth() + 1)) {
      // Jump to the first minute of the next month rather than stepping.
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    const domMatch = cron.dayOfMonth.values.includes(t.getDate());
    const dowMatch = cron.dayOfWeek.values.includes(t.getDay());
    const dayMatch = cron.bothDaysRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.values.includes(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.values.includes(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** Convenience: validate and compute the next fire in one call. */
export function nextFire(expression: string, from: Date): { ok: true; at: Date | null } | { ok: false; error: string } {
  const parsed = parseCron(expression);
  if (!parsed.ok) return parsed;
  return { ok: true, at: nextAfter(parsed.cron, from) };
}

/**
 * A short human description, for a rule list that must not lie.
 *
 * Only the shapes it can describe EXACTLY get a phrase; everything else
 * falls back to the raw expression. A description is read instead of the
 * expression, so "daily at 02:30" for a leap-day-only schedule would be a
 * worse outcome than showing `30 2 29 2 *` and making the reader think.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return `invalid (${parsed.error})`;
  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed.cron;
  const everyDayOfMonth = dayOfMonth.values.length === 31;
  const everyMonth = month.values.length === 12;
  const everyDayOfWeek = dayOfWeek.values.length === 7;
  const at = `${String(hour.values[0]).padStart(2, '0')}:${String(minute.values[0]).padStart(2, '0')}`;

  // Anything that restricts WHICH days it runs on is not "daily" and is
  // not described as such.
  if (everyDayOfMonth && everyMonth) {
    if (everyDayOfWeek) {
      if (minute.values.length === 60 && hour.values.length === 24) return 'every minute';
      if (minute.values.length === 1 && hour.values.length === 24) return `every hour at :${String(minute.values[0]).padStart(2, '0')}`;
      if (minute.values.length === 1 && hour.values.length === 1) return `daily at ${at}`;
    } else if (minute.values.length === 1 && hour.values.length === 1 && dayOfWeek.values.length === 1) {
      return `every ${DAY_NAMES[dayOfWeek.values[0]]} at ${at}`;
    }
  }
  return expression;
}

/* ══════════════════════════════════════════════════════════════════
   Rule-level validation
   ══════════════════════════════════════════════════════════════════ */

export interface RuleValidationIssue {
  field: string;
  message: string;
}

/**
 * Is this rule storable and runnable?
 *
 * Called at the API boundary rather than inside the store, because the
 * store's contract is "persist what you are given" and a store that
 * threw would make every existing caller a potential crash site. Refusing
 * at the edge, with a reason naming the field, is the same guarantee in
 * the place a user can act on it.
 *
 * A schedule with an unparseable cron or no project is refused outright:
 * both produce a rule that looks armed and can never fire, which is the
 * worst failure mode an automation UI can have.
 */
export function validateRule(rule: {
  trigger: { type: string; cron?: string; projectId?: string };
  chain: { action: string; config: Record<string, unknown> }[];
}): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];

  if (rule.trigger.type === 'schedule') {
    if (!rule.trigger.cron) {
      issues.push({ field: 'trigger.cron', message: 'A scheduled rule needs a cron expression.' });
    } else {
      const parsed = parseCron(rule.trigger.cron);
      if (!parsed.ok) issues.push({ field: 'trigger.cron', message: parsed.error });
      else if (!nextAfter(parsed.cron, new Date())) {
        issues.push({ field: 'trigger.cron', message: 'That expression has no next occurrence, so the rule could never fire.' });
      }
    }
    if (!rule.trigger.projectId) {
      issues.push({ field: 'trigger.projectId', message: 'A scheduled rule must name the project it runs against — there is no event to infer one from.' });
    }
  } else if (rule.trigger.cron) {
    issues.push({ field: 'trigger.cron', message: `A cron expression only applies to a schedule trigger, not to "${rule.trigger.type}".` });
  }

  for (const [i, action] of rule.chain.entries()) {
    if (action.action !== 'run-workflow') continue;
    if (!action.config?.workflowId || typeof action.config.workflowId !== 'string') {
      issues.push({ field: `chain[${i}].config.workflowId`, message: 'A run-workflow action must name the workflow it runs.' });
    }
  }

  return issues;
}
