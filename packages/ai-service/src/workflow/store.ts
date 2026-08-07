/**
 * Workflow store — persistent local workflow library.
 * ==================================================================
 * One JSON file per workflow under ~/.aura/workflows (AURA_HOME aware),
 * written atomically. Supports the full library surface: create, rename,
 * duplicate, delete, import, export, favorite, categories, recents.
 */

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { genId, type WfEdge, type WfNode, type Workflow, type WorkflowSummary } from './types';

const dir = () => {
  const d = homePath('workflows');
  mkdirSync(d, { recursive: true });
  return d;
};
const fileOf = (id: string) => path.join(dir(), `${id}.json`);
const now = () => new Date().toISOString();

function sanitize(wf: Partial<Workflow>, id: string): Workflow {
  const nodes: WfNode[] = Array.isArray(wf.nodes)
    ? wf.nodes.filter((n): n is WfNode => Boolean(n && typeof n.id === 'string' && typeof n.type === 'string')).map((n) => ({ id: n.id, type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, config: n.config && typeof n.config === 'object' ? n.config : {} }))
    : [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges: WfEdge[] = Array.isArray(wf.edges)
    ? wf.edges.filter((e): e is WfEdge => Boolean(e && ids.has(e.from) && ids.has(e.to))).map((e) => ({ id: typeof e.id === 'string' ? e.id : genId('e'), from: e.from, fromPort: typeof e.fromPort === 'string' ? e.fromPort : 'out', to: e.to }))
    : [];
  return {
    id,
    name: typeof wf.name === 'string' && wf.name.trim() ? wf.name.trim() : 'Untitled workflow',
    description: typeof wf.description === 'string' ? wf.description : '',
    category: typeof wf.category === 'string' && wf.category.trim() ? wf.category.trim() : 'General',
    favorite: wf.favorite === true,
    createdAt: typeof wf.createdAt === 'string' ? wf.createdAt : now(),
    updatedAt: now(),
    nodes,
    edges,
    webhookToken: typeof wf.webhookToken === 'string' && wf.webhookToken ? wf.webhookToken : undefined,
  };
}

export class WorkflowStore {
  list(): WorkflowSummary[] {
    const out: WorkflowSummary[] = [];
    for (const f of readdirSync(dir())) {
      if (!f.endsWith('.json')) continue;
      const wf = readJsonFile<Workflow | null>(path.join(dir(), f), null);
      if (!wf?.id) continue;
      out.push({ id: wf.id, name: wf.name, description: wf.description, category: wf.category, favorite: wf.favorite, createdAt: wf.createdAt, updatedAt: wf.updatedAt, nodeCount: wf.nodes.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Workflow | null {
    return readJsonFile<Workflow | null>(fileOf(id), null);
  }

  create(input: Partial<Workflow> = {}): Workflow {
    const wf = sanitize({ ...input, createdAt: now() }, genId('wf'));
    writeJsonFile(fileOf(wf.id), wf);
    return wf;
  }

  /** Full-definition save (the editor's Save). */
  save(id: string, def: Partial<Workflow>): Workflow | null {
    const existing = this.get(id);
    if (!existing) return null;
    const wf = sanitize({ ...existing, ...def, id, createdAt: existing.createdAt, favorite: def.favorite ?? existing.favorite }, id);
    writeJsonFile(fileOf(id), wf);
    return wf;
  }

  patch(id: string, partial: { name?: string; category?: string; favorite?: boolean; description?: string }): Workflow | null {
    const existing = this.get(id);
    if (!existing) return null;
    return this.save(id, { ...existing, ...partial });
  }

  duplicate(id: string): Workflow | null {
    const existing = this.get(id);
    if (!existing) return null;
    // Never carries the original's webhook token — a copy is a distinct
    // workflow and gets its own secret, lazily, the first time it needs one.
    return this.create({ ...existing, name: `${existing.name} copy`, favorite: false, webhookToken: undefined });
  }

  remove(id: string): boolean {
    try {
      rmSync(fileOf(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Import an exported definition (gets a fresh id). */
  import(def: Partial<Workflow>): Workflow {
    return this.create({ ...def, name: def.name ? `${def.name}` : 'Imported workflow' });
  }

  /** Lazily creates (once) and returns this workflow's inbound-trigger token, so an external system's own webhook config (GitHub, or anything else) can start a run without AURA needing an API client for that system. Idempotent — repeat calls return the same token until it's rotated. */
  ensureWebhookToken(id: string): string | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.webhookToken) return existing.webhookToken;
    const token = randomBytes(24).toString('hex');
    this.save(id, { ...existing, webhookToken: token });
    return token;
  }

  /** Invalidates the current token (if any) and issues a fresh one. */
  rotateWebhookToken(id: string): string | null {
    const existing = this.get(id);
    if (!existing) return null;
    const token = randomBytes(24).toString('hex');
    this.save(id, { ...existing, webhookToken: token });
    return token;
  }

  /** Constant-time-enough equality for a local single-user app — proportionate to this codebase's existing safety posture (see nodes.ts's sandboxedFetch comment), not a multi-tenant secret-comparison threat model. */
  verifyWebhookToken(id: string, token: string): Workflow | null {
    const wf = this.get(id);
    if (!wf?.webhookToken || !token || wf.webhookToken !== token) return null;
    return wf;
  }
}
