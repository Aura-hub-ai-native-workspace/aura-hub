/**
 * Execution Node Fabric — node identity, detection, capability resolution.
 * ==================================================================
 * Mission Control v3 executes one mission through MULTIPLE real execution
 * nodes. This module is the single authority for:
 *
 *   • the canonical node registry (what nodes exist and what they can do)
 *   • REAL environment detection (is the backing tooling present?)
 *   • deterministic capability → node resolution (which node runs a task)
 *   • deny-only node policy (admission control — never weakens a floor)
 *
 * The distinction that matters (preserved everywhere below):
 *
 *   DETECTED ≠ CAPABLE ≠ AUTHORIZED ≠ RESOLVED ≠ EXECUTED ≠ RECORDED
 *
 * A requested node NEVER silently becomes another node. If a requested
 * node cannot execute, resolution returns an explicit error and the
 * engine surfaces it as a task failure — no fallback, no fake success.
 *
 * This module is pure decision logic: it performs no execution. Side
 * effects live in the executors (`taskGen.ts`, `gitExecutor.ts`), which
 * are injected by `workspace.ts` exactly as before.
 */
import { execFile } from 'node:child_process';
import type { TaskKind } from '../types';

export type ExecutionNodeId = 'aura-ai' | 'git' | 'opencode' | 'claude-code';

/** The closed set of real capabilities an execution node can provide. */
export type NodeCapability =
  | 'code-implementation'
  | 'code-review'
  | 'git-operations'
  | 'documentation'
  | 'research'
  | 'testing';

export interface ExecutionNodeSpec {
  id: ExecutionNodeId;
  label: string;
  kind: 'ai' | 'git' | 'cli-agent';
  description: string;
  capabilities: NodeCapability[];
  /** True when the node can run through the governed fabric right now. */
  executable: boolean;
  /** Whether the underlying tooling is present on this machine. */
  detected: boolean;
  /** Why a detected-but-not-executable node is not executable. */
  unavailableReason?: string;
  /** Deny-only admission control — may only DENY a node, never permit more. */
  denies: (kind: TaskKind) => string | null;
}

/** How a task's capability is computed from what the task IS. */
export function capabilityForTask(kind: TaskKind): NodeCapability | 'manual' {
  switch (kind) {
    case 'file-operation': return 'code-implementation';
    case 'git-operation': return 'git-operations';
    case 'review': return 'code-review';
    case 'documentation': return 'documentation';
    case 'research': return 'research';
    case 'manual-operation':
    case 'approval':
      return 'manual';
  }
}

/**
 * The canonical node registry.
 *
 *   • `aura-ai`   — AURA's OWN governed proposal generator (`generateTaskProposal`).
 *                   This is the real execution backend that runs code
 *                   implementation today; it is preserved unchanged.
 *   • `git`       — the governed git executor (dry-run preview → human
 *                   Accept → allow-listed mutation), reusing the same
 *                   execFile/allow-list safety pattern as `workflow/nodes.ts`.
 *   • `opencode`  — DETECTED ONLY. The opencode CLI exists on this machine,
 *                   but AURA has no governed executor for it: running the
 *                   CLI would let it write files autonomously and bypass the
 *                   two human gates (plan approval, per-task Accept). It is
 *                   therefore never routed to.
 *   • `claude-code` — DETECTED ONLY. No Claude Code integration exists in
 *                   this environment, so it is never routed to.
 *
 * `detected` is static here and reconciled with the REAL machine by
 * `detectExecutionNodes()` below; `executable` reflects whether the node is
 * wired into the governed fabric (independent of detection).
 */
export const NODE_REGISTRY: Record<ExecutionNodeId, ExecutionNodeSpec> = {
  'aura-ai': {
    id: 'aura-ai',
    label: 'AURA AI',
    kind: 'ai',
    description: "AURA's own governed proposal generator — the real execution backend for code implementation.",
    capabilities: ['code-implementation', 'documentation', 'research', 'testing'],
    executable: true,
    detected: true,
    denies: (kind) => {
      if (kind === 'git-operation') return 'git operations must go through the git node';
      return null;
    },
  },
  git: {
    id: 'git',
    label: 'Git',
    kind: 'git',
    description: 'Governed git executor — dry-run preview, human Accept, then an allow-listed git mutation.',
    capabilities: ['git-operations'],
    executable: true,
    detected: true,
    denies: (kind) => {
      if (kind !== 'git-operation') return 'the git node only runs git operations';
      return null;
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'cli-agent',
    description: 'The opencode CLI. Detected on this machine but not wired into the governed fabric.',
    capabilities: ['code-implementation', 'code-review', 'testing'],
    executable: false,
    detected: false,
    unavailableReason:
      'no governed OpenCode executor exists in the Capability Fabric — running the CLI would bypass AURA\'s human-gated proposal/accept model',
    denies: () => null,
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'cli-agent',
    description: 'The claude CLI. Detected on this machine but not wired into the governed fabric.',
    capabilities: ['code-review', 'code-implementation'],
    executable: false,
    detected: false,
    unavailableReason:
      'no Claude Code execution integration exists in this environment — a requested review node cannot run',
    denies: () => null,
  },
};

/* ── Real environment detection ────────────────────────────────────── */

const detectCmd = process.platform === 'win32' ? 'where' : 'which';

function binaryOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(detectCmd, [bin], { timeout: 5_000, windowsHide: true }, (err) => resolve(!err));
  });
}

export interface NodeDetection {
  id: ExecutionNodeId;
  label: string;
  kind: ExecutionNodeSpec['kind'];
  detected: boolean;
  executable: boolean;
  available: boolean;
  capabilities: NodeCapability[];
  reason: string;
}

let detectionCache: { at: number; status: Record<ExecutionNodeId, NodeDetection> } | null = null;

/**
 * Real environment scan for the node fabric's backing tooling. Results are
 * cached briefly — a scan is only a PATH probe and does not run anything.
 */
export async function detectExecutionNodes(): Promise<Record<ExecutionNodeId, NodeDetection>> {
  const now = Date.now();
  if (detectionCache && now - detectionCache.at < 30_000) return detectionCache.status;

  const gitDetected = await binaryOnPath('git');
  const opencodeDetected = await binaryOnPath('opencode');
  const claudeDetected = await binaryOnPath('claude');

  const status: Record<ExecutionNodeId, NodeDetection> = {
    'aura-ai': {
      id: 'aura-ai', label: NODE_REGISTRY['aura-ai'].label, kind: 'ai',
      detected: true, executable: true, available: true,
      capabilities: NODE_REGISTRY['aura-ai'].capabilities,
      reason: 'AURA\'s own governed proposal generator',
    },
    git: {
      id: 'git', label: NODE_REGISTRY.git.label, kind: 'git',
      detected: gitDetected, executable: gitDetected, available: gitDetected,
      capabilities: NODE_REGISTRY.git.capabilities,
      reason: gitDetected ? 'git is on PATH' : 'git is not installed on this machine',
    },
    opencode: {
      id: 'opencode', label: NODE_REGISTRY.opencode.label, kind: 'cli-agent',
      detected: opencodeDetected, executable: false, available: false,
      capabilities: NODE_REGISTRY.opencode.capabilities,
      reason: opencodeDetected
        ? NODE_REGISTRY.opencode.unavailableReason!
        : 'opencode CLI is not installed on this machine',
    },
    'claude-code': {
      id: 'claude-code', label: NODE_REGISTRY['claude-code'].label, kind: 'cli-agent',
      detected: claudeDetected, executable: false, available: false,
      capabilities: NODE_REGISTRY['claude-code'].capabilities,
      reason: claudeDetected
        ? NODE_REGISTRY['claude-code'].unavailableReason!
        : 'claude CLI is not installed on this machine',
    },
  };

  detectionCache = { at: now, status };
  return status;
}

/* ── Capability → node resolution ──────────────────────────────────── */

export type TaskNode = ExecutionNodeId | 'manual';

export interface NodeResolution {
  node: TaskNode;
  reason: string;
}

const DEFAULT_NODE_BY_CAPABILITY: Record<NodeCapability, TaskNode> = {
  'code-implementation': 'aura-ai',
  'git-operations': 'git',
  'code-review': 'manual',
  documentation: 'manual',
  research: 'manual',
  testing: 'aura-ai',
};

/**
 * Deterministic node resolution for a task. Preserves the contract:
 *
 *   requested ≠ resolved ≠ executed ≠ recorded
 *
 * When the task carries a `requestedNode` it is honored EXACTLY — or the
 * resolution fails explicitly. A requested node is never silently replaced.
 * When nothing was requested, the canonical default for the task's
 * capability is resolved and verified executable before it is returned.
 */
export async function resolveNodeForTask(
  task: { kind: TaskKind; requestedNode?: TaskNode },
  detection?: Record<ExecutionNodeId, NodeDetection>,
): Promise<NodeResolution | { error: string }> {
  const d = detection ?? await detectExecutionNodes();
  const capability = capabilityForTask(task.kind);

  if (task.requestedNode) {
    const req = task.requestedNode;
    if (req === 'manual') {
      return capability === 'manual'
        ? { node: 'manual', reason: 'requested manual completion' }
        : { error: 'requested manual completion but this task has a governed execution path' };
    }
    const spec = NODE_REGISTRY[req];
    if (!spec) return { error: `unknown execution node: ${req}` };
    // Deny-only admission control is evaluated first — a node rule may only
    // DENY, and its denial outranks any capability match.
    const denied = spec.denies(task.kind);
    if (denied) return { error: `denied by node policy: ${denied}` };
    if (capability !== 'manual' && !spec.capabilities.includes(capability)) {
      return { error: `${req} cannot perform "${capability}" (capabilities: ${spec.capabilities.join(', ')})` };
    }
    if (!d[req].detected) return { error: `requested node ${req} is not detected on this machine` };
    if (!d[req].executable) return { error: `requested node ${req} cannot execute: ${d[req].reason}` };
    return { node: req, reason: `requested ${req}` };
  }

  if (capability === 'manual') return { node: 'manual', reason: 'no governed node — completed manually' };
  const node = DEFAULT_NODE_BY_CAPABILITY[capability];
  if (node === 'manual') return { node: 'manual', reason: 'no governed node — completed manually' };
  const det = d[node];
  if (!det.detected || !det.executable) {
    return { error: `no executable node for "${capability}": ${node} — ${det.reason}` };
  }
  return { node, reason: `${capability} → ${node}` };
}

/** UI-safe registry snapshot (metadata + current detection). */
export async function executionNodeStatus(): Promise<{ nodes: NodeDetection[]; resolvedAt: string }> {
  const d = await detectExecutionNodes();
  return { nodes: Object.values(d), resolvedAt: new Date().toISOString() };
}
