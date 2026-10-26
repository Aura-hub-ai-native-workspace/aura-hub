/**
 * failureReason — a failed turn keeps WHY it failed, across a restart.
 * ------------------------------------------------------------------
 * The message store used to keep only `error: true`, so after a reload the
 * specific reason ("model plan rejected: …") was gone and the generic
 * "Something went wrong" showed instead. The reason is now stored in the
 * message's `meta.errorReason` — after it has been scrubbed and bounded, because
 * a persisted conversation outlives the session and is read by other code.
 */

const MAX_REASON_CHARS = 600;

// Order matters: structured forms first, then bare tokens.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+(\s+[^\s,;]+)?/gi, '$1: [redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]+/gi, '$1=[redacted]'],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/(?<![A-Za-z0-9])(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}/g, '[redacted]'],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  // URLs: never keep credentials or query strings
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted]'],
];

/** A reason fit to store and show: no credentials, no multi-line diagnostics, bounded. */
export function sanitizeFailureReason(raw: string | null | undefined): string {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  for (const [re, to] of SECRET_PATTERNS) text = text.replace(re, to);
  if (text.length > MAX_REASON_CHARS) text = `${text.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;
  return text;
}

/** The meta object to persist for an assistant message, carrying the reason when it failed. */
export function metaWithReason<T extends object | undefined>(meta: T, failed: boolean, error: string | undefined): (T & { errorReason?: string }) | { errorReason: string } | T {
  if (!failed) return meta;
  const reason = sanitizeFailureReason(error);
  if (!reason) return meta;
  return { ...(meta ?? {}), errorReason: reason } as T & { errorReason: string };
}

/** The stored reason of a reloaded message, if it has one. */
export function reasonFromMeta(meta: unknown): string | undefined {
  const r = (meta as { errorReason?: unknown } | null | undefined)?.errorReason;
  return typeof r === 'string' && r.trim() ? sanitizeFailureReason(r) : undefined;
}
