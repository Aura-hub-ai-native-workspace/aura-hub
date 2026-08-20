/**
 * The single redaction authority.
 * ==================================================================
 * ⚠ PHASE-1-OWNED FILE, DUPLICATED HERE FOR MERGE.
 *
 * The content below is the seven credential regexes and the `redact`
 * function extracted VERBATIM from the private copy that lived in
 * `promptContract.ts`. Phase 1 creates this module as the single
 * redaction choke point; Phase 4 needs it to exist so the one composer
 * can guarantee "every context item passes redact() exactly once, by
 * construction". If both phases land, this file merges to itself.
 *
 * Do not add a second copy of these patterns anywhere. If a new prompt
 * path is added, route it through `redact()` here rather than repeating
 * the shapes — the whole point is that a section added later is covered
 * without anyone remembering to opt in.
 */

/**
 * Credential-shaped substrings, redacted at the render boundary.
 *
 * Deliberately conservative. It matches shapes, not names, and it never
 * tries to be a secret scanner — it is defence in depth behind "AURA does
 * not put secrets in context in the first place", not a replacement for it.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,              // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,                            // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                  // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,              // PEM private keys
  /\b(?:api[_-]?key|apikey|secret|password|passwd|token|bearer)\s*[:=]\s*\S+/gi,
];

/** Replace anything credential-shaped with a marker that says what happened. */
export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}
