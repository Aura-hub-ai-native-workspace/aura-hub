/**
 * dryrun — what would happen, computed without anything happening.
 * ==================================================================
 * A dry run answers four questions a person needs before pressing Run:
 *
 *   1. Is this graph even runnable?          (validation)
 *   2. What order would it go in?            (execution plan)
 *   3. What would it be allowed to do?       (policy, per governed node)
 *   4. What would it stop and ask me?        (approvals, counted)
 *
 * ── Why this is not a second execution engine ──────────────────────
 * It never calls `spec.run`, never calls `fabric.invoke`, and never
 * touches the filesystem, a process or the network. The two things it
 * does are:
 *
 *   • a STATIC graph walk — reachability and ordering, which is analysis
 *     of a data structure, not execution of it; and
 *   • `fabric.evaluate(capabilityId, context)` — the Capability Fabric's
 *     own pre-flight, which already exists because the mission engine
 *     needs the same answer, and which runs no executor by construction.
 *
 * Point 2 is the load-bearing one. The alternative — running the engine
 * with side effects stubbed — would mean a second code path through the
 * real engine whose only job is not to do things, and the day that path
 * diverges is the day a "dry run" writes a file.
 *
 * ── What it deliberately does NOT claim ────────────────────────────
 * A workflow's real shape is decided at run time: a Condition picks a
 * port from data that does not exist yet, and a Loop's iteration count
 * comes from its input. So every node downstream of a branch is reported
 * as `conditional`, never as "will run", and loop bodies are reported
 * once with their bound rather than unrolled. Guessing either would make
 * the plan confidently wrong, which is worse than incomplete.
 */

import type { CapabilityFabric, PolicyEvaluation } from '@aura/capability-fabric';
import { describeFabricCapability } from '@aura/capability-fabric';
import { grantsForScopes } from '../fabric/scopes';
import { secrets } from '../secrets';
import { computeEnvelope, type AuthorityEnvelope } from './envelope';
import { BINDINGS, NEEDS_NETWORK, NODE_CLASS, capabilityForNode, type NodeClass } from './governed';
import { NODE_SPECS, interpolate, type RunCtx } from './nodes';
import { validateWorkflow, type ValidationReport } from './validate';
import type { NodeIO, WfEdge, WfNode } from './types';

/** Whether a step is certain to run, or depends on run-time data. */
export type Reachability =
  /** Reached from an entry node with no branch in between. */
  | 'certain'
  /** Downstream of a Condition or a Loop body — depends on the data. */
  | 'conditional'
  /** No path reaches it. A graph mistake, reported rather than skipped. */
  | 'unreachable';

export interface PlannedStep {
  order: number;
  nodeId: string;
  type: string;
  label: string;
  nodeClass: NodeClass;
  reachability: Reachability;
  /** Depth from the nearest entry node. Steps at one depth may interleave. */
  depth: number;
  /** Populated for a governed node. */
  capabilityId?: string;
  capabilityName?: string;
  risk?: string;
  irreversible?: boolean;
  /** The Fabric's pre-flight answer. Absent when the node causes no effect. */
  policy?: PolicyEvaluation;
  /** True when this step would stop and ask a human. */
  wouldAskHuman?: boolean;
  /** True when policy would refuse it outright. */
  wouldBeDenied?: boolean;
  /** Human phrase for the action, built from UNRESOLVED config. */
  describes?: string;
  /** Why the arguments could not be planned, when they could not. */
  planError?: string;
  /** Loop bound, for a loop node. */
  maxIterations?: number;
  needsNetwork?: boolean;
  /** Secret names this step would resolve at execution time. */
  secretsUsed?: string[];
}

export interface DryRunReport {
  workflowId: string;
  workflowName: string;
  projectId: string;
  at: string;
  /** Schema, graph, policy and secret findings. */
  validation: ValidationReport;
  envelope: AuthorityEnvelope;
  plan: PlannedStep[];
  /** Steps that would pause for a person, in plan order. */
  approvalsRequired: { nodeId: string; capabilityId: string; reason: string; rule: string }[];
  /** Steps policy would refuse. A non-empty list means this run cannot finish. */
  denials: { nodeId: string; capabilityId: string; reason: string; rule: string }[];
  /** True when nothing would be denied and nothing would need a human. */
  wouldRunUnattended: boolean;
  /** True when the graph can complete without a network. */
  offlineCapable: boolean;
  secretsRequired: string[];
  secretsMissing: string[];
  /** Least-privilege grants this run would receive. */
  grants: { read: boolean; write: boolean; execute: boolean; autonomous: boolean };
  /**
   * Proof of inertness, carried on the report itself.
   *
   * A dry run that quietly performed something would be the single worst
   * bug in this file, so the contract states what it did: how many
   * capabilities it asked the policy engine about, and that it invoked
   * none. The verification suite asserts the audit trail did not grow.
   */
  sideEffects: { invocations: 0; policyEvaluations: number; note: string };
}

/* ── static graph analysis ──────────────────────────────────────── */

/** Ports whose targets are conditional on run-time data. */
const BRANCHING_PORTS = new Set(['true', 'false', 'each']);

function analyzeGraph(nodes: WfNode[], edges: WfEdge[]): Map<string, { depth: number; reach: Reachability }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, WfEdge[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  const info = new Map<string, { depth: number; reach: Reachability }>();
  for (const n of nodes) info.set(n.id, { depth: 0, reach: 'unreachable' });

  // Breadth-first from every entry node. Conditionality is INHERITED: once
  // a path passes a branching port, everything after it is conditional,
  // because the branch may not be taken.
  const queue: { id: string; depth: number; conditional: boolean }[] = [];
  for (const n of nodes) if ((inDeg.get(n.id) ?? 0) === 0) queue.push({ id: n.id, depth: 0, conditional: false });

  const seen = new Set<string>();
  let guard = 0;
  while (queue.length && guard++ < nodes.length * 8) {
    const { id, depth, conditional } = queue.shift()!;
    const current = info.get(id)!;
    const reach: Reachability = conditional ? 'conditional' : 'certain';
    // A node reachable both certainly and conditionally is certain.
    if (current.reach === 'unreachable' || (current.reach === 'conditional' && reach === 'certain')) {
      info.set(id, { depth: Math.max(current.depth, depth), reach });
    }
    const key = `${id}:${conditional}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const e of out.get(id) ?? []) {
      queue.push({ id: e.to, depth: depth + 1, conditional: conditional || BRANCHING_PORTS.has(e.fromPort) });
    }
  }
  return info;
}

/* ── the dry run ────────────────────────────────────────────────── */

export interface DryRunInput {
  workflowId: string;
  workflowName: string;
  nodes: WfNode[];
  edges: WfEdge[];
  projectId: string;
  projectPath: string;
  projectName: string;
  fabric: CapabilityFabric | null;
  inputs?: Record<string, string>;
}

export function dryRunWorkflow(input: DryRunInput): DryRunReport {
  const validation = validateWorkflow(input.nodes, input.edges);
  const envelope = computeEnvelope(input.nodes);
  const graph = analyzeGraph(input.nodes, input.edges);
  const grants = grantsForScopes(envelope.scopes.map((s) => s.scope));

  /* A context that names no run. `evaluate` is read-only, but it takes an
     InvocationContext, and handing it a real runId would let a scope
     registered for a live run leak into an answer about a hypothetical
     one. The grants a real run would get are reported separately above. */
  const context = {
    actor: { kind: 'human' as const, id: 'dry-run' },
    projectId: input.projectId,
    cwd: input.projectPath,
  };

  /* A context object shaped like RunCtx, purely so config interpolation
     produces the same text a real run would show. No pipeline, no memory,
     no signal — nothing here can execute. */
  const fakeCtx = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    vars: {},
    runInputs: input.inputs ?? {},
    log: () => {},
  } as unknown as RunCtx;
  const emptyIO: NodeIO = { text: '' };

  const plan: PlannedStep[] = [];
  const approvalsRequired: DryRunReport['approvalsRequired'] = [];
  const denials: DryRunReport['denials'] = [];
  let policyEvaluations = 0;

  const ordered = [...input.nodes].sort((a, b) => {
    const da = graph.get(a.id)?.depth ?? 0;
    const db = graph.get(b.id)?.depth ?? 0;
    return da - db || a.id.localeCompare(b.id);
  });

  for (const [i, node] of ordered.entries()) {
    const spec = NODE_SPECS[node.type];
    const info = graph.get(node.id) ?? { depth: 0, reach: 'unreachable' as Reachability };
    const nodeClass = NODE_CLASS[node.type];
    const step: PlannedStep = {
      order: i + 1,
      nodeId: node.id,
      type: node.type,
      label: spec?.label ?? node.type,
      nodeClass: nodeClass ?? 'pure',
      reachability: info.reach,
      depth: info.depth,
      needsNetwork: NEEDS_NETWORK[node.type] ?? false,
    };

    if (node.type === 'loop') {
      // Reported, not unrolled. The real count comes from the input.
      step.maxIterations = Math.max(1, Math.min(20, Number(node.config?.times) || 3));
    }

    const capabilityId = capabilityForNode(node.type);
    if (capabilityId) {
      const descriptor = describeFabricCapability(capabilityId);
      step.capabilityId = capabilityId;
      step.capabilityName = descriptor?.name;
      step.risk = descriptor?.risk;
      step.irreversible = Boolean(descriptor?.irreversible);

      // Plan the arguments the way the governor would, so a misconfigured
      // node is caught here rather than at the fifth minute of a run.
      const planner = BINDINGS[node.type];
      if (planner) {
        try {
          const planned = planner(fakeCtx, emptyIO, { ...node.config }, (t) => interpolate(t, fakeCtx, emptyIO));
          if (planned) {
            step.describes = planned.describe;
            const refs = new Set<string>();
            for (const v of Object.values(planned.input)) {
              if (typeof v === 'string') for (const n of secrets.referencesIn(v)) refs.add(n);
              else if (v && typeof v === 'object') {
                for (const hv of Object.values(v as Record<string, unknown>)) {
                  if (typeof hv === 'string') for (const n of secrets.referencesIn(hv)) refs.add(n);
                }
              }
            }
            // Names only. `resolve()` is never called here — a dry run must
            // not decrypt a credential, let alone put one in a report.
            if (refs.size) step.secretsUsed = [...refs].sort();
          }
        } catch (error) {
          step.planError = (error as Error).message;
        }
      }

      if (input.fabric) {
        // The Fabric's OWN pre-flight. Runs nothing by construction.
        const evaluation = input.fabric.evaluate(capabilityId, context);
        policyEvaluations += 1;
        if (evaluation) {
          step.policy = evaluation;
          step.wouldAskHuman = evaluation.decision === 'ask-user' || evaluation.decision === 'require-approval';
          step.wouldBeDenied = evaluation.decision === 'deny';
          if (step.wouldBeDenied) {
            denials.push({ nodeId: node.id, capabilityId, reason: evaluation.reason, rule: evaluation.rule });
          } else if (step.wouldAskHuman) {
            approvalsRequired.push({ nodeId: node.id, capabilityId, reason: evaluation.reason, rule: evaluation.rule });
          }
        }
      }
    }

    plan.push(step);
  }

  return {
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    projectId: input.projectId,
    at: new Date().toISOString(),
    validation,
    envelope,
    plan,
    approvalsRequired,
    denials,
    wouldRunUnattended: validation.valid && denials.length === 0 && approvalsRequired.length === 0,
    offlineCapable: envelope.offlineCapable,
    secretsRequired: validation.secretsReferenced,
    secretsMissing: validation.secretsMissing,
    grants,
    sideEffects: {
      invocations: 0,
      policyEvaluations,
      note: 'A dry run evaluates policy and never invokes a capability. Nothing was executed, written, spawned or sent.',
    },
  };
}
