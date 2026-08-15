/**
 * kage7-provider-verify — proves Kage7 is a normal AURA provider.
 * ==================================================================
 * Two things are checked, and they are deliberately not conflated.
 *
 * **The protocol logic** — URL normalisation and `/v1/models` parsing —
 * is pure, so it is driven directly with every payload shape a Kage7
 * gateway is known to answer with. No network, no ambiguity.
 *
 * **The transport** is exercised against a controlled mock gateway started
 * by this script: real HTTP, real Bearer auth, real `/v1/chat/completions`,
 * real streaming and cancellation. That proves AURA's side of the wire.
 *
 * What it does NOT prove is that the actual Kage7 deployment answers, and
 * this script never claims otherwise. With `KAGE7_API_KEY` set it also
 * probes the real gateway and says so; without it, the real-runtime result
 * is reported as NOT VERIFIED rather than quietly inferred from the mock.
 *
 * Usage:  node scripts/kage7-provider-verify.mjs
 *         KAGE7_API_KEY=… node scripts/kage7-provider-verify.mjs
 */
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(os.tmpdir(), `aura-kage7-verify-${process.pid}.mjs`);
const AI = process.env.HUB_API ?? 'http://localhost:4319';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const section = (t) => console.log(`\n=== ${t} ===`);
const info = (m) => console.log(`      ${m}`);

/* A stand-in gateway. Records what it was sent so the test can prove the
 * request really arrived, with the right auth, at the configured URL. */
function mockGateway({ models, status = 200, requireAuth = true }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (requireAuth && req.headers.authorization !== 'Bearer test-key-abc123') return send(401, { error: 'bad key' });
      if (status !== 200) return send(status, { error: 'upstream failure' });
      if (req.url === '/v1/models') return send(200, models);
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body || '{}');
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"str"}}]}\n');
          res.write('data: {"choices":[{"delta":{"content":"eamed"}}]}\n');
          res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n');
          res.write('data: [DONE]\n');
          return res.end();
        }
        return send(200, {
          model: parsed.model,
          choices: [{ finish_reason: 'stop', message: { content: `echo:${parsed.messages?.at(-1)?.content ?? ''}` } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        });
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

let gw = null;
try {
  await build({
    entryPoints: [path.join(ROOT, 'packages/ai-service/src/provider/adapters/kage7.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: OUT, logLevel: 'silent',
  });
  const K = await import(pathToFileURL(OUT).href);

  /* ── 1. URL configuration ────────────────────────────────────────── */
  section('1. GATEWAY URL IS CONFIGURATION, NOT A CONSTANT');

  for (const [input, expected] of [
    ['https://host.example', 'https://host.example'],
    ['https://host.example/', 'https://host.example'],
    ['https://host.example/v1', 'https://host.example'],
    ['https://host.example/v1/', 'https://host.example'],
    ['  https://host.example//  ', 'https://host.example'],
  ]) {
    check(`1. ${JSON.stringify(input)} → ${expected}`, K.normalizeGatewayUrl(input) === expected, K.normalizeGatewayUrl(input));
  }

  const prev = process.env.KAGE7_BASE_URL;
  process.env.KAGE7_BASE_URL = 'https://my-own-gateway.example/v1';
  check('1e. KAGE7_BASE_URL overrides the default gateway',
    K.kage7Gateway() === 'https://my-own-gateway.example', K.kage7Gateway());
  delete process.env.KAGE7_BASE_URL;
  check('1f. an unset variable falls back to a default rather than crashing',
    /^https?:\/\//.test(K.kage7Gateway()), K.kage7Gateway());
  if (prev !== undefined) process.env.KAGE7_BASE_URL = prev;

  /* ── 2. model parsing, every shape ───────────────────────────────── */
  section('2. /v1/models PARSING — EVERY SHAPE THE PROTOCOL ALLOWS');

  check('2a. OpenAI shape { data: [...] }',
    K.parseModels({ data: [{ id: 'alpha' }, { id: 'beta' }] }).map((m) => m.id).join(',') === 'alpha,beta');
  check('2b. { models: [...] } shape',
    K.parseModels({ models: [{ id: 'gamma' }] })[0]?.id === 'gamma');
  check('2c. a bare array',
    K.parseModels([{ id: 'delta' }])[0]?.id === 'delta');
  check('2d. plain-string entries',
    K.parseModels(['epsilon'])[0]?.id === 'epsilon');
  check('2e. `model` key instead of `id`',
    K.parseModels({ data: [{ model: 'zeta' }] })[0]?.id === 'zeta');

  const limits = K.parseModels({ data: [{ id: 'm1', context_length: 128000, max_output: 4096 }] })[0];
  check('2f. context_length / max_output are carried through',
    limits.capabilities.contextWindow === 128000 && limits.capabilities.maxOutput === 4096,
    `context=${limits.capabilities.contextWindow} output=${limits.capabilities.maxOutput}`);

  const alt = K.parseModels({ data: [{ id: 'm2', max_context: 64000, max_output_tokens: 2048 }] })[0];
  check('2g. the max_context / max_output_tokens spelling also works',
    alt.capabilities.contextWindow === 64000 && alt.capabilities.maxOutput === 2048,
    `context=${alt.capabilities.contextWindow} output=${alt.capabilities.maxOutput}`);

  const bare = K.parseModels({ data: [{ id: 'm3' }] })[0];
  check('2h. a gateway that advertises no limits still yields usable defaults',
    bare.capabilities.contextWindow > 0 && bare.capabilities.maxOutput > 0,
    `context=${bare.capabilities.contextWindow} output=${bare.capabilities.maxOutput}`);

  check('2i. a display name is derived from the id',
    K.parseModels(['glm-5.2'])[0]?.name === 'Glm 5.2', K.parseModels(['glm-5.2'])[0]?.name);
  check('2j. duplicates and nameless entries are dropped, not offered',
    K.parseModels({ data: [{ id: 'x' }, { id: 'x' }, { id: '' }, {}] }).length === 1);
  check('2k. an empty or malformed body yields no models rather than throwing',
    K.parseModels({}).length === 0 && K.parseModels(null).length === 0 && K.parseModels({ data: 'nope' }).length === 0);

  /* ── 3. no hardcoded model ───────────────────────────────────────── */
  section('3. NO MODEL IS HARDCODED');

  const src = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/provider/adapters/kage7.ts'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('3a. "glm" appears nowhere in the adapter\'s code',
    !/glm/i.test(codeOnly), 'no model id baked in');
  const adapter = new K.Kage7Adapter();
  check('3b. the adapter declares no default model, so discovery decides',
    adapter.metadata.defaultModel === '', `defaultModel=${JSON.stringify(adapter.metadata.defaultModel)}`);
  check('3c. identity matches the protocol spec',
    adapter.metadata.id === 'kage7' && adapter.metadata.name === 'Kage7',
    `${adapter.metadata.id} / ${adapter.metadata.name}`);

  /* ── 4. discovery + health against a controlled gateway ──────────── */
  section('4. TRANSPORT AGAINST A CONTROLLED MOCK GATEWAY');

  gw = await mockGateway({ models: { data: [{ id: 'model-one', context_length: 32000 }, { id: 'model-two' }] } });
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${gw.port}`;
  info(`mock gateway on 127.0.0.1:${gw.port}`);

  const discovered = await adapter.discoverModels('test-key-abc123');
  check('4a. discovery reaches the CONFIGURED endpoint',
    gw.seen.some((r) => r.url === '/v1/models'), gw.seen.map((r) => r.url).join(' '));
  check('4b. it sends Bearer authorization',
    gw.seen.at(-1)?.auth === 'Bearer test-key-abc123');
  check('4c. models come back dynamically from the gateway',
    discovered.map((m) => m.id).join(',') === 'model-one,model-two', discovered.map((m) => m.id).join(','));

  const health = await adapter.checkHealth('test-key-abc123');
  check('4d. health is CONNECTED only after an authenticated list',
    health.ok === true && health.state === 'connected', `state=${health.state}`);

  const unauth = await adapter.checkHealth('wrong-key');
  check('4e. a bad key is UNAUTHORIZED, not "unreachable"',
    unauth.ok === false && unauth.state === 'unauthorized', `state=${unauth.state} · ${unauth.error}`);

  /* dynamic re-discovery: the gateway changes, AURA follows */
  gw.server.close();
  gw = await mockGateway({ models: { models: ['freshly-added-model'] }, });
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${gw.port}`;
  const rediscovered = await adapter.discoverModels('test-key-abc123');
  check('4f. a changed gateway catalogue is picked up without a code change',
    rediscovered.length === 1 && rediscovered[0].id === 'freshly-added-model',
    rediscovered.map((m) => m.id).join(','));

  /* empty catalogue */
  gw.server.close();
  gw = await mockGateway({ models: { data: [] } });
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${gw.port}`;
  const empty = await adapter.checkHealth('test-key-abc123');
  check('4g. an authenticated-but-empty catalogue is NO_MODELS, never connected',
    empty.ok === false && empty.state === 'no-models', `state=${empty.state}`);

  /* upstream error */
  gw.server.close();
  gw = await mockGateway({ models: {}, status: 500 });
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${gw.port}`;
  const err = await adapter.checkHealth('test-key-abc123');
  check('4h. an upstream failure is ERROR', err.ok === false && err.state === 'error', `state=${err.state} · ${err.error}`);

  /* unreachable */
  gw.server.close();
  const deadPort = gw.port;
  gw = null;
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${deadPort}`;
  const down = await adapter.checkHealth('test-key-abc123');
  check('4i. a gateway that is not listening is UNREACHABLE',
    down.ok === false && down.state === 'unreachable', `state=${down.state}`);
  check('4j. discovery on an unreachable gateway returns nothing rather than throwing',
    (await adapter.discoverModels('test-key-abc123')).length === 0);

  /* ── 5. real inference through the shared transport ──────────────── */
  section('5. INFERENCE THROUGH THE EXISTING OPENAI-COMPATIBLE TRANSPORT');

  gw = await mockGateway({ models: { data: [{ id: 'model-one' }] } });
  process.env.KAGE7_BASE_URL = `http://127.0.0.1:${gw.port}`;
  const runtime = adapter.createRuntime('test-key-abc123', 'model-one');

  const answer = await runtime.generate({ messages: [{ role: 'user', content: 'ping' }] });
  const chat = gw.seen.find((r) => r.url === '/v1/chat/completions');
  check('5a. the request lands on {baseURL}/v1/chat/completions', !!chat, chat?.url);
  check('5b. it carries the Bearer key', chat?.auth === 'Bearer test-key-abc123');
  check('5c. the selected model is the one sent', JSON.parse(chat?.body ?? '{}').model === 'model-one');
  check('5d. a real response comes back', answer.content === 'echo:ping', answer.content);
  check('5e. usage is reported', answer.usage.totalTokens === 18,
    `prompt=${answer.usage.promptTokens} completion=${answer.usage.completionTokens} total=${answer.usage.totalTokens}`);

  let streamed = '';
  for await (const chunk of runtime.stream({ messages: [{ role: 'user', content: 'go' }] })) streamed += chunk.delta;
  check('5f. streaming works through the same transport', streamed === 'streamed', JSON.stringify(streamed));

  const slow = adapter.createRuntime('test-key-abc123', 'model-one');
  const pending = slow.generate({ messages: [{ role: 'user', content: 'cancel me' }] }).catch((e) => e);
  slow.cancel();
  const cancelled = await pending;
  check('5g. cancellation is honoured', cancelled instanceof Error, cancelled?.name ?? typeof cancelled);

  /* ── 6. the key never leaks ──────────────────────────────────────── */
  section('6. THE API KEY NEVER LEAKS');

  const KEY = 'test-key-abc123';
  const surfaces = {
    'health (connected)': JSON.stringify(await adapter.checkHealth(KEY)),
    'health (unauthorized)': JSON.stringify(unauth),
    'health (unreachable)': JSON.stringify(down),
    'discovered models': JSON.stringify(await adapter.discoverModels(KEY)),
    'generate response': JSON.stringify(answer),
  };
  for (const [label, blob] of Object.entries(surfaces)) {
    check(`6. the key is absent from ${label}`, !blob.includes(KEY));
  }
  check('6f. no API key is committed in the adapter source',
    !/kage7-sk-|sk-[A-Za-z0-9]{16,}/.test(src), 'no literal key');
  check('6g. the gateway URL is overridable, so no deployment is baked into core',
    /KAGE7_BASE_URL/.test(src));

  /* ── 7. registration in the running AURA service ─────────────────── */
  section('7. REGISTERED IN THE EXISTING PROVIDER SYSTEM');

  try {
    const res = await fetch(`${AI}/providers`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    const list = body.providers ?? [];
    const k = list.find((p) => p.id === 'kage7');
    check('7a. the live service lists Kage7 among its providers',
      !!k, k ? `${k.id} → "${k.name}"` : `${list.length} provider(s), no kage7`);
    check('7b. it is listed alongside the existing providers, not in a separate system',
      list.length > 1 && list.some((p) => p.id === 'nvidia'), `${list.length} providers total`);
  } catch (e) {
    info(`AURA service not reachable at ${AI} — registration checked statically instead (${e.message})`);
    const reg = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/provider/registry.ts'), 'utf8');
    check('7a. Kage7 is registered in the single provider registry', /new Kage7Adapter\(\)/.test(reg));
  }

  /* ── 8. no duplicate architecture ────────────────────────────────── */
  section('8. NO PARALLEL ARCHITECTURE');

  check('8a. the adapter extends the shared OpenAI-compatible base',
    /extends BaseOpenAICompatible/.test(src), 'no Kage7-only transport');
  // Against code only: the file's header documents which endpoint the base
  // class owns, and matching that prose would fail the check for saying so.
  check('8b. it implements no chat/completions call of its own',
    !/chat\/completions/.test(codeOnly), 'inference is the base class\'s');
  check('8c. there is exactly one provider registry',
    fs.readdirSync(path.join(ROOT, 'packages/ai-service/src/provider')).filter((f) => /registry/i.test(f)).length === 1);
  check('8d. it defines no credential storage of its own',
    !/credentialStore|auth\.json|writeFile/.test(src), 'keys stay in the existing encrypted store');
  // Checked on what it IMPORTS, not on words it contains: the adapter
  // legitimately uses the provider system's own `ModelCapabilities` type,
  // and a bare substring search for "capability" would flag that as Fabric
  // coupling. What actually matters is which modules it depends on.
  const imports = [...codeOnly.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  const forbidden = imports.filter((i) => /capability-fabric|\/fabric|mission|workspace/i.test(i));
  check('8e. it imports nothing from the Fabric, Workspace or Mission systems',
    forbidden.length === 0, forbidden.length ? forbidden.join(', ') : `imports: ${imports.join(', ')}`);

  /* ── 9. the real deployment ──────────────────────────────────────── */
  section('9. REAL KAGE7 DEPLOYMENT');

  const realKey = process.env.KAGE7_API_KEY?.trim();
  if (!realKey) {
    delete process.env.KAGE7_BASE_URL;
    info(`REAL KAGE7 RUNTIME: NOT VERIFIED — credentials unavailable (set KAGE7_API_KEY to verify).`);
    info(`Everything above used the controlled mock gateway and is NOT a Kage7 runtime result.`);
  } else {
    delete process.env.KAGE7_BASE_URL;
    info(`probing the real gateway at ${K.kage7Gateway()}`);
    const realAdapter = new K.Kage7Adapter();
    const h = await realAdapter.checkHealth(realKey);
    check('9a. the real Kage7 gateway authenticates and lists models',
      h.ok === true && h.state === 'connected', `state=${h.state} ${h.error ?? ''} (${h.latencyMs}ms)`);
    const real = await realAdapter.discoverModels(realKey);
    check('9b. real models are discovered', real.length > 0, real.map((m) => m.id).join(', '));
    if (real.length) {
      const rt = realAdapter.createRuntime(realKey, real[0].id);
      const reply = await rt.generate({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
      check('9c. a real prompt returns a real response',
        typeof reply.content === 'string' && reply.content.length > 0, `${real[0].id} → ${reply.content.slice(0, 60)}`);
      check('9d. the real response reports usage', reply.usage.totalTokens >= 0, JSON.stringify(reply.usage));
    }
  }
} catch (e) {
  console.log(`ERROR ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
  failed = true;
} finally {
  gw?.server.close();
  fs.rmSync(OUT, { force: true });
  console.log(`\n${process.env.KAGE7_API_KEY ? 'REAL KAGE7 RUNTIME: exercised above.' : 'REAL KAGE7 RUNTIME: NOT VERIFIED — credentials unavailable.'}`);
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
