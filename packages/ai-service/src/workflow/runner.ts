/**
 * runner — the single entry point for executing a workflow.
 * ==================================================================
 * Everything that can start a workflow — the Run button, a webhook, the
 * Automation Engine, a mission task through `workflow.run` — comes through
 * here. That is the point: there is exactly one place that decides what a
 * run IS, so there is exactly one place that can get versioning, scoping,
 * checkpointing or governance wrong.
 *
 * One run, in order:
 *
 *   1. resolve the workflow and the project
 *   2. freeze the graph as an immutable VERSION (or reuse the identical one)
 *   3. compute the version's authority ENVELOPE
 *   4. register the run's least-privilege SCOPE from that envelope
 *   5. create the durable RUN record
 *   6. build the GOVERNOR — the one door to the Capability Fabric
 *   7. execute, checkpointing after every node
 *   8. release the scope, always
 *
 * Step 4 is the one that is easy to skip and must not be: without it a
 * workflow runs with the machine's full authority regardless of what its
 * graph actually contains, and the envelope becomes decoration.
 */

import type { CapabilityFabric } from '@aura/capability-fabric';
import type { PipelineManager } from '../pipeline';
import type { RunScopeRegistry } from '../fabric/scopes';
import { secrets as secretStore } from '../secrets';
import { computeEnvelope, type AuthorityEnvelope } from './envelope';
import { runWorkflow as executeGraph, type RunOptions, type RunResult } from './engine';
import { createGovernor } from './governor';
import { createAgentRunner } from './agent/runner';
import type { AgentTrace } from './agent/types';
import { WorkflowRunStore } from './run/store';
import type { RunTrigger, WorkflowRun } from './run/types';
import { WorkflowVersionStore, type WorkflowVersion } from './versions';
import type { NodeIO, RunEvent, Workflow } from './types';

export interface RunnerDeps {
  pipeline: PipelineManager;
  fabric: CapabilityFabric | null;
  runScopes: RunScopeRegistry;
  versions: WorkflowVersionStore;
  runs: WorkflowRunStore;
}

export interface StartRunInput {
  workflow: Workflow;
  projectId: string;
  projectPath: string;
  projectName: string;
  trigger: RunTrigger;
  inputs?: Record<string, string>;
  /** Capabilities the human authorized for this run, if any. */
  approvedCapabilities?: string[];
  actor?: { kind: 'human' | 'agent' | 'system'; id: string };
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Called with the durable record the moment it exists, before the first
   * node runs. The caller needs the run id to register a cancel handle,
   * and it cannot wait for `start()` to resolve to get it — by then the
   * run is over and cancelling it is meaningless.
   */
  onRunCreated?: (run: WorkflowRun) => void;
}

export interface StartedRun {
  run: WorkflowRun;
  version: WorkflowVersion;
  envelope: AuthorityEnvelope;
  result: RunResult;
}

const DEFAULT_ACTOR = { kind: 'human' as const, id: 'user' };

export class WorkflowRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /** What a workflow would be allowed to do, without running it. */
  envelopeOf(wf: Workflow): AuthorityEnvelope {
    return computeEnvelope(wf.nodes);
  }

  /**
   * Start a run.
   *
   * Returns once the run reaches a terminal state OR parks on an approval.
   * A parked run is not an error — `result.runState === 'awaiting-approval'`
   * and the record is durable and resumable.
   */
  async start(input: StartRunInput, emit: (e: RunEvent) => void): Promise<StartedRun> {
    const { workflow, projectId, projectPath } = input;
    const actor = input.actor ?? DEFAULT_ACTOR;

    const version = this.deps.versions.ensureVersionForRun(workflow, `run:${actor.id}`);
    const envelope = computeEnvelope(version.nodes);

    const run = this.deps.runs.create({
      workflowId: workflow.id,
      versionId: version.id,
      workflowName: version.name,
      projectId,
      projectPath,
      trigger: input.trigger,
      inputs: input.inputs,
    });
    input.onRunCreated?.(run);

    const result = await this.execute({ ...input, version, envelope, run, actor }, emit);
    return { run: this.deps.runs.get(workflow.id, run.id) ?? run, version, envelope, result };
  }

  /**
   * Pick up a parked or interrupted run where it stopped.
   *
   * Nodes that already succeeded are REPLAYED from their checkpointed
   * output rather than re-executed. That is the whole safety argument for
   * resume: a workflow that committed and pushed before parking must not
   * commit and push again when the human says yes.
   *
   * Refuses when the version is gone (nothing to execute) or when nothing
   * was checkpointed (nothing to resume from) — a resume that silently
   * restarted from the beginning would be the worst possible behaviour.
   */
  async resume(
    workflow: Workflow,
    runId: string,
    emit: (e: RunEvent) => void,
    opts: {
      approvedCapabilities?: string[];
      signal?: AbortSignal;
      actor?: StartRunInput['actor'];
      timeoutMs?: number;
      onRunCreated?: (run: WorkflowRun) => void;
    } = {},
  ): Promise<StartedRun | { error: string }> {
    const previous = this.deps.runs.get(workflow.id, runId);
    if (!previous) return { error: 'no such run' };
    if (previous.state === 'succeeded') return { error: 'that run already succeeded — there is nothing to resume' };
    if (!previous.resumable) return { error: previous.notResumableReason ?? 'that run cannot be resumed' };

    const version = this.deps.versions.get(workflow.id, previous.versionId);
    if (!version) {
      return { error: `the version this run executed (${previous.versionId}) no longer exists, so it cannot be resumed` };
    }

    /* Replay set: every node that banked a result. A node parked on an
       approval is deliberately NOT in it — that node is the one the human
       just answered, and it is what the resumed run exists to perform. */
    const replay: Record<string, NodeIO & { port?: string }> = {};
    const agentResume: Record<string, AgentTrace> = {};
    for (const node of Object.values(previous.nodes)) {
      if (node.state === 'succeeded' && node.output) {
        replay[node.nodeId] = { text: node.output.text, data: node.output.data, files: node.output.files, port: node.output.port };
        continue;
      }
      /* A PARKED agent is not replayed — it is continued. Its ledger
         carries the transcript, the iterations already spent and the wall
         clock already used, so the resumed agent keeps its reasoning and
         keeps its bounds. Replaying it would restart the budget; skipping
         it would lose the reasoning. */
      if (node.state === 'awaiting-approval' && node.agentTrace) {
        agentResume[node.nodeId] = node.agentTrace as AgentTrace;
      }
    }
    if (!Object.keys(replay).length && !Object.keys(agentResume).length && previous.state !== 'awaiting-approval') {
      return { error: 'no node completed in that run, so there is no checkpoint to resume from' };
    }

    const envelope = computeEnvelope(version.nodes);
    const run = this.deps.runs.create({
      workflowId: workflow.id,
      versionId: version.id,
      workflowName: version.name,
      projectId: previous.projectId,
      projectPath: previous.projectPath,
      trigger: { kind: 'resume', of: previous.id },
      inputs: previous.inputs,
    });
    run.vars = { ...previous.vars };
    opts.onRunCreated?.(run);

    const result = await this.execute({
      workflow: { ...workflow, nodes: version.nodes, edges: version.edges },
      projectId: previous.projectId,
      projectPath: previous.projectPath,
      projectName: workflow.name,
      trigger: run.trigger,
      inputs: previous.inputs,
      approvedCapabilities: opts.approvedCapabilities,
      actor: opts.actor ?? DEFAULT_ACTOR,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      version,
      envelope,
      run,
      replay,
      agentResume,
    }, emit);

    return { run: this.deps.runs.get(workflow.id, run.id) ?? run, version, envelope, result };
  }

  /** The shared execution body. Registers the scope; always releases it. */
  private async execute(
    input: StartRunInput & {
      version: WorkflowVersion;
      envelope: AuthorityEnvelope;
      run: WorkflowRun;
      actor: NonNullable<StartRunInput['actor']>;
      replay?: Record<string, NodeIO & { port?: string }>;
      agentResume?: Record<string, AgentTrace>;
    },
    emit: (e: RunEvent) => void,
  ): Promise<RunResult> {
    const { run, version, envelope, actor } = input;

    // Least privilege, derived from the graph that is actually executing.
    const scopes = envelope.scopes.map((s) => s.scope);
    this.deps.runScopes.register(run.id, scopes);

    const governor = this.deps.fabric
      ? createGovernor({
          fabric: this.deps.fabric,
          secrets: secretStore,
          workflowId: run.workflowId,
          runId: run.id,
          projectId: run.projectId,
          projectPath: run.projectPath,
          actor,
          approvedCapabilities: input.approvedCapabilities,
        })
      : undefined;

    /* The agent runtime, built from the SAME envelope the governor uses.
       That shared envelope is what makes "the agent's tools ≤ the
       workflow's permissions" structural rather than advisory: both doors
       into the Fabric are bounded by one authority, computed once from the
       version that is actually executing. */
    const agents = this.deps.fabric
      ? createAgentRunner({
          fabric: this.deps.fabric,
          pipeline: this.deps.pipeline,
          envelope,
          workflowId: run.workflowId,
          runId: run.id,
          projectId: run.projectId,
          projectPath: run.projectPath,
          redact: governor?.redact ?? ((t: string) => t),
          signal: input.signal,
        })
      : undefined;

    const options: RunOptions = {
      projectId: run.projectId,
      projectPath: run.projectPath,
      projectName: input.projectName,
      pipeline: this.deps.pipeline,
      inputs: run.inputs,
      signal: input.signal,
      run,
      runs: this.deps.runs,
      governor,
      agents,
      timeoutMs: input.timeoutMs,
      replay: input.replay,
      agentResume: input.agentResume,
    };

    try {
      return await executeGraph({ ...input.workflow, nodes: version.nodes, edges: version.edges }, options, emit);
    } finally {
      // A run's authority never outlives the run, on any exit path.
      this.deps.runScopes.release(run.id);
    }
  }
}
