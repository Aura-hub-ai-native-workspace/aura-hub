/**
 * Expression / mapping system (§10 of the product spec).
 * ==================================================================
 * Users reference previous outputs with templates like
 *
 *   {{trigger.branch}}
 *   {{nodes.<nodeId>.out.summary}}
 *
 * Rules that keep this SAFE by construction:
 *   - path segments are identifiers ([A-Za-z0-9_-]), never code;
 *   - resolution is a pure lookup against a caller-supplied scope
 *     record — there is no eval, no function call, no getter, no
 *     prototype access (`__proto__`, `constructor`, `prototype` are
 *     rejected), so an expression can never execute anything;
 *   - evaluation is deterministic and reports missing paths rather
 *     than silently producing undefined;
 *   - templates may contain plain text around references
 *     (`Commit {{nodes.g.commit.out.sha}}`) for human-readable output.
 *
 * Scope shape (documented, not enforced here — the runtime builds it):
 *   trigger?: TriggerNodeConfig payload     — the event that started the run
 *   inputs?: Record<string, unknown>        — run-time inputs
 *   run?: WorkflowRun fields                — runId, status, ...
 *   nodes?: Record<nodeId, Record<portId, unknown>> — previous outputs
 */

export type Expression = string;

export const EXPRESSION_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** One `{{...}}` reference found in a template. */
export interface ExpressionReference {
  raw: string;
  /** Dot-split path segments, e.g. ['nodes', 'g', 'out', 'summary']. */
  path: string[];
  start: number;
  end: number;
}

export type ExpressionValidation =
  | { ok: true; references: ExpressionReference[] }
  | { ok: false; error: string };

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** Segments that would reach Object.prototype — never resolvable. */
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a template and return every reference. Rejects malformed
 * syntax: unbalanced braces, empty paths, path segments that are not
 * plain identifiers. Pure — never throws on valid input, always
 * reports a reason on invalid input.
 */
export function parseExpression(template: string): ExpressionValidation {
  const refs: ExpressionReference[] = [];
  let m: RegExpExecArray | null;
  EXPRESSION_RE.lastIndex = 0;
  while ((m = EXPRESSION_RE.exec(template)) !== null) {
    const raw = m[1];
    const segments = raw.split('.');
    if (segments.some((s) => !SEGMENT_RE.test(s))) {
      return { ok: false, error: `invalid expression "${m[0]}": path segments must be plain identifiers` };
    }
    if (segments.some((s) => BLOCKED.has(s))) {
      return { ok: false, error: `invalid expression "${m[0]}": unsafe path segment` };
    }
    refs.push({ raw, path: segments, start: m.index, end: m.index + m[0].length });
  }
  // Detect stray/unclosed braces that the regex did not consume.
  const withoutRefs = template.replace(EXPRESSION_RE, '');
  if (withoutRefs.includes('{{') || withoutRefs.includes('}}')) {
    return { ok: false, error: 'malformed expression: unbalanced "{{" or "}}"' };
  }
  return { ok: true, references: refs };
}

export function hasExpressions(template: string): boolean {
  return EXPRESSION_RE.test(template);
}

/**
 * Resolve one path against a scope by plain lookup. Returns
 * `{ found: false }` for any missing segment — never undefined.
 */
export function resolvePath(scope: Record<string, unknown>, path: string[]): { found: true; value: unknown } | { found: false } {
  let cursor: unknown = scope;
  for (const seg of path) {
    if (BLOCKED.has(seg)) return { found: false };
    if (cursor === null || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return { found: true, value: cursor };
}

export type ExpressionResult =
  | { ok: true; text: string; values: Record<string, unknown>; missing: string[] }
  | { ok: false; error: string };

/**
 * Evaluate a template against a scope: substitutes every reference,
 * joins arrays of strings with ", ", stringifies scalars, and reports
 * which references were missing. Missing references yield the empty
 * string so a partially-filled template still reads naturally; the
 * caller decides whether missing paths should fail the node.
 */
export function evaluateExpression(template: string, scope: Record<string, unknown>): ExpressionResult {
  const parsed = parseExpression(template);
  if (!parsed.ok) return parsed;
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  let text = template;
  for (const ref of parsed.references) {
    const hit = resolvePath(scope, ref.path);
    if (!hit.found) {
      missing.push(ref.raw);
      values[ref.raw] = undefined;
      text = text.replace(`{{${ref.raw}}}`, '');
      continue;
    }
    values[ref.raw] = hit.value;
    text = text.replace(`{{${ref.raw}}}`, stringifyValue(hit.value));
  }
  return { ok: true, text, values, missing };
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map((x) => stringifyValue(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return '';
}