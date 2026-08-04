/**
 * AI Workflow Builder — natural language to a real, valid workflow graph.
 * ==================================================================
 * Calls the same `pipeline.generate` seam every other AI feature in this
 * app already uses (chat, mission planning) — no new AI integration. The
 * system prompt enumerates the real NODE_SPECS registry so the model can
 * only reference node types that actually exist; the response is strictly
 * validated (real node types, real edge endpoints, real output ports)
 * before anything is returned — an invalid graph is rejected with a
 * specific reason, never silently accepted half-broken. Positions are
 * computed here (a simple left-to-right topological layout), not trusted
 * from the model, so a generated graph always renders cleanly.
 */
import type { PipelineManager } from '../pipeline';
import { NODE_SPECS, nodeSpecInfos } from './nodes';
import { genId, type WfEdge, type WfNode } from './types';

const NODE_W = 220;
const COL_GAP = 90;
const ROW_H = 140;

function specCatalog(): string {
  return nodeSpecInfos()
    .filter((s) => !s.disabled)
    .map((s) => {
      const fields = s.fields.length ? s.fields.map((f) => `${f.key}:${f.kind}${f.options ? `[${f.options.join('|')}]` : ''}`).join(', ') : 'none';
      return `- ${s.type} (${s.category}) — ${s.description} | inputs: ${s.inputs} | outputs: ${s.outputs.join(', ') || 'none (terminal)'} | fields: ${fields}`;
    })
    .join('\n');
}

function systemPrompt(): string {
  return `You design workflow automation graphs for AURA Hub's real workflow engine. You may ONLY use the node types listed below — never invent a type that isn't in this list.

Available node types:
${specCatalog()}

Rules:
- Output ONLY strict JSON, no prose, no markdown fences: { "name": string, "description": string, "nodes": [{ "id": string, "type": string, "config": object }], "edges": [{ "from": string, "fromPort": string, "to": string }] }
- Every node "id" must be unique and referenced correctly by edges.
- "fromPort" must be one of that source node's real output ports (most nodes have a single "out" port; "condition" has "true"/"false"; "loop" has "each"/"done"). Omit fromPort only if the source node has exactly one output port.
- Only connect an edge into a node whose "inputs" is not 0.
- Keep "config" fields to the field keys listed for that node type; leave a field out if you don't have a good value rather than guessing.
- Build a real, runnable sequence that matches the user's request — prefer a small correct graph over a large speculative one.
- Every workflow should end in at least one "output" node so results are visible.`;
}

export interface GeneratedGraph {
  name: string;
  description: string;
  nodes: WfNode[];
  edges: WfEdge[];
}

export type GenerateWorkflowResult =
  | ({ ok: true } & GeneratedGraph)
  | { ok: false; error: string };

interface RawNode { id?: unknown; type?: unknown; config?: unknown }
interface RawEdge { from?: unknown; fromPort?: unknown; to?: unknown }
interface RawGraph { name?: unknown; description?: unknown; nodes?: unknown; edges?: unknown }

function validateAndLayout(raw: RawGraph): GeneratedGraph | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'the model did not return an object' };
  const rawNodes = Array.isArray(raw.nodes) ? (raw.nodes as RawNode[]) : [];
  if (!rawNodes.length) return { error: 'the generated graph has no nodes' };

  const seenIds = new Set<string>();
  const nodes: WfNode[] = [];
  for (const rn of rawNodes) {
    const id = typeof rn.id === 'string' && rn.id.trim() ? rn.id.trim() : null;
    const type = typeof rn.type === 'string' ? rn.type : '';
    if (!id) return { error: 'a node is missing a valid id' };
    if (seenIds.has(id)) return { error: `duplicate node id: ${id}` };
    const nodeSpec = (NODE_SPECS as Record<string, (typeof NODE_SPECS)[keyof typeof NODE_SPECS] | undefined>)[type];
    if (!nodeSpec || nodeSpec.disabled) return { error: `unknown or disabled node type: "${type}"` };
    seenIds.add(id);
    nodes.push({ id, type: type as WfNode['type'], x: 0, y: 0, config: rn.config && typeof rn.config === 'object' ? (rn.config as Record<string, unknown>) : {} });
  }

  const rawEdges = Array.isArray(raw.edges) ? (raw.edges as RawEdge[]) : [];
  const edges: WfEdge[] = [];
  for (const re of rawEdges) {
    const from = typeof re.from === 'string' ? re.from : '';
    const to = typeof re.to === 'string' ? re.to : '';
    if (!seenIds.has(from) || !seenIds.has(to)) return { error: `an edge references a node id that doesn't exist (${from || '?'} -> ${to || '?'})` };
    const fromNode = nodes.find((x) => x.id === from) as WfNode;
    const fromSpec = NODE_SPECS[fromNode.type];
    const fromPort = typeof re.fromPort === 'string' && re.fromPort ? re.fromPort : (fromSpec.outputs[0] ?? 'out');
    if (!fromSpec.outputs.includes(fromPort)) return { error: `"${fromNode.type}" has no output port "${fromPort}"` };
    const toNode = nodes.find((x) => x.id === to) as WfNode;
    const toSpec = NODE_SPECS[toNode.type];
    if (toSpec.inputs === 0) return { error: `"${toNode.type}" does not accept an input (edge into ${to})` };
    edges.push({ id: genId('e'), from, fromPort, to });
  }

  // Auto-layout: left-to-right by topological depth from entry nodes (no
  // incoming edges). Purely cosmetic — the engine independently validates/
  // executes the graph regardless of position, so this doesn't need to be
  // a bulletproof topological sort, just bounded and deterministic.
  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  for (const node of nodes) inDeg.set(node.id, 0);
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    (outAdj.get(e.from) ?? outAdj.set(e.from, []).get(e.from)!).push(e.to);
  }
  const depth = new Map<string, number>();
  const queue: string[] = nodes.filter((node) => (inDeg.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  let head = 0;
  let iterations = 0;
  while (head < queue.length && iterations < nodes.length * 4) {
    iterations++;
    const id = queue[head++];
    for (const next of outAdj.get(id) ?? []) {
      const d = (depth.get(id) ?? 0) + 1;
      if (d > (depth.get(next) ?? -1) && d < nodes.length + 5) {
        depth.set(next, d);
        queue.push(next);
      }
    }
  }
  for (const node of nodes) if (!depth.has(node.id)) depth.set(node.id, 0);

  const byDepth = new Map<number, string[]>();
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(node.id);
  }
  for (const [d, ids] of byDepth) {
    ids.forEach((id, row) => {
      const node = nodes.find((x) => x.id === id) as WfNode;
      node.x = 60 + d * (NODE_W + COL_GAP);
      node.y = 60 + row * ROW_H;
    });
  }

  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Generated workflow',
    description: typeof raw.description === 'string' ? raw.description : '',
    nodes,
    edges,
  };
}

export async function generateWorkflow(pipeline: PipelineManager, text: string): Promise<GenerateWorkflowResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'describe the workflow you want' };
  const res = await pipeline.generate({ system: systemPrompt(), user: trimmed, json: true });
  // Labeled explicitly: this failure is from the active AI provider's own
  // API call (e.g. a 404 here means the provider rejected the request —
  // often an active-provider/active-model mismatch — not that an AURA
  // route was missing). An unlabeled "404: ..." string reads exactly like
  // a routing failure and is genuinely easy to misdiagnose as one.
  if (!res.ok) return { ok: false, error: `AI provider request failed (${res.error.type}): ${res.error.message}` };
  const cleaned = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let raw: RawGraph;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'the model did not return valid JSON' };
  }
  const result = validateAndLayout(raw);
  if ('error' in result) return { ok: false, error: result.error };
  return { ok: true, ...result };
}
