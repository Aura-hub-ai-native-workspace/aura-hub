/**
 * Expression scope + safe condition evaluation.
 * ==================================================================
 * The runtime builds one scope per node execution from the settled
 * node runs and the trigger payload, then evaluates templates with the
 * Phase 1+2 constrained expression system (pure path lookup — no eval,
 * no function call, no prototype access).
 *
 * Scope shape:
 *
 *   trigger.output  — the payload of the trigger that started the run
 *   inputs          — run inputs
 *   run             — run id, status, timestamps
 *   nodes.<id>.<port> — the value a settled node fired on a port
 *   nodes.<id>.status — the node run status
 *   <id>.output     — alias: the value a settled node fired on its
 *                     primary port (the product spec's {{nodeId.output}})
 *   <id>.status     — alias: {{nodeId.status}}
 *   input           — the current node's primary input value
 *
 * Conditions are evaluated with the operators of the domain model only.
 * Two shapes are supported:
 *
 *   - the condition node's op + value + field config (contains,
 *     not-contains, matches-regex, equals, not-equals, longer-than,
 *     is-empty, gt, lt);
 *   - the branch node's infix form:  {{path}} == "x"   risk >= 0.8
 *     Ops: ==  !=  >=  <=  >  <  contains  matches  is-empty.
 *     Literals: "quoted string", number, true/false, {{path}}.
 *     A tiny hand-rolled parser — no JavaScript is ever evaluated.
 */

import { evaluateExpression, parseExpression, resolvePath, type Expression } from '../expression';
import type { WorkflowDefinition, WorkflowNodeRun } from '../types';

/** A settled node run, projected into the expression scope. */
function nodeScopeEntry(run: WorkflowNodeRun, portValue: unknown): Record<string, unknown> {
  const entry: Record<string, unknown> = { status: run.status, output: portValue };
  if (run.firedPort) entry[run.firedPort] = portValue;
  return entry;
}

/** Persisted fired values are wrapped as { value }; unwrap for the scope. */
export function unwrapFired(outputs: unknown): unknown {
  if (!outputs || typeof outputs !== 'object') return outputs;
  if ('value' in outputs) return (outputs as Record<string, unknown>).value;
  return outputs;
}

/** Build the read scope from settled node runs + trigger payload. */
export function buildScope(
  _wf: WorkflowDefinition,
  nodeRuns: Map<string, WorkflowNodeRun>,
  triggerPayload: unknown,
  inputs: Record<string, unknown>,
  runFields: Record<string, unknown>,
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    trigger: { output: triggerPayload },
    inputs,
    run: runFields,
    nodes: {},
    input: undefined,
  };
  const nodes = scope.nodes as Record<string, unknown>;
  for (const [nodeId, nr] of nodeRuns) {
    if (nr.status !== 'success') {
      nodes[nodeId] = { status: nr.status };
      scope[nodeId] = nodes[nodeId];
      continue;
    }
    const portValue = nr.firedPort ? unwrapFired(nr.outputs) : undefined;
    const entry = nodeScopeEntry(nr, portValue);
    nodes[nodeId] = entry;
    scope[nodeId] = entry;
  }
  return scope;
}

/** The value of a node's primary input port, or undefined. */
export function primaryInput(delivered: Record<string, unknown>): unknown {
  return delivered['in'];
}

/** Strict template evaluation: any missing reference fails the node.
 *  Returns the resolved value when the template is a single reference,
 *  the interpolated text otherwise. */
export function evalStrict(template: string, scope: Record<string, unknown>, what: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof template !== 'string' || !template.trim()) return { ok: true, value: undefined };
  const parsed = parseExpression(template);
  if (!parsed.ok) return { ok: false, error: `invalid ${what}: ${parsed.error}` };
  if (parsed.references.length === 1 && template.trim() === `{{${parsed.references[0]!.raw}}}`) {
    const hit = resolvePath(scope, parsed.references[0]!.path);
    if (!hit.found) return { ok: false, error: `${what} references a missing path: {{${parsed.references[0]!.raw}}}` };
    return { ok: true, value: hit.value };
  }
  const out = evaluateExpression(template, scope);
  if (!out.ok) return { ok: false, error: `${what}: ${out.error}` };
  if (out.missing.length) return { ok: false, error: `${what} references missing paths: ${out.missing.join(', ')}` };
  return { ok: true, value: out.text };
}

/** Lax interpolation for human-readable text (logs, notifications). */
export function evalLax(template: string, scope: Record<string, unknown>): string {
  if (!template) return '';
  const out = evaluateExpression(template, scope);
  return out.ok ? out.text : '';
}

/** Parse a capability node's inputMap ("key: value" lines, values may
 *  be {{expressions}}). Strict: missing references fail the node. */
export function buildInputMap(
  mapText: unknown,
  scope: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {};
  if (typeof mapText !== 'string' || !mapText.trim()) return { ok: true, input };
  for (const line of mapText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return { ok: false, error: `inputMap line "${trimmed}" is not "key: value"` };
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    if (!key) return { ok: false, error: `inputMap line "${trimmed}" has an empty key` };
    const out = evalStrict(raw, scope, `inputMap field "${key}"`);
    if (!out.ok) return out;
    input[key] = out.value;
  }
  return { ok: true, input };
}

/* ── condition operators (the domain model's vocabulary) ──────────── */

export type ConditionOp = 'contains' | 'not-contains' | 'matches-regex' | 'equals' | 'not-equals' | 'longer-than' | 'is-empty' | 'gt' | 'lt';

export function isConditionOp(op: unknown): op is ConditionOp {
  return typeof op === 'string' && ['contains', 'not-contains', 'matches-regex', 'equals', 'not-equals', 'longer-than', 'is-empty', 'gt', 'lt'].includes(op);
}

export function evaluateConditionOp(op: ConditionOp, subject: unknown, value: unknown): boolean {
  switch (op) {
    case 'contains':
      return String(subject ?? '').includes(String(value ?? ''));
    case 'not-contains':
      return !String(subject ?? '').includes(String(value ?? ''));
    case 'matches-regex': {
      const pattern = String(value ?? '');
      try {
        return new RegExp(pattern).test(String(subject ?? ''));
      } catch {
        return false;
      }
    }
    case 'equals':
      return looseEquals(subject, value);
    case 'not-equals':
      return !looseEquals(subject, value);
    case 'longer-than':
      return String(subject ?? '').length > toNumber(value);
    case 'is-empty':
      return subject === undefined || subject === null || subject === '' || (Array.isArray(subject) && subject.length === 0);
    case 'gt':
      return toNumber(subject) > toNumber(value);
    case 'lt':
      return toNumber(subject) < toNumber(value);
  }
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return toNumber(a) === toNumber(b);
  return String(a ?? '') === String(b ?? '');
}

/* ── infix conditions (branch node): {{x}} == "y", risk >= 0.8 ────── */

export type InfixOp = '==' | '!=' | '>=' | '<=' | '>' | '<' | 'contains' | 'matches' | 'is-empty';

const INFIX_RE = /^\s*(\{\{[\w.-]+\}\}|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|\S+)\s*(==|!=|>=|<=|>|<|contains|matches|is-empty)\s*(\{\{[\w.-]+\}\}|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|\S+)?\s*$/;

/** Parse and evaluate a safe infix condition. No JavaScript is
 *  executed: the grammar is a fixed pattern over literals and {{path}}
 *  references. `is-empty` takes one operand (the subject). */
export function evaluateInfixCondition(expression: string, scope: Record<string, unknown>): { ok: true; result: boolean } | { ok: false; error: string } {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, error: 'empty condition' };

  const isEmpty = /^\s*is-empty\s+(\{\{[\w.-]+\}\}|"[^"]*"|'[^']*'|\S+)\s*$/.exec(trimmed);
  if (isEmpty) {
    const lhs = resolveOperand(isEmpty[1]!, scope);
    if (!lhs.ok) return lhs;
    const empty = lhs.value === undefined || lhs.value === null || lhs.value === '' || (Array.isArray(lhs.value) && lhs.value.length === 0);
    return { ok: true, result: empty };
  }

  const m = INFIX_RE.exec(trimmed);
  if (!m) return { ok: false, error: `condition "${expression}" is not a supported comparison` };
  const [, rawLhs, opRaw, rawRhs] = m;
  const op = opRaw as InfixOp;

  const lhs = resolveOperand(rawLhs!, scope);
  if (!lhs.ok) return lhs;
  if (op !== 'is-empty' && rawRhs === undefined) return { ok: false, error: `condition "${expression}" is missing a right-hand side` };
  const rhs = rawRhs === undefined ? { ok: true as const, value: undefined } : resolveOperand(rawRhs, scope);
  if (!rhs.ok) return rhs;

  const a = lhs.value;
  const b = rhs.value;
  let result: boolean;
  switch (op) {
    case '==':
      result = looseEquals(a, b);
      break;
    case '!=':
      result = !looseEquals(a, b);
      break;
    case '>=':
      result = toNumber(a) >= toNumber(b);
      break;
    case '<=':
      result = toNumber(a) <= toNumber(b);
      break;
    case '>':
      result = toNumber(a) > toNumber(b);
      break;
    case '<':
      result = toNumber(a) < toNumber(b);
      break;
    case 'contains':
      result = String(a ?? '').includes(String(b ?? ''));
      break;
    case 'matches': {
      try {
        result = new RegExp(String(b ?? '')).test(String(a ?? ''));
      } catch {
        result = false;
      }
      break;
    }
    case 'is-empty':
      result = a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);
      break;
  }
  return { ok: true, result };
}

function resolveOperand(raw: string, scope: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw.startsWith('{{')) {
    const parsed = parseExpression(raw);
    if (!parsed.ok || parsed.references.length !== 1) return { ok: false, error: `invalid reference "${raw}"` };
    const hit = resolvePath(scope, parsed.references[0]!.path);
    if (!hit.found) return { ok: false, error: `missing path in condition: {{${parsed.references[0]!.raw}}}` };
    return { ok: true, value: hit.value };
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return { ok: true, value: raw.slice(1, -1) };
  if (raw.startsWith("'") && raw.endsWith("'")) return { ok: true, value: raw.slice(1, -1) };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { ok: true, value: Number(raw) };
  return { ok: true, value: raw };
}

/** One evaluated expression, exported for tests. */
export function evalExpressionValue(template: Expression, scope: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string } {
  return evalStrict(template, scope, 'expression');
}