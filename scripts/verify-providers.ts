/**
 * Provider integration smoke test.
 * ==================================================================
 * Exercises the real provider stack — adapters, validation error
 * classification, model discovery, streaming runtime, RuntimeManager
 * switching and MISTRAL_API_KEY / CEREBRAS_API_KEY env auto-connect —
 * against a local mock OpenAI-compatible server. No real network call is
 * ever made.
 *
 * AURA_HOME is redirected to a temp directory and AURA_PROVIDER_SECRET is
 * fixed, so the user's real provider store is never touched. Env vars are
 * set BEFORE the ai-service modules load (the credential store captures
 * its file path at import time).
 *
 * Usage: node scripts/run-ts.mjs scripts/verify-providers.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-verify-'));
process.env.AURA_PROVIDER_SECRET = 'verify-seed';
process.env.MISTRAL_API_KEY = 'test-key-ok';

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { ProviderAdapter } from '../packages/ai-service/src/provider/types.ts';

const { MistralAdapter } = await import('../packages/ai-service/src/provider/adapters/mistral.ts');
const { CerebrasAdapter } = await import('../packages/ai-service/src/provider/adapters/cerebras.ts');
const { GroqAdapter } = await import('../packages/ai-service/src/provider/adapters/groq.ts');
const { NvidiaAdapter } = await import('../packages/ai-service/src/provider/adapters/nvidia.ts');
const { RuntimeManager, registerProvider, getConnectedProviders, storeCredential } = await import('../packages/ai-service/src/provider/index.ts');
const { getKey, getActive } = await import('../packages/ai-service/src/provider/credentialStore.ts');
const { WorkspaceManager } = await import('../packages/ai-service/src/workspace.ts');

let failures = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures += 1;
  console.error(`  ✗ ${name}${detail !== undefined ? ` — ${String(detail)}` : ''}`);
}

/* ── mock OpenAI-compatible server ─────────────────────────────────── */

const MOCK_MODELS = ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b', 'codestral-latest', 'llama-3.3-70b-versatile'];
const CEREBRAS_MODELS = ['llama3.3-70b', 'llama3.1-8b', 'llama4-maverick-17b-128e-instruct', 'llama4-scout-17b-16e-instruct'];

class MockServer {
  private server: Server;
  port = 0;
  constructor(private label: string, private models: string[] = MOCK_MODELS) { this.server = createServer((req, res) => this.handle(req, res)); }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  close(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (auth === 'bad-key') return this.json(res, 401, { error: { message: 'invalid api key' } });
      if (auth === 'ratelimit-key') return this.json(res, 429, { error: { message: 'rate limit' } });
      if (auth !== 'test-key-ok') return this.json(res, 403, { error: { message: 'forbidden' } });
      return this.json(res, 200, { data: this.models.map((id) => ({ id, object: 'model' })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (auth !== 'test-key-ok') return this.json(res, 401, { error: { message: 'invalid api key' } });
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: { stream?: boolean; model?: string } = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const model = body.model ?? 'mistral-large-latest';
        const text = `[${this.label}:${model}] hello from the mock runtime`;
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
    for (const w of text.split(' ')) {
      res.write(`data: ${JSON.stringify({ id: 'mock-1', model, choices: [{ index: 0, delta: { content: w + ' ' } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'mock-1', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

class MockMistral extends MistralAdapter { constructor(url: string) { super(); this.baseUrl = `${url}/v1`; } }
class MockGroq extends GroqAdapter { constructor(url: string) { super(); this.baseUrl = `${url}/v1`; } }
class MockNvidia extends NvidiaAdapter {
  constructor(url: string) { super(); this.baseUrl = `${url}/v1`; }
  override async discoverModels(apiKey: string) { return super.discoverModels(apiKey); }
}
class MockCerebras extends CerebrasAdapter { constructor(url: string) { super(); this.baseUrl = `${url}/v1`; } }

const mistralMock = new MockServer('mistral');
const groqMock = new MockServer('groq');
const nvidiaMock = new MockServer('nvidia');
const cerebrasMock = new MockServer('cerebras', CEREBRAS_MODELS);
await mistralMock.start();
await groqMock.start();
await nvidiaMock.start();
await cerebrasMock.start();

/* ── 1. validation states ──────────────────────────────────────────── */

const adapter: ProviderAdapter = new MockMistral(mistralMock.url);

console.log('\n1. Validation states (Mistral adapter against mock)');
check('Connected: ok:true for a valid key', (await adapter.validate('test-key-ok')).ok === true);
check('Invalid API key: 401 classified', (await adapter.validate('bad-key')).error?.includes('Invalid API key') === true);
check('Unauthorized: 403 classified', (await adapter.validate('forbidden-key')).error?.includes('Unauthorized') === true);
check('Rate limited: 429 classified', (await adapter.validate('ratelimit-key')).error?.includes('Rate limited') === true);

const dead = new MockMistral('http://127.0.0.1:1');
const netErr = await dead.validate('any');
check('Network error: unreachable host classified', netErr.error?.includes('Network error') === true, netErr.error);

/* ── 2. model discovery ────────────────────────────────────────────── */

console.log('\n2. Model discovery (dynamic, via GET /v1/models)');
const discovered = await adapter.discoverModels('test-key-ok');
check('discovers Mistral models', discovered.some((m) => m.id === 'mistral-large-latest'), discovered.map((m) => m.id));
check('discovery includes the full mock list', discovered.length === MOCK_MODELS.length, discovered.length);

/* ── 3. runtime: generate + stream ─────────────────────────────────── */

console.log('\n3. Runtime (createRuntime → generate / stream)');
const rt = adapter.createRuntime('test-key-ok', 'mistral-large-latest');
const gen = await rt.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('generate returns mock content', gen.content.includes('hello from the mock runtime'), gen.content);
check('generate reports usage', gen.usage.totalTokens > 0, gen.usage);

let streamed = '';
for await (const chunk of rt.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
  if (chunk.delta) streamed += chunk.delta;
}
check('stream accumulates deltas', streamed.includes('hello from the mock runtime'), JSON.stringify(streamed));
await new Promise((r) => setTimeout(r, 150));
check('no unhandled rejections during stream teardown', unhandled.length === 0, unhandled.map(String));

const health = await adapter.checkHealth('test-key-ok');
check('checkHealth ok with latency', health.ok === true && health.latencyMs >= 0, health);

/* ── 3b. Cerebras validation + discovery + runtime ─────────────────── */

console.log('\n3b. Cerebras (validation, discovery, runtime, streaming)');
const cerebrasAdapter: ProviderAdapter = new MockCerebras(cerebrasMock.url);
check('cerebras metadata name is Cerebras', cerebrasAdapter.metadata.name === 'Cerebras', cerebrasAdapter.metadata);
check('cerebras detect() matches csk_ prefix', cerebrasAdapter.detect('csk_abcdef') === true && cerebrasAdapter.detect('test-key-ok') === false);
check('cerebras Connected for a valid key', (await cerebrasAdapter.validate('test-key-ok')).ok === true);
check('cerebras Invalid API key: 401 classified', (await cerebrasAdapter.validate('bad-key')).error?.includes('Invalid API key') === true);
check('cerebras Rate limited: 429 classified', (await cerebrasAdapter.validate('ratelimit-key')).error?.includes('Rate limited') === true);
check('cerebras Unauthorized: 403 classified', (await cerebrasAdapter.validate('forbidden-key')).error?.includes('Unauthorized') === true);
const cerebrasModels = await cerebrasAdapter.discoverModels('test-key-ok');
check('cerebras discovers its own model list', cerebrasModels.some((m) => m.id === 'llama3.3-70b') && cerebrasModels.length === CEREBRAS_MODELS.length, cerebrasModels.map((m) => m.id));

const cRt = cerebrasAdapter.createRuntime('test-key-ok', 'llama3.3-70b');
const cGen = await cRt.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('cerebras generate returns mock content', cGen.content.includes('[cerebras:llama3.3-70b]'), cGen.content);
let cStreamed = '';
for await (const chunk of cRt.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
  if (chunk.delta) cStreamed += chunk.delta;
}
check('cerebras stream accumulates deltas', cStreamed.includes('hello from the mock runtime'), JSON.stringify(cStreamed));
await new Promise((r) => setTimeout(r, 150));
check('no unhandled rejections during cerebras stream teardown', unhandled.length === 0, unhandled.map(String));
const cHealth = await cerebrasAdapter.checkHealth('test-key-ok');
check('cerebras checkHealth ok with latency', cHealth.ok === true && cHealth.latencyMs >= 0, cHealth);

/* ── 4. MISTRAL_API_KEY env auto-connect (real connect path) ───────── */

console.log('\n4. Env auto-connect (MISTRAL_API_KEY → mistral, CEREBRAS_API_KEY → cerebras)');
registerProvider(new MockMistral(mistralMock.url));
registerProvider(new MockGroq(groqMock.url));
registerProvider(new MockNvidia(nvidiaMock.url));
registerProvider(new MockCerebras(cerebrasMock.url));

const manager = new WorkspaceManager();
const envResults = await manager.connectEnvProviders();
check('only mistral is env-mapped and connected', envResults.length === 1 && envResults[0].providerId === 'mistral' && envResults[0].ok === true, JSON.stringify(envResults));
check('stored key equals MISTRAL_API_KEY', getKey('mistral') === 'test-key-ok', getKey('mistral'));
check('mistral is the active runtime', manager.pipeline.providerStatus.type === 'byoak' && manager.pipeline.providerStatus.providerId === 'mistral', JSON.stringify(manager.pipeline.providerStatus));
check('active model persisted', getActive().providerId === 'mistral', JSON.stringify(getActive()));

const savedMistral = process.env.MISTRAL_API_KEY;
delete process.env.MISTRAL_API_KEY;
process.env.CEREBRAS_API_KEY = 'test-key-ok';
const cerebrasEnvResults = await manager.connectEnvProviders();
check('CEREBRAS_API_KEY connects cerebras (already-connected providers skipped)', cerebrasEnvResults.length === 1 && cerebrasEnvResults[0].providerId === 'cerebras' && cerebrasEnvResults[0].ok === true, JSON.stringify(cerebrasEnvResults));
check('stored key equals CEREBRAS_API_KEY', getKey('cerebras') === 'test-key-ok', getKey('cerebras'));
check('cerebras becomes the active runtime', manager.pipeline.providerStatus.type === 'byoak' && manager.pipeline.providerStatus.providerId === 'cerebras', JSON.stringify(manager.pipeline.providerStatus));

delete process.env.CEREBRAS_API_KEY;
const emptyResults = await manager.connectEnvProviders();
process.env.MISTRAL_API_KEY = savedMistral;
check('no env → no auto-connect', emptyResults.length === 0, JSON.stringify(emptyResults));

/* ── 5. runtime switching through the real RuntimeManager ───────────── */

console.log('\n5. Runtime switching (Groq ↔ NVIDIA ↔ Mistral ↔ Cerebras via RuntimeManager)');
storeCredential('groq', 'test-key-ok');
storeCredential('nvidia', 'test-key-ok');
storeCredential('cerebras', 'test-key-ok');

const rm = new RuntimeManager();
check('restores active provider from store', rm.getProviderId() === 'cerebras', rm.getProviderId());
check('switch to cerebras activates runtime', rm.switchToProvider('cerebras', 'llama3.3-70b') === true);
const cerebrasReply = await rm.runtime!.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('cerebras runtime is active', cerebrasReply.content.includes('[cerebras:'), cerebrasReply.content);

check('switch to mistral activates runtime', rm.switchToProvider('mistral', 'mistral-large-latest') === true);
const mistralReply = await rm.runtime!.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('mistral runtime is active', mistralReply.content.includes('[mistral:'), mistralReply.content);

check('switch to groq activates runtime', rm.switchToProvider('groq', 'llama-3.3-70b-versatile') === true);
check('active provider id is groq', rm.getProviderId() === 'groq', rm.getProviderId());
const groqReply = await rm.runtime!.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('groq runtime is active', groqReply.content.includes('[groq:'), groqReply.content);

check('switch to nvidia activates runtime', rm.switchToProvider('nvidia', 'meta/llama-3.1-8b-instruct') === true);
check('active provider id is nvidia', rm.getProviderId() === 'nvidia', rm.getProviderId());
const nvidiaReply = await rm.runtime!.generate({ messages: [{ role: 'user', content: 'hi' }] });
check('nvidia runtime is active', nvidiaReply.content.includes('[nvidia:'), nvidiaReply.content);

rm.switchToProvider('cerebras', 'llama3.3-70b');
check('switch back to cerebras', rm.getProviderId() === 'cerebras', rm.getProviderId());

/* ── 6. connected provider state ────────────────────────────────────── */

console.log('\n6. Connected provider state');
const connected = getConnectedProviders();
check('only the test providers are in the store', connected.map((c) => c.id).sort().join(',') === 'cerebras,groq,mistral,nvidia', JSON.stringify(connected.map((c) => c.id)));
const cerebrasEntry = connected.find((c) => c.id === 'cerebras');
check('cerebras has discovered models + health', Boolean(cerebrasEntry && cerebrasEntry.models.length > 0 && cerebrasEntry.health?.ok), JSON.stringify(cerebrasEntry));
const mistralEntry = connected.find((c) => c.id === 'mistral');
check('mistral has discovered models + health', Boolean(mistralEntry && mistralEntry.models.length > 0 && mistralEntry.health?.ok), JSON.stringify(mistralEntry));

await mistralMock.close();
await groqMock.close();
await nvidiaMock.close();
await cerebrasMock.close();

/* ── result ────────────────────────────────────────────────────────── */

console.log('');
if (failures === 0 && unhandled.length === 0) {
  console.log(`PASS — provider stack verified against mock (mistral@${mistralMock.url}, groq@${groqMock.url}, nvidia@${nvidiaMock.url}, cerebras@${cerebrasMock.url})`);
  process.exit(0);
}
console.error(`FAIL — ${failures} check(s) failed${unhandled.length ? `, ${unhandled.length} unhandled rejection(s)` : ''}`);
process.exit(1);
