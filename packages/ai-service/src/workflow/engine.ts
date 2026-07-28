/**
 * Workflow engine — sequential, observable, node-by-node execution.
 * ==================================================================
 * Executes a workflow graph against the REAL mounted project. Nodes run
 * one at a time (a workflow is "a sequence of actions executed by the
 * environment"); every state change is emitted as a RunEvent so the UI
 * can show queued/running/waiting/completed/failed, per-node timing and
 * logs live over SSE.
 *
 * Branching: a Condition fires exactly one of its ports; everything only
 * reachable from the un-taken port is marked skipped. Loop runs its
 * "each" subtree once per item (bounded), then fires "done".
 * The run stops at the first failed node.
 */

import type { PipelineManager } from '../pipeline';
import { NODE_SPECS, type RunCtx } from './nodes';
import type { NodeIO, NodeRunState, RunEvent, WfEdge, WfNode, Workflow } from './types';

const MAX_LOOP_ITERATIONS = 20;
const MAX_NODE_EXECUTIONS = 400; // hard safety valve

export interface RunOptions {
  projectId: string;
  projectPath: string;
  projectName: string;
  pipeline: PipelineManager;
  /** Values for user-input nodes, keyed by node id. */
  inputs?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RunResult {
  status: 'completed' | 'failed';
  ms: number;
  outputs: { nodeId: string; title: string; text: string }[];
  nodes: Record<string, { status: NodeRunState; ms: number }>;
  error?: string;
}

interface Delivery {
  io: NodeIO | null; // null = skipped upstream
}

export async function runWorkflow(wf: Workflow, opts: RunOptions, emit: (e: RunEvent) => void): Promise<RunResult> {
  const t0 = Date.now();
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, WfEdge[]>();
  const inEdges = new Map<string, WfEdge[]>();
  for (const e of wf.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }

  const states = new Map<string, NodeRunState>();
  const timings = new Map<string, number>();
  const received = new Map<string, Map<string, Delivery>>(); // nodeId → edgeId → delivery
  const outputs: RunResult['outputs'] = [];
  let executions = 0;
  let failure: { nodeId: string; message: string } | null = null;

  const ctx: RunCtx = {
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    projectName: opts.projectName,
    pipeline: opts.pipeline,
    vars: {},
    runInputs: opts.inputs ?? {},
    log: (level, text) => emit({ type: 'log', nodeId: currentNode, level, text, at: new Date().toISOString() }),
    signal: opts.signal,
  };
  let currentNode: string | null = null;

  const setState = (id: string, status: NodeRunState, extra: { ms?: number; summary?: string; error?: string } = {}) => {
    states.set(id, status);
    if (extra.ms !== undefined) timings.set(id, extra.ms);
    emit({ type: 'node', nodeId: id, status, ...extra });
  };

  emit({ type: 'start', workflowId: wf.id, at: new Date().toISOString() });
  for (const n of wf.nodes) setState(n.id, 'queued');

  /** Merge all delivered inputs for a node into one NodeIO. */
  const mergeInputs = (id: string): NodeIO => {
    const dels = [...(received.get(id)?.values() ?? [])].filter((d): d is { io: NodeIO } => d.io !== null);
    if (!dels.length) return { text: '' };
    if (dels.length === 1) return dels[0].io;
    return {
      text: dels.map((d) => d.io.text).filter(Boolean).join('\n\n'),
      files: dels.flatMap((d) => d.io.files ?? []),
      data: dels[dels.length - 1].io.data,
    };
  };

  const readyToRun = (id: string): boolean => {
    const ins = inEdges.get(id) ?? [];
    const got = received.get(id);
    return ins.every((e) => got?.has(e.id));
  };

  const allInputsSkipped = (id: string): boolean => {
    const ins = inEdges.get(id) ?? [];
    if (!ins.length) return false;
    const got = received.get(id);
    return ins.every((e) => got?.get(e.id)?.io === null);
  };

  /** Deliver a value (or a skip) along an edge; enqueue the target when complete. */
  const queue: string[] = [];
  const deliver = (edge: WfEdge, io: NodeIO | null) => {
    const map = received.get(edge.to) ?? received.set(edge.to, new Map()).get(edge.to)!;
    map.set(edge.id, { io });
    if (readyToRun(edge.to) && states.get(edge.to) === 'queued') queue.push(edge.to);
  };

  const skipDownstream = (id: string, port?: string) => {
    for (const e of outEdges.get(id) ?? []) {
      if (port !== undefined && e.fromPort !== port) continue;
      deliver(e, null);
    }
  };

  /** Execute one node (loop handled by the caller). */
  const execNode = async (node: WfNode, input: NodeIO): Promise<void> => {
    const spec = NODE_SPECS[node.type];
    if (!spec || spec.disabled) {
      setState(node.id, 'skipped', { summary: spec ? 'disabled' : 'unknown node type' });
      skipDownstream(node.id);
      return;
    }
    executions++;
    if (executions > MAX_NODE_EXECUTIONS) throw new Error('execution limit reached');
    currentNode = node.id;
    setState(node.id, node.type === 'delay' ? 'waiting' : 'running');
    const t = Date.now();
    try {
      const result = await spec.run(ctx, input, { ...node.config, __nodeId: node.id });
      const ms = Date.now() - t;
      setState(node.id, 'completed', { ms, summary: result.summary });
      emit({ type: 'log', nodeId: node.id, level: 'info', text: `completed in ${ms}ms${result.summary ? ` — ${result.summary}` : ''}`, at: new Date().toISOString() });
      if (node.type === 'output') {
        const title = String(node.config.title ?? '') || 'Result';
        outputs.push({ nodeId: node.id, title, text: result.text });
        emit({ type: 'output', nodeId: node.id, title, text: result.text });
      }
      const port = result.port ?? 'out';
      for (const e of outEdges.get(node.id) ?? []) deliver(e, e.fromPort === port ? { text: result.text, data: result.data, files: result.files } : null);
    } catch (err) {
      const ms = Date.now() - t;
      const message = (err as Error).message;
      setState(node.id, 'failed', { ms, error: message });
      emit({ type: 'log', nodeId: node.id, level: 'error', text: message, at: new Date().toISOString() });
      failure = { nodeId: node.id, message };
    } finally {
      currentNode = null;
    }
  };

  /** Run the loop node: its "each" subtree once per item, then "done". */
  const execLoop = async (node: WfNode, input: NodeIO): Promise<void> => {
    const mode = String(node.config.mode ?? 'repeat');
    const times = Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Number(node.config.times) || 3));
    const items: NodeIO[] =
      mode === 'for-each-line'
        ? input.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_LOOP_ITERATIONS).map((l) => ({ text: l }))
        : Array.from({ length: times }, () => input);
    setState(node.id, 'running');
    const t = Date.now();

    // The subtree reachable via 'each' edges.
    const eachEdges = (outEdges.get(node.id) ?? []).filter((e) => e.fromPort === 'each');
    const subtree = new Set<string>();
    const walk = (id: string) => {
      if (subtree.has(id)) return;
      subtree.add(id);
      for (const e of outEdges.get(id) ?? []) walk(e.to);
    };
    for (const e of eachEdges) walk(e.to);

    emit({ type: 'log', nodeId: node.id, level: 'info', text: `loop: ${items.length} iteration${items.length === 1 ? '' : 's'} over ${subtree.size} node${subtree.size === 1 ? '' : 's'}`, at: new Date().toISOString() });
    for (let i = 0; i < items.length && !failure && !opts.signal?.aborted; i++) {
      // Reset the subtree for this iteration.
      for (const id of subtree) { states.set(id, 'queued'); received.get(id)?.clear(); }
      for (const e of eachEdges) deliver(e, items[i]);
      await drain(subtree);
    }
    const ms = Date.now() - t;
    if (!failure) {
      setState(node.id, 'completed', { ms, summary: `${items.length} iterations` });
      for (const e of outEdges.get(node.id) ?? []) if (e.fromPort === 'done') deliver(e, input);
      for (const e of outEdges.get(node.id) ?? []) if (e.fromPort !== 'done' && e.fromPort !== 'each') deliver(e, null);
    } else {
      setState(node.id, 'failed', { ms, error: 'a loop iteration failed' });
    }
  };

  /** Process the queue until empty (optionally restricted to a node set). */
  const drain = async (restrict?: Set<string>): Promise<void> => {
    while (queue.length && !failure) {
      if (opts.signal?.aborted) { failure = { nodeId: '', message: 'run cancelled' }; break; }
      const id = queue.shift()!;
      if (restrict && !restrict.has(id)) continue;
      if (states.get(id) !== 'queued') continue;
      const node = nodes.get(id)!;
      if (allInputsSkipped(id)) {
        setState(id, 'skipped');
        skipDownstream(id);
        continue;
      }
      const input = mergeInputs(id);
      if (node.type === 'loop') await execLoop(node, input);
      else await execNode(node, input);
    }
  };

  // Entry nodes: no incoming edges.
  for (const n of wf.nodes) if (!(inEdges.get(n.id)?.length) && states.get(n.id) === 'queued') queue.push(n.id);
  await drain();

  // Anything still queued was unreachable (cycle without a loop node, or dangling).
  for (const [id, st] of states) if (st === 'queued') setState(id, 'skipped', { summary: 'unreachable' });

  const ms = Date.now() - t0;
  const f = failure as { nodeId: string; message: string } | null;
  const status: RunResult['status'] = f ? 'failed' : 'completed';
  emit({ type: 'done', status, ms, error: f?.message });
  return {
    status,
    ms,
    outputs,
    nodes: Object.fromEntries([...states].map(([id, st]) => [id, { status: st, ms: timings.get(id) ?? 0 }])),
    error: f?.message,
  };
}
