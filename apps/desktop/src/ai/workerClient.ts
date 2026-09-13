/**
 * workerClient — the renderer's window onto AURA's real AI workers.
 * ==================================================================
 *
 * A WORKER is another AI runtime that AURA delegates bounded work to
 * (OpenCode, Claude Code, Kilo, Codex, Gemini, Qwen). A TOOL is a
 * capability the Fabric drives itself (git, the GitHub CLI, the
 * filesystem). They are shown separately because they are connected on
 * completely different evidence, and blurring them is what made the word
 * "connected" mean nothing.
 *
 * Rules this client keeps:
 *   • The backend decides `connected`. Nothing here infers it from a
 *     probe, a version string, or a click. `connected: true` means the
 *     backend PROVED a real dispatch/response round-trip.
 *   • Every field below is the backend's vocabulary, verbatim.
 *   • A transport failure resolves to an honest "could not read", never
 *     to an empty list that would read as "no workers".
 */

import { ENVIRONMENT_BASE } from '../environment/environmentClient';

/** Why a worker is not connected. Backend vocabulary, never invented here. */
export type WorkerReason =
  | 'NOT_INSTALLED'
  | 'RUNTIME_UNAVAILABLE'
  | 'ADAPTER_UNKNOWN'
  | 'INVOCATION_FAILED'
  | 'NO_RESPONSE'
  | 'RESPONSE_UNCORRELATED'
  | 'TIMEOUT'
  | 'GOVERNANCE_UNSUPPORTED'
  | '';

/**
 * How much of a worker's behaviour AURA can actually govern in real time.
 * `UNSUPPORTED` is a statement about the runtime, not about the worker's
 * usefulness; `NOT_CONNECTED` means the question does not arise yet.
 */
export type WorkerGovernance =
  | 'FULLY_GOVERNED'
  | 'CONNECTED_FOR_BASIC_WORK'
  | 'UNSUPPORTED'
  | 'NOT_CONNECTED';

export type WorkerLifecycle =
  | 'DISCOVERED' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'IDLE'
  | 'ACTIVE' | 'WAITING' | 'PARKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  | 'TERMINATED' | 'UNSUPPORTED';

export interface WorkerReadinessProof {
  proved: boolean;
  reason: string;
  detail: string;
  probeId: string;
  at: string;
  stages: string[];
  exitCode: number | null;
  governance: string;
  actionsObserved: number;
  allowedActions: number;
}

export interface WorkerDescriptor {
  id: string;
  name: string;
  binary: string;
  kind: 'worker';
  runtime: string;
  installed: boolean;
  version: string;
  installDetail: string;
  /** AURA has a verified way to drive this runtime non-interactively. */
  invocable: boolean;
  connected: boolean;
  lifecycle: WorkerLifecycle;
  reason: WorkerReason;
  detail: string;
  governance: WorkerGovernance;
  governanceSupports: Record<string, string>;
  capabilities: string[];
  roles: string[];
  proof: WorkerReadinessProof | null;
  notes: string;
}

export interface WorkerListResult {
  workers: WorkerDescriptor[];
  connected: number;
  total: number;
  /** Set when the backend could not be read. Never a silent empty list. */
  error?: string;
}

export interface WorkerConnectResult {
  connected: boolean;
  worker: WorkerDescriptor | null;
  proof: WorkerReadinessProof | null;
  detail: string;
  error?: string;
}

async function list(): Promise<WorkerListResult> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/workers`);
    if (!res.ok) {
      return { workers: [], connected: 0, total: 0, error: `request failed (${res.status})` };
    }
    return (await res.json()) as WorkerListResult;
  } catch (e) {
    return {
      workers: [], connected: 0, total: 0,
      error: e instanceof Error ? e.message : 'the AURA service could not be reached',
    };
  }
}

/**
 * Ask the backend to PROVE it can drive this worker. This runs a real
 * bounded round-trip against the real runtime, so it takes as long as
 * that runtime takes — there is no fast path, because a fast path would
 * be a guess.
 */
async function connect(id: string): Promise<WorkerConnectResult> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/workers/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json()) as WorkerConnectResult & { error?: string };
    if (!res.ok) {
      return {
        connected: false, worker: null, proof: null, detail: '',
        error: body.error ?? `request failed (${res.status})`,
      };
    }
    return body;
  } catch (e) {
    return {
      connected: false, worker: null, proof: null, detail: '',
      error: e instanceof Error ? e.message : 'the AURA service could not be reached',
    };
  }
}

async function disconnect(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/workers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) return { ok: false, error: `request failed (${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unreachable' };
  }
}

export const workerClient = { list, connect, disconnect };
