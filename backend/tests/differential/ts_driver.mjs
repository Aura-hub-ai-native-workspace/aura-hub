/**
 * Differential driver — feeds cases to the REAL bundled TypeScript
 * implementations. Adds "storeops": runs an identical persistence op-script
 * against an isolated AURA_HOME using the genuine WorkflowStore /
 * WorkflowRunStore / WorkflowVersionStore / AutomationStore classes.
 *
 * Determinism: the harness overrides globalThis.Date and Math.random BEFORE
 * importing the bundles, so generated ids/timestamps match the Python port
 * tick-for-tick. randomBytes (CSPRNG) is NOT patchable — token-minting ops
 * are therefore excluded from cross-language scripts.
 *
 * Input : {"func":"fingerprint"|"graphHash"|"policy"|"storeops", ...}
 * Output: {"results":[...]} | {"tree":{relpath:sha256}, "results":[...]}
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { payload += c; });
process.stdin.on('end', async () => {
  const req = JSON.parse(payload);

  if (req.func === 'intentops') {
    process.stdout.write(JSON.stringify(await runIntentOps(req)));
    return;
  }

  if (req.func === 'agentops') {
    const out = await runAgentOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (req.func === 'wfops') {
    const out = await runWfOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (req.func === 'dryops') {
    const out = await runDryOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (req.func === 'autops') {
    const out = await runAutoOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (req.func === 'fabricops') {
    const out = req.config?.wiring ? await runFabricOpsWired(req) : await runFabricOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (req.func === 'storeops') {
    const out = await runStoreOps(req);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  const fabric = await import(process.env.TSREF_FABRIC);
  const fabricApi = await import(process.env.TSREF_FABRIC_INDEX);
  const versions = await import(process.env.TSREF_VERSIONS);
  const results = [];
  for (const c of req.cases) {
    if (req.func === 'fingerprint') {
      results.push(fabric.fingerprintInvocation(c.capabilityId, c.input, c.context));
    } else if (req.func === 'graphHash') {
      results.push(versions.hashGraph(c.nodes, c.edges));
    } else if (req.func === 'policy') {
      const config = fabricApi.sanitizePolicy(c.raw);
      const evaluation = fabricApi.evaluatePolicy({
        capability: c.capability, config, granted: c.granted,
        nodeAvailable: c.nodeAvailable, subject: c.subject ?? undefined,
      });
      results.push({ policy: config, evaluation });
    } else throw new Error(`unknown func ${req.func}`);
  }
  process.stdout.write(JSON.stringify({ results }));
});

async function runStoreOps(req) {
  // ── deterministic globals BEFORE bundle import ──
  const startMs = req.startMs;
  let tick = startMs;
  const nextTick = () => (tick += 1000);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;

  let randState = 1;
  const stepDenom = 4194304;
  globalThis.Math = Object.create(Math);
  globalThis.Math.random = () => {
    randState += 7;
    return (randState % stepDenom) / stepDenom;
  };
  // keep everything else from real Math
  for (const k of Object.getOwnPropertyNames(Math)) {
    if (!(k in globalThis.Math)) globalThis.Math[k] = Math[k];
  }

  process.env.AURA_HOME = req.home;

  const wfmod = await import(process.env.TSREF_WFSTORE);
  const runmod = await import(process.env.TSREF_RUNSTORE);
  const vermod = await import(process.env.TSREF_VERSIONS);
  const automod = await import(process.env.TSREF_AUTOSTORE);
  const runtypes = await import(process.env.TSREF_RUNTYPES);

  const WF = new wfmod.WorkflowStore();
  const RUNS = new runmod.WorkflowRunStore();
  const VER = new vermod.WorkflowVersionStore();
  const AUTO = new automod.AutomationStore();

  const results = [];
  // $rN / $rN.a.b[i].c — reference into prior results (mirrored in _pyops.py)
  const resolve = (v) => {
    if (typeof v === 'string') {
      const m = /^\$r(\d+)(?:\.(.*))?$/.exec(v);
      if (m) {
        let cur = results[Number(m[1])];
        if (m[2]) {
          for (const part of m[2].split('.')) {
            cur = cur?.[/^\d+$/.test(part) ? Number(part) : part];
          }
        }
        return cur;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = resolve(val);
      return out;
    }
    return v;
  };
  for (const op of req.ops) {
    const [target, method] = op.op.split('.');
    try {
      let obj;
      if (target === 'wf') obj = WF;
      else if (target === 'runs') obj = RUNS;
      else if (target === 'ver') obj = VER;
      else if (target === 'auto') obj = AUTO;
      else if (target === 'obj') {
        if (method === 'merge') {
          const dstObj = resolve(op.args[0]);
          const patch = resolve(op.args[1]);
          const deepMerge = (dst, src) => {
            for (const [k, v] of Object.entries(src)) {
              if (v && typeof v === 'object' && !Array.isArray(v)
                  && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v);
              else dst[k] = v;
            }
          };
          deepMerge(dstObj, patch);
          results.push(null);
        } else throw new Error(`obj.${method}`);
        continue;
      } else if (target === 'helpers') {
        const [fn] = method.split(':');
        const args = (op.args ?? []).map(resolve);
        if (fn === 'emptyNodeRecord') results.push(runmod.emptyNodeRecord(...args));
        else if (fn === 'transitionNode') { runmod.transitionNode(...args); results.push(null); }
        else if (fn === 'appendLog') { runmod.appendLog(...args); results.push(null); }
        else if (fn === 'attachEvidence') { runmod.attachEvidence(...args); results.push(null); }
        else if (fn === 'runStateFor') results.push(runmod.runStateFor(args[0]));
        else if (fn === 'summarizeRun') results.push(runtypes.summarizeRun(args[0]));
        else throw new Error(`helper ${fn}`);
        continue;
      } else if (target === 'fs') {
        // raw filesystem probes for corruption/recovery paths
        const fs = await import('node:fs');
        const p = join(req.home, op.path);
        if (method === 'write') { fs.mkdirSync(join(p, '..'), { recursive: true }); fs.writeFileSync(p, op.data); }
        else if (method === 'rm') { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
        else if (method === 'read') { try { results.push(fs.readFileSync(p, 'utf8')); } catch { results.push(null); } }
        continue;
      }
      const args = (op.args ?? []).map(resolve);
      const r = await obj[method](...args);
      results.push(r === undefined ? null : r);
    } catch (e) {
      results.push({ __error__: String(e && e.message || e) });
    }
  }

  const tree = {};
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const p = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else tree[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(req.home, '');
  return { results, tree };
}

// ── fabricops: drive the REAL CapabilityFabric through a scripted scenario ──
async function runFabricOps(req) {
  const startMs = req.startMs;
  let tick = startMs;
  const nextTick = () => (tick += 1);   // +1 ms per draw: deterministic durations
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;

  process.env.AURA_HOME = req.home || '/tmp/opencode/fabric-home';

  const api = await import(process.env.TSREF_FABRIC_INDEX);

  // instant backoff — timing is compared via Date draws, never wall sleep
  const slept = [];
  const realSetTimeout = setTimeout;
  globalThis.setTimeout = (fn, ms) => { slept.push(ms); fn(); return 0; };

  const cfg = req.config;
  const results = [], events = [], auditFeed = [];

  const host = {
    permissionsFor: (cap) => (cfg.permissions[cap.id] ?? { read: true, write: true, execute: true, autonomous: true }),
    nodeAvailable: (cap) => (cfg.nodeAvailable && cap.id in cfg.nodeAvailable ? cfg.nodeAvailable[cap.id] : true),
    requestApproval: async (request, _ctx) => {
      if (cfg.approvals === 'grant') return true;
      if (cfg.approvals === 'throw') throw new Error('host exploded');
      return false; // park
    },
  };

  const fabric = new api.CapabilityFabric(host);
  fabric.on((e) => events.push(e));
  if (cfg.policyRaw !== undefined) fabric.setPolicy(api.sanitizePolicy(cfg.policyRaw));

  for (const ex of cfg.executors ?? []) {
    const queue = ex.steps.map((s) => ({ ...s }));
    const impl = {
      capabilityId: ex.capabilityId,
      run: async () => {
        const step = queue.length > 1 ? queue.shift() : queue[0];
        if (step.throw) throw new Error(step.throw);
        const out = { ok: !!step.ok, detail: step.detail };
        if ('output' in step) out.output = step.output;
        return out;
      },
    };
    if (ex.verify) {
      if (ex.verify.throw) impl.verify = async () => { throw new Error(ex.verify.throw); };
      else impl.verify = async () => ({ passed: ex.verify.passed, kind: ex.verify.kind, detail: ex.verify.detail });
    }
    fabric.register(impl);
  }

  const resolve = (v) => {
    if (typeof v === 'string') {
      const m = /^\$r(\d+)(?:\.(.*))?$/.exec(v);
      if (m) {
        let cur = results[Number(m[1])];
        if (m[2]) for (const part of m[2].split('.')) cur = cur?.[/^\d+$/.test(part) ? Number(part) : part];
        return cur;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = resolve(x); return o; }
    return v;
  };

  for (const op of req.ops) {
    try {
      switch (op.op) {
        case 'invoke': {
          const r = await fabric.invoke(resolve(op.capabilityId), resolve(op.input ?? {}), resolve(op.context ?? {}));
          results.push(r);
          break;
        }
        case 'evaluate':
          results.push(fabric.evaluate(resolve(op.capabilityId), resolve(op.context ?? {})));
          break;
        case 'decide': {
          const id = resolve(op.id);
          results.push(fabric.decideApproval(id, op.granted, op.by ?? 'user', op.reason));
          break;
        }
        case 'consume':
          results.push(fabric.consumeApproval(resolve(op.id)));
          break;
        case 'pending':
          results.push(JSON.parse(JSON.stringify(fabric.pendingApprovals())));
          break;
        case 'audit':
          results.push(JSON.parse(JSON.stringify(fabric.audit())));
          break;
        default:
          throw new Error(`unknown fabric op ${op.op}`);
      }
    } catch (e) {
      results.push({ __error__: String(e && e.message || e) });
    }
  }

  return { results, events, slept };
}

async function runFabricOpsWired(req) {
  const startMs = req.startMs;
  let tick = startMs;
  const nextTick = () => (tick += 1);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;
  process.env.AURA_HOME = req.home;

  const wiring = await import(process.env.TSREF_FABRICWIRING);
  const apiIndex = await import(process.env.TSREF_FABRIC_INDEX);

  const stubManager = {
    listProjects: () => [], createProject: () => { throw new Error('not in differential'); },
    open: () => { throw new Error('not in differential'); }, currentProject: () => null,
    profile: () => null, getMission: () => null, approveMission: () => null,
    knowledgeGraph: () => null, listEngineeringMemory: () => [],
    workflows: { get: () => null },
    startWorkflowRun: async () => { throw new Error('not in differential'); },
    workflowRuns: { find: () => null },
  };

  const cfg = req.config;
  const events = [];
  const fabric = wiring.createFabric({
    manager: stubManager,
    providedNodeCapabilities: () => new Set(cfg.providedNodeCapabilities ?? []),
    presentNodes: () => cfg.presentNodes ?? [],
  });
  fabric.on((e) => events.push(e));
  if (cfg.policyRaw !== undefined) fabric.setPolicy(apiIndex.sanitizePolicy(cfg.policyRaw));

  const results = [];
  const resolve = (v) => {
    if (typeof v === 'string') {
      const m = /^\$r(\d+)(?:\.(.*))?$/.exec(v);
      if (m) { let c2 = results[Number(m[1])]; if (m[2]) for (const p of m[2].split('.')) c2 = c2?.[/^\d+$/.test(p) ? Number(p) : p]; return c2; }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = resolve(x); return o; }
    return v;
  };
  for (const op of req.ops) {
    try {
      switch (op.op) {
        case 'invoke': results.push(await fabric.invoke(resolve(op.capabilityId), resolve(op.input ?? {}), resolve(op.context ?? {}))); break;
        case 'evaluate': results.push(fabric.evaluate(resolve(op.capabilityId), resolve(op.context ?? {}))); break;
        case 'decide':
          results.push(fabric.decideApproval(resolve(op.id), op.granted, op.by ?? 'user', op.reason));
          break;
        case 'consume':
          results.push(fabric.consumeApproval(resolve(op.id)));
          break;
        case 'pending': results.push(JSON.parse(JSON.stringify(fabric.pendingApprovals()))); break;
        case 'audit': results.push(JSON.parse(JSON.stringify(fabric.audit()))); break;
        default: throw new Error(`op ${op.op}`);
      }
    } catch (e) { results.push({ __error__: String(e && e.message || e) }); }
  }
  return { results, events, slept: [] };
}

// ── wfops: drive the REAL TS workflow engine through graph scripts ──────────
async function runWfOps(req) {
  const startMs = req.startMs;
  let tick = startMs;
  const nextTick = () => (tick += 1);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;
  process.env.AURA_HOME = req.home;

  const eng = await import(process.env.TSREF_WFENGINE);
  const storeMod = await import(process.env.TSREF_RUNSTORE);

  const runs = new storeMod.WorkflowRunStore();
  const events = [];
  const record = req.run ?? null;
  const opts = {
    projectId: 'p', projectPath: req.projPath, projectName: 'T',
    inputs: req.inputs ?? {}, run: record, runs,
    governor: req.governor, replay: req.replay,
  };
  const result = await eng.runWorkflow(req.workflow, opts, (e) => events.push(e));
  return { result, events, run: JSON.parse(JSON.stringify(record)) };
}

// ── autops: REAL AutomationEngine with deterministic clock/rand ─────────────
async function runAutoOps(req) {
  const { readdirSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  let tick = req.startMs;
  const nextTick = () => (tick += 1000);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;
  let randState = 1;
  globalThis.Math = Object.create(Math);
  globalThis.Math.random = () => { randState += 7; return (randState % 4194304) / 4194304; };
  for (const k of Object.getOwnPropertyNames(Math)) if (!(k in globalThis.Math)) globalThis.Math[k] = Math[k];
  process.env.AURA_HOME = req.home;

  const mod = await import(process.env.TSREF_AUTOENGINE);
  const storeMod = await import(process.env.TSREF_AUTOSTORE);
  const store = new storeMod.AutomationStore();
  const events = [];
  const slept = [];
  const gate = { open: false };
      req.gate = gate;
      const baseActions = Object.fromEntries(Object.entries(req.config.actions ?? {}).map(([k, v]) => [k, typeof v === 'function' ? v : async () => JSON.parse(JSON.stringify(v))]));
      baseActions['gated'] = async () => {
        while (!gate.open) await new Promise((r) => setImmediate(r));
        return { ok: true, summary: 'ran' };
      };
    const eng = new mod.AutomationEngine({ store, actions: baseActions,
    emit: (e) => events.push(JSON.parse(JSON.stringify(e))), sleep: async (ms) => slept.push(ms) });

  const results = [];
  const resolve = (v) => {
    if (typeof v === 'string') {
      const m = /^\$r(\d+)(?:\.(.*))?$/.exec(v);
      if (m) {
        let cur = results[Number(m[1])];
        if (m[2]) for (const part of m[2].split('.')) cur = cur?.[/^\d+$/.test(part) ? Number(part) : part];
        return cur;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = resolve(x); return o; }
    return v;
  };
  for (const op of req.ops) {
    try {
      switch (op.op) {
        case 'createRule': results.push(store.createRule(op.args[0])); break;
        case 'handleEvent': {
          const r = eng.handleEvent(op.args[0]);
          await new Promise((res) => setTimeout(res, 0));
          await new Promise((res) => setImmediate(res));
          results.push(r ? JSON.parse(JSON.stringify(r)) : null);
          break;
        }
        case 'listRuns': results.push(JSON.parse(JSON.stringify(store.listRuns((op.args ?? [undefined])[0])))); break;
        case 'indexRuns': results.push(JSON.parse(JSON.stringify(store.indexRuns(op.args[0] ?? {})))); break;
        case 'gate': req.gate.open = !!op.open; await new Promise((r) => setImmediate(r)); break;
        case 'pause': results.push(JSON.parse(JSON.stringify(eng.pauseRule(resolve(op.args[0]))))); break;
        case 'resume': {
          const rr = eng.resumeRule(resolve(op.args[0]));
          await new Promise((res) => setImmediate(res));
          await new Promise((res) => setImmediate(res));
          results.push(rr ? JSON.parse(JSON.stringify(rr)) : null);
          break;
        }
        case 'cancel': {
          const rc = eng.cancelRun(resolve(op.args[0]), resolve(op.args[1]));
          await new Promise((res) => setImmediate(res));
          await new Promise((res) => setImmediate(res));
          results.push(rc ? JSON.parse(JSON.stringify(rc)) : null);
          break;
        }
        case 'fs': {
          const fp = join(req.home, op.path);
          if (op.kind === 'write') { mkdirSync(join(fp, '..'), { recursive: true }); writeFileSync(fp, op.data); }
          else if (op.kind === 'rm') { try { rmSync(fp, { force: true }); } catch {} }
          results.push(null);
          break;
        }
        default: throw new Error(`op ${op.op}`);
      }
    } catch (e) { results.push({ __error__: String(e && e.message || e) }); }
  }
  const tree = {};
  const walk = (dir, rel) => {
    let es = []; try { es = readdirSync(dir); } catch { return; }
    for (const e of es.sort()) {
      const p = join(dir, e); const rr = rel ? `${rel}/${e}` : e;
      if (statSync(p).isDirectory()) walk(p, rr);
      else tree[rr] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(req.home, '');
  return { results, events, slept, tree };
}

// ── dryops: REAL TS dryRunWorkflow vs same graphs ───────────────────────────
async function runDryOps(req) {
  let tick = req.startMs;
  const nextTick = () => (tick += 1000);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;
  process.env.AURA_HOME = req.home;

  const mod = await import(process.env.TSREF_DRYRUN);
  const fabricApi = await import(process.env.TSREF_FABRIC_INDEX);

  class OracleFabric {
    constructor() { this.evaluations = 0; this.invocations = 0; }
    evaluate(capability_id, context) {
      this.evaluations += 1;
      const d = fabricApi.describeFabricCapability(capability_id);
      if ((req.input.denyFor ?? []).includes(capability_id)) {
        this.evaluations += 1;
        return { decision: "deny", rule: "override:test", risk: d ? d.risk : "low",
                 reason: "denied for the demo" };
      }
      const risk = d ? d.risk : "low";
      const decision = { low: "auto-execute", medium: "ask-user", high: "require-approval" }[risk];
      return { decision, rule: `risk-default:${risk}`, risk, reason: `${capability_id} ${decision}` };
    }
    async invoke() { throw new Error("DRY RUN INVOKED"); }
  }
  const fabric = new OracleFabric();
  const input = { ...req.input, fabric };
  const report = mod.dryRunWorkflow(input);
  const out = JSON.parse(JSON.stringify(report));
  out._fabricEvaluations = fabric.evaluations;
  out._fabricInvocations = fabric.invocations;
  out._fabricInvocations = fabric.invocations;
  return out;
}

// ── agentops: REAL TS AgentNodeRunner with scripted model/fabric ────────────
async function runAgentOps(req) {
  let tick = req.startMs;
  const nextTick = () => (tick += 1000);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nextTick()])); }
    static now() { return nextTick(); }
  }
  globalThis.Date = FakeDate;

  const mod = await import(process.env.TSREF_AGENTRUNNER);

  const script = ((req.fabricScript && req.fabricScript.length) ? req.fabricScript : [{ ok: true }]).map((s) => ({ ...s }));
  let invSeq = 0;
  const fabricHost = {
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => null,
    isSupported: (id) => ["filesystem.read", "terminal.execute"].includes(id),
    async requestApproval(request, _ctx) {
      const approved = new Set(req.approvedCapabilities ?? []);
      return request.items.every((item) => approved.has(item.capabilityId));
    },
    async invoke(capabilityId, input, context) {
      const step = script.length > 1 ? script.shift() : script[0];
      const base = {
        invocationId: `inv-${++invSeq}`, capabilityId,
        detail: "executed",
        verification: { passed: null, kind: null, detail: "no mechanical check" },
        policy: { decision: "auto-execute", rule: "risk-default:low",
                  risk: "low", reason: "low" },
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        durationMs: 1, attempts: 1,
      };
      if (step.park) Object.assign(base, { outcome: "awaiting-approval", approvalId: "apr-1" });
      else if (step.deny) base.outcome = "denied";
      else Object.assign(base, { outcome: "succeeded", output: { stdout: "ok" } });
      return base;
    },
  };

  const steps = req.model.map((s) => ({ ...s }));
  const pipeline = { generate: async () => {
    const step = steps.length > 1 ? steps.shift() : steps[0];
    let body;
    if (step.final !== undefined) body = { final: step.final };
    else if (step.toolCall) body = { plan: "step", tool: { name: step.toolCall.capabilityId,
                                                          input: step.toolCall.input } };
    else body = { plan: "think", final: step.text ?? "" };
    return { ok: true, text: JSON.stringify(body), usage: { totalTokens: step.tokens ?? 1 } };
  }};

  const envelope = req.envelope ?? { capabilities: [] };
  const secretsStub = { redactor: () => (t) => t,
                        resolve: (v) => ({ text: v, used: [] }) };

  const runner = mod.createAgentRunner({
    fabric: fabricHost, pipeline, secrets: secretsStub,
    workflowId: "wf", runId: "wr", projectId: "p", projectPath: "/p",
    actor: { kind: "agent", id: "agent:workflow" }, envelope,
  });

  const beats = [];
  const outcome = await runner.run(req.node, {}, { text: "" }, {
    interpolate: (t) => t,
    onBeat: (b) => beats.push(JSON.parse(JSON.stringify(b))),
    signal: undefined,
  });
  return { result: JSON.parse(JSON.stringify(outcome)), events: beats, slept: [] };
}


// ── intentops: frozen KeywordIntentClassifier/TemplatePromptEnhancer parity ──
async function runIntentOps(req) {
  const { KeywordIntentClassifier } = await import(process.env.TSREF_INTENTCLS);
  const { TemplatePromptEnhancer } = await import(process.env.TSREF_PROMPTENH);
  const cls = new KeywordIntentClassifier();
  const enh = new TemplatePromptEnhancer();
  const out = [];
  for (const text of req.input.texts) {
    const intent = await cls.classify({ input: text });
    const prompt = await enh.enhance({ input: text }, intent);
    out.push({
      text,
      intent: {
        type: intent.type,
        confidence: Math.round(intent.confidence * 1e6) / 1e6,
        rationale: intent.rationale ?? null,
        alternatives: (intent.alternatives ?? []).map((a) => ({
          type: a.type, confidence: Math.round(a.confidence * 1e6) / 1e6 })),
      },
      enhanced: prompt.enhanced,
      systemHints: prompt.systemHints ?? null,
      directives: prompt.directives ?? null,
    });
  }
  return out;
}
