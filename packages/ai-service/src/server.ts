import http from 'node:http';
import fs from 'node:fs';
import { WorkspaceManager } from './workspace';
import type { PipelineOptions, StreamEmit } from './pipeline';
import { DEFAULT_SETTINGS } from './settings';
import type { MemoryKind } from './memory';
import type { ConfidenceLevel, ImportanceLevel, MemoryCategory } from '@aura/engineering-memory';
import { nodeSpecInfos } from './workflow/nodes';
import { TEMPLATES, instantiateTemplate } from './workflow/templates';
import { generateWorkflow } from './workflow/generate';
import type { RunEvent, Workflow } from './workflow/types';
import { setupProviders } from './provider';
import { graphifyGraphPath, graphifyStatus, runGraphify } from './graphify';
import { handleCodeAction, type CodeActionRequest } from './codeAction';
import { AUTOMATION_TEMPLATES, instantiateAutomationTemplate } from '@aura/automation';
import type { AutomationEvent, AutomationRule } from '@aura/automation';
import { automationEvent } from './automation';
import type { DiagnosisEvent, DiagnosisRequest } from './diagnosis/types';
import type { MissionEvent } from './mission/types';
import type { ExecutionEvent } from './mission/execution/types';
import {
  getEngineeringScorecard,
  getEngineeringAudit,
  getProjectInsights,
  getArchitectureCouncil,
  type AuditScope,
} from '@aura/governance';

const CORS = {
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** Local-only server: reflect the origin only for known local clients. */
const ALLOWED_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const fail = (err: HttpError) => { if (!settled) { settled = true; reject(err); } };
    req.on('data', (c) => {
      if (settled) return;
      raw += c;
      if (raw.length > MAX_BODY_BYTES) fail(new HttpError(413, 'request body too large'));
    });
    req.on('error', () => fail(new HttpError(400, 'invalid request body')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'malformed JSON body'));
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

  // Auto-connect providers configured through environment variables
  // (e.g. MISTRAL_API_KEY) so an env-configured key is active on startup.
  await manager.connectEnvProviders().catch((e) => {
    console.warn('[providers] env auto-connect failed:', (e as Error).message);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGIN.test(origin)) res.setHeader('access-control-allow-origin', origin);
    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const p = manager.pipeline;

    try {
      /* ── health / settings / key ──────────────────────────────── */
      if (method === 'GET' && seg[0] === 'health') return json(res, 200, { health: await p.health(), key: p.keyStatus(), index: manager.indexStatus(), project: manager.currentProject() });
      if (method === 'GET' && (seg.length === 0 || seg[0] === 'settings')) return json(res, 200, { settings: p.getSettings(), defaults: DEFAULT_SETTINGS, key: p.keyStatus() });
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
        const result = await manager.switchToProvider(providerId, model || undefined);
        return json(res, result.ok ? 200 : 400, { ok: result.ok, status: p.providerStatus, error: result.error });
      }
      if ((method === 'GET' || method === 'POST') && seg[0] === 'providers' && seg[1] === 'models') {
        const b = (seg[3] ? { providerId: seg[2], apiKey: seg[3] } : await readJson(req)) as { providerId?: string; apiKey?: string };
        if (!b.providerId || !b.apiKey) return json(res, 400, { models: [] });
        const models = await manager.discoverModels(b.providerId, b.apiKey);
        return json(res, 200, { models });
      }

      /* ── index status ─────────────────────────────────────────── */
      if (method === 'GET' && seg[0] === 'index') return json(res, 200, manager.indexStatus());
      if (method === 'POST' && seg[0] === 'reindex') return json(res, 200, await p.reindex());

      /* ── global engineering dashboard (across all projects) ────── */
      if (method === 'GET' && seg[0] === 'missions' && seg[1] === 'dashboard') {
        return json(res, 200, manager.missionDashboard());
      }

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
          if (seg[4] === 'message' && seg[5] === 'last' && method === 'DELETE') return json(res, 200, { ok: manager.removeLastAssistantMessage(id, cid) });
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
          const stack = manager.resolveArchitectureLayers(id);
          return json(res, 200, { layers: stack.layers, edges: stack.edges });
        }
        if (seg[2] === 'changes' && method === 'GET') {
          const log = manager.changeLog(id);
          return log ? json(res, 200, log) : json(res, 404, { error: 'no such project' });
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
        if (seg[2] === 'engineering-memory') {
          // The richer Engineering Memory platform (missions/diagnoses/decisions/
          // patches) — distinct from the simple Project Memory above. The manager
          // methods already exist (used internally on mission/diagnosis events);
          // this just exposes them over HTTP for the first time.
          if (method === 'GET') return json(res, 200, { items: manager.listEngineeringMemory(id) });
          if (method === 'POST') {
            const b = await readJson(req);
            const item = manager.addEngineeringMemory({
              projectId: id,
              category: (b.category as MemoryCategory) ?? 'knowledge-update',
              importance: (b.importance as ImportanceLevel) ?? 'medium',
              confidence: (b.confidence as ConfidenceLevel) ?? 'medium',
              relatedFiles: Array.isArray(b.relatedFiles) ? b.relatedFiles.map(String) : [],
              relatedSymbols: Array.isArray(b.relatedSymbols) ? b.relatedSymbols.map(String) : [],
              relatedMissionId: typeof b.relatedMissionId === 'string' ? b.relatedMissionId : undefined,
              relatedDiagnosisId: typeof b.relatedDiagnosisId === 'string' ? b.relatedDiagnosisId : undefined,
              tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
              summary: String(b.summary ?? ''),
              detailedRecord: String(b.detailedRecord ?? ''),
              references: Array.isArray(b.references) ? b.references : [],
            });
            return json(res, 200, item);
          }
        }
        if (seg[2] === 'diagnose') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { diagnoses: manager.listDiagnoses(id) });
          if (seg.length === 3 && method === 'POST') {
            const b = await readJson(req);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
            const ac = new AbortController();
            res.on('close', () => ac.abort());
            const emit = (e: DiagnosisEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
            const diagReq: Omit<DiagnosisRequest, 'projectId'> = {
              filePath: String(b.filePath ?? ''),
              language: String(b.language ?? ''),
              selectionRange: (b.selectionRange ?? null) as DiagnosisRequest['selectionRange'],
            };
            try {
              await manager.runDiagnosis(id, diagReq, emit, ac.signal);
            } catch (e) {
              emit({ type: 'error', message: (e as Error).message });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            return;
          }
          const did = seg[3];
          if (seg.length === 4 && method === 'GET') {
            const d = manager.getDiagnosis(id, did);
            return d ? json(res, 200, d) : json(res, 404, { error: 'no such diagnosis' });
          }
          if (seg[4] === 'accept' && method === 'POST') {
            const b = await readJson(req);
            const candidateId = b.candidateId;
            if (candidateId !== 'A' && candidateId !== 'B' && candidateId !== 'C') return json(res, 400, { error: 'candidateId (A|B|C) is required' });
            const result = manager.acceptDiagnosis(id, did, candidateId);
            return json(res, result.ok ? 200 : 400, result);
          }
          if (seg[4] === 'reject' && method === 'POST') {
            const b = await readJson(req);
            const candidateId = b.candidateId as 'A' | 'B' | 'C' | undefined;
            const result = manager.rejectDiagnosis(id, did, candidateId, typeof b.reason === 'string' ? b.reason : undefined);
            return json(res, result.ok ? 200 : 400, result);
          }
        }
        if (seg[2] === 'missions') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { missions: manager.listMissions(id) });
          if (seg.length === 3 && method === 'POST') {
            const b = await readJson(req);
            const text = String(b.text ?? '').trim();
            if (!text) return json(res, 400, { error: 'text is required' });
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
            const ac = new AbortController();
            res.on('close', () => ac.abort());
            const emit = (e: MissionEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
            try {
              await manager.runMissionCreation(id, text, emit, ac.signal);
            } catch (e) {
              emit({ type: 'error', message: (e as Error).message });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            return;
          }
          const mid = seg[3];
          if (seg.length === 4 && method === 'GET') {
            const m = manager.getMission(id, mid);
            return m ? json(res, 200, m) : json(res, 404, { error: 'no such mission' });
          }
          if (seg[4] === 'approve' && method === 'POST') {
            const m = manager.approveMission(id, mid);
            return m ? json(res, 200, m) : json(res, 404, { error: 'no such mission' });
          }
          if (seg[4] === 'reject' && method === 'POST') {
            const b = await readJson(req);
            const m = manager.rejectMission(id, mid, typeof b.reason === 'string' ? b.reason : undefined);
            return m ? json(res, 200, m) : json(res, 404, { error: 'no such mission' });
          }
          /* ── Mission Control v3 — execution lifecycle ──────────── */
          if (seg[4] === 'start' && method === 'POST') {
            const r = manager.startMissionExecution(id, mid);
            return json(res, r.ok ? 200 : 400, r);
          }
          if (seg[4] === 'execute' && method === 'POST') {
            const b = await readJson(req);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
            const ac = new AbortController();
            res.on('close', () => ac.abort());
            const emit = (e: ExecutionEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
            try {
              const result = await manager.runMissionBatch(id, mid, { maxParallel: typeof b.maxParallel === 'number' ? b.maxParallel : 2 }, emit);
              if (result.mission?.execution) emit({ type: 'execution', record: { id, projectId: id, execution: result.mission.execution } });
              if (!result.ok && result.error) emit({ type: 'error', message: result.error });
            } catch (e) {
              emit({ type: 'error', message: (e as Error).message });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            return;
          }
          if (seg[4] === 'pause' && method === 'POST') {
            const r = manager.pauseMissionExecution(id, mid);
            return json(res, r.ok ? 200 : 400, r);
          }
          if (seg[4] === 'resume' && method === 'POST') {
            const r = manager.resumeMissionExecution(id, mid);
            return json(res, r.ok ? 200 : 400, r);
          }
          if (seg[4] === 'cancel' && method === 'POST') {
            const b = await readJson(req);
            const r = manager.cancelMissionExecution(id, mid, typeof b.reason === 'string' ? b.reason : undefined);
            return json(res, r.ok ? 200 : 400, r);
          }
          if (seg[4] === 'review' && method === 'POST') {
            const b = await readJson(req);
            const r = manager.reviewMissionCheckpoint(id, mid, b.pass === true, typeof b.note === 'string' ? b.note : undefined);
            return json(res, r.ok ? 200 : 400, r);
          }
          if (seg[4] === 'replay' && method === 'GET') {
            const replay = manager.getMissionReplay(id, mid);
            return replay ? json(res, 200, replay) : json(res, 404, { error: 'no replay available' });
          }
          if (seg[4] === 'tasks' && method === 'POST') {
            const taskId = seg[5];
            if (seg[6] === 'run') {
              const ac = new AbortController();
              res.on('close', () => ac.abort());
              const result = await manager.runMissionTask(id, mid, taskId, ac.signal);
              return json(res, result.ok ? 200 : 400, result);
            }
            if (seg[6] === 'accept') return json(res, 200, manager.acceptMissionTask(id, mid, taskId));
            if (seg[6] === 'reject') {
              const r = manager.rejectMissionTask(id, mid, taskId);
              return json(res, r.ok ? 200 : 400, r);
            }
            if (seg[6] === 'complete') return json(res, 200, manager.completeManualTask(id, mid, taskId));
            if (seg[6] === 'retry') {
              const r = manager.retryMissionTask(id, mid, taskId);
              return json(res, r.ok ? 200 : 400, r);
            }
          }
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
        if (seg[1] === 'generate' && method === 'POST') {
          const b = await readJson(req);
          const result = await generateWorkflow(p, String(b.text ?? ''));
          if (!result.ok) return json(res, 400, { error: result.error });
          const { ok: _ok, ...graph } = result;
          const wf = wfs.create({ name: graph.name, description: graph.description, category: 'AI Generated', nodes: graph.nodes, edges: graph.edges });
          return json(res, 200, wf);
        }
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
        if (seg[2] === 'export' && method === 'GET') {
          const wf = wfs.get(id);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          // Export is for sharing/portability (copy elsewhere, check into
          // version control) — never include this workflow's private
          // trigger secret in that.
          const { webhookToken: _drop, ...portable } = wf;
          return json(res, 200, portable);
        }
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
        if (seg[2] === 'webhook-token' && method === 'POST') {
          const b = await readJson(req);
          const token = b.rotate === true ? wfs.rotateWebhookToken(id) : wfs.ensureWebhookToken(id);
          if (!token) return json(res, 404, { error: 'no such workflow' });
          return json(res, 200, { token, path: `/workflows/${id}/trigger/${token}` });
        }
        // Inbound trigger — an external system (GitHub's own webhook config,
        // or anything else) can start a run by POSTing here with the token
        // from the endpoint above. This is a fire-and-forget receiver, not
        // an SSE stream: webhook senders expect a fast ack, and there's no
        // client waiting to consume run events here, so the run executes in
        // the background against whichever project is currently mounted —
        // the same constraint the manual Run button already has.
        if (seg[2] === 'trigger' && method === 'POST') {
          const token = seg[3] ?? '';
          const wf = wfs.verifyWebhookToken(id, token);
          if (!wf) return json(res, 404, { error: 'no such workflow, or an invalid trigger token' });
          const payload = await readJson(req);
          const inputs: Record<string, string> = {};
          for (const n of wf.nodes) if (n.type === 'user-input') inputs[n.id] = JSON.stringify(payload);
          void manager.runWorkflow(wf, inputs, () => {}).catch((e) => {
            console.error(`[workflow trigger] run failed for ${id}:`, (e as Error).message);
          });
          return json(res, 202, { accepted: true });
        }
        if (seg.length === 2) {
          if (method === 'GET') { const wf = wfs.get(id); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'PUT') { const b = await readJson(req); const wf = wfs.save(id, b as Partial<Workflow>); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'PATCH') { const b = await readJson(req); const wf = wfs.patch(id, b as { name?: string; favorite?: boolean; category?: string }); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'DELETE') return json(res, 200, { ok: wfs.remove(id) });
        }
      }

      /* ── automation engine ──────────────────────────────────────── */
      if (seg[0] === 'automation') {
        const auto = manager.automation;
        if (seg[1] === 'templates' && method === 'GET') {
          return json(res, 200, { templates: AUTOMATION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category })) });
        }
        if (seg[1] === 'events' && method === 'POST') {
          const b = await readJson(req);
          const type = String(b.type ?? '') as AutomationEvent['type'];
          const projectId = String(b.projectId ?? '');
          if (!type || !projectId) return json(res, 400, { error: 'type and projectId are required' });
          const project = manager.registry.get(projectId);
          if (!project) return json(res, 404, { error: 'no such project' });
          auto.engine.handleEvent(automationEvent(type, projectId, project.path, (b.payload ?? {}) as Record<string, unknown>));
          return json(res, 200, { ok: true });
        }
        if (seg[1] === 'events' && seg[2] === 'stream' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
          res.write('data: {"type":"subscribed"}\n\n');
          const unsub = auto.subscribe((e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); });
          res.on('close', () => { unsub(); });
          return;
        }
        if (seg[1] === 'rules') {
          if (seg.length === 2) {
            if (method === 'GET') return json(res, 200, { rules: auto.store.listRules() });
            if (method === 'POST') {
              const b = await readJson(req);
              const fromTemplate = typeof b.template === 'string' ? instantiateAutomationTemplate(b.template) : null;
              if (typeof b.template === 'string' && !fromTemplate) return json(res, 404, { error: 'no such template' });
              return json(res, 200, auto.store.createRule(fromTemplate ?? (b as Record<string, unknown>)));
            }
          }
          const ruleId = seg[2];
          if (seg[3] === 'run' && method === 'POST') {
            const b = await readJson(req);
            const rule = auto.store.getRule(ruleId);
            if (!rule) return json(res, 404, { error: 'no such rule' });
            const projectId = String(b.projectId ?? '');
            const project = manager.registry.get(projectId);
            if (!project) return json(res, 400, { error: 'projectId is required' });
            const run = await auto.engine.runRuleNow(ruleId, automationEvent(rule.trigger.type, projectId, project.path, (b.payload ?? {}) as Record<string, unknown>));
            return run ? json(res, 200, run) : json(res, 200, { error: 'conditions not met', run: null });
          }
          if (seg[3] === 'pause' && method === 'POST') {
            const run = auto.engine.pauseRule(ruleId);
            return json(res, run ? 200 : 404, run ?? { error: 'no running run to pause' });
          }
          if (seg[3] === 'resume' && method === 'POST') {
            const run = auto.engine.resumeRule(ruleId);
            return json(res, run ? 200 : 404, run ?? { error: 'no paused run to resume' });
          }
          if (seg[3] === 'runs') {
            const runId = seg[4];
            // The list route only matches with no further segment — a bare
            // `method === 'GET'` check here would also swallow
            // `.../runs/:runId`, making the single-run route below dead code.
            if (!runId && method === 'GET') return json(res, 200, { runs: auto.store.listRuns(ruleId) });
            if (runId && seg[5] === 'cancel' && method === 'POST') {
              const run = auto.engine.cancelRun(ruleId, runId);
              return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
            }
            if (runId && method === 'GET') {
              const run = auto.store.getRun(ruleId, runId);
              return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
            }
          }
          if (seg.length === 3) {
            if (method === 'GET') { const r = auto.store.getRule(ruleId); return r ? json(res, 200, r) : json(res, 404, { error: 'no such rule' }); }
            if (method === 'PUT') { const b = await readJson(req); const r = auto.store.saveRule(ruleId, b as Partial<AutomationRule>); return r ? json(res, 200, r) : json(res, 404, { error: 'no such rule' }); }
            if (method === 'PATCH') { const b = await readJson(req); const r = auto.store.saveRule(ruleId, b as Partial<AutomationRule>); return r ? json(res, 200, r) : json(res, 404, { error: 'no such rule' }); }
            if (method === 'DELETE') return json(res, 200, { ok: auto.store.removeRule(ruleId) });
          }
        }
      }

      /* ── predictive engineering platform ───────────────────────── */
      if (seg[0] === 'predictive') {
        const { buildPredictiveEngine, missionContextFrom, candidateContextFrom } = await import('./predictive');
        const projectId = String(url.searchParams.get('projectId') ?? '');
        const project = manager.registry.get(projectId);
        const pathOf = (): string => {
          if (project?.path) return project.path;
          if (p.currentProjectId && manager.registry.get(p.currentProjectId)?.path) return manager.registry.get(p.currentProjectId)!.path;
          return '';
        };
        if (seg[1] === 'report' && method === 'GET') {
          const root = pathOf();
          if (!root) return json(res, 400, { error: 'projectId is required (or open a project)' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          return json(res, 200, engine.report());
        }
        if (seg[1] === 'mission' && seg[2] && method === 'GET') {
          const root = pathOf();
          if (!root) return json(res, 400, { error: 'projectId is required (or open a project)' });
          const ctx = missionContextFrom(projectId || p.currentProjectId || 'unknown', seg[2]);
          if (!ctx) return json(res, 404, { error: 'no such mission' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          return json(res, 200, engine.missionFailure(ctx));
        }
        if (seg[1] === 'candidate' && seg[2] && seg[3] && method === 'GET') {
          const root = pathOf();
          if (!root) return json(res, 400, { error: 'projectId is required (or open a project)' });
          const ctx = candidateContextFrom(projectId || p.currentProjectId || 'unknown', seg[2], seg[3]);
          if (!ctx) return json(res, 404, { error: 'no such diagnosis candidate' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          return json(res, 200, engine.proposalSuccess(ctx));
        }
        if (seg[1] === 'impact' && seg[2] && method === 'GET') {
          const root = pathOf();
          if (!root) return json(res, 400, { error: 'projectId is required (or open a project)' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          return json(res, 200, engine.impact(decodeURIComponent(seg[2])));
        }
        if (seg[1] === 'simulate' && method === 'POST') {
          const b = await readJson(req);
          const root = pathOf();
          if (!root || !b.target || !b.change) return json(res, 400, { error: 'projectId, target and change are required' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          return json(res, 200, engine.simulate(String(b.target), String(b.change) as 'modify' | 'add' | 'remove'));
        }
        if (seg[1] === 'explain' && method === 'POST') {
          const b = await readJson(req);
          const root = pathOf();
          if (!root) return json(res, 400, { error: 'projectId is required (or open a project)' });
          const engine = await buildPredictiveEngine({ projectId: project?.id ?? p.currentProjectId ?? 'unknown', projectPath: root });
          const report = engine.report();
          const lines: string[] = [
            `Predictive Engineering report for ${report.projectId} (deterministic, no ML).`,
            `Overall risk: ${report.risk.level} (${Math.round(report.risk.overall * 100)}%).`,
            `Dimensions: ${report.risk.dimensions.map((d) => `${d.label} ${Math.round(d.score * 100)}%`).join(', ')}.`,
            `Top predicted hotspots: ${report.hotspots.slice(0, 5).map((p) => `${p.target} (${Math.round(p.probability * 100)}%)`).join(', ') || 'none'}.`,
            `Predicted regressions: ${report.regressions.slice(0, 5).map((p) => `${p.target} (${Math.round(p.probability * 100)}%)`).join(', ') || 'none'}.`,
            `Upcoming architecture risks: ${report.architectureRisks.slice(0, 5).map((p) => `${p.target} (${Math.round(p.probability * 100)}%)`).join(', ') || 'none'}.`,
            `Suggested preventive actions: ${report.preventiveActions.slice(0, 8).join('; ') || 'none'}.`,
          ];
          if (b.predictionId) {
            const pred = report.predictions.find((x) => x.id === b.predictionId);
            if (pred) {
              lines.push(
                `\nPrediction ${pred.id} (${pred.kind}) on ${pred.target}:`,
                `- probability ${Math.round(pred.probability * 100)}%, severity ${pred.severity}, horizon ${pred.horizon}`,
                `- confidence ${Math.round(pred.confidence.score * 100)}% (${pred.confidence.signals} positive signals; ${pred.confidence.caveats.join(' ')})`,
                `- drivers: ${pred.drivers.map((d) => `${d.label}=${d.value}`).join('; ') || 'none'}`,
                `- preventive: ${pred.preventiveActions.join('; ') || 'none'}`,
              );
            }
          }
          return json(res, 200, { text: lines.join('\n'), report });
        }
        return json(res, 404, { error: 'no such predictive endpoint' });
      }

      /* ── workspace-level intelligence (cross-repository) ───────── */
      if (method === 'GET' && seg[0] === 'workspace' && seg[1] === 'intelligence') return json(res, 200, manager.workspaceIntelligence());

      /* ── engineering governance platform (Node-side scans) ─────── */
      if (seg[0] === 'governance' && method === 'POST') {
        const b = await readJson(req);
        const projectPath = typeof b.projectPath === 'string' && b.projectPath ? b.projectPath : manager.currentProject()?.path ?? null;
        if (!projectPath) return json(res, 400, { error: 'projectPath required' });
        if (seg[1] === 'scorecard') return json(res, 200, await getEngineeringScorecard({ projectPath }));
        if (seg[1] === 'audit') return json(res, 200, await getEngineeringAudit({ projectPath, scope: b.scope as AuditScope | undefined }));
        if (seg[1] === 'insights') return json(res, 200, await getProjectInsights({ projectPath }));
        if (seg[1] === 'council') return json(res, 200, await getArchitectureCouncil({ projectPath }));
        return json(res, 404, { error: 'not found' });
      }

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
      if (method === 'POST' && seg[0] === 'code' && seg[1] === 'action') {
        const b = await readJson(req);
        if (!b.filePath || !b.action) return json(res, 400, { error: 'filePath and action are required' });
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        return json(res, 200, await handleCodeAction(p, b as unknown as CodeActionRequest, ac.signal));
      }
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
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const history = resolveHistory(manager, b);
        const emit = (e: StreamEmit) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
        await p.streamEvents(String(b.text ?? ''), emit, ac.signal, history);
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
    }
  });

  const port = opts.port ?? 4319;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return { port: addr.port, url: `http://127.0.0.1:${addr.port}`, manager, close: () => new Promise((r) => server.close(() => r())) };
}
