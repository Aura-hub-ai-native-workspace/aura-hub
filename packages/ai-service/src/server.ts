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
import { WorkflowBridge } from './workflowBridge';
import { setupProviders } from './provider';
import { graphifyGraphPath, graphifyStatus, runGraphify } from './graphify';
import { handleCodeAction, type CodeActionRequest } from './codeAction';
import { CATALOG } from '@aura/connected-environment';
import { probeNode, scanEnvironment } from './environment';
import { CAPABILITY_MANIFEST, annotateMissionCapabilities, type InvocationContext, type NodeRef } from '@aura/capability-fabric';
import { createFabric } from './fabric';
import { verifyAuditChain, auditFilePath } from './fabric/auditStore';
import { drivableAgentBinaries } from './fabric/executors';
import { composeContextView, type ContextSources } from './context/compose';
import { renderContextContract } from './context/promptContract';
import { AURA_SYSTEM_PROMPT, buildAgentPrompt, measureAgentPrompt } from './context/systemPrompt';
import { scanAndDiff } from './intelligence';
import { CAPABILITIES } from '@aura/connected-environment';
import { savePolicy, policyFilePath } from './fabric/policyStore';
import { initUiToken, isUserDirect } from './uiToken';
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
  bridge: WorkflowBridge;
  close: () => Promise<void>;
}

export async function startService(opts: PipelineOptions & { port?: number; openPath?: string; onShutdownRequest?: () => void } = {}): Promise<ServiceHandle> {
  setupProviders();
  const manager = new WorkspaceManager(opts);

  /**
   * One Fabric for the process lifetime, so the audit trail is continuous.
   * Node availability is read at decision time from the last environment
   * scan, so connecting a tool takes effect without a restart.
   */
  let providedNodeCapabilities = new Set<string>();
  /**
   * Nodes that answered a probe, in catalogue order — the routing view of
   * the same scan that produces `providedNodeCapabilities`. Built here,
   * beside it, so the two can never describe different machines.
   */
  let presentNodes: NodeRef[] = [];
  let lastScanAt: string | null = null;

  /**
   * THE assembly of ContextSources. Every consumer — the Context panel
   * route, Ask AURA, and `agent.delegate` through the Fabric — goes
   * through this one function, so none of them can be told a different
   * story about the same project.
   *
   * Declared as a hoisted function so `createFabric` below can reference
   * it; `fabric` is initialised long before any invocation calls it.
   */
  async function contextViewFor(projectId: string, changes?: ReturnType<typeof scanAndDiff>['result']) {
    const proj = manager.registry.get(projectId);
    if (!proj) return null;
    const byoak = manager.byoakStatus();
    const sources: ContextSources = {
      project: proj,
      mountedProjectId: manager.pipeline.currentProjectId,
      profile: manager.profile(projectId),
      // Versions live in the scan result, not in NodeRef. Reporting null
      // is honest; inventing one from the catalogue would not be.
      presentNodes: presentNodes.map((n) => ({
        id: n.id, name: n.name, capabilities: n.capabilities, binary: n.binary, version: null,
      })),
      providedCapabilities: [...providedNodeCapabilities],
      knownCapabilities: Object.keys(CAPABILITIES),
      catalogueSize: CATALOG.length,
      scannedAt: lastScanAt,
      missions: manager.listMissions(projectId),
      pendingApprovals: fabric.pendingApprovals().length,
      // `active` and `model` ONLY. `byoakStatus()` also carries a key
      // fingerprint per provider; it is deliberately not read here.
      provider: {
        id: byoak.active,
        connected: byoak.active !== null,
        model: byoak.model || null,
      },
      drivableAgentBinaries: drivableAgentBinaries(),
      // Activity comes from the Fabric's audit log — the existing record
      // of what actually ran, scoped to this project. No new activity
      // store is introduced.
      changes,
      activity: fabric.audit()
        .filter((a) => a.projectId === projectId)
        .slice(-12)
        .reverse()
        .map((a) => ({
          at: a.at,
          kind: a.capabilityId,
          summary: `${a.outcome}${a.executedNodeId ? ` via ${a.executedNodeId}` : ''}${a.decision ? ` (${a.decision})` : ''}`,
        })),
    };
    return composeContextView(sources);
  }

  /** The canonical prompt for a delegated agent. Null when unavailable. */
  async function agentPromptFor(projectId: string, task: string): Promise<string | null> {
    const view = await contextViewFor(projectId);
    return view ? buildAgentPrompt({ view, task }) : null;
  }

  /**
   * The canonical context contract for ONE Ask AURA request.
   *
   * Returns the contract to pass down that request's call path — it is
   * never stored anywhere, so two concurrent requests cannot overwrite
   * each other (P0-2).
   *
   * ── One request, one project (P0-1) ──────────────────────────────
   * The canonical context is composed for the REQUESTED project, while
   * the retrieval half of the same request (`inspect` → identity,
   * summary, code excerpts, memory) is hard-scoped to whichever project
   * the pipeline has MOUNTED. If those differ, a single prompt would
   * carry `<PROJECT_CONTEXT>` for A alongside A's retrieved code — a
   * hybrid describing two projects at once.
   *
   * A mismatch is therefore refused, not reconciled. Specifically it is
   * NOT fixed by mounting the requested project: mounting starts
   * indexing and changes what every other surface sees, and a read must
   * never do that as a side effect. The caller mounts first, or asks
   * about the project that is already mounted.
   */
  type AuraContextResult =
    | { ok: true; contract: string | null; scan?: ReturnType<typeof scanAndDiff> }
    | { ok: false; conflict: { requested: string; mounted: string | null; message: string } };

  async function resolveAuraContext(body: Record<string, unknown>): Promise<AuraContextResult> {
    const requested = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    const mounted = manager.pipeline.currentProjectId;

    if (requested && requested !== mounted) {
      return {
        ok: false,
        conflict: {
          requested,
          mounted,
          message: mounted
            ? `This request asks about "${requested}" but AURA currently has "${mounted}" open. `
              + 'Open the project first — AURA will not answer using two projects at once.'
            : `This request asks about "${requested}" but AURA has no project open. `
              + 'Open the project first.',
        },
      };
    }

    const projectId = requested ?? mounted;
    if (!projectId) return { ok: true, contract: null };
    try {
      /* ONE tree walk for the whole request. The view needs the diff for
         freshness and the pipeline needs it for artifact staleness; they
         used to take one each, over the same tree, in the same request.
         The snapshot rides along so the pipeline can rebase the baseline —
         composing a view still never writes anything. */
      const proj = manager.registry.get(projectId);
      const scan = proj ? scanAndDiff(projectId, proj.path) : undefined;
      const view = await contextViewFor(projectId, scan?.result);
      return { ok: true, contract: view ? renderContextContract(view) : null, scan };
    } catch {
      // Context is an improvement to the answer, never a precondition for
      // one. A composition failure must not take Ask AURA down with it.
      return { ok: true, contract: null };
    }
  }

  const fabric = createFabric({
    agentPrompt: agentPromptFor,
    manager,
    providedNodeCapabilities: () => providedNodeCapabilities,
    presentNodes: () => presentNodes,
  });
  // Closes the loop: mission tasks now execute THROUGH this same Fabric
  // instance, so a task inherits the identical policy, approval,
  // verification, recovery and audit path as a direct /fabric/invoke.
  manager.attachFabric(fabric);

  /**
   * Scan the machine and publish what is genuinely reachable.
   *
   * Shared by boot and by `POST /environment/scan` so there is exactly one
   * place that decides what "available" means — a node counts only when it
   * actually answered a probe. Nothing is assumed present.
   */
  const refreshNodeAvailability = async (ids?: string[], refresh = false) => {
    const scan = await scanEnvironment(ids, refresh);
    const provided = new Set<string>();
    const nodes: NodeRef[] = [];
    // CATALOG order is the tie-break when several nodes provide the same
    // capability and the caller named none (§22.4 rule 4), so this is
    // walked in catalogue order rather than scan-result order.
    for (const entry of CATALOG) {
      const result = scan.results[entry.id];
      if (!result?.present) continue;
      for (const capability of entry.capabilities) provided.add(capability);
      nodes.push({
        id: entry.id,
        name: entry.name,
        capabilities: [...entry.capabilities],
        binary: entry.probe?.command,
      });
    }
    providedNodeCapabilities = provided;
    presentNodes = nodes;
    // Recorded so the Context Fabric can report WHEN the machine was last
    // measured. Context that cannot say how old it is has to say "unknown".
    lastScanAt = scan.scannedAt;
    return scan;
  };

  // Auto-connect providers configured through environment variables
  // (e.g. MISTRAL_API_KEY) so an env-configured key is active on startup.
  await manager.connectEnvProviders().catch((e) => {
    console.warn('[providers] env auto-connect failed:', (e as Error).message);
  });

  // Discover the environment before serving. Without this a restart left
  // every node-backed capability denied as `no-provider` until someone
  // happened to trigger a scan — git would be installed and working, and
  // the Fabric would still refuse `git.diff`.
  await refreshNodeAvailability().then(
    (scan) => console.log(`[environment] ${scan.found ?? providedNodeCapabilities.size} node(s) present · ${providedNodeCapabilities.size} capabilities available`),
    (e) => console.warn('[environment] boot scan failed:', (e as Error).message),
  );

  /**
   * The workflow bridge — the ONE production seam into @aura/workflow.
   *
   * Built after the Fabric exists (so every workflow side effect inherits
   * the same policy/approval/audit authority as missions), and before the
   * server accepts traffic. Boot does two things:
   *   - migrateAll(): the legacy ~/.aura/workflows store is converted
   *     once into workflow-defs/ (idempotent; legacy entries are kept and
   *     stay editable in the builder UI);
   *   - startScheduler(): scheduled/git/file/mission triggers for ready
   *     definitions begin firing through the host event sources.
   */
  const bridge = new WorkflowBridge({ fabric, manager });
  {
    const entries = bridge.migrateAll();
    const migrated = entries.filter((e) => e.outcome === 'migrated').length;
    const partial = entries.filter((e) => e.outcome === 'partial').length;
    console.log(`[workflows] boot migration: ${migrated} ready · ${partial} partial (unsupported nodes) · ${entries.length - migrated - partial} skipped/invalid of ${entries.length} legacy workflow(s)`);
    for (const e of entries.filter((x) => x.outcome === 'partial')) {
      console.warn(`[workflows] ${e.workflowId} (${e.name}) is not runnable in the new runtime:`);
      for (const u of e.unsupported) console.warn(`  - node ${u.nodeId} (${u.legacyType}): ${u.reason}`);
    }
  }
  bridge.startScheduler();

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

      /**
       * Graceful shutdown over the loopback port — the desktop shell's
       * Windows lifecycle path. Unix has SIGTERM (start.ts handles it);
       * Windows has no SIGTERM, so the supervisor asks the service to
       * close itself and only force-terminates a process that ignores it.
       * The `x-aura-shutdown` header is required: a cross-origin webpage
       * cannot send it (the CORS preflight this server does not allow
       * would block it), so this stays no more reachable to other local
       * processes than a signal is on Unix.
       */
      if (method === 'POST' && seg[0] === 'shutdown') {
        if (req.headers['x-aura-shutdown'] !== '1') {
          return json(res, 403, { error: 'shutdown requires the x-aura-shutdown header' });
        }
        json(res, 200, { ok: true, shuttingDown: true });
        opts.onShutdownRequest?.();
        return;
      }
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

      /* ── connected environment ────────────────────────────────
         Real capability detection. The command a probe runs always
         comes from the catalog entry looked up by id — never from the
         request — so no request can reach arbitrary execution. See
         environment.ts for the full boundary. */
      if (seg[0] === 'environment') {
        if (method === 'GET' && seg[1] === 'catalog') return json(res, 200, { catalog: CATALOG });
        if (method === 'POST' && seg[1] === 'scan') {
          const b = await readJson(req);
          const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : undefined;
          // A scan is also the Fabric's view of what is reachable: every
          // capability of every node that answered becomes available for
          // policy evaluation, with no separate connect step to drift from.
          const scan = await refreshNodeAvailability(ids, Boolean(b.refresh));
          return json(res, 200, { ...scan, providedCapabilities: [...providedNodeCapabilities].sort() });
        }
        if (method === 'POST' && seg[1] === 'probe') {
          const b = await readJson(req);
          const id = String(b.id ?? '');
          if (!id) return json(res, 400, { error: 'a node id is required' });
          return json(res, 200, { id, result: await probeNode(id, Boolean(b.refresh)) });
        }
      }

      /* ── capability fabric ─────────────────────────────────────
         The single governed path to a side effect. `invoke` runs the
         full chain: policy → approval → execute → verify → audit.
         Approval is per-call (`approvedCapabilities`); this service has
         no UI and therefore never grants one implicitly. */
      if (seg[0] === 'fabric') {
        if (method === 'GET' && seg[1] === 'capabilities') {
          const supported = new Set(fabric.supported());
          return json(res, 200, {
            capabilities: CAPABILITY_MANIFEST.map((c) => ({ ...c, supported: supported.has(c.id) })),
            supportedCount: supported.size,
            providedNodeCapabilities: [...providedNodeCapabilities].sort(),
            policy: fabric.getPolicy(),
          });
        }
        /* Tamper-evidence is only useful if something can ask. The chain
           is checked here, over the journal on disk, rather than over the
           in-memory log — the in-memory log is a cache, and a cache cannot
           be tampered with independently of the file it came from. */
        if (method === 'GET' && seg[1] === 'audit' && seg[2] === 'verify') {
          return json(res, 200, { chain: verifyAuditChain(), file: auditFilePath() });
        }
        if (method === 'GET' && seg[1] === 'audit') {
          return json(res, 200, { audit: fabric.audit() });
        }
        /* POST /fabric/policy — the operator's caution settings. Held
           service-side so the desktop can display them but never be the
           authority on them. Sanitized, then persisted to ~/.aura so it
           survives a restart. */
        if (method === 'POST' && seg[1] === 'policy') {
          const b = await readJson(req);
          const current = fabric.getPolicy();
          // Field-by-field on purpose: this merge is an allow-list, so an
          // unknown key in the request body can never reach the policy.
          // Anything genuinely new must be added here deliberately.
          const merged = {
            byRisk: (b.byRisk as typeof current.byRisk) ?? current.byRisk,
            overrides: (b.overrides as typeof current.overrides) ?? current.overrides,
            nodeOverrides: (b.nodeOverrides as typeof current.nodeOverrides) ?? current.nodeOverrides,
            nodeAllowlists: (b.nodeAllowlists as typeof current.nodeAllowlists) ?? current.nodeAllowlists,
            allowAutonomous: typeof b.allowAutonomous === 'boolean' ? b.allowAutonomous : current.allowAutonomous,
          };
          const saved = savePolicy(merged);
          fabric.setPolicy(saved);
          return json(res, 200, { policy: saved, file: policyFilePath() });
        }

        /* ── approval gate ─────────────────────────────────────────
           The authoritative approval surface. The desktop reads pending
           requests here and answers them here; it never names a
           capability itself. */
        if (method === 'GET' && seg[1] === 'approvals') {
          return json(res, 200, { approvals: fabric.pendingApprovals() });
        }

        if (method === 'POST' && seg[1] === 'approvals' && seg[2] && seg[3] === 'decide') {
          const b = await readJson(req);
          const granted = b.granted === true;
          const reason = typeof b.reason === 'string' ? b.reason : undefined;

          const request = fabric.approvalById(seg[2]);
          if (!request) return json(res, 404, { error: 'no such approval request' });
          // Already decided — a replayed request, a second tab, or a
          // double-click. Report the existing decision rather than
          // authorizing anything a second time.
          if (request.state !== 'pending') {
            return json(res, 409, { error: `This request was already ${request.state}.`, approval: request });
          }

          const decided = fabric.decideApproval(seg[2], granted, 'user', reason);
          if (!decided) return json(res, 409, { error: 'This request is no longer pending.' });

          // The grant is derived from the STORED request, never from the
          // client. A caller can say "I approve request X"; it can never
          // say "I approve filesystem.write".
          const capabilities = decided.items.map((i) => i.capabilityId);
          const pid = decided.projectId;
          const mid = decided.missionId;
          const tid = decided.taskId;

          if (!pid || !mid || !tid) {
            return json(res, 200, { approval: decided, resumed: false, detail: 'Recorded. This request is not attached to a mission task.' });
          }

          if (!granted) {
            // Nothing executes. The task is left declined with the reason
            // on Mission Control's timeline, which stays the authority on
            // mission history.
            const r = manager.rejectMissionTask(pid, mid, tid, reason ?? 'Approval declined by operator');
            return json(res, 200, { approval: decided, resumed: false, declined: true, mission: r.mission });
          }

          // Resume the SAME task with the server-derived grant.
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          const result = await manager.runMissionTask(pid, mid, tid, ac.signal, capabilities);
          return json(res, 200, { approval: decided, resumed: true, ...result });
        }
        /* GET /fabric/mission/:projectId/:missionId — the additive
           annotation over a finished plan (assumptions, open questions,
           per-task capability bindings, gaps). Read-only and derived on
           demand: nothing here is persisted onto the MissionRecord, and
           nothing here re-plans. See CONSOLIDATION_MAP.md §2.1/§2.2. */
        if (method === 'GET' && seg[1] === 'mission' && seg[2] && seg[3]) {
          const mission = manager.getMission(seg[2], seg[3]);
          if (!mission) return json(res, 404, { error: 'mission not found' });
          return json(
            res,
            200,
            annotateMissionCapabilities(
              mission.intent,
              mission.signals,
              mission.goalGraph?.tasks ?? [],
              fabric.supported(),
            ),
          );
        }
        if (method === 'POST' && seg[1] === 'invoke') {
          const b = await readJson(req);
          const capabilityId = String(b.capabilityId ?? '');
          if (!capabilityId) return json(res, 400, { error: 'capabilityId is required' });
          const raw = (b.context ?? {}) as Record<string, unknown>;
          const projectId = typeof raw.projectId === 'string' ? raw.projectId : null;
          // The working directory is resolved from the registry, never
          // taken from the request — a caller cannot point execution at an
          // arbitrary directory on the machine.
          const project = projectId
            ? (manager.listProjects() as { id: string; path: string }[]).find((p) => p.id === projectId)
            : undefined;
          const context: InvocationContext = {
            actor: {
              kind: (raw.actorKind as 'agent' | 'human' | 'system') ?? 'human',
              id: typeof raw.actorId === 'string' ? raw.actorId : 'user',
            },
            projectId,
            cwd: project?.path,
            missionId: typeof raw.missionId === 'string' ? raw.missionId : undefined,
            taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
            timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
            // Attested from the transport, never from the body. A caller
            // cannot ask to be trusted; it can only present the token this
            // boot minted into the user's config directory, which is what
            // AURA's own window does and nothing else has reason to.
            initiator: isUserDirect(req) ? 'user-direct' : 'request',
            // Names an approval a human already answered through
            // `/fabric/approvals/:id/decide`. Unlike the grant this route
            // used to accept, it authorizes nothing by itself — the
            // Fabric spends it only if it is genuinely granted, unspent,
            // and for this same capability.
            resumeApprovalId: typeof raw.resumeApprovalId === 'string' ? raw.resumeApprovalId : undefined,
            // `approvedCapabilities` is deliberately NOT read here.
            //
            // It used to be, straight from the request body, and that made
            // every hard floor self-satisfiable: a caller could name the
            // capability it wanted and hand itself the grant in the same
            // request. `irreversible-floor` on `agent.delegate` was one
            // POST away from being no floor at all.
            //
            // A grant now has exactly one source — an ApprovalRequest the
            // Fabric itself raised, answered through
            // `/fabric/approvals/:id/decide`, where the capability is read
            // back from the stored request rather than supplied by the
            // answerer. The property `fabricClient.ts` documents is now
            // true of this route too.
            // Routing intent. Only an id — never a path or a binary — so a
            // caller can narrow which connected node runs the action but
            // can never point execution at something off the catalogue.
            //
            // Also accepted in the INPUT position, where `agent.delegate`
            // used to declare it. Honouring the alias matters: dropping it
            // would mean a caller who named a node got a different one
            // without being told, which is precisely the silent
            // substitution routing exists to prevent.
            nodeId: typeof raw.nodeId === 'string'
              ? raw.nodeId
              : typeof (b.input as Record<string, unknown> | undefined)?.nodeId === 'string'
                ? ((b.input as Record<string, unknown>).nodeId as string)
                : undefined,
          };
          const input = (b.input ?? {}) as Record<string, unknown>;
          return json(res, 200, await fabric.invoke(capabilityId, input, context));
        }
      }

      /* ── global engineering dashboard (across all projects) ────── */
      if (method === 'GET' && seg[0] === 'missions' && seg[1] === 'dashboard') {
        return json(res, 200, manager.missionDashboard());
      }

      /* ── projects ─────────────────────────────────────────────── */
      if (seg[0] === 'projects') {
        if (seg.length === 1) {
          // `registry.readable` travels with the list so a client can tell
          // "no projects" from "the registry could not be read". Pruning an
          // active project on the strength of the latter loses user state.
          if (method === 'GET') return json(res, 200, {
            projects: manager.listProjects(),
            current: manager.currentProject(),
            registry: { readable: manager.registry.readable, error: manager.registry.readError },
          });
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
        /* GET /projects/:id/context — the Context Fabric read model.
           The ONE place ContextSources is assembled, so every consumer
           (Context panel, Ask AURA, later agents) sees the same projection
           of the same authorities. `?prompt=1` additionally returns the
           rendered agent contract, so a caller never re-derives it.
           This never triggers a scan or a re-index: a stale view is
           reported as stale and refreshed through the existing paths. */
        /* POST /projects/:id/reindex — a re-index that names its target.
           The generic POST /reindex acts on whatever is mounted, so the
           Context panel (which is scoped to a project id) could ask to
           refresh project A and re-index project B instead.

           A mismatch is refused rather than reconciled, for the same
           reason as the Ask AURA conflict: mounting is a state change and
           a refresh must not cause one behind the user's back. */
        if (seg[2] === 'reindex' && method === 'POST') {
          if (!manager.registry.get(id)) return json(res, 404, { error: 'no such project' });
          const mounted = manager.pipeline.currentProjectId;
          if (mounted !== id) {
            return json(res, 409, {
              error: mounted
                ? `Cannot re-index "${id}" while "${mounted}" is the open project. Open it first.`
                : `Cannot re-index "${id}" because no project is open. Open it first.`,
              requested: id,
              mounted,
            });
          }
          return json(res, 200, await p.reindex());
        }
        if (seg[2] === 'context' && method === 'GET') {
          const view = await contextViewFor(id);
          if (!view) return json(res, 404, { error: 'no such project' });
          if (url.searchParams.get('prompt') !== '1') return json(res, 200, { view });
          // `task` makes this the exact prompt `agent.delegate` would send,
          // built by the same function — a transparency surface, not a
          // second builder.
          const task = url.searchParams.get('task');
          return json(res, 200, {
            view,
            contract: renderContextContract(view),
            ...(task
              ? {
                agentPrompt: buildAgentPrompt({ view, task }),
                measurement: measureAgentPrompt({ view, task }),
              }
              : { systemPrompt: AURA_SYSTEM_PROMPT }),
          });
        }
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
        if (seg[2] === 'nodes' && method === 'GET') {
          return json(res, 200, await manager.executionNodes());
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
              // No grant is accepted from the caller. A gated task is
              // resumed only through POST /fabric/approvals/:id/decide,
              // which derives the capability from the stored request — so
              // a crafted body can never authorize an action.
              const result = await manager.runMissionTask(id, mid, taskId, ac.signal);
              // 202 for an approval gate: the request was understood and the
              // task is parked, which is not the same as a bad request.
              return json(res, result.ok ? 200 : result.awaitingApproval ? 202 : 400, result);
            }
            if (seg[6] === 'accept') {
              // Accept IS the operator's authorization for the write, so the
              // grant is derived from the act of accepting — server-side,
              // with no capability list crossing the wire.
              const r = await manager.acceptMissionTask(id, mid, taskId);
              return json(res, r.ok ? 200 : 400, r);
            }
            if (seg[6] === 'reject') {
              // Also the decline path for a task parked at a Fabric approval
              // gate: the reason is recorded on the mission timeline, and the
              // Fabric already holds its own audit record of the gate.
              const rb = await readJson(req).catch(() => ({}) as Record<string, unknown>);
              const reason = typeof rb.reason === 'string' ? rb.reason : undefined;
              const r = manager.rejectMissionTask(id, mid, taskId, reason);
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
          bridge.syncLegacy(wf);
          return json(res, 200, wf);
        }
        // Approval management — the human side of the Fabric's ONE approval
        // authority. Runs park at approval nodes; the decision is recorded
        // here and the run resumes (or the parked node fails) in place.
        if (seg[1] === 'approvals') {
          if (seg.length === 2 && method === 'GET') return json(res, 200, { approvals: bridge.pendingApprovals() });
          if (seg.length === 3 && seg[2] === 'pending' && method === 'GET') {
            return json(res, 200, { approvals: bridge.pendingApprovals() });
          }
          if (seg.length === 3) {
            if (method === 'GET') {
              const a = bridge.approvalById(seg[2] as string);
              return a ? json(res, 200, a) : json(res, 404, { error: 'no such approval request' });
            }
            if (method === 'POST') {
              const b = await readJson(req);
              const ok = bridge.decideApproval(seg[2] as string, Boolean(b.granted), String(b.decidedBy ?? 'user'), typeof b.reason === 'string' ? b.reason : undefined);
              return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such approval request' });
            }
          }
        }
        if (seg[1] === 'runs' && seg[2] === 'resume' && seg.length === 3 && method === 'POST') {
          return json(res, 200, { ok: bridge.resumeRun(seg[2] as string) });
        }
        if (seg.length === 1) {
          if (method === 'GET') return json(res, 200, { workflows: wfs.list() });
          if (method === 'POST') {
            const b = await readJson(req);
            const fromTemplate = typeof b.template === 'string' ? instantiateTemplate(b.template) : null;
            if (typeof b.template === 'string' && !fromTemplate) return json(res, 404, { error: 'no such template' });
            const wf = wfs.create(fromTemplate ?? { name: b.name as string | undefined, category: b.category as string | undefined });
            bridge.syncLegacy(wf);
            return json(res, 200, wf);
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
            await bridge.runLegacy(wf, { inputs: (b.inputs ?? {}) as Record<string, string>, projectId: manager.currentProject()?.id ?? null }, emit);
          } catch (e) {
            emit({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message });
          }
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          return;
        }
        // Manual trigger — starts the run through the bridge and returns
        // runId/status immediately (no SSE). The run continues in the
        // background; GET /workflows/:id/runs/:runId reports its state.
        if (seg[2] === 'start' && method === 'POST') {
          const b = await readJson(req);
          try {
            const started = await bridge.startManual(id, { inputs: (b.inputs ?? {}) as Record<string, string>, projectId: manager.currentProject()?.id ?? null });
            return json(res, 200, started);
          } catch (e) {
            return json(res, 400, { error: (e as Error).message });
          }
        }
        if (seg[2] === 'runs') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { runs: bridge.listRuns(id, { limit: 50 }) });
          if (seg.length === 4 && method === 'GET') {
            const run = bridge.getRun(seg[3] as string);
            return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
          }
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
          const userInputs = wf.nodes.filter((n) => n.type === 'user-input');
          if (userInputs.length === 1) inputs[userInputs[0]!.id] = JSON.stringify(payload);
          void bridge.startTriggered(id, { inputs, triggerPayload: JSON.stringify(payload) }).catch((e) => {
            console.error(`[workflow trigger] run failed for ${id}:`, (e as Error).message);
          });
          return json(res, 202, { accepted: true });
        }
        if (seg.length === 2) {
          if (method === 'GET') { const wf = wfs.get(id); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'PUT') {
            const b = await readJson(req);
            const wf = wfs.save(id, b as Partial<Workflow>);
            if (wf) bridge.syncLegacy(wf);
            return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' });
          }
          if (method === 'PATCH') { const b = await readJson(req); const wf = wfs.patch(id, b as { name?: string; favorite?: boolean; category?: string }); if (wf) bridge.syncLegacy(wf); return wf ? json(res, 200, wf) : json(res, 404, { error: 'no such workflow' }); }
          if (method === 'DELETE') { const ok = wfs.remove(id); if (ok) bridge.definitions.remove(id); return json(res, 200, { ok }); }
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
        const ctx = await resolveAuraContext(b);
        // 409: the request named a project other than the one AURA has
        // open. Refusing is the only answer that cannot be a hybrid.
        if (!ctx.ok) return json(res, 409, { error: ctx.conflict.message, ...ctx.conflict });
        return json(res, 200, await p.ask(String(b.text ?? ''), ac.signal, history, ctx.contract, ctx.scan));
      }
      if (method === 'POST' && seg[0] === 'stream') {
        const b = await readJson(req);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const history = resolveHistory(manager, b);
        const emit = (e: StreamEmit) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
        const ctx = await resolveAuraContext(b);
        if (!ctx.ok) {
          /* The SSE headers are already sent, so the conflict travels as
             the stream's own error event rather than an HTTP status. The
             client surfaces it exactly like any other stream failure. */
          emit({ type: 'error', error: { type: 'project_conflict', message: ctx.conflict.message, retryable: false } });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          return;
        }
        await p.streamEvents(String(b.text ?? ''), emit, ac.signal, history, ctx.contract, ctx.scan);
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
    }
  });

  const port = opts.port ?? 4319;
  // Minted before the port opens, so no request can ever be evaluated
  // against an absent token and be mistaken for a direct user action.
  initUiToken();

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return {
    port: addr.port, url: `http://127.0.0.1:${addr.port}`, manager, bridge,
    // Graceful shutdown: stop the workflow scheduler first (no new runs,
    // timers and watchers released), then the HTTP server. Paused runs
    // stay persisted and resumable by the next boot.
    close: async () => {
      bridge.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
