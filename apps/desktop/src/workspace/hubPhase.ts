/**
 * hubPhase — projections from real mission state onto the Hub canvas.
 * ==================================================================
 * Pure functions, no React, no fetching, no state. Everything here is a
 * *reading* of authority that lives somewhere else:
 *
 *   • mission progress  ← `CreationState` + `MissionRecord.execution`
 *   • node activity     ← the mission's in-flight tasks, mapped through
 *                          `CAPABILITY_MANIFEST[].requiresNodeCapability`
 *
 * Two rules hold this file together, and both exist to stop the Hub from
 * inventing a second version of the truth:
 *
 *   1. **No new status values.** Every phase below is a *label* for a
 *      state the mission system already computes. Where the brief asked
 *      for a step Mission Control does not model, it is derived from real
 *      data and marked as such (see `preparing`) rather than faked.
 *   2. **Nothing is persisted.** These projections are recomputed from
 *      current state on every render and discarded. A node can therefore
 *      never be left claiming it is running after a mission has ended.
 *
 * See docs/WORKSPACE_EXECUTION_ARCHITECTURE.md §5 (Axis B) and §21.8.
 */

import type { EnvironmentNode } from '@aura/connected-environment';
import type {
  ApprovalRequest,
  CapabilityDescriptorView,
  MissionCapabilityAnnotation,
} from '../ai/fabricClient';
import type { MissionRecord } from '../ai/missionClient';
import type { CreationState } from '../screens/missions/useMissions';

/* ══════════════════════════════════════════════════════════════════
   Mission progress
   ══════════════════════════════════════════════════════════════════ */

/**
 * What the Hub tells the user it is doing. Each of these maps onto
 * canonical mission state — the mapping is in `deriveHubPhase`, and it is
 * the only place a label is attached to a state.
 */
export type HubPhase =
  | 'idle'
  | 'understanding'
  | 'planning'
  | 'preparing'
  | 'awaiting-approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed';

export interface HubProgress {
  phase: HubPhase;
  label: string;
  /** One line of *real* detail: a stage name, a count, a reason. */
  detail: string;
  /** True while AURA is working and the composer must stay locked. */
  busy: boolean;
}

/** The creation stages, in the order the orchestrator emits them. */
const UNDERSTANDING = new Set(['classify', 'signals', 'intent']);
const PLANNING = new Set(['strategy', 'goal-graph', 'risk', 'review', 'quality']);

const STAGE_DETAIL: Record<string, string> = {
  classify: 'Classifying intent',
  signals: 'Reading project signals',
  intent: 'Extracting goals and constraints',
  strategy: 'Selecting a strategy',
  'goal-graph': 'Building the goal graph',
  risk: 'Analysing risk',
  review: 'Reviewing the plan',
  quality: 'Scoring plan quality',
};

/**
 * Collapses the real mission state into one phase.
 *
 * Order matters: execution state outranks creation state, because a
 * mission that is running has finished being planned. `creation.stage`
 * only describes the most recent creation stream.
 */
export function deriveHubPhase(
  creation: CreationState,
  mission: MissionRecord | null,
  annotation: MissionCapabilityAnnotation | null,
  approvals: ApprovalRequest[],
): HubProgress {
  // Creation failures are the loudest thing that can happen; surface first.
  if (creation.stage === 'error') {
    return {
      phase: 'failed',
      label: 'Planning failed',
      detail: creation.errorMessage ?? 'The mission could not be planned.',
      busy: false,
    };
  }
  if (UNDERSTANDING.has(creation.stage)) {
    return { phase: 'understanding', label: 'Understanding', detail: STAGE_DETAIL[creation.stage] ?? '', busy: true };
  }
  if (PLANNING.has(creation.stage)) {
    return { phase: 'planning', label: 'Planning', detail: STAGE_DETAIL[creation.stage] ?? '', busy: true };
  }

  const execution = mission?.execution ?? null;

  // A Fabric gate parked mid-execution is the user's turn, so it outranks
  // the engine's own status.
  const pending = approvals.filter((a) => a.state === 'pending');
  if (pending.length > 0) {
    return {
      phase: 'awaiting-approval',
      label: 'Awaiting approval',
      detail: pending[0].summary || `${pending.length} request${pending.length === 1 ? '' : 's'} waiting on you`,
      busy: false,
    };
  }

  if (execution) {
    switch (execution.status) {
      case 'running': {
        const m = execution.metrics;
        return {
          phase: 'executing',
          label: 'Executing',
          detail: m ? `${m.tasksCompleted}/${m.tasksTotal} tasks · batch ${m.currentBatch + 1}/${m.parallelBatches}` : 'Running tasks',
          busy: true,
        };
      }
      case 'reviewing':
        return { phase: 'verifying', label: 'Verifying', detail: 'Checkpoint review', busy: false };
      case 'completed':
        return { phase: 'completed', label: 'Completed', detail: 'All tasks finished', busy: false };
      case 'failed':
        return { phase: 'failed', label: 'Failed', detail: mission?.error ?? 'Execution failed', busy: false };
      case 'paused':
        return { phase: 'executing', label: 'Paused', detail: 'Execution paused', busy: false };
      case 'cancelled':
        return { phase: 'failed', label: 'Cancelled', detail: 'Mission cancelled', busy: false };
      default:
        break;
    }
  }

  // A mission that recorded an error has failed, even when the creation
  // stream itself closed cleanly — the orchestrator writes the reason onto
  // the record. Without this, a mission whose planning died upstream (a
  // provider timeout, say) would fall through to `idle` and render as
  // though the user had never asked for anything.
  if (mission?.error) {
    return { phase: 'failed', label: 'Planning failed', detail: mission.error, busy: false };
  }

  // Plan exists but nothing has run. If the annotation reports gaps, the
  // honest state is that the environment is not ready — this is the one
  // phase with no canonical mission status behind it, so it is computed
  // from the Fabric's real gap analysis rather than asserted.
  if (mission?.goalGraph) {
    if (annotation && annotation.gaps.length > 0) {
      return {
        phase: 'preparing',
        label: 'Preparing environment',
        detail: `${annotation.gaps.length} capabilit${annotation.gaps.length === 1 ? 'y is' : 'ies are'} missing`,
        busy: false,
      };
    }
    if (mission.approval.status === 'pending') {
      return {
        phase: 'awaiting-approval',
        label: 'Awaiting approval',
        detail: `${mission.goalGraph.tasks.length} tasks planned — approve to begin`,
        busy: false,
      };
    }
    return { phase: 'preparing', label: 'Ready', detail: 'Plan approved — start execution', busy: false };
  }

  return { phase: 'idle', label: 'Hub', detail: 'Where AURA plans and orchestrates', busy: false };
}

/* ══════════════════════════════════════════════════════════════════
   Node activity (Axis B)
   ══════════════════════════════════════════════════════════════════ */

/**
 * Execution activity for one node. Orthogonal to `NodeStatus`: a node is
 * `status × phase`, e.g. *connected + running*. Derived only.
 */
export type NodeActivityPhase = 'idle' | 'running' | 'verifying' | 'waiting-approval' | 'blocked';

/**
 * capabilityId → the node capability it needs before it can run at all.
 *
 * Built from the manifest the *service* reports (`GET /fabric/capabilities`)
 * rather than a compile-time import, so this can never disagree with the
 * Fabric actually executing. Capabilities with no `requiresNodeCapability`
 * run inside AURA and therefore light up no node.
 */
export type CapabilityNodeMap = Map<string, string>;

export function buildCapabilityNodeMap(capabilities: CapabilityDescriptorView[]): CapabilityNodeMap {
  return new Map(
    capabilities.flatMap((c) => (c.requiresNodeCapability ? [[c.id, c.requiresNodeCapability] as const] : [])),
  );
}

/**
 * Which nodes are involved in what the mission is doing *right now*.
 *
 * The chain is entirely real and entirely deterministic:
 *
 *   in-flight task  → `annotation.bindings[].requires` (the Fabric's own
 *                      per-task projection)
 *                   → `requiresNodeCapability` from the manifest
 *                   → the placed node whose catalogue entry provides it
 *
 * A task that needs no external capability lights up nothing. A required
 * capability nothing provides lights up nothing either — the gap is
 * reported by `annotation.gaps`, not by animating an unrelated node.
 */
export function projectNodeActivity(
  mission: MissionRecord | null,
  annotation: MissionCapabilityAnnotation | null,
  nodes: EnvironmentNode[],
  approvals: ApprovalRequest[],
  capabilityToNode: CapabilityNodeMap,
): Map<string, NodeActivityPhase> {
  const activity = new Map<string, NodeActivityPhase>();
  const dag = mission?.execution?.dag;
  if (!dag || !annotation) return activity;

  const bindingFor = new Map(annotation.bindings.map((b) => [b.taskId, b]));

  /** Every node that provides `nodeCapability`, among those placed. */
  const providersOf = (nodeCapability: string) =>
    nodes.filter((n) => (n.entry.capabilities as readonly string[]).includes(nodeCapability));

  // A pending Fabric approval names its own task, so the node holding
  // things up can be identified exactly rather than guessed at.
  const approvalTaskIds = new Set(
    approvals.filter((a) => a.state === 'pending' && a.taskId).map((a) => a.taskId as string),
  );

  // Later writes win, so apply in ascending order of urgency: a node that
  // is both running and gated should read as gated.
  const ORDER: NodeActivityPhase[] = ['blocked', 'verifying', 'running', 'waiting-approval'];
  const rank = (p: NodeActivityPhase) => ORDER.indexOf(p);

  const mark = (nodeId: string, phase: NodeActivityPhase) => {
    const current = activity.get(nodeId);
    if (!current || rank(phase) > rank(current)) activity.set(nodeId, phase);
  };

  for (const task of dag.nodes) {
    let phase: NodeActivityPhase | null = null;
    if (approvalTaskIds.has(task.id)) phase = 'waiting-approval';
    else if (task.status === 'running' || task.status === 'retrying') phase = 'running';
    else if (task.status === 'review') phase = 'verifying';
    else if (task.status === 'blocked') phase = 'blocked';
    if (!phase) continue;

    const binding = bindingFor.get(task.id);
    if (!binding) continue;

    for (const capabilityId of binding.requires) {
      const nodeCapability = capabilityToNode.get(capabilityId);
      if (!nodeCapability) continue; // runs inside AURA — no node to light up
      for (const provider of providersOf(nodeCapability)) mark(provider.id, phase);
    }
  }

  return activity;
}

export const ACTIVITY_LABEL: Record<NodeActivityPhase, string> = {
  idle: '',
  running: 'Working',
  verifying: 'Verifying',
  'waiting-approval': 'Needs approval',
  blocked: 'Blocked',
};

/**
 * Which placed nodes a mission needs but cannot use. Drives the Hub's
 * "Docker is required but isn't installed" line, using the Fabric's gap
 * list rather than any inference of the Hub's own.
 */
export function missingNodesFor(
  annotation: MissionCapabilityAnnotation | null,
  nodes: EnvironmentNode[],
  capabilityToNode: CapabilityNodeMap,
): { node: EnvironmentNode; capabilityId: string }[] {
  if (!annotation) return [];
  const out: { node: EnvironmentNode; capabilityId: string }[] = [];
  const seen = new Set<string>();
  for (const gap of annotation.gaps) {
    const nodeCapability = capabilityToNode.get(gap.capabilityId);
    if (!nodeCapability) continue;
    for (const node of nodes) {
      if (!(node.entry.capabilities as readonly string[]).includes(nodeCapability)) continue;
      if (node.health.status === 'connected' || node.health.status === 'available') continue;
      const key = `${node.id}:${gap.capabilityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ node, capabilityId: gap.capabilityId });
    }
  }
  return out;
}
