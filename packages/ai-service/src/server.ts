import http from 'node:http';
import fs from 'node:fs';
import { WorkspaceManager } from './workspace';
import type { PipelineOptions, StreamEmit } from './pipeline';
import { DEFAULT_SETTINGS } from './settings';
import type { MemoryKind } from './memory';
import { nodeSpecInfos } from './workflow/nodes';
import { TEMPLATES, instantiateTemplate } from './workflow/templates';
import type { RunEvent, Workflow } from './workflow/types';
import { setupProviders } from './provider';
import { graphifyGraphPath, graphifyJsonPath, graphifyStatus, runGraphify } from './graphify';
import { extractArchitectureLayers, layersFromFullstack } from './architectureExtractor';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};

function resolveHistory(manager: WorkspaceManager, b: Record<string, unknown>) {
  if (Array.isArray(b.history)) return b.history as { role: 'user' | 'assistant' | 'system'; content: string }[];
  const pid = typeof b.projectId === 'string' ? b.projectId : null;
  const cid = typeof b.conversationId === 'string' ? b.conversationId : null;
  if (!pid || !cid) return undefined;
  let h = manager.conversationHistory(pid, cid);
  const text = String(b.text ?? '');
  if (h.length && h[h.length - 1].role === 'user' && h[h.length - 1].content === text) h = h.slice(0, -1);
  return h.length ? h : undefined;
}

export interface ServiceHandle {
  port: number;
  url: string;
  manager: WorkspaceManager;
  close: () => Promise<void>;
}

export async function startService(opts: PipelineOptions & { port?: number; openPath?: string } = {}): Promise<ServiceHandle> {
  setupProviders();
  const manager = new WorkspaceManager(opts);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const p = manager.pipeline;

    try {
      /* ── health / settings / key ──────────────────────────────── */
      if (method === 'GET' && seg[0] === 'health') return json(res, 200, { health: await p.health(), key: p.keyStatus(), index: manager.indexStatus(), project: manager.currentProject() });
      if (method === 'GET' && (seg.length === 0 || seg[0] === 'settings')) return json(res, 200, { settings: p.getSettings(), models: [], defaults: DEFAULT_SETTINGS, key: p.keyStatus() });
      if (method === 'POST' && seg[0] === 'settings' && seg[1] === 'key') { const b = await readJson(req); return json(res, 200, p.setKey(String(b.apiKey ?? ''), Boolean(b.persist))); }
      if (method === 'DELETE' && seg[0] === 'settings' && seg[1] === 'key') { p.clearKey(); return json(res, 200, { ok: true }); }
      if (method === 'POST' && seg[0] === 'settings') { const b = await readJson(req); return json(res, 200, { settings: p.setSettings(b) }); }

      /* ── BYOAK provider endpoints ─────────────────────────────── */
      if (method === 'GET' && seg[0] === 'providers') {
        const providers = manager.listKnownProviders();
        const byoak = manager.byoakStatus();
        return json(res, 200, { providers, defaultProvider: null, connected: byoak.connected, active: byoak.active, activeModel: byoak.model, status: p.providerStatus });
      }
      if (method === 'POST' && seg[0] === 'providers' && seg[1] === 'connect') {
        const b = await readJson(req);
        const providerId = String(b.providerId ?? '');
        const apiKey = String(b.apiKey ?? '');
        if (!providerId || !apiKey) return json(res, 400, { ok: false, error: 'Provider ID and API key are required' });
        const result = await manager.connectProvider(providerId, apiKey);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (method === 'POST' && seg[0] === 'providers' && seg[1] === 'disconnect') {
        const b = await readJson(req);
        const providerId = String(b.providerId ?? '');
        manager.disconnectProvider(providerId);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && seg[0] === 'providers' && seg[1] === 'switch') {
        const b = await readJson(req);
        const providerId = String(b.providerId ?? '');
        if (!providerId || providerId === 'none') {
          manager.deactivateProvider();
          return json(res, 200, { ok: true, status: p.providerStatus });
        }
        const model = String(b.model ?? '');
        const result = manager.switchToProvider(providerId, model || undefined);
        return json(res, result.ok ? 200 : 400, { ok: result.ok, status: p.providerStatus, error: result.error });
      }
      if (method === 'GET' && seg[0] === 'providers' && seg[1] === 'models') {
        const b = (seg[3] ? { providerId: seg[2], apiKey: seg[3] } : await readJson(req)) as { providerId?: string; apiKey?: string };
        if (!b.providerId || !b.apiKey) return json(res, 400, { models: [] });
        const models = await manager.discoverModels(b.providerId, b.apiKey);
        return json(res, 200, { models });
      }

      /* ── index status ─────────────────────────────────────────── */
      if (method === 'GET' && seg[0] === 'index') return json(res, 200, manager.indexStatus());
      if (method === 'POST' && seg[0] === 'reindex') return json(res, 200, await p.reindex());

      /* ── projects ─────────────────────────────────────────────── */
      if (seg[0] === 'projects') {
        if (seg.length === 1) {
          if (method === 'GET') return json(res, 200, { projects: manager.listProjects(), current: manager.currentProject() });
          if (method === 'POST') {
            const b = await readJson(req);
            try { return json(res, 200, manager.addProject({ name: b.name as string, path: String(b.path ?? ''), icon: b.icon as string })); }
            catch (e) { return json(res, 400, { error: (e as Error).message }); }
          }
        }
        const id = seg[1];
        if (seg[2] === 'open' && method === 'POST') {
          try { return json(res, 200, manager.open(id)); }
          catch (e) { return json(res, 404, { error: (e as Error).message }); }
        }
        if (seg[2] === 'profile' && method === 'GET') {
          const prof = manager.profile(id);
          return prof ? json(res, 200, prof) : json(res, 404, { error: 'no profile' });
        }
        if (seg[2] === 'conversations') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { conversations: manager.listConversations(id) });
          if (seg.length === 3 && method === 'POST') { const b = await readJson(req); return json(res, 200, manager.createConversation(id, b.title as string | undefined)); }
          const cid = seg[3];
          if (seg.length === 4 && method === 'GET') { const c = manager.getConversation(id, cid); return c ? json(res, 200, c) : json(res, 404, { error: 'no such conversation' }); }
          if (seg.length === 4 && (method === 'PATCH' || method === 'POST')) { const b = await readJson(req); const c = manager.renameConversation(id, cid, String(b.title ?? '')); return c ? json(res, 200, c) : json(res, 404, { error: 'no such conversation' }); }
          if (seg.length === 4 && method === 'DELETE') return json(res, 200, { ok: manager.removeConversation(id, cid) });
          if (seg[4] === 'message' && method === 'POST') { const b = await readJson(req); return json(res, 200, manager.appendMessage(id, cid, { role: b.role === 'assistant' ? 'assistant' : 'user', content: String(b.content ?? ''), meta: b.meta, error: Boolean(b.error) }) ?? { error: 'no such conversation' }); }
        }
        if (seg[2] === 'graph' && method === 'GET') { const kg = manager.knowledgeGraph(id); return kg ? json(res, 200, kg) : json(res, 404, { error: 'project not open' }); }
        if (seg[2] === 'intelligence' && method === 'GET') { const r = manager.projectIntelligence(id); return r ? json(res, 200, r) : json(res, 404, { error: 'no such project' }); }
        if (seg[2] === 'graphify' && seg[3] === 'status' && method === 'GET') {
          return json(res, 200, graphifyStatus(id));
        }
        if (seg[2] === 'graphify' && seg[3] === 'generate' && method === 'POST') {
          const proj = manager.registry.get(id);
          if (!proj) return json(res, 404, { error: 'no such project' });
          runGraphify(id, proj.path);
          return json(res, 200, { ok: true, phase: graphifyStatus(id).phase });
        }
        if (seg[2] === 'graphify' && method === 'GET') {
          const gp = graphifyGraphPath(id);
          if (!gp) return json(res, 404, { error: 'graphify not run yet' });
          const html = fs.readFileSync(gp, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS });
          res.end(html);
          return;
        }
        if (seg[2] === 'architecture-layers' && method === 'GET') {
          const name = manager.registry.get(id)?.name;
          const jp = graphifyJsonPath(id);
          // Prefer the rich graphify graph; fall back to AURA's FullStack graph
          // for the mounted project so EVERY project shows real, unique layers
          // even before graphify has finished (never the generic default).
          let layers = jp ? extractArchitectureLayers(jp, name) : [];
          if (layers.length <= 1 && p.currentProjectId === id) {
            const g = p.graphView() as { entities?: { id: string; name: string; relPath: string }[]; relations?: { from: string; to: string }[] };
            if (g.entities?.length) layers = layersFromFullstack(g.entities, g.relations ?? [], name);
          }
          return json(res, 200, { layers });
        }
        if (seg[2] === 'memory') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { items: manager.listMemory(id) });
          if (seg.length === 3 && method === 'POST') {
            const b = await readJson(req);
            return json(res, 200, manager.addMemory(id, { kind: (b.kind as MemoryKind) ?? 'conversation', title: String(b.title ?? ''), body: String(b.body ?? ''), pinned: Boolean(b.pinned) }));
          }
          const memId = seg[3];
          if (seg[4] === 'pin' && method === 'POST') {
            const b = await readJson(req);
            const item = manager.pinMemory(id, memId, Boolean(b.pinned));
            return item ? json(res, 200, item) : json(res, 404, { error: 'no such memory' });
          }
          if (seg.length === 4 && method === 'DELETE') return json(res, 200, { ok: manager.removeMemory(id, memId) });
        }
        if (seg.length === 2) {
          if (method === 'PATCH' || method === 'POST') {
            const b = await readJson(req);
            try {
              let rec = manager.registry.get(id);
              if (!rec) return json(res, 404, { error: 'no such project' });
              if (typeof b.name === 'string') rec = manager.renameProject(id, b.name);
              if (typeof b.favorite === 'boolean') rec = manager.setFavorite(id, b.favorite);
              return json(res, 200, rec);
            } catch (e) { return json(res, 400, { error: (e as Error).message }); }
          }
          if (method === 'DELETE') return json(res, 200, { ok: manager.removeProject(id) });
        }
      }

      /* ── workflows ────────────────────────────────────────────── */
      if (seg[0] === 'workflows') {
        const wfs = manager.workflows;
        if (seg[1] === 'specs' && method === 'GET') return json(res, 200, { specs: nodeSpecInfos() });
        if (seg[1] === 'templates' && method === 'GET') return json(res, 200, { templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, nodeCount: t.nodes.length })) });
        if (seg[1] === 'import' && method === 'POST') { const b = await readJson(req); return json(res, 200, wfs.import((b.def ?? b) as Partial<Workflow>)); }
        if (seg.length === 1) {
          if (method === 'GET') return json(res, 200, { workflows: wfs.list() });
          if (method === 'POST') {
            const b = await readJson(req);
            const fromTemplate = typeof b.template === 'string' ? instantiateTemplate(b.template) : null;
            if (typeof b.template === 'string' && !fromTemplate) return json(res, 404, { error: 'no such template' });
            return json(res, 200, wfs.create(fromTemplate ?? { name: b.name as string | undefined, category: b.category as string | undefined }));
          }
        }
        const id = seg[1];
        if (seg[2] === 'duplicate' && method === 'POST') { const wf = wfs.duplicate(id); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
        if (seg[2] === 'export' && method === 'GET') { const wf = wfs.get(id); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
        if (seg[2] === 'run' && method === 'POST') {
          const wf = wfs.get(id);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          const b = await readJson(req);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          const emit = (e: RunEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
          try {
            await manager.runWorkflow(wf, (b.inputs ?? {}) as Record<string, string>, emit, ac.signal);
          } catch (e) {
            emit({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message });
          }
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          return;
        }
        if (seg.length === 2) {
          if (method === 'GET') { const wf = wfs.get(id); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'PUT') { const b = await readJson(req); const wf = wfs.save(id, b as Partial<Workflow>); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'PATCH') { const b = await readJson(req); const wf = wfs.patch(id, b as { name?: string; favorite?: boolean; category?: string }); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'DELETE') return json(res, 200, { ok: wfs.remove(id) });
        }
      }

      /* ── workspace-level intelligence (cross-repository) ───────── */
      if (method === 'GET' && seg[0] === 'workspace' && seg[1] === 'intelligence') return json(res, 200, manager.workspaceIntelligence());

      /* ── real project views ───────────────────────────────────── */
      if (method === 'GET' && seg[0] === 'graph') return json(res, 200, p.graphView());
      if (method === 'POST' && seg[0] === 'retrieve') { const b = await readJson(req); return json(res, 200, p.retrieve(String(b.text ?? ''))); }

      /* ── runtime models (of the active provider, if any) ──────── */
      if (method === 'GET' && seg[0] === 'models') {
        const models = (await p.runtimeManager.runtime?.listModels()) ?? [];
        return json(res, 200, {
          provider: p.runtimeManager.getProviderId(),
          defaultModel: p.runtimeManager.getModel(),
          models,
        });
      }

      /* ── AI pipeline ──────────────────────────────────────────── */
      if (method === 'POST' && seg[0] === 'inspect') { const b = await readJson(req); return json(res, 200, await p.inspect(String(b.text ?? ''))); }
      if (method === 'POST' && seg[0] === 'ask') {
        const b = await readJson(req);
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const history = resolveHistory(manager, b);
        return json(res, 200, await p.ask(String(b.text ?? ''), ac.signal, history));
      }
      if (method === 'POST' && seg[0] === 'stream') {
        const b = await readJson(req);
        console.error('[TRACE:SERVER] /stream POST received:', { textLen: String(b.text ?? '').length, projectId: b.projectId, conversationId: b.conversationId });
        console.error('[TRACE:SERVER] Current pipeline project:', p.currentProjectId);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const history = resolveHistory(manager, b);
        console.error('[TRACE:SERVER] History resolved:', { historyLen: history?.length ?? 0 });
        const emit = (e: StreamEmit) => { console.error('[TRACE:SERVER] emit:', e.type, e.type === 'token' ? { textLen: e.text.length } : e.type === 'done' ? { finishReason: e.finishReason, usage: e.usage } : e.type === 'error' ? e.error : e.type === 'meta' ? { contextTokens: e.meta.contextTokens } : ''); if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
        console.error('[TRACE:SERVER] Calling streamEvents...');
        const t0 = Date.now();
        await p.streamEvents(String(b.text ?? ''), emit, ac.signal, history);
        console.error('[TRACE:SERVER] streamEvents returned in', Date.now() - t0, 'ms');
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  const port = opts.port ?? 4319;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return { port: addr.port, url: `http://127.0.0.1:${addr.port}`, manager, close: () => new Promise((r) => server.close(() => r())) };
}
