/**
 * Knowledge graph — the project's living brain, from real data only.
 * ==================================================================
 * Merges the FullStack Knowledge Engine's real entity/relation graph
 * (files, classes, functions, services, endpoints, tables, docs…) with
 * the project's real Memory and Conversations into one typed node/edge
 * graph. Nothing is invented: memory/conversation/decision nodes exist
 * only if the user actually created them, and a memory→file edge is
 * drawn only when the memory text really references that file/entity.
 */

import type { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import type { ProjectMemory } from './memory';
import type { ProjectConversations } from './conversations';

export interface GraphNode {
  id: string;
  type: 'file' | 'class' | 'function' | 'component' | 'service' | 'endpoint' | 'table' | 'doc' | 'module' | 'config' | 'memory' | 'decision' | 'conversation';
  label: string;
  group: 'frontend' | 'backend' | 'database' | 'config' | 'docs' | 'memory' | 'conversation';
  relPath?: string;
  line?: number;
  detail?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}
export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Record<string, number>;
}

const ENTITY_TYPE: Record<string, GraphNode['type']> = {
  page: 'component', component: 'component', layout: 'component', hook: 'function', route: 'module', 'api-client': 'module', 'state-store': 'module', asset: 'file',
  endpoint: 'endpoint', controller: 'class', service: 'service', repository: 'class', middleware: 'module', 'auth-guard': 'class',
  'orm-model': 'class', table: 'table', migration: 'file',
  'env-var': 'config', dependency: 'module', dockerfile: 'config', 'compose-service': 'config', 'ci-pipeline': 'config', 'build-config': 'config',
  'arch-module': 'module', doc: 'doc',
};
const LAYER_GROUP: Record<string, GraphNode['group']> = { frontend: 'frontend', backend: 'backend', database: 'database', config: 'config', docs: 'docs', infra: 'config', architecture: 'docs' };

/** Build the merged, real knowledge graph for the mounted project. */
export function buildKnowledgeGraph(
  fullstack: FullStackKnowledgeEngine,
  memory: ProjectMemory,
  conversations: ProjectConversations,
  opts: { maxEntities?: number } = {},
): KnowledgeGraph {
  const g = fullstack.graph();
  const max = opts.maxEntities ?? 220;

  // Rank entities so the most-connected survive the cap (real signal).
  const degree = new Map<string, number>();
  for (const r of g.relations) { degree.set(r.from, (degree.get(r.from) ?? 0) + 1); degree.set(r.to, (degree.get(r.to) ?? 0) + 1); }
  const entities = [...g.entities].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, max);
  const kept = new Set(entities.map((e) => e.id));

  const nodes: GraphNode[] = entities.map((e) => ({
    id: e.id,
    type: ENTITY_TYPE[e.kind] ?? 'module',
    label: e.name,
    group: LAYER_GROUP[e.layer] ?? 'config',
    relPath: e.relPath,
    line: e.line,
    detail: e.summary ?? `${e.kind} in ${e.relPath}`,
  }));
  const edges: GraphEdge[] = g.relations.filter((r) => kept.has(r.from) && kept.has(r.to)).map((r) => ({ from: r.from, to: r.to, kind: r.kind }));

  // Memory + decisions as real nodes, linked to any entity they mention.
  const entityByName = new Map<string, string>();
  for (const e of entities) entityByName.set(e.name.toLowerCase(), e.id);
  for (const item of memory.list()) {
    const nid = `memory:${item.id}`;
    nodes.push({ id: nid, type: item.kind === 'decision' ? 'decision' : 'memory', label: item.title, group: 'memory', detail: item.body.slice(0, 240) });
    const text = `${item.title} ${item.body}`.toLowerCase();
    for (const [name, eid] of entityByName) {
      if (name.length >= 4 && text.includes(name)) { edges.push({ from: nid, to: eid, kind: 'references' }); }
    }
  }

  // Conversations as real nodes (one per conversation the user created).
  for (const c of conversations.list()) {
    nodes.push({ id: `conv:${c.id}`, type: 'conversation', label: c.title, group: 'conversation', detail: `${c.messageCount} messages · ${c.preview}` });
  }

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return { nodes, edges, counts };
}
