/**
 * Workflow Runtime — host boundary (§Phase 5: Runtime + Governance).
 * ==================================================================
 * The runtime owns orchestration only. Everything that touches the
 * outside world arrives through this interface:
 *
 *   - `fabric`  — the ONE governed path for capability / mission / agent
 *     / export nodes. The runtime never spawns a process, never opens a
 *     socket and never touches git: it calls `fabric.invoke(...)` and
 *     the Fabric does resolve → policy → approval → execute → verify →
 *     audit.
 *   - `ai`      — read-only provider seam for AI nodes (ask-aura,
 *     generate, classify, ...). There is deliberately no manifest
 *     capability for generation: a pure model call has no permission
 *     scope, so it is not a governed side effect. The seam is where the
 *     host plugs the existing provider pipeline.
 *   - `missions`— the mission authority. `wait`/`update` have no manifest
 *     capability yet (see the migration map); the host implements them
 *     against Mission Control v3.
 *   - `notify`  — optional UI surface for notification nodes.
 *   - `askApproval` — the gate behind an `approval` node. The host owns
 *     the UI; a host with no UI should resolve false (park) rather than
 *     block — an unanswered gate is a denial, never a bypass.
 *   - `sleep`   — injectable so tests can fake time; defaults to
 *     setTimeout. The runtime never creates processes, so "no new
 *     process manager" holds by construction.
 */

import type { CapabilityFabric, InvocationActor } from '@aura/capability-fabric';
import type { TriggerType, WorkflowNodeRunStatus, WorkflowRunStatus } from '../types';

/** One model call through the existing provider seam. */
export interface AiSeamRequest {
  nodeType: string;
  prompt: string;
  input?: unknown;
  model?: string;
  temperature?: number;
  format?: string;
  providerId?: string;
  timeoutMs?: number;
}

export type AiSeamResult = { ok: true; output: unknown } | { ok: false; error: string };

export interface AiSeam {
  generate(request: AiSeamRequest): Promise<AiSeamResult>;
}

/** Mission Control v3 — the mission authority. */
export interface MissionSeam {
  /** Resolves when the mission reaches `until`, bounded by timeoutMs. */
  wait(missionId: string, until: string, timeoutMs: number): Promise<{ ok: boolean; state?: string; error?: string }>;
  update(missionId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

/** The human gate behind an `approval` node. */
export interface RuntimeApprovalRequest {
  runId: string;
  nodeId: string;
  summary: string;
  detail?: string;
}

export interface RuntimeHost {
  /** The one governed path to a side effect. */
  fabric: CapabilityFabric;
  /** Read-only provider seam for AI nodes. */
  ai: AiSeam;
  /** Mission authority (required only by mission nodes). */
  missions?: MissionSeam;
  /** UI surface for notification nodes; absent = no-op. */
  notify?(event: { runId: string; nodeId: string; message: string }): void;
  /** Absolute path of a project, for the Fabric invocation context. */
  projectPath?(projectId: string): string | undefined;
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleep?(ms: number): Promise<void>;
  /** Ask the human behind an approval node. Default: park (false). */
  askApproval?(request: RuntimeApprovalRequest): Promise<boolean>;
}

/** What started a run. Phase 5 ships `manual`; future trigger systems
 *  (schedule, git-event, file-change, mission-event, agent-event,
 *  environment-event) plug into the runtime through the same interface
 *  rather than duplicating execution logic. */
export interface TriggerInvocation {
  type: TriggerType;
  payload?: unknown;
  at?: string;
}

export interface RunOptions {
  /** Defaults to `{ type: 'manual' }`. */
  trigger?: TriggerInvocation;
  /** Who acts. Defaults to an agent id derived from the run. */
  actor?: InvocationActor;
  /** Overrides the definition's project binding. */
  projectId?: string | null;
  /** Run inputs; the fired trigger node exposes them as its payload. */
  inputs?: Record<string, unknown>;
  /** Capability ids the human has explicitly authorized for THIS run. */
  approvedCapabilities?: string[];
  reason?: string;
}

export type RuntimeEvent =
  | { type: 'run-started'; runId: string; at: string }
  | { type: 'run-settled'; runId: string; status: WorkflowRunStatus; at: string }
  | { type: 'node-settled'; runId: string; nodeId: string; status: WorkflowNodeRunStatus; at: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;