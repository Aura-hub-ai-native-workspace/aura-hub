/**
 * A model stuck in a loop, detected from its own text only. Mirrors
 * backend/aura/central_agent/repetition.py (same thresholds, same rule): the tail
 * is a unit of at least MIN_UNIT characters repeated back to back at least
 * MIN_REPEATS times. Shorter echoes and less regular structure (tables, lists,
 * similar code lines) never qualify, so a long legitimate answer is not cut short.
 */
export const MIN_UNIT = 40;
export const MIN_REPEATS = 3;
export const MAX_UNIT = 1500;
const STEP = 128;

/** Index just after the FIRST copy of a trailing loop, or null. */
export function findLoop(text: string): number | null {
  const n = text.length;
  const tail = text.slice(Math.max(0, n - (MIN_REPEATS * MAX_UNIT + 200)));
  const offset = n - tail.length;
  const m = tail.length;
  const limit = Math.min(MAX_UNIT, Math.floor(m / MIN_REPEATS));
  for (let unit = MIN_UNIT; unit <= limit; unit++) {
    const a = tail.slice(m - unit);
    let ok = true;
    for (let k = 2; k <= MIN_REPEATS; k++) {
      if (tail.slice(m - k * unit, m - (k - 1) * unit) !== a) { ok = false; break; }
    }
    if (!ok) continue;
    let start = m - MIN_REPEATS * unit;
    while (start > 0 && tail[start - 1] === tail[start - 1 + unit]) start -= 1;
    return offset + start + unit;
  }
  return null;
}

export class RepetitionGuard {
  private text = '';
  private checkedAt = 0;
  cut: number | null = null;

  /** True once a loop is established. */
  feed(piece: string): boolean {
    this.text += piece;
    if (this.cut !== null) return true;
    if (this.text.length - this.checkedAt < STEP || this.text.length < MIN_UNIT * MIN_REPEATS) return false;
    this.checkedAt = this.text.length;
    this.cut = findLoop(this.text);
    return this.cut !== null;
  }

  /** What was written before the loop, plus one copy of its unit. */
  usefulText(): string {
    return this.cut === null ? this.text : this.text.slice(0, this.cut);
  }
}

/** Thrown when a stream was stopped because the model was looping. */
export class DegenerateOutputError extends Error {
  constructor(public readonly partial: string) {
    super('The model began repeating itself and was stopped.');
    this.name = 'DegenerateOutputError';
  }
}
