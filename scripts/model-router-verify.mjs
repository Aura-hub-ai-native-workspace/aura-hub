/**
 * model-router-verify — privacy, capability, context, cost, fallback.
 * ==================================================================
 * The router decides which model answers, and the first of its gates is
 * the one that must never be wrong: context marked `secret` may not leave
 * this machine. So the checks below are ordered the way the gates are,
 * and every one of them has a negative control — including the privacy
 * gate, where the control is the case that would silently pass on a
 * router that simply always chose local.
 *
 * Part D is a live round-trip against a REAL local model server (Ollama)
 * with no API key and no cloud provider connected. If no local server is
 * running, Part D reports NOT VERIFIED and says exactly what a human must
 * run — it does not quietly skip, and it does not pretend.
 *
 * Run:  node scripts/model-router-verify.mjs
 */

import { register } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OLLAMA = process.env.OLLAMA_HOST?.replace(/\/$/, '') ?? 'http://127.0.0.1:11434';

let failed = false;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const unverified = (name, why) => {
  results.push({ name, ok: null, extra: why });
  console.log(`NOT VERIFIED  ${name} — ${why}`);
};
const info = (m) => console.log(`      ${m}`);
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/* ══════════════════════════════════════════════════════════════════
   A — the router, as the pure decision function it is
   ══════════════════════════════════════════════════════════════════ */

/** Candidates modelled on real providers, with the catalogue's real figures. */
function candidates() {
  return [
    {
      providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o', local: false,
      capabilities: { contextWindow: 128000, inputCostPer1k: 0.0025, outputCostPer1k: 0.01, toolCalling: true },
      healthy: true, latencyMs: 300,
    },
    {
      providerId: 'anthropic', providerName: 'Anthropic', modelId: 'claude-sonnet-4-5', local: false,
      capabilities: { contextWindow: 200000, inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCalling: true },
      healthy: true, latencyMs: 400,
    },
    {
      providerId: 'groq', providerName: 'Groq', modelId: 'llama-3.1-8b-instant', local: false,
      capabilities: { contextWindow: 131072, inputCostPer1k: 0.00005, outputCostPer1k: 0.00008, toolCalling: true },
      healthy: true, latencyMs: 120,
    },
    {
      providerId: 'ollama', providerName: 'Ollama', modelId: 'qwen2.5-coder:1.5b', local: true,
      capabilities: { contextWindow: 32768, inputCostPer1k: 0, outputCostPer1k: 0, toolCalling: true },
      healthy: true, latencyMs: 900,
    },
  ];
}

async function partA() {
  section('A. The router — privacy first, then capability, context, cost');
  const { route } = await import(`${ROOT}/packages/ai-service/src/provider/router.ts`);

  /* A1 — the gate that must never be wrong. */
  const secret = route(candidates(), { taskKind: 'code', sensitivity: 'secret', promptTokens: 4000 });
  const allLocal = secret.ok && secret.chain.every((c) => c.local);
  const cloudRejected = secret.rejected.filter((r) => r.rule === 'privacy-gate');
  check('A1 `secret` context is never routed to a cloud provider',
    allLocal && cloudRejected.length === 3,
    `chain = [${secret.chain.map((c) => `${c.providerId}/${c.modelId}`).join(', ')}]; ${cloudRejected.length} refused on privacy-gate`);

  /* A1-neg — the control that makes A1 mean something. A router that
     always chose local would pass A1 and be wrong. */
  const internal = route(candidates(), { taskKind: 'code', sensitivity: 'internal', promptTokens: 4000 });
  check('A1-neg NEGATIVE CONTROL: non-secret context DOES reach cloud providers',
    internal.ok && internal.chain.some((c) => !c.local) && internal.rejected.every((r) => r.rule !== 'privacy-gate'),
    `chain = [${internal.chain.map((c) => c.providerId).join(', ')}]`);

  /* A2 — privacy beats availability. No local model and `secret` means
     no answer, not a quiet downgrade. */
  const noLocal = route(candidates().filter((c) => !c.local), { taskKind: 'code', sensitivity: 'secret', promptTokens: 100 });
  check('A2 with no local model, `secret` REFUSES rather than falling back',
    noLocal.ok === false && noLocal.chain.length === 0 && noLocal.rule === 'privacy-gate',
    noLocal.detail.split('.')[0]);
  check('A2-neg NEGATIVE CONTROL: the same list answers when nothing is secret',
    route(candidates().filter((c) => !c.local), { taskKind: 'code', sensitivity: 'public', promptTokens: 100 }).ok === true,
    'proves the refusal came from the sensitivity, not from an empty candidate list');

  /* A3 — capability. Only an explicit `false` disqualifies; unknown does not. */
  const noTools = candidates().map((c) => (c.providerId === 'groq' ? { ...c, capabilities: { ...c.capabilities, toolCalling: false } } : c));
  const needsTools = route(noTools, { taskKind: 'code', sensitivity: 'public', promptTokens: 100, requiresTools: true });
  const unknownTools = candidates().map((c) => (c.providerId === 'groq' ? { ...c, capabilities: { ...c.capabilities, toolCalling: undefined } } : c));
  const withUnknown = route(unknownTools, { taskKind: 'code', sensitivity: 'public', promptTokens: 100, requiresTools: true });
  check('A3 a model that declares no tool calling is refused for a tool task',
    needsTools.chain.every((c) => c.providerId !== 'groq')
    && needsTools.rejected.some((r) => r.providerId === 'groq' && r.rule === 'capability-gate'),
    'explicit toolCalling:false disqualifies');
  check('A3-neg NEGATIVE CONTROL: UNKNOWN tool support does not disqualify',
    withUnknown.chain.some((c) => c.providerId === 'groq'),
    'most local models advertise nothing; refusing them for silence would exclude every one');

  /* A4 — the context gate. This is the first reader `contextWindow` has
     ever had, so it has to actually read it. */
  const big = route(candidates(), { taskKind: 'code', sensitivity: 'public', promptTokens: 60000, expectedOutputTokens: 2048 });
  const ollamaRejected = big.rejected.find((r) => r.providerId === 'ollama');
  check('A4 a prompt larger than a model\'s context window is refused for it',
    Boolean(ollamaRejected) && ollamaRejected.rule === 'context-gate' && big.chain.some((c) => c.providerId === 'anthropic'),
    ollamaRejected ? ollamaRejected.reason : 'the 32k model was not refused a 62k request');
  const small = route(candidates(), { taskKind: 'code', sensitivity: 'public', promptTokens: 1000 });
  check('A4-neg NEGATIVE CONTROL: the same model IS eligible for a small prompt',
    small.chain.some((c) => c.providerId === 'ollama'),
    'proves the refusal came from the size, not from the model');

  /* A5 — cost. Cheapest healthy first among equals; an UNPRICED model is
     ranked last rather than assumed free. */
  const cheapestFirst = route(candidates(), { taskKind: 'chat', sensitivity: 'public', promptTokens: 1000, expectedOutputTokens: 1000 });
  const cloudOrder = cheapestFirst.chain.filter((c) => !c.local).map((c) => c.providerId);
  check('A5 cheaper providers are preferred among equals',
    cloudOrder[0] === 'groq',
    `cloud order: ${cloudOrder.join(' → ')}`);

  const unpriced = candidates().map((c) => (c.providerId === 'groq'
    ? { ...c, capabilities: { contextWindow: 131072, toolCalling: true } }
    : c));
  const withUnpriced = route(unpriced, { taskKind: 'chat', sensitivity: 'public', promptTokens: 1000, expectedOutputTokens: 1000 });
  const unpricedOrder = withUnpriced.chain.filter((c) => !c.local).map((c) => c.providerId);
  check('A5-neg NEGATIVE CONTROL: an unpriced model is ranked last, not treated as free',
    unpricedOrder[unpricedOrder.length - 1] === 'groq',
    `cloud order with groq unpriced: ${unpricedOrder.join(' → ')}`);

  /* A6 — an explicit per-call budget. */
  const budgeted = route(candidates(), { taskKind: 'chat', sensitivity: 'public', promptTokens: 100000, expectedOutputTokens: 4000, maxCostUsd: 0.05 });
  check('A6 a per-call budget removes what exceeds it',
    budgeted.rejected.some((r) => r.rule === 'budget-gate') && budgeted.ok,
    `${budgeted.rejected.filter((r) => r.rule === 'budget-gate').length} candidate(s) over budget; chose ${budgeted.chain[0]?.providerId}`);

  /* A7 — offline. */
  const offline = route(candidates(), { taskKind: 'chat', sensitivity: 'public', promptTokens: 100, networkUp: false });
  check('A7 with no network, only local models remain',
    offline.ok && offline.chain.every((c) => c.local) && offline.rejected.every((r) => r.rule === 'network-gate'),
    `chain = [${offline.chain.map((c) => c.providerId).join(', ')}]`);
  check('A7-neg NEGATIVE CONTROL: with no network AND no local model, it refuses',
    route(candidates().filter((c) => !c.local), { taskKind: 'chat', sensitivity: 'public', promptTokens: 100, networkUp: false }).ok === false,
    'an offline machine with no local model has no answer, and says so');

  /* A8 — the chain's shape: preferred → sibling cloud → local. */
  const preferred = route(candidates(), { taskKind: 'chat', sensitivity: 'public', promptTokens: 100, preferProviderId: 'anthropic' });
  const shape = preferred.chain.map((c) => c.providerId);
  check('A8 the fallback chain is preferred → sibling cloud → local',
    shape[0] === 'anthropic' && shape[shape.length - 1] === 'ollama' && shape.length === 4,
    shape.join(' → '));
}

/* ══════════════════════════════════════════════════════════════════
   B — the tokenizer
   ══════════════════════════════════════════════════════════════════ */

async function partB() {
  section('B. A real tokenizer, and an honest label when it is not one');
  const tk = await import(`${ROOT}/packages/ai-service/src/tokenizer/index.ts`);
  const bpe = await import(`${ROOT}/packages/ai-service/src/tokenizer/bpe.ts`);

  /* B1 — the BPE merge algorithm itself, against a hand-built rank table
     with a known answer. This is what makes "real BPE" a claim with a
     test behind it rather than an assertion about unexercised code. */
  {
    const ranks = new Map();
    // Merges, in rank order: "ab", then "abc", then "abcd".
    ranks.set('ab', 0);
    ranks.set('abc', 1);
    ranks.set('abcd', 2);
    const table = { name: 'test', ranks };
    const one = bpe.bpeMerge(new Uint8Array(Buffer.from('abcd', 'utf8')), ranks);
    const partial = bpe.bpeMerge(new Uint8Array(Buffer.from('abce', 'utf8')), ranks);
    // "abcd" collapses to a single token; "abce" collapses to "abc" + "e".
    check('B1 the BPE merge loop merges by lowest rank, repeatedly',
      one === 1 && partial === 2,
      `"abcd" → ${one} token, "abce" → ${partial} tokens`);
    check('B1-neg NEGATIVE CONTROL: with no merges, every byte is a token',
      bpe.bpeMerge(new Uint8Array(Buffer.from('abcd', 'utf8')), new Map()) === 4,
      'if this were also 1, the merge table is being ignored');
    void table;
  }

  /* B2 — the published .tiktoken format is parsed exactly. */
  {
    const lines = [
      `${Buffer.from('ab').toString('base64')} 0`,
      `${Buffer.from('abc').toString('base64')} 1`,
      'not a valid line',
      `${Buffer.from('hello').toString('base64')} 2`,
    ].join('\n');
    const parsed = bpe.parseTiktoken(lines, 'fixture');
    check('B2 the published .tiktoken rank format is parsed, bad lines skipped',
      parsed.ranks.size === 3 && parsed.ranks.get('abc') === 1,
      `${parsed.ranks.size} ranks from 4 lines, one of them malformed`);
  }

  /* B3 — the full ladder uses a vocabulary when one is present. */
  {
    const ranks = new Map();
    for (const word of ['const', ' x', ' =', ' 42', ';']) ranks.set(word, ranks.size);
    bpe.__installRankTable('o200k_base', { name: 'o200k_base', ranks });
    const withVocab = tk.countTokensSync('const x = 42;', { providerId: 'openai', modelId: 'gpt-4o' });
    check('B3 with a vocabulary present, the count is real BPE and says so',
      withVocab.method === 'bpe' && withVocab.exact === true && withVocab.tokens === 5,
      `${withVocab.tokens} tokens · ${withVocab.detail}`);
    bpe.__installRankTable('o200k_base', null);
    const without = tk.countTokensSync('const x = 42;', { providerId: 'openai', modelId: 'gpt-4o' });
    check('B3-neg NEGATIVE CONTROL: with no vocabulary it does NOT claim to be exact',
      without.method === 'estimate' && without.exact === false,
      `${without.tokens} tokens · ${without.detail}`);
  }

  /* B4 — the estimate is not `length / 4`. Four-chars-per-token is
     roughly right for prose and badly wrong for what AURA actually
     sends, so the two must visibly differ on code. */
  {
    const code = 'export const handleRequest = async (req: Request): Promise<Response> => { return new Response(JSON.stringify({ok:true}),{status:200}); };';
    const structural = tk.estimateTokensStructural(code);
    const naive = tk.charsOverFour(code);
    check('B4 the estimate is structural, not characters ÷ 4',
      structural !== naive && structural > 0,
      `structural=${structural} vs length/4=${naive} on a line of TypeScript`);
    const cjk = '这是一段中文文本，用来测试分词器对多字节文本的处理方式。';
    check('B4 non-Latin text is not under-counted the way length/4 does',
      tk.estimateTokensStructural(cjk) > tk.charsOverFour(cjk),
      `structural=${tk.estimateTokensStructural(cjk)} vs length/4=${tk.charsOverFour(cjk)} on CJK`);
  }

  /* B5 — `chars-over-4` exists, is labelled, and is the floor. */
  check('B5 the length/4 fallback is present and clearly labelled as a last resort',
    tk.countTokensSync('').method === 'bpe'
    && /LAST RESORT/.test(fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/tokenizer/index.ts'), 'utf8')),
    'reachable only when even pre-tokenization throws');

  /* B6 — all three original `/4` sites are gone. */
  {
    const sites = [
      'packages/ai-service/src/intelligence/contextAssembler.ts',
      'packages/ai-service/src/context/systemPrompt.ts',
      'packages/retrieval/src/types.ts',
    ];
    // Comments are stripped first: these files now DESCRIBE the divisor
    // they replaced, and a detector that cannot tell code from prose
    // would report the explanation as the offence.
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders = sites.filter((f) => {
      const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      // The retrieval seam keeps ONE labelled floor named `charsOverFour`.
      return /\.length \/ 4/.test(code) && !code.includes('charsOverFour');
    });
    check('B6 none of the three original `length / 4` sites still decides a budget',
      offenders.length === 0,
      offenders.length ? `still naive: ${offenders.join(', ')}` : 'all three now go through the tokenizer');
  }
}

/* ══════════════════════════════════════════════════════════════════
   C — the per-model catalogue
   ══════════════════════════════════════════════════════════════════ */

async function partC() {
  section('C. Published context windows and prices, actually read');
  const cat = await import(`${ROOT}/packages/ai-service/src/provider/modelCatalog.ts`);

  const gpt4o = cat.catalogEntry('openai', 'gpt-4o-2024-11-20');
  check('C1 a dated model snapshot resolves to its family\'s published figures',
    Boolean(gpt4o) && gpt4o.contextWindow === 128000 && gpt4o.inputCostPer1k === 0.0025 && gpt4o.source.startsWith('https://'),
    gpt4o ? `gpt-4o-2024-11-20 → ${gpt4o.contextWindow} ctx, $${gpt4o.inputCostPer1k}/1k in · ${gpt4o.source}` : 'no entry');

  const mini = cat.catalogEntry('openai', 'gpt-4o-mini');
  check('C1 longest-prefix wins, so gpt-4o-mini is not priced as gpt-4o',
    Boolean(mini) && mini.inputCostPer1k === 0.00015,
    mini ? `$${mini.inputCostPer1k}/1k in` : 'no entry');

  check('C2 an unknown model gets NO cost fields rather than an invented price',
    cat.catalogEntry('openai', 'some-unreleased-model') === null
    && cat.estimateCost({ contextWindow: 4096 }, 1000, 1000) === null,
    'absent is honest; zero would make the router route by fiction');

  const cost = cat.estimateCost({ inputCostPer1k: 0.0025, outputCostPer1k: 0.01 }, 10000, 2000);
  check('C3 cost is computed from the published rates',
    Math.abs(cost - (0.0025 * 10 + 0.01 * 2)) < 1e-9,
    `10k in + 2k out on gpt-4o = $${cost.toFixed(4)}`);

  const local = cat.capabilitiesForLocalModel('qwen2.5-coder:1.5b', '1.5B');
  check('C4 a local model costs zero, and its context window is NOT guessed',
    local.inputCostPer1k === 0 && local.outputCostPer1k === 0 && local.contextWindow === undefined,
    'the window comes from the server that will run it, or it is absent');

  check('C5 the recorded-on date is carried so a stale price can be spotted',
    /^\d{4}-\d{2}-\d{2}$/.test(cat.PRICES_RECORDED_AT),
    `PRICES_RECORDED_AT = ${cat.PRICES_RECORDED_AT}`);
}

/* ══════════════════════════════════════════════════════════════════
   D — live: a real local model, no API key, no cloud provider
   ══════════════════════════════════════════════════════════════════ */

async function ollamaModels() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.models ?? []).filter((m) => !m.capabilities || m.capabilities.includes('completion'));
  } catch { return null; }
}

/**
 * A fault-injection server that speaks LM Studio's OpenAI-compatible API.
 *
 * It is NOT a model and never pretends to be one: it lists a model so the
 * provider connects exactly as a real LM Studio would, and then fails
 * every completion with 503. There is no way to make a real provider go
 * down on command, and "a provider that is down" is precisely the
 * condition the fallback chain exists for.
 */
function faultInjectingLmStudio(port) {
  const state = { failCompletions: false, completionAttempts: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fault-injection-target', object: 'model' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      state.completionAttempts += 1;
      if (state.failCompletions) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'service unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'fault-injection-target',
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, state, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)) };
}

async function startService(home, port, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/run-ts.mjs'), path.join(ROOT, 'packages/ai-service/src/start.ts'), '--none'], {
    cwd: ROOT,
    env: { ...process.env, AURA_HOME: home, AI_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 90000;
  for (;;) {
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`service did not start:\n${log}`); }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch { /* not up */ }
    await sleep(500);
  }
  return { child, logText: () => log };
}

async function partD() {
  section('D. Live — a real local model, with no API key and no cloud provider');

  const models = await ollamaModels();
  if (!models || models.length === 0) {
    unverified('D live local round-trip',
      `no local model server answered at ${OLLAMA}. To verify: install Ollama (https://ollama.com/download), run `
      + '`ollama serve`, then `ollama pull qwen2.5-coder:1.5b`, then re-run this script. '
      + (models ? 'Ollama answered but has no chat model installed.' : 'Nothing answered /api/tags.'));
    return;
  }
  info(`Ollama at ${OLLAMA} with ${models.length} chat model(s): ${models.map((m) => m.name).join(', ')}`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-router-'));
  const port = await freePort();
  const lmPort = await freePort();
  /* Built now, but NOT listening yet. Boot discovery must find only the
     real Ollama, so D1-D5 measure a real local model rather than this
     test's own stub — and D6 then brings the stub up deliberately. */
  const fault = faultInjectingLmStudio(lmPort);

  let svc;
  try {
    svc = await startService(home, port, { LMSTUDIO_BASE_URL: `http://127.0.0.1:${lmPort}/v1` });
    const API = `http://127.0.0.1:${port}`;

    /* D1 — no key was ever supplied, and there is AI anyway. */
    const providers = await (await fetch(`${API}/providers`)).json();
    const connectedIds = providers.connected.map((c) => c.id);
    const allLocal = providers.connected.every((c) => providers.providers.find((p) => p.id === c.id)?.local === true);
    check('D1 the hub connected a model with no API key and no cloud provider',
      connectedIds.length === 1 && connectedIds[0] === 'ollama' && allLocal && providers.active === 'ollama',
      `connected: ${connectedIds.join(', ')} · active: ${providers.active}/${providers.activeModel}`);

    const ollamaProvider = providers.connected.find((c) => c.id === 'ollama');
    const withWindow = (ollamaProvider?.models ?? []).filter((m) => m.capabilities?.contextWindow > 0);
    check('D2 local models report their REAL context window, from the server',
      withWindow.length > 0,
      withWindow.length ? withWindow.map((m) => `${m.id}=${m.capabilities.contextWindow}`).join(', ') : 'no context windows discovered');
    check('D2-neg NEGATIVE CONTROL: embedding-only models are not offered as chat targets',
      !(ollamaProvider?.models ?? []).some((m) => /nomic-embed|embed-text/.test(m.id)),
      'routing a question to an embedding model fails confusingly at generate time');

    /* D3 — the privacy gate, on the REAL connected set. */
    const secretRoute = await (await fetch(`${API}/providers/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'the production database password is in this paragraph', sensitivity: 'secret' }),
    })).json();
    check('D3 `secret` routes only to a model on this machine',
      secretRoute.decision.ok && secretRoute.decision.chain.every((c) => c.local),
      `chose ${secretRoute.decision.chain[0]?.providerId}/${secretRoute.decision.chain[0]?.modelId} · ${secretRoute.promptTokens} prompt tokens`);

    /* D4 — a genuine round trip, offline, on a real model. */
    const t0 = Date.now();
    const asked = await (await fetch(`${API}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Reply with exactly the word: ONLINE' }),
    })).json();
    const took = Date.now() - t0;
    check('D4 AURA answers with no internet and no API key',
      asked.ok === true && typeof asked.answer === 'string' && asked.answer.trim().length > 0,
      asked.ok ? `${asked.provider} answered in ${took}ms: "${asked.answer.trim().slice(0, 60).replace(/\n/g, ' ')}"` : JSON.stringify(asked.error ?? asked).slice(0, 200));
    check('D4 the answer is attributed to a LOCAL model in the routing report',
      asked.routing?.chosen?.local === true,
      asked.routing ? `${asked.routing.chosen.providerId}/${asked.routing.chosen.modelId} — ${asked.routing.detail}` : 'no routing report');

    /* D5 — the provider's OWN token counter, from the server that runs it. */
    {
      const { OllamaRuntime } = await import(`${ROOT}/packages/ai-service/src/provider/adapters/local.ts`);
      const runtime = new OllamaRuntime(OLLAMA, models[0].name);
      const exact = await runtime.countPromptTokens('The quick brown fox jumps over the lazy dog.');
      check('D5 a local model counts its own prompt tokens (a real tokenizer, not an estimate)',
        typeof exact === 'number' && exact > 0,
        exact === null ? 'the server did not report prompt_eval_count' : `${models[0].name} reports ${exact} prompt tokens`);
      const tk = await import(`${ROOT}/packages/ai-service/src/tokenizer/index.ts`);
      const viaLadder = await tk.countTokens('The quick brown fox jumps over the lazy dog.', {
        modelId: models[0].name,
        counter: (text, model) => runtime.countPromptTokens(text, model),
      });
      check('D5 the tokenizer ladder prefers the provider counter and labels it exact',
        viaLadder.method === 'provider' && viaLadder.exact === true,
        `${viaLadder.tokens} tokens · ${viaLadder.detail}`);
    }

    /* D6 — the fallback chain, with a provider that is genuinely failing. */
    {
      // Bring the fault-injection endpoint up and connect it as LM Studio,
      // then make it active — exactly the state a user with a real LM
      // Studio running would be in.
      await fault.listen();
      const connected = await (await fetch(`${API}/providers/local/discover`, { method: 'POST' })).json();
      const lm = connected.local.find((l) => l.providerId === 'lmstudio');
      check('D6 the fault-injection endpoint connected as a normal provider',
        Boolean(lm?.ok),
        lm ? `${lm.endpoint} · ${lm.models} model(s)` : 'not connected');

      await fetch(`${API}/providers/switch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'lmstudio', model: 'fault-injection-target' }),
      });

      // Now take it down, the way a real one goes down.
      fault.state.failCompletions = true;
      const attemptsBefore = fault.state.completionAttempts;

      const failedOver = await (await fetch(`${API}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Reply with exactly the word: FALLBACK' }),
      })).json();

      const attempted = failedOver.routing?.attempted ?? [];
      check('D6 a failing provider falls over to the next in the chain',
        failedOver.ok === true && attempted.length > 1 && attempted[0].providerId === 'lmstudio'
        && failedOver.routing?.chosen?.providerId === 'ollama',
        `attempted ${attempted.map((a) => a.providerId).join(' → ')}; answered by ${failedOver.routing?.chosen?.providerId}`);
      check('D6 the failing provider was really contacted (not skipped)',
        fault.state.completionAttempts > attemptsBefore,
        `${fault.state.completionAttempts - attemptsBefore} completion attempt(s) hit the failing server`);

      // The active provider must NOT have been silently reassigned: the
      // user chose LM Studio and still has it chosen.
      const after = await (await fetch(`${API}/providers`)).json();
      check('D6-neg NEGATIVE CONTROL: a failover does not steal the user\'s active provider',
        after.active === 'lmstudio',
        `active is still ${after.active}`);

      // And with the provider healthy again, no failover happens — which
      // proves D6 detected a real failure rather than always failing over.
      fault.state.failCompletions = false;
      const healthy = await (await fetch(`${API}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Reply with exactly the word: HEALTHY' }),
      })).json();
      check('D6-neg NEGATIVE CONTROL: a healthy provider is not failed over',
        healthy.ok === true && (healthy.routing?.attempted ?? []).length === 1
        && healthy.routing?.chosen?.providerId === 'lmstudio',
        `attempted ${(healthy.routing?.attempted ?? []).map((a) => a.providerId).join(' → ')}`);
    }
  } finally {
    if (svc) {
      svc.child.kill('SIGTERM');
      await new Promise((r) => { svc.child.on('exit', r); setTimeout(r, 4000); });
    }
    fault.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ── run ───────────────────────────────────────────────────────── */

try {
  await partA();
  await partB();
  await partC();
  await partD();
} catch (e) {
  console.error(`\nFATAL  ${e.stack ?? e.message}`);
  failed = true;
}

console.log(`\n${'═'.repeat(66)}`);
const passed = results.filter((r) => r.ok === true).length;
const skipped = results.filter((r) => r.ok === null).length;
console.log(`${passed}/${results.filter((r) => r.ok !== null).length} checks passed${skipped ? ` · ${skipped} NOT VERIFIED` : ''}`);
process.exit(failed ? 1 : 0);
