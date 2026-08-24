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
