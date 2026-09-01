/**
 * validate — is this graph runnable, and is it safe to activate?
 * ==================================================================
 * Four layers, in the order the research names them. The first two were
 * already enforced inside `generate.ts` for AI-produced graphs; hoisting
 * them here means an IMPORTED graph gets the same treatment, which is the
 * case that actually matters — an imported workflow is untrusted content
 * with a friendly name.
 *
 *   1. schema — every node type is real, every config key belongs
 *   2. graph  — edges reference real nodes and real ports, entry exists,
 *               nothing is orphaned
 *   3. policy — what authority this asks for, and what a person must be
 *               told before it runs
 *   4. secrets— every `{{secret:NAME}}` reference resolves to a stored name
 *
 * Layer 3 does NOT decide anything. It reports the envelope and flags the
 * findings a human must see before activation. The policy engine still
 * decides, per invocation, at run time.
 */

import { secrets } from '../secrets';
import { computeEnvelope, type AuthorityEnvelope } from './envelope';
import { NODE_SPECS } from './nodes';
import type { WfEdge, WfNode } from './types';

export type FindingLevel = 'error' | 'warning' | 'notice';

export interface ValidationFinding {
  level: FindingLevel;
  layer: 'schema' | 'graph' | 'policy' | 'secrets';
  message: string;
  nodeId?: string;
}

export interface ValidationReport {
  /** False when any `error` finding exists. An invalid graph never runs. */
  valid: boolean;
  findings: ValidationFinding[];
  envelope: AuthorityEnvelope;
  /** Secret names the graph references. Names only — never values. */
  secretsReferenced: string[];
  /** Referenced but not stored. Each one fails the run at that node. */
  secretsMissing: string[];
  /**
   * True when a person must review before this is activated: it asks for
   * something irreversible, or something rated high risk.
   */
  requiresReview: boolean;
}

export function validateWorkflow(nodes: WfNode[], edges: WfEdge[]): ValidationReport {
  const findings: ValidationFinding[] = [];
  const ids = new Set<string>();

  /* 1. schema */
  for (const node of nodes) {
    if (ids.has(node.id)) findings.push({ level: 'error', layer: 'schema', message: `duplicate node id "${node.id}"`, nodeId: node.id });
    ids.add(node.id);
    const spec = NODE_SPECS[node.type];
    if (!spec) {
      findings.push({ level: 'error', layer: 'schema', message: `unknown node type "${node.type}"`, nodeId: node.id });
      continue;
    }
    if (spec.disabled) {
      findings.push({ level: 'error', layer: 'schema', message: `"${spec.label}" is not enabled in this build`, nodeId: node.id });
    }
    const known = new Set(spec.fields.map((f) => f.key));
    for (const key of Object.keys(node.config ?? {})) {
      if (key.startsWith('__') || known.has(key)) continue;
      // A stray key is a notice, not an error: it is inert at run time, and
      // rejecting a graph over one would break workflows saved by an older
      // build that had a field this one dropped.
      findings.push({ level: 'notice', layer: 'schema', message: `"${key}" is not a field of ${spec.label} and will be ignored`, nodeId: node.id });
    }
  }

  /* 2. graph */
  const inDegree = new Map<string, number>();
  for (const node of nodes) inDegree.set(node.id, 0);
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      findings.push({ level: 'error', layer: 'graph', message: `edge references a node that does not exist (${edge.from} → ${edge.to})` });
      continue;
    }
    const fromSpec = NODE_SPECS[nodes.find((n) => n.id === edge.from)!.type];
    if (fromSpec && !fromSpec.outputs.includes(edge.fromPort)) {
      findings.push({ level: 'error', layer: 'graph', message: `${fromSpec.label} has no output port "${edge.fromPort}"`, nodeId: edge.from });
    }
    const toSpec = NODE_SPECS[nodes.find((n) => n.id === edge.to)!.type];
    if (toSpec && toSpec.inputs === 0) {
      findings.push({ level: 'error', layer: 'graph', message: `${toSpec.label} accepts no input`, nodeId: edge.to });
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  if (nodes.length && ![...inDegree.values()].some((d) => d === 0)) {
    findings.push({ level: 'error', layer: 'graph', message: 'no entry node — every node has an incoming edge, so nothing can start' });
  }
  if (nodes.length && !nodes.some((n) => n.type === 'output')) {
    findings.push({ level: 'warning', layer: 'graph', message: 'no Output node, so this workflow produces no visible result' });
  }

  /* 3. policy — reported, never decided */
  const envelope = computeEnvelope(nodes);
  for (const cap of envelope.capabilities) {
    if (cap.irreversible) {
      findings.push({ level: 'warning', layer: 'policy', message: `${cap.name} cannot be undone by AURA and will always ask for your go-ahead`, nodeId: cap.nodeIds[0] });
    } else if (cap.risk === 'high') {
      findings.push({ level: 'warning', layer: 'policy', message: `${cap.name} is rated high risk and needs explicit authorization`, nodeId: cap.nodeIds[0] });
    }
  }
  for (const nodeId of envelope.unknownNodes) {
    findings.push({ level: 'error', layer: 'policy', message: 'this node has no known classification, so its authority cannot be established', nodeId });
  }
  for (const effect of envelope.auraInternalEffects) {
    findings.push({ level: 'notice', layer: 'policy', message: `${effect.type} writes inside AURA's own storage — recorded on the run, but not a governed capability`, nodeId: effect.nodeId });
  }
  if (envelope.hosts.dynamic) {
    findings.push({ level: 'warning', layer: 'policy', message: 'a URL in this workflow is built at run time, so the hosts it can reach cannot be known in advance' });
  }

  /* 4. secrets */
  const referenced = secrets.referencesInConfigs(nodes.map((n) => n.config ?? {}));
  const missing = referenced.filter((name) => !secrets.has(name));
  for (const name of missing) {
    findings.push({ level: 'error', layer: 'secrets', message: `this workflow references the secret "${name}", which is not stored` });
  }

  return {
    valid: !findings.some((f) => f.level === 'error'),
    findings,
    envelope,
    secretsReferenced: referenced,
    secretsMissing: missing,
    requiresReview: envelope.hasIrreversible || envelope.highestRisk === 'high',
  };
}
