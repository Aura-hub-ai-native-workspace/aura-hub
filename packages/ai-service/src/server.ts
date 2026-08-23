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
import { validateWorkflow } from './workflow/validate';
import { summarizeRun } from './workflow/run/types';
import { classifyAllTools, describeTools, resolveTools } from './workflow/agent/bounds';
import { AGENT_CEILINGS, AGENT_DEFAULTS } from './workflow/agent/types';
import type { RunEvent, Workflow } from './workflow/types';
import { setupProviders } from './provider';
import { graphifyGraphPath, graphifyStatus, runGraphify } from './graphify';
import { handleCodeAction, type CodeActionRequest } from './codeAction';
import { CATALOG } from '@aura/connected-environment';
import { probeNode, scanEnvironment } from './environment';
import { CAPABILITY_MANIFEST, annotateMissionCapabilities, type InvocationContext, type NodeRef } from '@aura/capability-fabric';
import { isUnavailable, type ContextSurface, type EnvironmentSnapshot } from './context';
import { createFabric } from './fabric';
import { secrets } from './secrets';
import { savePolicy, policyFilePath } from './fabric/policyStore';
import { AUTOMATION_TEMPLATES, instantiateAutomationTemplate, validateRule } from '@aura/automation';
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
  /**
   * The same scan, in the shape the Context Fabric consumes. Built in the
   * one loop below beside `presentNodes` and `providedNodeCapabilities`,
   * for the same reason those two are: three projections of one scan must
   * never be able to describe different machines.
   *
   * Held so that composing a ContextView reads an already-observed
   * environment instead of triggering a second scan.
   */
  let environmentSnapshot: EnvironmentSnapshot | null = null;
  const fabric = createFabric({
    manager,
    providedNodeCapabilities: () => providedNodeCapabilities,
    presentNodes: () => presentNodes,
    // Per-run least privilege. Owned by the manager because the manager
    // owns runs; the Fabric only asks it what an in-flight run may do.
    runScopes: manager.runScopes,
  });
  // Closes the loop: mission tasks now execute THROUGH this same Fabric
  // instance, so a task inherits the identical policy, approval,
  // verification, recovery and audit path as a direct /fabric/invoke.
  manager.attachFabric(fabric);

  /**
   * A record still saying "running" after the process running it is gone
   * asserts something false. Reconciling once at boot turns those orphans
   * into honestly-failed runs that say why, and marks the ones that
   * checkpointed far enough to be resumable.
   */
  const recovered = manager.reconcileWorkflowRuns();
  if (recovered.length) {
    console.log(`[workflow] recovered ${recovered.length} interrupted run${recovered.length === 1 ? '' : 's'} from a previous session`);
  }

  /**
   * Start the clock.
   *
   * `start()` reconciles BEFORE arming the timer, so schedules that came
   * due while AURA was closed are counted as missed and never executed —
   * launching the app must not silently perform a backlog of work.
   */
  const schedules = manager.automation.scheduler.start();
  if (schedules.scheduled || schedules.missed) {
    console.log(`[schedule] ${schedules.scheduled} rule(s) armed`
      + (schedules.missed ? ` · ${schedules.missed} fire(s) missed while AURA was closed (not run)` : ''));
  }

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
    const tools: NonNullable<EnvironmentSnapshot['nodes']> = [];
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
      // Version comes from the probe's own output — never from a
      // credential, an env var or a config file.
      tools.push({
        id: entry.id,
        name: entry.name,
        capabilities: [...entry.capabilities],
        version: result.version,
        // The catalogue already knows which entries are AURA's own
        // subsystems rather than programs on the machine. Carrying that
        // distinction keeps an agent from reading "Mission Control" as a
        // binary it could run.
        internal: entry.transport === 'internal',
      });
    }
    providedNodeCapabilities = provided;
    presentNodes = nodes;
    environmentSnapshot = {
      scannedAt: scan.scannedAt,
      nodes: tools,
      providedCapabilities: [...provided],
    };
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
            approvedCapabilities: Array.isArray(b.approvedCapabilities)
              ? b.approvedCapabilities.filter((x): x is string => typeof x === 'string')
              : undefined,
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

          /* ── the agent context seam ───────────────────────────────
             Delegating to a coding agent without AURA's context is the
             thing the Context Fabric exists to fix: the agent would
             re-derive the project the service already understands.

             So when a caller delegates within a resolved project and
             says nothing about context, AURA supplies it. The executor
             only consumes it — composition stays here, on the caller
             side, with the one Context Fabric.

             Passing `context: ''` explicitly opts out; the executor
             treats empty as "no context" and sends the bare task. */
          if (capabilityId === 'agent.delegate' && projectId && input.context === undefined) {
            const contract = await manager.contextContract(projectId, {
              surface: 'coding',
              environment: environmentSnapshot,
            });
            if (contract) input.context = contract;
          }

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

        /* ── context fabric ──────────────────────────────────────
           Read-only. Explicitly project-scoped: the id in the path is
           the only project any of this describes. The environment is
           handed in from the last scan this process performed, so
           reading context never triggers a new one. */
        if (seg[2] === 'context') {
          const surface = (url.searchParams.get('surface') ?? 'general') as ContextSurface;
          const includeGit = url.searchParams.get('git') !== 'false';
          const opts = { surface, includeGit, environment: environmentSnapshot };

          // The agent-facing text contract.
          if (seg[3] === 'contract' && method === 'GET') {
            const contract = await manager.contextContract(id, opts);
            if (contract === null) return json(res, 404, { error: `no project is registered with id "${id}"` });
            return json(res, 200, { projectId: id, surface, contract });
          }

          if (seg.length === 3 && method === 'GET') {
            const view = await manager.contextView(id, opts);
            // An unresolvable project is 404, never an empty view — a
            // caller must not be able to read "no such project" as "a
            // project AURA knows nothing about".
            return isUnavailable(view) ? json(res, 404, view) : json(res, 200, view);
          }
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

      /* ── agent contract vocabulary ────────────────────────────────
       * The bounds a UI must render, and the tools a given workflow could
       * actually offer an agent. Both are computed server-side on purpose:
       * a client that decided either for itself would be deciding
       * authority, and the answer would stop matching what the runtime
       * enforces. */
      if (seg[0] === 'agent') {
        if (seg[1] === 'bounds' && method === 'GET') {
          return json(res, 200, { defaults: AGENT_DEFAULTS, ceilings: AGENT_CEILINGS });
        }
        if (seg[1] === 'tools' && method === 'GET') {
          const workflowId = url.searchParams.get('workflowId') ?? '';
          const wf = manager.workflows.get(workflowId);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          const envelope = manager.workflowEnvelope(wf);
          const requested = (url.searchParams.get('requested') ?? '')
            .split(',').map((t) => t.trim()).filter(Boolean);
          // With nothing requested, report what the envelope COULD offer —
          // that is the selectable set the inspector draws, and anything
          // outside it is struck through with the stated reason.
          const supported = (id: string) => fabric.isSupported(id);
          const resolved = requested.length
            ? resolveTools(requested, envelope, supported)
            // With nothing named, classify the WHOLE manifest so the picker
            // can render every option with the reason it is or is not
            // selectable — rather than silently listing only what works.
            : classifyAllTools(envelope, supported);
          return json(res, 200, { ...resolved, envelope, describe: describeTools(resolved.allowed) });
        }
      }

      /* ── workflow runs (across every workflow) ────────────────── */
      if (seg[0] === 'workflow-runs') {
        if (seg.length === 1 && method === 'GET') {
          // Filtered and paged HERE. The client never merges per-workflow
          // histories — a merge it would get wrong as soon as retention
          // pruned one workflow's runs and not another's.
          const q = url.searchParams;
          const num = (k: string) => (q.get(k) === null ? undefined : Number(q.get(k)));
          return json(res, 200, manager.runIndex({
            workflowId: q.get('workflowId') ?? undefined,
            projectId: q.get('projectId') ?? undefined,
            state: (q.get('state') ?? undefined) as never,
            trigger: q.get('trigger') ?? undefined,
            q: q.get('q') ?? undefined,
            since: q.get('since') ?? undefined,
            limit: num('limit'),
            offset: num('offset'),
          }));
        }
        if (seg[1] === 'stats' && method === 'GET') {
          return json(res, 200, { stats: manager.workflowRuns.stats(url.searchParams.get('projectId') ?? undefined) });
        }
        if (seg[1] === 'reindex' && method === 'POST') {
          // The index is a cache over the run files. This rebuilds it from
          // them, and reports the count rather than repairing silently.
          return json(res, 200, { indexed: manager.workflowRuns.rebuildIndex() });
        }
        if (seg[1] === 'awaiting' && method === 'GET') {
          return json(res, 200, { runs: manager.workflowRuns.listAwaitingApproval() });
        }
        if (seg.length === 2 && method === 'GET') {
          const run = manager.workflowRuns.find(seg[1]);
          return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
        }
      }

      /* ── secrets ──────────────────────────────────────────────────
       * Names and metadata only. There is deliberately NO route that
       * returns a value: a secret that can be read back over HTTP is a
       * secret the whole design has stopped protecting. Values leave the
       * store exactly once, inside `governor.ts`, on their way into a
       * Fabric invocation. */
      if (seg[0] === 'secrets') {
        if (seg.length === 1 && method === 'GET') return json(res, 200, { secrets: secrets.list() });
        if (seg.length === 1 && method === 'POST') {
          const b = await readJson(req);
          try {
            return json(res, 200, secrets.set(String(b.name ?? ''), String(b.value ?? ''), typeof b.note === 'string' ? b.note : undefined));
          } catch (e) {
            return json(res, 400, { error: (e as Error).message });
          }
        }
        if (seg.length === 2 && method === 'DELETE') return json(res, 200, { ok: secrets.remove(seg[1]) });
      }

      /* ── workflows ────────────────────────────────────────────── */
      if (seg[0] === 'workflows') {
        const wfs = manager.workflows;
        if (seg[1] === 'specs' && method === 'GET') return json(res, 200, { specs: nodeSpecInfos() });
        if (seg[1] === 'templates' && method === 'GET') return json(res, 200, { templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, nodeCount: t.nodes.length })) });
        if (seg[1] === 'import' && method === 'POST') {
          const b = await readJson(req);
          const wf = wfs.import((b.def ?? b) as Partial<Workflow>);
          // An imported workflow is untrusted content with a friendly name.
          // It is stored, and the caller is handed everything needed to
          // review it before the first run.
          return json(res, 200, { ...wf, validation: validateWorkflow(wf.nodes, wf.edges) });
        }
        if (seg[1] === 'generate' && method === 'POST') {
          const b = await readJson(req);
          const result = await generateWorkflow(p, String(b.text ?? ''));
          if (!result.ok) return json(res, 400, { error: result.error });
          const { ok: _ok, ...graph } = result;
          const wf = wfs.create({ name: graph.name, description: graph.description, category: 'AI Generated', nodes: graph.nodes, edges: graph.edges });
          // A generated workflow is returned WITH its validation report and
          // authority envelope. "The AI must never silently create an unsafe
          // workflow" is only true if the thing that created it hands over
          // what it would be allowed to do, in the same response.
          return json(res, 200, { ...wf, validation: validateWorkflow(wf.nodes, wf.edges) });
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
        if (seg[2] === 'dry-run' && (method === 'POST' || method === 'GET')) {
          const wf = wfs.get(id);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          const b = method === 'POST' ? await readJson(req) : {};
          try {
            return json(res, 200, manager.dryRunWorkflow(wf, {
              projectId: typeof b.projectId === 'string' ? b.projectId : (url.searchParams.get('projectId') ?? undefined),
              inputs: (b.inputs ?? {}) as Record<string, string>,
              versionId: typeof b.versionId === 'string' ? b.versionId : (url.searchParams.get('versionId') ?? undefined),
            }));
          } catch (e) {
            return json(res, 400, { error: (e as Error).message });
          }
        }
        if (seg[2] === 'validate' && method === 'GET') {
          const wf = wfs.get(id);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          return json(res, 200, validateWorkflow(wf.nodes, wf.edges));
        }
        if (seg[2] === 'envelope' && method === 'GET') {
          const wf = wfs.get(id);
          if (!wf) return json(res, 404, { error: 'no such workflow' });
          return json(res, 200, { envelope: manager.workflowEnvelope(wf), diff: manager.workflowEnvelopeDiff(wf) });
        }
        if (seg[2] === 'versions') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { versions: manager.workflowVersions.list(id) });
          if (seg.length === 3 && method === 'POST') {
            const wf = wfs.get(id);
            if (!wf) return json(res, 404, { error: 'no such workflow' });
            const b = await readJson(req);
            return json(res, 200, manager.workflowVersions.publish(wf, 'user', typeof b.note === 'string' ? b.note : undefined));
          }
          if (seg.length === 4 && method === 'GET') {
            const v = manager.workflowVersions.get(id, seg[3]);
            return v ? json(res, 200, v) : json(res, 404, { error: 'no such version' });
          }
          if (seg[4] === 'restore' && method === 'POST') {
            const wf = wfs.get(id);
            if (!wf) return json(res, 404, { error: 'no such workflow' });
            const v = manager.workflowVersions.restore(wf, seg[3]);
            if (!v) return json(res, 404, { error: 'no such version' });
            // Restoring publishes a NEW version and makes it the draft, so
            // history stays append-only and the editor shows what will run.
            wfs.save(id, { ...wf, nodes: v.nodes, edges: v.edges });
            return json(res, 200, v);
          }
        }
        if (seg[2] === 'runs') {
          if (seg.length === 3 && method === 'GET') return json(res, 200, { runs: manager.listWorkflowRuns(id) });
          if (seg.length === 4 && method === 'GET') {
            const run = manager.getWorkflowRun(id, seg[3]);
            return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
          }
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> b23fe9f (feat(backend): stream and persist agent execution traces)
          if (seg[4] === 'chain' && method === 'GET') {
            // One logical execution across however many resume legs it took.
            const chain = manager.workflowRunChain(id, seg[3]);
            return chain.length ? json(res, 200, { chain: chain.map(summarizeRun) }) : json(res, 404, { error: 'no such run' });
          }
<<<<<<< HEAD
=======
>>>>>>> 916ba80 (feat(backend): govern workflow execution and integrate the bounded agent)
=======
>>>>>>> b23fe9f (feat(backend): stream and persist agent execution traces)
          if (seg[4] === 'cancel' && method === 'POST') {
            return json(res, 200, { cancelled: manager.cancelWorkflowRun(seg[3]) });
          }
          if (seg[4] === 'resume' && method === 'POST') {
            const b = await readJson(req);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
            const ac = new AbortController();
            res.on('close', () => ac.abort());
            const emit = (e: RunEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
            try {
              const out = await manager.resumeWorkflowRun(id, seg[3], emit, {
                approvedCapabilities: Array.isArray(b.approvedCapabilities) ? (b.approvedCapabilities as string[]) : undefined,
                signal: ac.signal,
              });
              if ('error' in out) emit({ type: 'done', status: 'failed', ms: 0, error: out.error, runState: 'failed' });
            } catch (e) {
              emit({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message, runState: 'failed' });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            return;
          }
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
            await manager.startWorkflowRun(wf, {
              inputs: (b.inputs ?? {}) as Record<string, string>,
              // A crafted body can widen nothing: this is a per-invocation
              // grant the Fabric spends once, and every hard floor still
              // applies above it. See fabric.ts step 4.
              approvedCapabilities: Array.isArray(b.approvedCapabilities) ? (b.approvedCapabilities as string[]) : undefined,
              projectId: typeof b.projectId === 'string' ? b.projectId : undefined,
              signal: ac.signal,
            }, emit);
          } catch (e) {
            emit({ type: 'done', status: 'failed', ms: 0, error: (e as Error).message, runState: 'failed' });
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
          // An externally-triggered run has no human present, so it gets no
          // per-invocation grant at all. Anything its policy rates above
          // auto-execute parks at `awaiting-approval` and waits in the
          // approvals inbox — it is never quietly performed on the strength
          // of an inbound HTTP request.
          void manager.startWorkflowRun(wf, {
            inputs,
            trigger: { kind: 'webhook', tokenId: `${id}` },
            actor: { kind: 'system', id: `webhook:${id}` },
          }, () => {}).catch((e) => {
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
        /* Cross-rule run index. The backend is authoritative for this
           view — a client never fetches every rule and merges. */
        if (seg[1] === 'runs') {
          if (seg.length === 2 && method === 'GET') {
            const q = url.searchParams;
            const num = (k: string) => (q.get(k) === null ? undefined : Number(q.get(k)));
            return json(res, 200, manager.automationRunIndex({
              ruleId: q.get('ruleId') ?? undefined,
              projectId: q.get('projectId') ?? undefined,
              status: (q.get('status') ?? undefined) as never,
              trigger: (q.get('trigger') ?? undefined) as never,
              workflowId: q.get('workflowId') ?? undefined,
              q: q.get('q') ?? undefined,
              since: q.get('since') ?? undefined,
              until: q.get('until') ?? undefined,
              limit: num('limit'),
              offset: num('offset'),
            }));
          }
          if (seg[2] === 'stats' && method === 'GET') {
            return json(res, 200, {
              stats: auto.store.runStats({
                projectId: url.searchParams.get('projectId') ?? undefined,
                ruleId: url.searchParams.get('ruleId') ?? undefined,
              }),
            });
          }
          if (seg[2] === 'reindex' && method === 'POST') {
            // The index is a cache over the run files. Rebuilt from them,
            // and the count reported rather than repaired silently.
            return json(res, 200, { indexed: auto.store.rebuildRunIndex() });
          }
        }
        if (seg[1] === 'schedules' && method === 'GET') {
          // Next/last fire and the missed count, per rule. The scheduler is
          // the authority; this only reads it.
          return json(res, 200, { schedules: auto.scheduler.status() });
        }
        if (seg[1] === 'validate' && method === 'POST') {
          const b = await readJson(req);
          return json(res, 200, { issues: validateRule(b as Parameters<typeof validateRule>[0]) });
        }
        if (seg[1] === 'rules') {
          if (seg.length === 2) {
            // Summaries carry their schedule state, so a rule list can show
            // "next 09:00 · 3 missed" without a second round trip.
            if (method === 'GET') return json(res, 200, { rules: manager.listAutomationRules() });
            if (method === 'POST') {
              const b = await readJson(req);
              const fromTemplate = typeof b.template === 'string' ? instantiateAutomationTemplate(b.template) : null;
              if (typeof b.template === 'string' && !fromTemplate) return json(res, 404, { error: 'no such template' });
              const draft = (fromTemplate ?? b) as Parameters<typeof validateRule>[0];
              // Refused at the edge, not coerced in the store. A schedule
              // with a cron that cannot parse, or a run-workflow action with
              // no workflow, would be a rule that looks armed and can never
              // fire — the worst state an automation list can display.
              const issues = validateRule(draft);
              if (issues.length) return json(res, 400, { error: issues[0].message, issues });
              const created = auto.store.createRule(draft as Record<string, unknown>);
              auto.scheduler.refresh(created.id);
              return json(res, 200, created);
            }
          }
          const ruleId = seg[2];
          if (seg[3] === 'dry-run' && (method === 'POST' || method === 'GET')) {
            const b = method === 'POST' ? await readJson(req) : {};
            const sample = b.sampleEvent as AutomationEvent | undefined;
            const out = manager.dryRunAutomationRule(ruleId, {
              sampleEvent: sample && typeof sample === 'object' ? sample : undefined,
              projectId: typeof b.projectId === 'string' ? b.projectId : (url.searchParams.get('projectId') ?? undefined),
            });
            return 'error' in out ? json(res, 404, out) : json(res, 200, out);
          }
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
            if (method === 'PUT' || method === 'PATCH') {
              const b = await readJson(req);
              const existing = auto.store.getRule(ruleId);
              if (!existing) return json(res, 404, { error: 'no such rule' });
              // Validate the MERGED rule, not the patch: a PATCH that only
              // flips `enabled` must still be judged against the trigger it
              // is enabling, or an invalid schedule could be armed by a
              // request that never mentions cron.
              const merged = { ...existing, ...(b as Partial<AutomationRule>), trigger: { ...existing.trigger, ...(b as Partial<AutomationRule>).trigger } };
              const issues = validateRule(merged as Parameters<typeof validateRule>[0]);
              if (issues.length) return json(res, 400, { error: issues[0].message, issues });
              const r = auto.store.saveRule(ruleId, b as Partial<AutomationRule>);
              if (r) auto.scheduler.refresh(ruleId);
              return r ? json(res, 200, r) : json(res, 404, { error: 'no such rule' });
            }
            if (method === 'DELETE') {
              const ok = auto.store.removeRule(ruleId);
              // Drops the schedule state too, so a deleted rule cannot leave
              // an armed entry behind.
              auto.scheduler.refresh(ruleId);
              return json(res, 200, { ok });
            }
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
