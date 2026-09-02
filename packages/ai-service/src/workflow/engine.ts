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
 *
 * ── What this engine does NOT do ───────────────────────────────────
 * It orchestrates. It does not govern. A node classified `governed` in
 * `governed.ts` is never executed here — it is handed to the injected
 * `NodeGovernor`, which routes it through the Capability Fabric, and the
 * engine only interprets the outcome. There is no fallback path: with no
 * governor attached a governed node REFUSES rather than performing a
 * direct effect, because a bypass that exists "only in tests" is a bypass.
 *
 * ── Durability ─────────────────────────────────────────────────────
 * When a `WorkflowRun` and its store are supplied, the run is checkpointed
 * after every node resolves. The record on disk is always the furthest
 * point reached, which is what makes crash recovery and resume possible
 * without an event store. Passing neither keeps the original in-memory
 * behaviour exactly, so existing callers are unaffected.
 */

import type { PipelineManager } from '../pipeline';
import type { AgentNodeRunner } from './agent/runner';
import type { AgentBeat, AgentTrace } from './agent/types';
import { NODE_CLASS } from './governed';
import { provenanceOf, weakest, type Provenance } from './provenance';
import type { NodeGovernor } from './governor';
import { NODE_SPECS, interpolate, type RunCtx } from './nodes';
import { appendLog, attachEvidence, emptyNodeRecord, runStateFor, transitionNode, type WorkflowRunStore } from './run/store';
import { MAX_CHECKPOINT_TEXT, type NodeState, type RunState, type WorkflowRun } from './run/types';
import type { NodeIO, NodeRunState, RunEvent, WfEdge, WfNode, Workflow } from './types';

const MAX_LOOP_ITERATIONS = 20;
const MAX_NODE_EXECUTIONS = 400; // hard safety valve
/** Default wall clock for a whole run. Bounded so nothing runs forever. */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/**
 * How often a mid-flight agent ledger is written to disk.
 *
 * A compromise, stated rather than tuned silently: often enough that a
 * reconnecting client sees recent thinking, rarely enough that watching an
 * agent does not dominate the cost of running one.
 */
const BEAT_CHECKPOINT_MS = 1000;

export interface RunOptions {
  projectId: string;
  projectPath: string;
  projectName: string;
  pipeline: PipelineManager;
  /** Values for user-input nodes, keyed by node id. */
  inputs?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * The durable record for this execution. Supplying it (with `runs`)
   * turns on checkpointing, resume and the explicit state vocabulary.
   */
  run?: WorkflowRun;
  runs?: WorkflowRunStore;
  /** The one door to the Capability Fabric. Required for governed nodes. */
  governor?: NodeGovernor;
  /** The one door to the agent runtime. Required for agent nodes. */
  agents?: AgentNodeRunner;
  /**
   * Agent ledgers to continue from, keyed by node id.
   *
   * Populated by `resumeRun()` from the parked run's checkpoint. An agent
   * node with an entry here picks up its transcript, its iteration count
   * and its remaining wall clock rather than starting over — see
   * `agent/loop.ts`, where refusing to restart the budget is the point.
   */
  agentResume?: Record<string, AgentTrace>;
  /** Whole-run wall clock. */
  timeoutMs?: number;
  /**
   * Resume: node ids whose recorded output should be replayed instead of
   * re-executed. Only ever populated from a checkpoint by `resumeRun()`.
   */
  replay?: Record<string, NodeIO & { port?: string }>;
}

export interface RunResult {
  status: 'completed' | 'failed';
  /** The unflattened truth. `status` above stays two-valued for consumers. */
  runState: RunState;
  ms: number;
  outputs: { nodeId: string; title: string; text: string }[];
  nodes: Record<string, { status: NodeRunState; ms: number }>;
  error?: string;
  /** Set when the run parked on a human decision. */
  awaiting?: { nodeId: string; requestId?: string; capabilityId?: string };
}

interface Delivery {
  io: NodeIO | null; // null = skipped upstream
}

/** Durable state → live event vocabulary. Never collapses a distinction. */
const EVENT_STATE: Record<NodeState, NodeRunState> = {
  queued: 'queued',
  running: 'running',
  'awaiting-approval': 'awaiting-approval',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'denied',
  skipped: 'skipped',
  cancelled: 'cancelled',
  'timed-out': 'timed-out',
};

export async function runWorkflow(wf: Workflow, opts: RunOptions, emit: (e: RunEvent) => void): Promise<RunResult> {
  const t0 = Date.now();
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const deadline = t0 + timeoutMs;
  const record = opts.run ?? null;
  const store = opts.runs ?? null;
  const redact = opts.governor?.redact ?? ((t: string) => t);

  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, WfEdge[]>();
  const inEdges = new Map<string, WfEdge[]>();
  for (const e of wf.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }

  const states = new Map<string, NodeState>();
  const timings = new Map<string, number>();
  const received = new Map<string, Map<string, Delivery>>(); // nodeId → edgeId → delivery
  const outputs: RunResult['outputs'] = [];
  let executions = 0;
  let failure: { nodeId: string; message: string; state: NodeState } | null = null;
  let parked: RunResult['awaiting'] | null = null;

  const ctx: RunCtx = {
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    projectName: opts.projectName,
    pipeline: opts.pipeline,
    vars: record?.vars ?? {},
    runInputs: opts.inputs ?? {},
    log: (level, text) => log(currentNode, level, text),
    signal: opts.signal,
  };
  let currentNode: string | null = null;

  function log(nodeId: string | null, level: 'info' | 'warn' | 'error', text: string): void {
    const safe = redact(text);
    emit({ type: 'log', nodeId, level, text: safe, at: new Date().toISOString() });
    if (record) appendLog(record, nodeId, level, safe);
  }

  /** The single place a node's state changes, on the record and the wire. */
  const setState = (
    id: string,
    state: NodeState,
    extra: { ms?: number; summary?: string; error?: string; eventStatus?: NodeRunState } = {},
  ) => {
    states.set(id, state);
    if (extra.ms !== undefined) timings.set(id, extra.ms);
    if (record) {
      const node = record.nodes[id] ?? (record.nodes[id] = emptyNodeRecord(id, nodes.get(id)?.type ?? 'unknown'));
      // Never assigns `node.state` directly — `transitionNode` is what
      // makes the history complete, and a direct assignment here would be
      // a transition that silently did not happen.
      transitionNode(node, state, extra.error ? redact(extra.error) : extra.summary ? redact(extra.summary) : undefined);
      if (extra.ms !== undefined) node.ms = extra.ms;
      if (extra.summary !== undefined) node.summary = redact(extra.summary);
      if (extra.error !== undefined) node.error = redact(extra.error);
      if (state === 'running') node.startedAt = new Date().toISOString();
      if (state !== 'queued' && state !== 'running') node.finishedAt = new Date().toISOString();
    }
    emit({
      type: 'node',
      nodeId: id,
      status: extra.eventStatus ?? EVENT_STATE[state],
      ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
      ...(extra.summary !== undefined ? { summary: redact(extra.summary) } : {}),
      ...(extra.error !== undefined ? { error: redact(extra.error) } : {}),
    });
  };

  const checkpoint = () => {
    if (!record || !store) return;
    record.vars = { ...ctx.vars };
    record.ms = Date.now() - t0;
    store.checkpoint(record);
  };

  emit({ type: 'start', workflowId: wf.id, at: new Date().toISOString(), runId: record?.id, versionId: record?.versionId });
  if (record) {
    record.state = 'running';
    record.startedAt = new Date().toISOString();
    for (const n of wf.nodes) record.nodes[n.id] ??= emptyNodeRecord(n.id, n.type);
  }
  for (const n of wf.nodes) setState(n.id, 'queued');
  checkpoint();

  /** Merge all delivered inputs for a node into one NodeIO. */
  const mergeInputs = (id: string): NodeIO => {
    const dels = [...(received.get(id)?.values() ?? [])].filter((d): d is { io: NodeIO } => d.io !== null);
    if (!dels.length) return { text: '' };
    if (dels.length === 1) return dels[0].io;
    return {
      text: dels.map((d) => d.io.text).filter(Boolean).join('\n\n'),
      files: dels.flatMap((d) => d.io.files ?? []),
      data: dels[dels.length - 1].io.data,
      // Merging trusted and untrusted text produces untrusted text. Taking
      // the strongest here would let one authored edge launder everything
      // arriving beside it.
      provenance: weakest(dels.map((d) => d.io.provenance ?? 'external')),
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

  /**
   * Fan a node's result out along its ports, stamped with what it is worth.
   *
   * Computed here rather than inside each node so a node cannot claim a
   * trust level for its own output — the rule is the node TYPE's ceiling
   * capped by what actually reached it, and nothing a node returns can
   * raise either.
   */
  const fanOut = (id: string, io: NodeIO, port: string) => {
    for (const e of outEdges.get(id) ?? []) deliver(e, e.fromPort === port ? io : null);
  };

  /**
   * Stamp a node's result with what it is worth.
   *
   * Applied ONCE, before the value is either recorded or delivered, so the
   * run record and the downstream edge can never disagree about a value's
   * trust. Computing it inside `fanOut` had exactly that bug: the record
   * was written from the unstamped object and every persisted output said
   * `undefined`.
   */
  const stamp = (id: string, io: NodeIO): NodeIO => {
    const node = nodes.get(id);
    if (!node) return { ...io, provenance: 'external' };
    const inbound = [...(received.get(id)?.values() ?? [])]
      .filter((d): d is { io: NodeIO } => d.io !== null)
      .map((d) => d.io.provenance ?? 'external');
    const provenance: Provenance = provenanceOf(node.type, inbound, record?.trigger ?? { kind: 'manual', by: 'unknown' });
    return { ...io, provenance };
  };

  /**
   * Persist what a node received.
   *
   * Redacted and bounded like every other recorded text. `fromNodeIds` is
   * carried because a merged input is the case where "look at the upstream
   * node's output" stops being a usable answer.
   */
  const rememberInput = (id: string, io: NodeIO) => {
    if (!record) return;
    const node = record.nodes[id];
    if (!node) return;
    const text = io.text ?? '';
    const truncated = text.length > MAX_CHECKPOINT_TEXT;
    node.input = {
      text: redact(truncated ? text.slice(0, MAX_CHECKPOINT_TEXT) : text),
      files: io.files,
      ...(truncated ? { truncated: true } : {}),
      fromNodeIds: (inEdges.get(id) ?? []).map((e) => e.from),
      provenance: io.provenance,
    };
  };

  /** Persist a node's output so a resumed run can replay it, not repeat it. */
  const rememberOutput = (id: string, io: NodeIO, port: string) => {
    if (!record) return;
    const node = record.nodes[id];
    if (!node) return;
    const text = io.text ?? '';
    const truncated = text.length > MAX_CHECKPOINT_TEXT;
    node.output = {
      text: redact(truncated ? text.slice(0, MAX_CHECKPOINT_TEXT) : text),
      files: io.files,
      port,
      ...(truncated ? { truncated: true } : {}),
      provenance: io.provenance,
    };
  };

  /** Execute one node (loop handled by the caller). */
  const execNode = async (node: WfNode, input: NodeIO): Promise<void> => {
    const spec = NODE_SPECS[node.type];
    if (!spec || spec.disabled) {
      setState(node.id, 'skipped', { summary: spec ? 'disabled' : 'unknown node type' });
      skipDownstream(node.id);
      return;
    }

    /* Replay — a resumed run must not repeat an effect that already
       happened. The recorded output is delivered downstream and the node
       is left in its recorded terminal state. */
    const replayed = opts.replay?.[node.id];
    if (replayed) {
      setState(node.id, 'succeeded', { ms: timings.get(node.id) ?? 0, summary: 'replayed from checkpoint' });
      log(node.id, 'info', 'replayed from checkpoint — not re-executed');
      fanOut(node.id, stamp(node.id, { text: replayed.text, data: replayed.data, files: replayed.files }), replayed.port ?? 'out');
      return;
    }

    executions++;
    if (executions > MAX_NODE_EXECUTIONS) throw new Error('execution limit reached');
    currentNode = node.id;
    // `delay` reports `waiting` on the wire (the UI already animates that
    // state) while the durable record says `running` — the two vocabularies
    // stay honest about the same fact.
    setState(node.id, 'running', node.type === 'delay' ? { eventStatus: 'waiting' } : {});
    const t = Date.now();
    if (record) record.nodes[node.id].attempts += 1;

    try {
      if (NODE_CLASS[node.type] === 'governed') {
        if (!opts.governor) {
          // No fallback. A governed node with no governed path does not run.
          throw new Error(`"${spec.label}" performs a real effect and must run through the Capability Fabric, which is not attached to this run.`);
        }
        const outcome = await opts.governor.run(node, ctx, input, (t2) => interpolate(t2, ctx, input));
        const ms = Date.now() - t;
        if (outcome.evidence && record) attachEvidence(record, node.id, outcome.evidence);

        if (outcome.kind === 'awaiting-approval') {
          setState(node.id, 'awaiting-approval', { ms, summary: outcome.summary });
          if (record && outcome.approval) record.nodes[node.id].approval = outcome.approval;
          log(node.id, 'info', `parked — ${outcome.summary}`);
          parked = { nodeId: node.id, requestId: outcome.approval?.requestId, capabilityId: outcome.approval?.capabilityId };
          failure = { nodeId: node.id, message: 'waiting on your authorization', state: 'awaiting-approval' };
          return;
        }
        if (outcome.kind === 'denied' || outcome.kind === 'failed') {
          const state: NodeState = outcome.kind === 'denied' ? 'denied' : 'failed';
          setState(node.id, state, { ms, error: outcome.error, summary: outcome.summary });
          log(node.id, 'error', outcome.error ?? outcome.summary);
          failure = { nodeId: node.id, message: outcome.error ?? outcome.summary, state };
          return;
        }
        setState(node.id, 'succeeded', { ms, summary: outcome.summary });
        log(node.id, 'info', `completed in ${ms}ms — ${outcome.summary}`);
        const io = stamp(node.id, { text: outcome.text, data: outcome.data, files: outcome.files });
        rememberOutput(node.id, io, 'out');
        fanOut(node.id, io, 'out');
        return;
      }

      if (node.type === 'agent') {
        const liveBeats: AgentBeat[] = [];
        let lastBeatCheckpoint = 0;
        if (!opts.agents) {
          // Same rule as a governed node: no runtime, no run. An agent
          // node that silently did nothing would be worse than one that
          // refuses, because a workflow would carry on as if it had thought.
          throw new Error(`"${spec.label}" reasons and calls tools through the Capability Fabric, which is not attached to this run.`);
        }
        const outcome = await opts.agents.run(node, ctx, input, {
          resumeFrom: opts.agentResume?.[node.id],
          interpolate: (t2) => interpolate(t2, ctx, input),
          // Live, through the ONE event stream the engine already owns.
          // No second channel, no second format.
          onBeat: (beat) => {
            emit({ type: 'agent', nodeId: node.id, runId: record?.id, beat });
            /* Reconnect story, and the reason there is no replay buffer.
             *
             * A client that drops mid-agent catches up by re-reading the
             * run record, so the partial ledger has to BE there while the
             * agent is still thinking — otherwise a reconnect sees nothing
             * until the node ends, which is the gap this milestone exists
             * to close, merely moved somewhere less obvious.
             *
             * Throttled, because a file write per beat would make watching
             * an agent more expensive than running it. A beat lost to the
             * throttle is never lost outright: the authoritative write
             * happens when the node resolves. */
            if (!record) return;
            liveBeats.push(beat);
            const rec = record.nodes[node.id];
            if (rec) rec.agentTrace = { ...(rec.agentTrace as object ?? {}), beats: [...liveBeats], partial: true };
            const now = Date.now();
            if (now - lastBeatCheckpoint < BEAT_CHECKPOINT_MS) return;
            lastBeatCheckpoint = now;
            checkpoint();
          },
        });
        const ms = Date.now() - t;
        // Every tool call the agent made is attached to THIS node, so the
        // run's evidence list reconstructs the whole execution.
        if (record) {
          for (const ev of outcome.evidence) attachEvidence(record, node.id, ev);
          // Provenance travels onto the ledger so a trace can say the
          // agent was handed quarantined material, not merely that it
          // produced an odd answer.
          // The authoritative write. `partial` is cleared, so a reader can
          // tell a finished ledger from a snapshot of one in progress.
          record.nodes[node.id].agentTrace = {
            ...outcome.trace,
            inputProvenance: outcome.inputProvenance,
            taskWasQuarantined: outcome.taskWasQuarantined,
            partial: false,
          };
        }

        if (outcome.parked) {
          setState(node.id, 'awaiting-approval', { ms, summary: outcome.summary });
          if (record && outcome.approval) record.nodes[node.id].approval = outcome.approval;
          log(node.id, 'info', `agent parked — ${outcome.summary}`);
          parked = { nodeId: node.id, requestId: outcome.approval?.requestId, capabilityId: outcome.approval?.capabilityId };
          failure = { nodeId: node.id, message: 'the agent is waiting on your authorization', state: 'awaiting-approval' };
          return;
        }

        if (outcome.port === 'done') {
          setState(node.id, 'succeeded', { ms, summary: outcome.summary });
          log(node.id, 'info', `agent completed in ${ms}ms — ${outcome.summary}`);
          const io = stamp(node.id, { text: outcome.text });
          rememberOutput(node.id, io, 'done');
          fanOut(node.id, io, 'done');
          return;
        }

        /* An agent that stopped short leaves by its port when the author
           wired one, and fails the run when they did not. Routing a
           failure into a branch nobody built would swallow it. */
        const wired = (outEdges.get(node.id) ?? []).some((e) => e.fromPort === outcome.port);
        const state: NodeState = outcome.stopReason === 'denied' ? 'denied'
          : outcome.stopReason === 'cancelled' ? 'cancelled'
            : outcome.stopReason === 'timeout' ? 'timed-out' : 'failed';
        if (wired) {
          // Recorded as what it was, then routed. The node still says
          // `denied` or `timed-out`; the workflow simply has a plan for it.
          setState(node.id, state, { ms, summary: outcome.summary, error: outcome.error });
          log(node.id, 'warn', `agent stopped (${outcome.stopReason}) — routed via "${outcome.port}"`);
          const io = stamp(node.id, { text: outcome.text });
          rememberOutput(node.id, io, outcome.port!);
          fanOut(node.id, io, outcome.port!);
          return;
        }
        setState(node.id, state, { ms, summary: outcome.summary, error: outcome.error });
        log(node.id, 'error', outcome.error ?? outcome.summary);
        failure = { nodeId: node.id, message: outcome.error ?? outcome.summary, state };
        return;
      }

      const result = await spec.run(ctx, input, { ...node.config, __nodeId: node.id });
      const ms = Date.now() - t;
      setState(node.id, 'succeeded', { ms, summary: result.summary });
      log(node.id, 'info', `completed in ${ms}ms${result.summary ? ` — ${result.summary}` : ''}`);
      if (node.type === 'output') {
        const title = String(node.config.title ?? '') || 'Result';
        const text = redact(result.text);
        outputs.push({ nodeId: node.id, title, text });
        if (record) record.outputs.push({ nodeId: node.id, title, text });
        emit({ type: 'output', nodeId: node.id, title, text });
      }
      const port = result.port ?? 'out';
      const io = stamp(node.id, { text: result.text, data: result.data, files: result.files });
      rememberOutput(node.id, io, port);
      fanOut(node.id, io, port);
    } catch (err) {
      const ms = Date.now() - t;
      const message = redact((err as Error).message);
      const aborted = opts.signal?.aborted === true;
      const state: NodeState = aborted ? 'cancelled' : Date.now() > deadline ? 'timed-out' : 'failed';
      setState(node.id, state, { ms, error: message });
      log(node.id, 'error', message);
      failure = { nodeId: node.id, message, state };
    } finally {
      currentNode = null;
      checkpoint();
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

    log(node.id, 'info', `loop: ${items.length} iteration${items.length === 1 ? '' : 's'} over ${subtree.size} node${subtree.size === 1 ? '' : 's'}`);
    for (let i = 0; i < items.length && !failure && !opts.signal?.aborted; i++) {
      // Reset the subtree for this iteration.
      for (const id of subtree) {
        states.set(id, 'queued');
        received.get(id)?.clear();
        if (record?.nodes[id]) record.nodes[id].iteration = i;
      }
      for (const e of eachEdges) deliver(e, items[i]);
      await drain(subtree);
    }
    const ms = Date.now() - t;
    if (!failure) {
      setState(node.id, 'succeeded', { ms, summary: `${items.length} iterations` });
      const loopIo = stamp(node.id, input);
      for (const e of outEdges.get(node.id) ?? []) if (e.fromPort === 'done') deliver(e, loopIo);
      for (const e of outEdges.get(node.id) ?? []) if (e.fromPort !== 'done' && e.fromPort !== 'each') deliver(e, null);
    } else {
      // The loop reports the same kind of stop its body hit, so a loop
      // parked on an approval is not reported as a failed loop.
      setState(node.id, failure.state === 'awaiting-approval' ? 'awaiting-approval' : 'failed', {
        ms,
        error: failure.state === 'awaiting-approval' ? undefined : 'a loop iteration failed',
      });
    }
    checkpoint();
  };

  /** Process the queue until empty (optionally restricted to a node set). */
  const drain = async (restrict?: Set<string>): Promise<void> => {
    while (queue.length && !failure) {
      if (opts.signal?.aborted) { failure = { nodeId: '', message: 'run cancelled', state: 'cancelled' }; break; }
      if (Date.now() > deadline) { failure = { nodeId: '', message: `run exceeded its ${Math.round(timeoutMs / 1000)}s budget`, state: 'timed-out' }; break; }
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
      rememberInput(id, input);
      if (node.type === 'loop') await execLoop(node, input);
      else await execNode(node, input);
    }
  };

  // Entry nodes: no incoming edges.
  for (const n of wf.nodes) if (!(inEdges.get(n.id)?.length) && states.get(n.id) === 'queued') queue.push(n.id);
  await drain();

  // Anything still queued was unreachable (cycle without a loop node, or
  // dangling) — unless the run stopped early, in which case those nodes
  // never got their chance and saying "unreachable" would be a lie.
  const stoppedEarly = Boolean(failure);
  for (const [id, st] of states) {
    if (st !== 'queued') continue;
    if (stoppedEarly) setState(id, 'queued');
    else setState(id, 'skipped', { summary: 'unreachable' });
  }

  const ms = Date.now() - t0;
  const f = failure as { nodeId: string; message: string; state: NodeState } | null;
  const runState: RunState = f ? (runStateFor(f.state) ?? 'failed') : 'succeeded';
  const status: RunResult['status'] = runState === 'succeeded' ? 'completed' : 'failed';

  if (record) {
    record.state = runState;
    record.ms = ms;
    record.finishedAt = new Date().toISOString();
    record.error = f ? redact(f.message) : undefined;
    // A run is resumable when it stopped somewhere a human can act on and
    // at least one node banked a result. Anything else is honest about not
    // being resumable rather than offering a button that cannot work.
    const completed = Object.values(record.nodes).filter((n) => n.state === 'succeeded').length;
    if (runState === 'awaiting-approval') {
      record.resumable = true;
    } else if (runState === 'succeeded') {
      record.resumable = false;
      record.notResumableReason = undefined;
    } else if (completed > 0) {
      record.resumable = true;
    } else {
      record.resumable = false;
      record.notResumableReason = 'No node completed, so there is no checkpoint to resume from.';
    }
    checkpoint();
  }

  emit({ type: 'done', status, ms, error: f ? redact(f.message) : undefined, runState, runId: record?.id });
  return {
    status,
    runState,
    ms,
    outputs,
    nodes: Object.fromEntries([...states].map(([id, st]) => [id, { status: EVENT_STATE[st], ms: timings.get(id) ?? 0 }])),
    error: f ? redact(f.message) : undefined,
    awaiting: parked ?? undefined,
  };
}
