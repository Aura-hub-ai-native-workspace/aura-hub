/**
 * Node execution — the orchestration boundary (Phase 5).
 * ==================================================================
 * One function per node KIND, all routing through the RuntimeHost:
 *
 *   capability / agent / create-mission / run-mission / mission-approval
 *   / export        → fabric.invoke(...)   — the ONE governed path:
 *                     resolve → policy → approval → execute → verify
 *                     → audit. The runtime never spawns anything.
 *   ask-aura & AI   → host.ai.generate     — read-only provider seam.
 *   update/wait-mission → host.missions    — the mission authority.
 *   control nodes   → scheduler primitives — pure orchestration.
 *   approval node   → host.askApproval     — a human gate; parks the
 *                     run when unanswered, never bypasses.
 *
 * The executor is deliberately NOT an execution authority: it carries
 * no policy, no permissions and no process primitive. Every governed
 * effect is a Fabric invocation; the Fabric's audit record is the
 * trace (workflow → node → capability → policy → approval → execution
 * → result).
 */

import type { InvocationContext, InvocationResult } from '@aura/capability-fabric';
import type { RetryPolicy, WorkflowDefinition, WorkflowNode, WorkflowNodeRun, WorkflowRun } from '../types';
import type { RuntimeHost } from './types';
import { buildInputMap, evalLax, evalStrict, evaluateConditionOp, evaluateInfixCondition, isConditionOp, primaryInput } from './scope';

/** The result of executing one node. */
export type NodeExecutionResult =
  | { kind: 'fire'; port: string; value: unknown }
  | { kind: 'done' }
  | {
      kind: 'fail';
      error: string;
      /**
       * True when this failure is a governed call to an irreversible
       * capability whose effect may already exist (the Fabric's own
       * attestation). Automatic retries — the node-level `withRetry` loop
       * and the `retry` control node — must never re-run it without fresh
       * approval.
       */
      irreversibleEffect?: boolean;
    }
  | { kind: 'approval-required'; requestId: string }
  | { kind: 'paused'; reason: string };

/** A subtree capture session granted by the scheduler (loop/retry/...). */
export interface CaptureSession {
  /** Node ids inside the iteration subtree. */
  subtree: Set<string>;
  /** Reset subtree node states and iteration edge deliveries. */
  reset(): void;
}

/** Everything the scheduler gives a node executor. */
export interface NodeExecutionContext {
  wf: WorkflowDefinition;
  run: WorkflowRun;
  node: WorkflowNode;
  nodeRun: WorkflowNodeRun;
  scope: Record<string, unknown>;
  delivered: Record<string, unknown>;
  host: RuntimeHost;
  approvedCapabilities?: string[];
  isCancelled(): boolean;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  sleep(ms: number): Promise<void>;
  capture(node: WorkflowNode, iterationPorts: string[]): CaptureSession;
  deliver(nodeId: string, port: string, value: unknown): void;
  drainCapture(): Promise<{ ok: true } | { ok: false; failedNodeId: string; error: string; irreversibleEffect?: boolean }>;
  pendingApprovalForInvocation(invocationId: string): string | undefined;
  notify(message: string): void;
  recordResult(value: unknown): void;
}

/* ── helpers ──────────────────────────────────────────────────────── */

const SECRET_KEY = /(^|[^a-z])(api[_-]?key|token|secret|password|private[_-]?key|authorization)([^a-z]|$)/i;

/** §16 — never persist secrets inside workflow-run JSON. Redacts every
 *  value whose KEY looks like a secret, at any depth (a trigger payload
 *  nests under { value }, so a shallow pass is not enough). */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const seen = new Set<object>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      if (seen.has(value)) return value;
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = SECRET_KEY.test(key) ? '<redacted>' : walk(child);
      }
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = SECRET_KEY.test(key) ? '<redacted>' : walk(value);
  }
  return out;
}

export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map((x) => stringifyValue(x)).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/** A node-level retry policy: node config first, workflow settings fallback. */
function retryPolicyOf(ctx: NodeExecutionContext): RetryPolicy | null {
  const raw = ctx.node.config.retry ?? ctx.wf.settings.retry;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<RetryPolicy>;
  const maxAttempts = clampInt(p.maxAttempts, 1, 10, 1);
  if (maxAttempts <= 1) return null;
  const delayMs = Math.max(0, Math.min(600_000, Number(p.delayMs) || 0));
  const backoffFactor = Math.max(1, Math.min(10, Number(p.backoffFactor) || 1));
  return { maxAttempts, delayMs, backoffFactor };
}

/** Effective execution budget: node governance → node config → settings. */
function timeoutOf(ctx: NodeExecutionContext): number | undefined {
  const raw = ctx.node.governance?.timeoutMs ?? ctx.node.config.timeoutMs ?? ctx.wf.settings.defaultTimeoutMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Retry a failing execution with backoff; approval gates are not retried.
 *
 * The same irreversible-effect invariant the Fabric enforces applies
 * here: a node that failed on an irreversible capability whose effect may
 * already exist is never re-run automatically. The Fabric is the single
 * authority on both facts (`InvocationResult.irreversible` +
 * `effectStarted`); this loop only refuses to undo its decision.
 */
async function withRetry(ctx: NodeExecutionContext, run: () => Promise<NodeExecutionResult>): Promise<NodeExecutionResult> {
  const policy = retryPolicyOf(ctx);
  if (!policy) return run();
  let result = await run();
  let attempt = 1;
  while (result.kind === 'fail' && attempt < policy.maxAttempts) {
    if (result.irreversibleEffect) {
      // The effect may already exist; retrying could repeat or compound
      // it. The failure stands — only a fresh human grant can authorize
      // another attempt (which the Fabric parks for on its own gate).
      ctx.log('warn', `not retrying ${ctx.node.id}: the capability is irreversible and its effect may already have started`);
      break;
    }
    const delay = Math.round(policy.delayMs * policy.backoffFactor ** (attempt - 1));
    ctx.log('warn', `node failed (attempt ${attempt}/${policy.maxAttempts}); retrying in ${delay}ms`);
    await ctx.sleep(delay);
    if (ctx.isCancelled()) return result;
    attempt += 1;
    ctx.nodeRun.attempts = attempt;
    result = await run();
  }
  return result;
}

/** Bound the whole node execution (retries included) with a budget. */
async function withTimeout(ctx: NodeExecutionContext, run: () => Promise<NodeExecutionResult>): Promise<NodeExecutionResult> {
  const budget = timeoutOf(ctx);
  if (!budget) return run();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: 'fail', error: `node timed out after ${budget}ms` });
    }, budget);
    run().then((r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/** Invocation context for a governed call — workflow-correlated. */
function invocationContextFor(ctx: NodeExecutionContext, opts: { timeoutMs?: number } = {}): InvocationContext {
  return {
    actor: ctx.node.governance?.actor ?? { kind: 'agent', id: `workflow:${ctx.run.runId}` },
    projectId: ctx.run.projectId,
    cwd: ctx.run.projectId ? ctx.host.projectPath?.(ctx.run.projectId) : undefined,
    // Correlate the audit trail with the workflow run and node. Also the
    // approval identity: a gated capability asks once per (run, node,
    // capability) instead of once per attempt/restart.
    missionId: `workflow:${ctx.run.runId}`,
    taskId: ctx.node.id,
    timeoutMs: opts.timeoutMs ?? timeoutOf(ctx),
    approvedCapabilities: ctx.approvedCapabilities,
    nodeId: ctx.node.governance?.nodeId,
  };
}

/** Map a Fabric InvocationResult onto a node outcome. */
function outcomeOf(ctx: NodeExecutionContext, result: InvocationResult): NodeExecutionResult {
  ctx.nodeRun.policy = result.policy;
  if (result.invocationId) ctx.nodeRun.auditIds.push(result.invocationId);
  switch (result.outcome) {
    case 'succeeded':
      return { kind: 'fire', port: 'out', value: result.output };
    case 'unverified':
      ctx.log('warn', `executed but the check did not confirm it: ${result.detail}`);
      return { kind: 'fire', port: 'out', value: result.output };
    case 'awaiting-approval': {
      const requestId = ctx.pendingApprovalForInvocation(result.invocationId);
      if (!requestId) return { kind: 'fail', error: `approval was required but the request cannot be found (${result.detail})` };
      return { kind: 'approval-required', requestId };
    }
    case 'denied':
      return { kind: 'fail', error: result.detail };
    case 'unsupported':
      return { kind: 'fail', error: result.detail };
    case 'failed':
      return {
        kind: 'fail',
        error: result.detail,
        // The Fabric is the single authority on both halves: it knows the
        // capability's descriptor (irreversible or not) and the executor's
        // attestation that the effect may already exist. When both say no
        // automatic re-run, the workflow must not undo that by retrying.
        irreversibleEffect: result.irreversible === true && result.effectStarted !== false,
      };
  }
}

/* ── the per-kind executors ───────────────────────────────────────── */

async function runCapability(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const capabilityId = typeof ctx.node.config.capabilityId === 'string' ? ctx.node.config.capabilityId : '';
  if (!capabilityId) return { kind: 'fail', error: 'capability node needs a capabilityId' };
  const mapped = buildInputMap(ctx.node.config.inputMap, ctx.scope);
  if (!mapped.ok) return { kind: 'fail', error: mapped.error };
  const input = redactRecord(mapped.input);
  const result = await ctx.host.fabric.invoke(capabilityId, mapped.input, invocationContextFor(ctx));
  ctx.nodeRun.inputs = input;
  return outcomeOf(ctx, result);
}

async function runAgentDelegate(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const task = evalStrict(ctx.node.config.task as string, ctx.scope, 'task');
  if (!task.ok) return { kind: 'fail', error: task.error };
  const result = await ctx.host.fabric.invoke(
    'agent.delegate',
    { task: task.value, model: typeof ctx.node.config.model === 'string' ? ctx.node.config.model : undefined },
    invocationContextFor(ctx),
  );
  ctx.nodeRun.inputs = { task: task.value };
  return outcomeOf(ctx, result);
}

async function runMissionFabric(ctx: NodeExecutionContext, capabilityId: string, input: Record<string, unknown>): Promise<NodeExecutionResult> {
  if (!ctx.run.projectId) return { kind: 'fail', error: `mission node "${ctx.node.type}" needs a project-bound run` };
  const result = await ctx.host.fabric.invoke(capabilityId, { projectId: ctx.run.projectId, ...input }, invocationContextFor(ctx));
  ctx.nodeRun.inputs = redactRecord({ projectId: ctx.run.projectId, ...input });
  return outcomeOf(ctx, result);
}

async function runAi(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const config = ctx.node.config;
  let prompt = '';
  switch (ctx.node.type) {
    case 'ask-aura':
      prompt = `${evalLax(typeof config.prompt === 'string' ? config.prompt : '', ctx.scope)}${input !== undefined ? `\n\n${stringifyValue(input)}` : ''}`.trim();
      break;
    case 'analyze':
      prompt = `${config.prompt ? `${evalLax(String(config.prompt), ctx.scope)}\n` : ''}Analyze this input:\n${stringifyValue(input)}`.trim();
      break;
    case 'summarize':
      prompt = `${config.prompt ? `${evalLax(String(config.prompt), ctx.scope)}: ` : ''}${stringifyValue(input)}`.trim();
      break;
    case 'generate': {
      const instruction = evalLax(typeof config.instruction === 'string' ? config.instruction : '', ctx.scope);
      prompt = `${instruction}\n\n${stringifyValue(input)}`.trim();
      break;
    }
    case 'classify': {
      const labels = Array.isArray(config.labels) ? (config.labels as unknown[]).join(', ') : String(config.labels ?? '');
      prompt = `Classify the input into one of: ${labels}\n\n${stringifyValue(input)}`.trim();
      break;
    }
    case 'decide':
      prompt = `${evalLax(typeof config.question === 'string' ? config.question : '', ctx.scope)}\n\n${stringifyValue(input)}`.trim();
      break;
    default:
      return { kind: 'fail', error: `unhandled ai node "${ctx.node.type}"` };
  }
  const result = await ctx.host.ai.generate({
    nodeType: ctx.node.type,
    prompt,
    input,
    model: typeof config.model === 'string' ? config.model : undefined,
    temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
    format: typeof config.format === 'string' ? config.format : undefined,
    providerId: typeof config.providerId === 'string' ? config.providerId : undefined,
    timeoutMs: timeoutOf(ctx),
  });
  if (!result.ok) return { kind: 'fail', error: result.error };
  ctx.nodeRun.inputs = { prompt };
  return { kind: 'fire', port: 'out', value: result.output };
}

async function runCondition(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const config = ctx.node.config;
  const op = config.op;
  if (!isConditionOp(op)) return { kind: 'fail', error: `condition node needs a supported op, got "${String(op)}"` };
  let subject: unknown = input;
  if (typeof config.field === 'string' && config.field.trim()) {
    const field = evalStrict(config.field, ctx.scope, 'condition field');
    if (!field.ok) return { kind: 'fail', error: field.error };
    subject = field.value;
  }
  const target = literalValue(evalStrict(typeof config.value === 'string' ? config.value : '', ctx.scope, 'condition value'));
  if (!target.ok) return { kind: 'fail', error: target.error };
  const pass = evaluateConditionOp(op, subject, target.value);
  return { kind: 'fire', port: pass ? 'true' : 'false', value: input };
}

/** Condition values are literals ("go", 0.8); unquote a quoted one. */
function literalValue(r: { ok: true; value: unknown } | { ok: false; error: string }): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!r.ok) return r;
  const v = r.value;
  if (typeof v === 'string' && v.length >= 2) {
    const first = v[0];
    if ((first === '"' || first === "'") && v.endsWith(first)) return { ok: true, value: v.slice(1, -1) };
  }
  return r;
}

async function runBranch(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const condition = typeof ctx.node.config.condition === 'string' ? ctx.node.config.condition : '';
  const out = evaluateInfixCondition(condition, ctx.scope);
  if (!out.ok) return { kind: 'fail', error: out.error };
  return { kind: 'fire', port: out.result ? 'true' : 'false', value: input };
}

async function runSwitch(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const field = evalStrict(typeof ctx.node.config.field === 'string' ? ctx.node.config.field : '', ctx.scope, 'switch field');
  if (!field.ok) return { kind: 'fail', error: field.error };
  const cases = Array.isArray(ctx.node.config.cases)
    ? (ctx.node.config.cases as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : String(ctx.node.config.cases ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const idx = cases.findIndex((c) => String(field.value ?? '') === c);
  return { kind: 'fire', port: idx >= 0 ? `case-${idx + 1}` : 'default', value: input };
}

async function runIteration(ctx: NodeExecutionContext, ports: string[], items: unknown[]): Promise<NodeExecutionResult> {
  const session = ctx.capture(ctx.node, ports);
  for (const item of items) {
    session.reset();
    if (ctx.isCancelled()) return { kind: 'fail', error: 'cancelled' };
    ctx.deliver(ctx.node.id, ports[0]!, item);
    const out = await ctx.drainCapture();
    if (!out.ok) return { kind: 'fail', error: `${ctx.node.type} iteration failed: ${out.error}`, irreversibleEffect: out.irreversibleEffect };
  }
  return { kind: 'fire', port: ports[1] ?? 'done', value: items.length === 1 ? items[0] : items };
}

async function runRetryNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const maxAttempts = clampInt(ctx.node.config.maxAttempts, 1, 10, 3);
  const delayMs = Math.max(0, Math.min(600_000, Number(ctx.node.config.delayMs) || 0));
  const backoffFactor = Math.max(1, Math.min(10, Number(ctx.node.config.backoffFactor) || 1));
  const session = ctx.capture(ctx.node, ['out']);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    session.reset();
    ctx.deliver(ctx.node.id, 'out', input);
    const out = await ctx.drainCapture();
    if (out.ok) return { kind: 'fire', port: 'out', value: input };
    if (out.irreversibleEffect) {
      // Same invariant as withRetry: a subtree failure on an irreversible
      // capability whose effect may already exist is never retried. The
      // failure is surfaced on the retry node's failed port immediately.
      ctx.log('error', `retry node: not retrying — the subtree failed on an irreversible capability whose effect may already have started`);
      return { kind: 'fire', port: 'failed', value: { input, error: out.error } };
    }
    ctx.nodeRun.attempts = attempt;
    if (attempt < maxAttempts) {
      const delay = Math.round(delayMs * backoffFactor ** (attempt - 1));
      ctx.log('warn', `retry node: attempt ${attempt}/${maxAttempts} failed (${out.error}); retrying in ${delay}ms`);
      await ctx.sleep(delay);
    }
  }
  ctx.log('error', `retry node: all ${maxAttempts} attempts failed`);
  return { kind: 'fire', port: 'failed', value: { input, error: `all ${maxAttempts} attempts failed` } };
}

async function runTimeoutNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const budget = Math.max(1, Math.min(300_000, Number(ctx.node.config.ms) || 30_000));
  const started = Date.now();
  const session = ctx.capture(ctx.node, ['out']);
  session.reset();
  ctx.deliver(ctx.node.id, 'out', input);    const out = await ctx.drainCapture();
    if (!out.ok) return { kind: 'fail', error: `${ctx.node.type} subtree failed: ${out.error}`, irreversibleEffect: out.irreversibleEffect };
  if (Date.now() - started >= budget) {
    ctx.log('warn', `timeout node: subtree exceeded the ${budget}ms budget`);
    return { kind: 'fire', port: 'timed-out', value: input };
  }
  return { kind: 'fire', port: 'out', value: input };
}

async function runApprovalGate(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const summary = evalLax(typeof ctx.node.config.summary === 'string' ? ctx.node.config.summary : '', ctx.scope);
  const detail = evalLax(typeof ctx.node.config.detail === 'string' ? ctx.node.config.detail : '', ctx.scope);
  ctx.nodeRun.approval = { requestId: `wr:${ctx.run.runId}:${ctx.node.id}`, state: 'pending' };
  const granted = (await ctx.host.askApproval?.({ runId: ctx.run.runId, nodeId: ctx.node.id, summary, detail })) ?? false;
  if (!granted) return { kind: 'paused', reason: `waiting on human approval: ${summary}` };
  ctx.nodeRun.approval = { ...ctx.nodeRun.approval, state: 'granted', decidedAt: new Date().toISOString() };
  return { kind: 'fire', port: 'approved', value: input };
}

async function runExport(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const input = primaryInput(ctx.delivered);
  const target = evalStrict(typeof ctx.node.config.path === 'string' ? ctx.node.config.path : '', ctx.scope, 'export path');
  if (!target.ok) return { kind: 'fail', error: target.error };
  const content = typeof ctx.node.config.template === 'string' && ctx.node.config.template.trim()
    ? evalLax(ctx.node.config.template, ctx.scope)
    : stringifyValue(input);
  const result = await ctx.host.fabric.invoke(
    'filesystem.write',
    { path: target.value, content },
    invocationContextFor(ctx),
  );
  ctx.nodeRun.inputs = redactRecord({ path: target.value, content });
  return outcomeOf(ctx, result);
}

/* ── dispatch ─────────────────────────────────────────────────────── */

/** Execute one node through the host boundary. */
export async function executeNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const inner = async (): Promise<NodeExecutionResult> => {
    switch (ctx.node.type) {
      /* triggers are fired by the scheduler pre-pass, never here */
      case 'manual': case 'schedule': case 'git-event': case 'file-change':
      case 'mission-event': case 'agent-event': case 'environment-event':
        return { kind: 'fail', error: `trigger node "${ctx.node.type}" was not fired by the run trigger` };

      case 'ask-aura': case 'analyze': case 'summarize': case 'generate':
      case 'classify': case 'decide':
        return runAi(ctx);

      case 'agent':
        return runAgentDelegate(ctx);
      case 'capability':
        return runCapability(ctx);

      case 'create-mission':
        return runMissionFabric(ctx, 'mission.create', { text: evalLax(typeof ctx.node.config.text === 'string' ? ctx.node.config.text : '', ctx.scope) || stringifyValue(primaryInput(ctx.delivered)) });
      case 'run-mission': {
        const missionId = evalStrict(typeof ctx.node.config.missionId === 'string' ? ctx.node.config.missionId : '', ctx.scope, 'missionId');
        if (!missionId.ok) return { kind: 'fail', error: missionId.error };
        return runMissionFabric(ctx, 'mission.start', { missionId: missionId.value });
      }
      case 'mission-approval': {
        const missionId = evalStrict(typeof ctx.node.config.missionId === 'string' ? ctx.node.config.missionId : '', ctx.scope, 'missionId');
        if (!missionId.ok) return { kind: 'fail', error: missionId.error };
        return runMissionFabric(ctx, 'mission.approve', { missionId: missionId.value });
      }
      case 'update-mission': {
        const missions = ctx.host.missions;
        if (!missions?.update) return { kind: 'fail', error: 'host does not provide the mission update seam' };
        const missionId = evalStrict(typeof ctx.node.config.missionId === 'string' ? ctx.node.config.missionId : '', ctx.scope, 'missionId');
        if (!missionId.ok) return { kind: 'fail', error: missionId.error };
        const out = await missions.update(String(missionId.value), { note: stringifyValue(primaryInput(ctx.delivered)) });
        if (!out.ok) return { kind: 'fail', error: out.error ?? 'mission update failed' };
        ctx.nodeRun.inputs = { missionId: missionId.value };
        return { kind: 'fire', port: 'out', value: { missionId: missionId.value, updated: true } };
      }
      case 'wait-mission': {
        const missions = ctx.host.missions;
        if (!missions?.wait) return { kind: 'fail', error: 'host does not provide the mission wait seam' };
        const missionId = evalStrict(typeof ctx.node.config.missionId === 'string' ? ctx.node.config.missionId : '', ctx.scope, 'missionId');
        if (!missionId.ok) return { kind: 'fail', error: missionId.error };
        const until = typeof ctx.node.config.until === 'string' ? ctx.node.config.until : 'completed';
        const budget = Math.max(1, Math.min(3_600_000, Number(ctx.node.config.timeoutMs) || 600_000));
        const out = await missions.wait(String(missionId.value), until, budget);
        if (!out.ok) return { kind: 'fail', error: out.error ?? `mission did not reach "${until}" within ${budget}ms` };
        return { kind: 'fire', port: 'out', value: { missionId: missionId.value, state: out.state } };
      }

      case 'condition':
        return runCondition(ctx);
      case 'branch':
        return runBranch(ctx);
      case 'switch':
        return runSwitch(ctx);
      case 'merge': {
        const values = ctx.delivered['in'];
        return { kind: 'fire', port: 'out', value: values };
      }
      case 'delay': {
        const ms = Math.max(0, Math.min(60_000, Number(ctx.node.config.ms) || 0));
        await ctx.sleep(ms);
        return { kind: 'fire', port: 'out', value: primaryInput(ctx.delivered) };
      }
      case 'loop': {
        const times = clampInt(ctx.node.config.times, 0, 1000, 3);
        const items = Array.from({ length: times }, () => primaryInput(ctx.delivered));
        if (times === 0) return { kind: 'fire', port: 'done', value: primaryInput(ctx.delivered) };
        return runIteration(ctx, ['each', 'done'], items);
      }
      case 'for-each': {
        const input = primaryInput(ctx.delivered);
        if (!Array.isArray(input)) return { kind: 'fail', error: 'for-each needs an array input' };
        return runIteration(ctx, ['each', 'done'], input);
      }
      case 'parallel': {
        const branches = clampInt(ctx.node.config.branchCount, 1, 8, 2);
        const input = primaryInput(ctx.delivered);
        const ports = Array.from({ length: branches }, (_, i) => `branch-${i + 1}`);
        for (const port of ports) {
          const session = ctx.capture(ctx.node, [port]);
          session.reset();
          ctx.deliver(ctx.node.id, port, input);
          const out = await ctx.drainCapture();
          if (!out.ok) return { kind: 'fail', error: `${ctx.node.type} branch failed: ${out.error}`, irreversibleEffect: out.irreversibleEffect };
        }
        return { kind: 'fire', port: 'all', value: input };
      }
      case 'retry':
        return runRetryNode(ctx);
      case 'timeout':
        return runTimeoutNode(ctx);

      case 'notification': {
        const message = evalLax(typeof ctx.node.config.message === 'string' ? ctx.node.config.message : '', ctx.scope);
        ctx.notify(message);
        ctx.nodeRun.outputs = { message };
        return { kind: 'done' };
      }
      case 'log': {
        const text = evalLax(typeof ctx.node.config.message === 'string' ? ctx.node.config.message : '', ctx.scope);
        if (text) ctx.log('info', text);
        ctx.nodeRun.outputs = { message: text };
        return { kind: 'fire', port: 'out', value: primaryInput(ctx.delivered) };
      }
      case 'result': {
        const value = primaryInput(ctx.delivered);
        ctx.recordResult(value);
        ctx.nodeRun.outputs = redactRecord({ value });
        return { kind: 'done' };
      }
      case 'approval':
        return runApprovalGate(ctx);
      case 'export':
        return runExport(ctx);
    }
  };
  return withTimeout(ctx, () => withRetry(ctx, inner));
}