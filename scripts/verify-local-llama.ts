/**
 * Local LLaMA provider verification.
 * ==================================================================
 * Exercises the real local-llama stack — registration, URL
 * configuration, model discovery, health states, chat, streaming,
 * cancellation, routing through RuntimeManager and the governance
 * boundary — against local mock llama-server endpoints. No real network
 * call is ever made unless the opt-in live variables are set (see §L).
 *
 * AURA_HOME is redirected to a temp directory and AURA_PROVIDER_SECRET is
 * fixed, so the user's real provider store is never touched. Env vars are
 * set BEFORE the ai-service modules load. The live-test variables are
 * captured first and restored only for the live section, so a configured
 * developer machine can run both mock and live checks in one pass.
 *
 * Usage: node scripts/run-ts.mjs scripts/verify-local-llama.ts
 * Live:  AURA_LOCAL_LLM_BASE_URL=http://<host>:<port>/v1 \
 *        AURA_LOCAL_LLM_MODEL=<model> AURA_LOCAL_LLM_API_KEY=<optional> \
 *        node scripts/run-ts.mjs scripts/verify-local-llama.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Capture live-test configuration before the mock setup overwrites it. */
const LIVE_BASE_URL = process.env.AURA_LOCAL_LLM_BASE_URL;
const LIVE_MODEL = process.env.AURA_LOCAL_LLM_MODEL;
const LIVE_API_KEY = process.env.AURA_LOCAL_LLM_API_KEY;

process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-verify-local-llama-'));
process.env.AURA_PROVIDER_SECRET = 'verify-local-llama-seed';

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

const {
  LocalLlamaAdapter,
  normalizeLocalLlamaUrl,
  localLlamaOrigin,
  localLlamaConfigError,
  parseLocalLlamaModels,
  DEFAULT_LOCAL_LLAMA_ORIGIN,
} = await import('../packages/ai-service/src/provider/adapters/local-llama.ts');
const { getAdapter, getAllAdapters, ENV_VAR_BY_PROVIDER } = await import('../packages/ai-service/src/provider/registry.ts');
const { RuntimeManager, listProviders, storeCredential } = await import('../packages/ai-service/src/provider/index.ts');
const { getKey } = await import('../packages/ai-service/src/provider/credentialStore.ts');
const { resolveModel, isModelValidForProvider } = await import('../packages/ai-service/src/provider/modelValidation.ts');
const { ProviderHttpError, translateProviderError } = await import('../packages/ai-service/src/provider/errorTranslator.ts');

let failures = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures += 1;
  console.error(`  ✗ ${name}${detail !== undefined ? ` — ${String(detail)}` : ''}`);
}

/* ── mock llama-server ───────────────────────────────────────────── */

const MOCK_MODELS = ['qwen-3.5-27b-instruct', 'qwen-3.5-7b-instruct'];

interface MockFlags {
  modelsMode: 'ok' | 'empty' | 'malformed' | 'alt-shape';
  requireKey: boolean;
  expectedKey: string;
  delayModelsMs: number;
  slowStream: boolean;
}

class MockLlamaServer {
  private server: Server;
  port = 0;
  lastAuthHeader: string | null = null;
  lastChatBody: { model?: string; messages?: { role: string; content: string }[]; stream?: boolean } | null = null;
  requestCount = 0;
  flags: MockFlags = { modelsMode: 'ok', requireKey: false, expectedKey: 'test-key-ok', delayModelsMs: 0, slowStream: false };
  constructor(private label: string, private models: string[] = MOCK_MODELS) { this.server = createServer((req, res) => void this.handle(req, res)); }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  close(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestCount += 1;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? null;
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      this.lastAuthHeader = auth;
      if (this.flags.delayModelsMs > 0) await new Promise((r) => setTimeout(r, this.flags.delayModelsMs));
      if (this.flags.requireKey && auth !== `Bearer ${this.flags.expectedKey}`) {
        return this.json(res, 401, { error: { message: 'invalid api key' } });
      }
      if (this.flags.modelsMode === 'empty') return this.json(res, 200, { data: [] });
      if (this.flags.modelsMode === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('this is not json{{{');
        return;
      }
      if (this.flags.modelsMode === 'alt-shape') {
        // llama.cpp-adjacent tolerance shape: `{models}`, string entries,
        // duplicates and a nameless entry the parser must skip.
        return this.json(res, 200, { models: [...this.models, this.models[0], '', { id: '' }] });
      }
      return this.json(res, 200, { data: this.models.map((id) => ({ id, object: 'model' })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      this.lastAuthHeader = auth;
      if (this.flags.requireKey && auth !== `Bearer ${this.flags.expectedKey}`) {
        return this.json(res, 401, { error: { message: 'invalid api key' } });
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: { stream?: boolean; model?: string; messages?: { role: string; content: string }[] } = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        this.lastChatBody = body;
        const model = body.model ?? 'qwen-3.5-27b-instruct';
        if (model === 'missing-model') return this.json(res, 404, { error: { message: 'model not found' } });
        const text = `[${this.label}:${model}] mock llama reply`;
        if (body.stream) return this.stream(res, model, text);
        return this.json(res, 200, {
          id: 'mock-1', model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });
      return;
    }
    this.json(res, 404, { error: { message: 'not found' } });
  }
  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private stream(res: ServerResponse, model: string, text: string): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const words = text.split(' ');
    const send = (i: number): void => {
      if (i < words.length) {
        res.write(`data: ${JSON.stringify({ id: 'mock-1', model, choices: [{ index: 0, delta: { content: words[i] + ' ' } }] })}\n\n`);
        if (this.flags.slowStream && i === 0) { setTimeout(() => send(1), 300); return; }
        send(i + 1);
        return;
      }
      // One malformed line the shared SSE parser must skip without failing.
      res.write('data: {not valid json\n\n');
      res.write(`data: ${JSON.stringify({ id: 'mock-1', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    send(0);
  }
}

const mock = new MockLlamaServer('local-llama');
const mock2 = new MockLlamaServer('local-llama-2', ['other-model']);
await mock.start();
await mock2.start();
process.env.AURA_LOCAL_LLM_BASE_URL = mock.url;

const adapter = new LocalLlamaAdapter();

/* ── A. registry ─────────────────────────────────────────────────── */

console.log('\nA. Registry');
check('local-llama adapter resolves from the registry', getAdapter('local-llama')?.metadata.id === 'local-llama');
check('registry lists the provider exactly once', getAllAdapters().filter((a) => a.metadata.id === 'local-llama').length === 1);
check('metadata id is local-llama', adapter.metadata.id === 'local-llama', adapter.metadata.id);
check('metadata name is Local LLaMA', adapter.metadata.name === 'Local LLaMA', adapter.metadata.name);
check('metadata description names self-hosted llama-server', /self-hosted llama-server/i.test(adapter.metadata.description), adapter.metadata.description);
check('metadata docsUrl points at llama.cpp', adapter.metadata.docsUrl === 'https://github.com/llama.cpp/llama.cpp', adapter.metadata.docsUrl);
check('metadata defaultModel is qwen-3.5-27b-instruct', adapter.metadata.defaultModel === 'qwen-3.5-27b-instruct', adapter.metadata.defaultModel);
check('adapter declares authOptional', adapter.authOptional === true);
check('listProviders exposes local-llama with authOptional', listProviders().some((p) => p.id === 'local-llama' && p.authOptional === true));
check('ENV_VAR_BY_PROVIDER maps AURA_LOCAL_LLM_API_KEY', ENV_VAR_BY_PROVIDER['local-llama'] === 'AURA_LOCAL_LLM_API_KEY', JSON.stringify(ENV_VAR_BY_PROVIDER['local-llama']));
check('detect() claims no key shape', adapter.detect('anything-at-all') === false);

/* ── B. configuration ────────────────────────────────────────────── */

console.log('\nB. Configuration');
check('loopback default origin', DEFAULT_LOCAL_LLAMA_ORIGIN === 'http://127.0.0.1:8080', DEFAULT_LOCAL_LLAMA_ORIGIN);
delete process.env.AURA_LOCAL_LLM_BASE_URL;
check('unset env falls back to the loopback default', localLlamaOrigin() === DEFAULT_LOCAL_LLAMA_ORIGIN && localLlamaConfigError() === null);
process.env.AURA_LOCAL_LLM_BASE_URL = `${mock.url}/v1/`;
check('configured URL resolves (strips /v1 + slash)', localLlamaOrigin() === mock.url && localLlamaConfigError() === null, localLlamaOrigin());
const urlCases: [string, boolean][] = [
  ['http://192.168.1.10:8080/v1', true],
  ['https://llama.example.com/', true],
  ['http://[::1]:8080', true],
  ['', false],
  ['not-a-url', false],
  ['ftp://host/models', false],
  ['file:///etc/passwd', false],
  ['javascript:alert(1)', false],
  ['http://user:pass@host:8080/v1', false],
  ['http:///missing-host', false],
];
for (const [input, wantOk] of urlCases) {
  check(`URL ${wantOk ? 'accepted' : 'rejected'}: ${input || '(empty)'}`, normalizeLocalLlamaUrl(input).ok === wantOk, JSON.stringify(normalizeLocalLlamaUrl(input)));
}
process.env.AURA_LOCAL_LLM_BASE_URL = 'ftp://host/models';
check('invalid env surfaces a config error (no silent fallback)', localLlamaConfigError() !== null, localLlamaConfigError());
{
  const invalidValidation = await adapter.validate('');
  check('invalid env fails validation deterministically', invalidValidation.ok === false && /valid (server )?url|http\(s\)/i.test(invalidValidation.error ?? ''), invalidValidation.error);
}
check('invalid env discovers nothing', (await adapter.discoverModels('')).length === 0);
check('invalid env health reports error state', (await adapter.checkHealth('')).state === 'error', JSON.stringify(await adapter.checkHealth('')));
process.env.AURA_LOCAL_LLM_BASE_URL = mock.url;

/* Requests follow the configured URL: point at the second mock and the
   traffic must move there, proving settings → adapter → runtime wiring. */
const before = mock2.requestCount;
process.env.AURA_LOCAL_LLM_BASE_URL = mock2.url;
await adapter.discoverModels('');
check('configured base URL is actually used for requests', mock2.requestCount > before, `mock2 requests: ${mock2.requestCount}`);
process.env.AURA_LOCAL_LLM_BASE_URL = mock.url;

/* ── C. model discovery ──────────────────────────────────────────── */

console.log('\nC. Model discovery');
mock.flags = { modelsMode: 'ok', requireKey: false, expectedKey: 'test-key-ok', delayModelsMs: 0, slowStream: false };
const discovered = await adapter.discoverModels('');
check('discovers the served models', discovered.some((m) => m.id === 'qwen-3.5-27b-instruct') && discovered.length === MOCK_MODELS.length, discovered.map((m) => m.id));
check('capabilities stay conservative (streaming only)', discovered.every((m) => m.capabilities.streaming === true && m.capabilities.vision === undefined && m.capabilities.reasoning === undefined), JSON.stringify(discovered[0]?.capabilities));
mock.flags.modelsMode = 'alt-shape';
const alt = await adapter.discoverModels('');
check('tolerates alt shapes, dedupes, skips nameless entries', alt.length === MOCK_MODELS.length, alt.map((m) => m.id));
mock.flags.modelsMode = 'empty';
check('empty catalogue discovers nothing', (await adapter.discoverModels('')).length === 0);
mock.flags.modelsMode = 'malformed';
check('malformed body discovers nothing (deterministic)', (await adapter.discoverModels('')).length === 0);
mock.flags = { modelsMode: 'ok', requireKey: true, expectedKey: 'test-key-ok', delayModelsMs: 0, slowStream: false };
check('wrong key discovers nothing', (await adapter.discoverModels('wrong-key')).length === 0);
check('empty key against a keyed server discovers nothing', (await adapter.discoverModels('')).length === 0);
check('correct key discovers against a keyed server', (await adapter.discoverModels('test-key-ok')).length === MOCK_MODELS.length);
process.env.AURA_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:1';
check('unreachable server discovers nothing (honest)', (await adapter.discoverModels('')).length === 0);
process.env.AURA_LOCAL_LLM_BASE_URL = mock.url;
mock.flags.requireKey = false;
check('parse helper: bare array + strings', parseLocalLlamaModels(['a', 'b', 'a']).map((m) => m.id).join(',') === 'a,b');
check('parse helper: non-array garbage yields []', parseLocalLlamaModels({ nope: 1 }).length === 0 && parseLocalLlamaModels(null).length === 0);

/* ── D. health ───────────────────────────────────────────────────── */

console.log('\nD. Health');
mock.flags = { modelsMode: 'ok', requireKey: false, expectedKey: 'test-key-ok', delayModelsMs: 0, slowStream: false };
const healthy = await adapter.checkHealth('');
check('healthy server reports connected + latency', healthy.ok === true && healthy.state === 'connected' && healthy.latencyMs >= 0 && typeof healthy.lastChecked === 'string', JSON.stringify(healthy));
mock.flags.modelsMode = 'empty';
const noModels = await adapter.checkHealth('');
check('empty catalogue is no-models, not connected', noModels.ok === false && noModels.state === 'no-models', JSON.stringify(noModels));
mock.flags.modelsMode = 'malformed';
const malformed = await adapter.checkHealth('');
check('malformed body is an error state', malformed.ok === false && malformed.state === 'error', JSON.stringify(malformed));
mock.flags = { modelsMode: 'ok', requireKey: true, expectedKey: 'test-key-ok', delayModelsMs: 0, slowStream: false };
const unauth = await adapter.checkHealth('');
check('keyed server + no key is unauthorized (with guidance)', unauth.ok === false && unauth.state === 'unauthorized' && (unauth.error ?? '').includes('requires an API key'), unauth.error);
const unauthKeyed = await adapter.checkHealth('wrong-key');
check('wrong key is unauthorized', unauthKeyed.ok === false && unauthKeyed.state === 'unauthorized', unauthKeyed.error);
process.env.AURA_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:1';
const down = await adapter.checkHealth('');
check('unreachable server is unreachable (no leak)', down.ok === false && down.state === 'unreachable' && !(down.error ?? '').includes('test-key'), down.error);
process.env.AURA_LOCAL_LLM_BASE_URL = mock.url;
mock.flags = { modelsMode: 'ok', requireKey: false, expectedKey: 'test-key-ok', delayModelsMs: 6000, slowStream: false };
const timedOut = await adapter.checkHealth('');
check('stalled server times out distinctly (~5s)', timedOut.ok === false && timedOut.state === 'unreachable' && (timedOut.error ?? '').includes('timed out'), timedOut.error);
mock.flags.delayModelsMs = 0;

/* ── E. chat ─────────────────────────────────────────────────────── */

console.log('\nE. Chat');
mock.lastChatBody = null;
mock.lastAuthHeader = 'unset';
const rt = adapter.createRuntime('', 'qwen-3.5-27b-instruct');
const gen = await rt.generate({ system: 'You are a test assistant.', messages: [{ role: 'user', content: 'hi' }] });
check('generate returns server content', gen.content.includes('mock llama reply'), gen.content);
check('generate reports the served model', gen.model === 'qwen-3.5-27b-instruct', gen.model);
check('generate reports usage', gen.usage.totalTokens === 15, JSON.stringify(gen.usage));
check('system + user messages both sent', mock.lastChatBody?.messages?.length === 2 && mock.lastChatBody.messages[0]?.role === 'system' && mock.lastChatBody.messages[1]?.role === 'user', JSON.stringify(mock.lastChatBody?.messages));
check('correct model sent', mock.lastChatBody?.model === 'qwen-3.5-27b-instruct', mock.lastChatBody?.model);
check('no Authorization header when keyless', mock.lastAuthHeader === null, mock.lastAuthHeader);
const rtKeyed = adapter.createRuntime('test-key-ok', 'qwen-3.5-27b-instruct');
await rtKeyed.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('Bearer header sent when a key is configured', mock.lastAuthHeader === 'Bearer test-key-ok', mock.lastAuthHeader);

mock.flags.requireKey = true;
let chatErr: unknown = null;
try {
  await adapter.createRuntime('wrong-key', 'qwen-3.5-27b-instruct').generate({ messages: [{ role: 'user', content: 'hi' }] });
} catch (e) { chatErr = e; }
check('401 surfaces as ProviderHttpError(401)', chatErr instanceof ProviderHttpError && chatErr.status === 401, String(chatErr));
if (chatErr instanceof ProviderHttpError) {
  const t = translateProviderError(chatErr.providerName, chatErr.status, chatErr.body);
  check('401 classifies as auth, not retryable', t.type === 'auth' && t.retryable === false, t.type);
  check('translated message leaks no key material', !t.message.includes('wrong-key'), t.message);
}
let notFoundErr: unknown = null;
try {
  await adapter.createRuntime('test-key-ok', 'missing-model').generate({ messages: [{ role: 'user', content: 'hi' }] });
} catch (e) { notFoundErr = e; }
check('unknown model maps to the model category', notFoundErr instanceof ProviderHttpError && translateProviderError(notFoundErr.providerName, notFoundErr.status, notFoundErr.body).type === 'model');
mock.flags.requireKey = false;

/* ── F. streaming ────────────────────────────────────────────────── */

console.log('\nF. Streaming');
let streamed = '';
let sawUsage = false;
for await (const chunk of rt.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
  if (chunk.delta) streamed += chunk.delta;
  if (chunk.usage) sawUsage = true;
}
check('stream accumulates deltas across chunks', streamed.includes('mock llama reply'), JSON.stringify(streamed));
check('stream surfaces usage', sawUsage === true);
await new Promise((r) => setTimeout(r, 150));
check('no unhandled rejections during stream teardown', unhandled.length === 0, unhandled.map(String));

/* ── G. cancellation ─────────────────────────────────────────────── */

console.log('\nG. Cancellation');
mock.flags.slowStream = true;
const rtCancel = adapter.createRuntime('', 'qwen-3.5-27b-instruct');
const iter = rtCancel.stream({ messages: [{ role: 'user', content: 'hi' }] })[Symbol.asyncIterator]();
const first = await iter.next();
check('first chunk arrives before cancel', first.done !== true && typeof first.value?.delta === 'string');
rtCancel.cancel();
let cancelled = false;
try {
  for (;;) { const n = await iter.next(); if (n.done) break; }
} catch {
  cancelled = true;
}
check('cancel aborts the in-flight stream', cancelled === true);
mock.flags.slowStream = false;
let cancelBeforeOk = true;
try {
  const rtIdle = adapter.createRuntime('', 'qwen-3.5-27b-instruct');
  rtIdle.cancel();
  await rtIdle.generate({ messages: [{ role: 'user', content: 'hi' }] });
} catch { cancelBeforeOk = false; }
check('cancel with no flight is harmless; runtime reusable', cancelBeforeOk === true);
await new Promise((r) => setTimeout(r, 150));
check('no unhandled rejections from cancellation', unhandled.length === 0, unhandled.map(String));

/* ── H. telemetry ────────────────────────────────────────────────── */

console.log('\nH. Telemetry');
check('provider identity is local-llama', adapter.metadata.id === 'local-llama');
check('model identity round-trips from the server', gen.model === 'qwen-3.5-27b-instruct', gen.model);
check('health carries latency + timestamp', typeof healthy.latencyMs === 'number' && !Number.isNaN(Date.parse(healthy.lastChecked ?? '')), JSON.stringify({ latencyMs: healthy.latencyMs, lastChecked: healthy.lastChecked }));

/* ── I. routing ──────────────────────────────────────────────────── */

console.log('\nI. Routing (RuntimeManager)');
storeCredential('local-llama', '');
check('empty key is storable for the key-optional provider', getKey('local-llama') === '');
const rm = new RuntimeManager();
check('switch to local-llama activates with an empty stored key', (await rm.switchToProvider('local-llama', 'qwen-3.5-27b-instruct')) === true);
check('active provider id is local-llama', rm.getProviderId() === 'local-llama', rm.getProviderId());
check('active model is the requested one', rm.getModel() === 'qwen-3.5-27b-instruct', rm.getModel());
const routed = await rm.runtime!.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('routed runtime answers through the mock server', routed.content.includes('mock llama reply'), routed.content);
check('requested model validates against discovered catalogue', isModelValidForProvider('local-llama', 'qwen-3.5-27b-instruct') === true);
check('resolveModel keeps a known request', resolveModel('local-llama', 'qwen-3.5-7b-instruct', await adapter.discoverModels('')) === 'qwen-3.5-7b-instruct');
const rm2 = new RuntimeManager();
check('restart restores the keyless provider from the store', rm2.getProviderId() === 'local-llama' && rm2.getModel() === 'qwen-3.5-27b-instruct', `${rm2.getProviderId()}/${rm2.getModel()}`);
check('unknown provider still refuses to switch', (await rm.switchToProvider('no-such-provider')) === false);

/* ── J. governance ───────────────────────────────────────────────── */

console.log('\nJ. Governance (no execution authority in the provider)');
const adapterPath = new URL('../packages/ai-service/src/provider/adapters/local-llama.ts', import.meta.url);
const adapterSrc = fs.readFileSync(adapterPath, 'utf8');
const forbidden = ['CapabilityFabric', 'capability-fabric', 'child_process', 'execFile', 'node:fs', 'execa', 'spawn', 'invoke(', '.invoke(', 'approval', 'audit'];
const hits = forbidden.filter((p) => adapterSrc.includes(p));
check('adapter source has no execution/governance imports', hits.length === 0, hits.join(','));
const runtimeSurface = Object.getOwnPropertyNames(Object.getPrototypeOf(rt)).filter((k) => k !== 'constructor').sort();
// Note: TypeScript `private` helpers (buildBody/headers/post) are visible
// at runtime — the check is that the surface offers the Runtime contract
// and nothing execution-shaped.
check('runtime exposes the full Runtime contract', ['cancel', 'generate', 'health', 'listModels', 'stream'].every((k) => runtimeSurface.includes(k)), runtimeSurface.join(','));
check('runtime surface has no execute/invoke members', !runtimeSurface.some((k) => /execute|invoke/i.test(k)), runtimeSurface.join(','));
check('adapter exposes no execute/invoke members', (adapter as unknown as Record<string, unknown>).execute === undefined && (adapter as unknown as Record<string, unknown>).invoke === undefined);
check('adapter source contains no hardcoded private IPs', !/(192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\.)/.test(adapterSrc));
check('adapter source contains no key material', !/sk-|gsk_|Bearer [A-Za-z0-9]{8,}/.test(adapterSrc.replace(/`Bearer \$\{apiKey\}`/g, '')));

await mock.close();
await mock2.close();

/* ── L. live integration (opt-in) ────────────────────────────────── */

console.log('\nL. Live integration (opt-in via AURA_LOCAL_LLM_BASE_URL)');
if (!LIVE_BASE_URL) {
  console.log('  · SKIP — AURA_LOCAL_LLM_BASE_URL is not set; mock suite is authoritative.');
} else {
  if (LIVE_API_KEY !== undefined) process.env.AURA_LOCAL_LLM_API_KEY = LIVE_API_KEY; else delete process.env.AURA_LOCAL_LLM_API_KEY;
  process.env.AURA_LOCAL_LLM_BASE_URL = LIVE_BASE_URL;
  const liveKey = LIVE_API_KEY ?? '';
  const live = new LocalLlamaAdapter();
  const liveModels = await live.discoverModels(liveKey);
  check('live GET /v1/models returns a catalogue', liveModels.length > 0, liveModels.map((m) => m.id).slice(0, 5).join(','));
  const wanted = LIVE_MODEL ?? liveModels[0]?.id ?? live.metadata.defaultModel;
  check('configured live model is served', liveModels.some((m) => m.id === wanted), `wanted=${wanted}`);
  const liveHealth = await live.checkHealth(liveKey);
  check('live health is connected', liveHealth.ok === true && liveHealth.state === 'connected', JSON.stringify(liveHealth));
  const liveRt = live.createRuntime(liveKey, wanted);
  const liveGen = await liveRt.generate({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16 });
  check('live chat completion returns text', liveGen.content.trim().length > 0, liveGen.content.slice(0, 120));
  let liveStreamed = '';
  for await (const chunk of liveRt.stream({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16 })) {
    if (chunk.delta) liveStreamed += chunk.delta;
  }
  check('live streaming returns deltas', liveStreamed.trim().length > 0, liveStreamed.slice(0, 120));
  const leakProbe = `${liveGen.content} ${liveStreamed}`;
  check('live responses leak no credentials', !(LIVE_API_KEY && leakProbe.includes(LIVE_API_KEY)) && !/sk-[A-Za-z0-9]{8,}/.test(leakProbe));
}

/* ── result ──────────────────────────────────────────────────────── */

console.log('');
if (failures === 0 && unhandled.length === 0) {
  console.log('PASS — local-llama provider verified (mock llama-server; live section above if configured)');
  process.exit(0);
}
console.error(`FAIL — ${failures} check(s) failed${unhandled.length ? `, ${unhandled.length} unhandled rejection(s)` : ''}`);
process.exit(1);
