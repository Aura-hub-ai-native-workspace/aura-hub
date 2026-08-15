/**
 * Definition validation — the editor's health signals.
 * ==================================================================
 * `validateDefinition` checks a WorkflowDefinition structurally:
 * node ids, edge endpoints, port existence and type compatibility,
 * required config, expression syntax, trigger configuration, capability
 * references and cycle rules. It never executes anything and never
 * touches policy — it answers "can this graph be a runnable contract".
 *
 * Host knowledge is passed in (a narrower capability set, the provider
 * registry ids) but defaults to the real Fabric manifest, so a workflow
 * can never reference a capability AURA does not describe.
 */

import { parseExpression } from './expression';
import { NODE_SCHEMAS, knownCapabilities } from './schemas';
import type { ConfigFieldSpec, PortSpec, WorkflowDefinition, WorkflowNode, WorkflowNodeType } from './types';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export interface ValidateOptions {
  schemas?: Readonly<Record<WorkflowNodeType, NodeSchemaLike>>;
  knownCapabilities?: ReadonlySet<string>;
  knownProviders?: ReadonlySet<string>;
}

export interface NodeSchemaLike {
  category: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  config: ConfigFieldSpec[];
}

/** Ports an edge may leave a source node with; dynamic for switch/parallel. */
export function dynamicOutputPorts(schema: NodeSchemaLike | undefined, node: WorkflowNode): PortSpec[] {
  if (!schema) return [];
  const dyn: PortSpec[] = [];
  if (node.type === 'switch') {
    const count = caseCount(node);
    for (let i = 1; i <= count; i++) dyn.push({ id: `case-${i}`, label: `Case ${i}`, type: 'any' });
    dyn.push({ id: 'default', label: 'Default', type: 'any' });
    return dyn;
  }
  if (node.type === 'parallel') {
    const count = Math.max(0, Math.min(16, Number(node.config.branchCount) || 0));
    for (let i = 1; i <= count; i++) dyn.push({ id: `branch-${i}`, label: `Branch ${i}`, type: 'any' });
    dyn.push({ id: 'all', label: 'All done', type: 'any' });
    return dyn;
  }
  return [];
}

export function caseCount(node: WorkflowNode): number {
  if (node.type !== 'switch') return 0;
  const cases = Array.isArray(node.config.cases) ? (node.config.cases as unknown[]) : String(node.config.cases ?? '').split(/\r?\n/);
  const count = cases.filter((c) => typeof c === 'string' && c.trim()).length;
  return Math.max(1, Math.min(16, count));
}

function isAssignable(from: PortSpec['type'], to: PortSpec['type']): boolean {
  return from === to || from === 'any' || to === 'any';
}

function cronIsValid(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7], [0, 59]];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f === '*') continue;
    const [min, max] = ranges[i] as [number, number];
    for (const part of f.split(',')) {
      const m = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
      if (!m) return false;
      const lo = Number(m[1]);
      if (m[2] !== undefined) {
        const hi = Number(m[2]);
        if (hi < lo) return false;
        if (lo < min || hi > max) return false;
      } else if (m[3] !== undefined) {
        if (lo < 1 || lo > max) return false;
      } else if (lo < min || lo > max) {
        return false;
      }
    }
  }
  return true;
}

function triggerConfigIssues(node: WorkflowNode, issues: ValidationIssue[]): void {
  const cfg = node.config;
  // The discriminator is the NODE TYPE, never a duplicated config field.
  switch (node.type) {
    case 'schedule': {
      const cron = typeof cfg.cron === 'string' ? cfg.cron : '';
      if (!cron.trim() || !cronIsValid(cron)) {
        issues.push({ severity: 'error', code: 'invalid-cron', nodeId: node.id, message: `schedule trigger "${node.label ?? node.id}" has an invalid cron expression` });
      }
      break;
    }
    case 'git-event':
    case 'mission-event':
    case 'agent-event':
    case 'environment-event': {
      const events = Array.isArray(cfg.events) ? (cfg.events as unknown[]) : [];
      if (!events.length) {
        issues.push({ severity: 'error', code: 'invalid-trigger-config', nodeId: node.id, message: `trigger "${node.label ?? node.id}" needs at least one event` });
      }
      break;
    }
    case 'file-change': {
      const paths = Array.isArray(cfg.paths) ? (cfg.paths as unknown[]) : [];
      if (!paths.length) {
        issues.push({ severity: 'error', code: 'invalid-trigger-config', nodeId: node.id, message: `trigger "${node.label ?? node.id}" needs at least one path` });
      }
      break;
    }
    default:
      break; // manual needs nothing
  }
}

function expressionValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('{{')) return null;
  return value;
}

export function validateDefinition(wf: WorkflowDefinition, opts: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const schemas = opts.schemas ?? (NODE_SCHEMAS as unknown as Record<string, NodeSchemaLike>);
  const caps = opts.knownCapabilities ?? knownCapabilities();

  if (wf.schemaVersion !== 1) {
    issues.push({ severity: 'error', code: 'unsupported-schema', message: `schemaVersion ${String(wf.schemaVersion)} is not supported (expected 1)` });
  }
  if (!wf.id.trim()) issues.push({ severity: 'error', code: 'missing-id', message: 'workflow id is missing' });
  if (!wf.name.trim()) issues.push({ severity: 'error', code: 'missing-name', message: 'workflow name is missing' });

  /* ── nodes ─────────────────────────────────────────────────────── */
  const seen = new Set<string>();
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of wf.nodes) {
    if (seen.has(node.id)) {
      issues.push({ severity: 'error', code: 'duplicate-node-id', nodeId: node.id, message: `duplicate node id "${node.id}"` });
      continue;
    }
    seen.add(node.id);
    nodeById.set(node.id, node);

    const schema = schemas[node.type];
    if (!schema) {
      issues.push({ severity: 'error', code: 'unknown-node-type', nodeId: node.id, message: `node "${node.label ?? node.id}" has unknown type "${node.type}"` });
      continue;
    }
    for (const key of Object.keys(node.config)) {
      if (key === 'enabled' && schema.category === 'trigger') continue; // common trigger flag
      if (!schema.config.some((f) => f.key === key)) {
        issues.push({ severity: 'warning', code: 'unknown-config-key', nodeId: node.id, message: `node "${node.label ?? node.id}" has a config key "${key}" its type does not declare` });
      }
    }
    for (const f of schema.config) {
      if (f.required && node.config[f.key] === undefined) {
        issues.push({ severity: 'error', code: 'missing-required-config', nodeId: node.id, message: `node "${node.label ?? node.id}" is missing required config "${f.key}"` });
      }
    }
    for (const f of schema.config) {
      const raw = node.config[f.key];
      const expr = expressionValue(raw);
      if (expr !== null) {
        const parsed = parseExpression(expr);
        if (!parsed.ok) {
          issues.push({ severity: 'error', code: 'invalid-expression', nodeId: node.id, message: `node "${node.label ?? node.id}" config "${f.key}": ${parsed.error}` });
        }
      }
    }
    // capability node: the tool reference must be a real Fabric capability.
    if (node.type === 'capability') {
      const id = node.config.capabilityId;
      if (typeof id !== 'string' || !id.trim()) {
        issues.push({ severity: 'error', code: 'missing-capability', nodeId: node.id, message: `capability node "${node.label ?? node.id}" needs a capabilityId` });
      } else if (!caps.has(id)) {
        issues.push({ severity: 'error', code: 'unknown-capability', nodeId: node.id, message: `capability node "${node.label ?? node.id}" references "${id}" which is not in the capability manifest` });
      }
    }
    // ai node: warn when a provider is named and the host knows its registry.
    if (node.type !== 'capability' && node.config.providerId && opts.knownProviders && typeof node.config.providerId === 'string') {
      if (!opts.knownProviders.has(node.config.providerId)) {
        issues.push({ severity: 'warning', code: 'unknown-provider', nodeId: node.id, message: `node "${node.label ?? node.id}" names provider "${node.config.providerId}" which is not in the provider registry` });
      }
    }
    if (node.type === 'schedule' || node.type === 'git-event' || node.type === 'file-change' || node.type === 'mission-event' || node.type === 'agent-event' || node.type === 'environment-event') {
      triggerConfigIssues(node, issues);
    }
  }

  /* ── edges ─────────────────────────────────────────────────────── */
  const edgeSeen = new Set<string>();
  for (const edge of wf.edges) {
    const dupKey = `${edge.from}|${edge.fromPort}|${edge.to}|${edge.toPort}`;
    if (edgeSeen.has(dupKey)) {
      issues.push({ severity: 'error', code: 'duplicate-edge', edgeId: edge.id, message: `duplicate edge ${edge.from}.${edge.fromPort} → ${edge.to}.${edge.toPort}` });
      continue;
    }
    edgeSeen.add(dupKey);

    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode || !toNode) {
      issues.push({ severity: 'error', code: 'edge-unknown-node', edgeId: edge.id, message: `edge references a node that does not exist (${edge.from} → ${edge.to})` });
      continue;
    }
    const fromSchema = schemas[fromNode.type];
    const toSchema = schemas[toNode.type];
    if (!fromSchema || !toSchema) continue;

    const fromPorts = [...fromSchema.outputs, ...dynamicOutputPorts(fromSchema, fromNode)];
    const fromPort = fromPorts.find((p) => p.id === edge.fromPort);
    if (!fromPort) {
      issues.push({ severity: 'error', code: 'edge-unknown-port', edgeId: edge.id, message: `"${fromNode.type}" has no output port "${edge.fromPort}" (edge ${edge.from} → ${edge.to})` });
      continue;
    }
    const toPort = toSchema.inputs.find((p) => p.id === edge.toPort);
    if (!toPort) {
      issues.push({ severity: 'error', code: 'edge-unknown-port', edgeId: edge.id, message: `"${toNode.type}" has no input port "${edge.toPort}" (edge ${edge.from} → ${edge.to})` });
      continue;
    }
    if (toSchema.inputs.length === 0) {
      issues.push({ severity: 'error', code: 'edge-into-entry-node', edgeId: edge.id, message: `"${toNode.type}" is an entry node and accepts no incoming edges (edge ${edge.from} → ${edge.to})` });
      continue;
    }
    if (!isAssignable(fromPort.type, toPort.type)) {
      issues.push({ severity: 'error', code: 'edge-port-type-mismatch', edgeId: edge.id, message: `port type mismatch: ${fromNode.type}.${edge.fromPort} (${fromPort.type}) → ${toNode.type}.${edge.toPort} (${toPort.type})` });
    }
    if (!toPort.multiple) {
      const others = wf.edges.filter((e) => e.to === edge.to && e.toPort === edge.toPort && e.id !== edge.id);
      if (others.length) {
        issues.push({ severity: 'error', code: 'edge-merge-conflict', edgeId: edge.id, message: `input port "${edge.toPort}" of "${edge.to}" accepts a single edge (use a merge node)` });
      }
    }
  }

  /* ── reachability ──────────────────────────────────────────────── */
  const inDegree = new Map<string, number>();
  for (const n of wf.nodes) inDegree.set(n.id, 0);
  for (const e of wf.edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);

  const entryIds = wf.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (!entryIds.length) {
    issues.push({ severity: 'warning', code: 'no-entry-node', message: 'the graph has no entry node — nothing can start it' });
  }

  const reachable = new Set<string>(entryIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of wf.edges) {
      if (reachable.has(e.from) && !reachable.has(e.to)) {
        reachable.add(e.to);
        changed = true;
      }
    }
  }
  for (const n of wf.nodes) {
    if (!reachable.has(n.id)) {
      issues.push({ severity: 'warning', code: 'unreachable-node', nodeId: n.id, message: `node "${n.label ?? n.id}" is not reachable from any entry node` });
    }
  }

  /* ── cycles: never legitimate ────────────────────────────────────
   * Loop, for-each, retry and timeout drive repetition internally —
   * their subtrees are DAGs that never return to the control node. Any
   * graph cycle would make the runtime spin forever, so every cycle is
   * an error, period. (A future feedback-loop feature must add its own
   * bounded control node rather than legitimizing raw cycles.) */
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycleStack: string[] = [];

  const visit = (id: string): void => {
    if (done.has(id) || !reachable.has(id)) return;
    if (visiting.has(id)) {
      const cycleNodes = [...cycleStack.slice(cycleStack.lastIndexOf(id)), id];
      issues.push({
        severity: 'error',
        code: 'cycle',
        nodeId: id,
        message: `the graph contains a cycle (${cycleNodes.map((nid) => nodeById.get(nid)?.type ?? nid).join(' → ')}) — repetition belongs inside loop/for-each/retry/timeout nodes`,
      });
      return;
    }
    visiting.add(id);
    cycleStack.push(id);
    for (const e of wf.edges) if (e.from === id) visit(e.to);
    cycleStack.pop();
    visiting.delete(id);
    done.add(id);
  };
  for (const id of entryIds) visit(id);

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function issuesSummary(issues: ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return errors ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : `${warnings} warning${warnings === 1 ? '' : 's'}`;
}