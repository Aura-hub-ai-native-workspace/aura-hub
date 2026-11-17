import { afterEach, describe, expect, it, vi } from 'vitest';

import { DemonRouteAdapter } from './demonroute';
import { getAdapter, ENV_VAR_BY_PROVIDER } from '../registry';
import { resolveModel } from '../modelValidation';
import { ProviderHttpError } from '../errorTranslator';

/**
 * Demon Route adapter — the wire contract, tested offline.
 *
 * No real key and no network: `fetch` is stubbed and every assertion
 * pins what the adapter would put on the wire (URL, Bearer auth, body)
 * or how it reads what comes back. The adapter is a deliberate clone of
 * the Novita shape — `BaseOpenAICompatible` with a constant base URL —
 * so these tests exist to keep that sameness true: if Demon Route ever
 * grows provider-specific behavior, it should fail here first and need
 * a reason, not drift in silently.
 *
 * Run with `npm run test:service` from the repo root.
 */
const adapter = new DemonRouteAdapter();
const KEY = 'test-key-not-a-real-secret';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stubFetch(handler: (call: RecordedCall) => Promise<Response> | Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('DemonRouteAdapter identity', () => {
  it('declares the spec identity: id, docs and the verified default model', () => {
    expect(adapter.metadata.id).toBe('demonroute');
    expect(adapter.metadata.name).toBe('Demon Route');
    expect(adapter.metadata.docsUrl).toBe('https://demonroute.com/docs');
    expect(adapter.metadata.defaultModel).toBe('glm-5.3-flash');
  });

  it('is registered as a cloud fallback, never self-hosted primary', () => {
    const registered = getAdapter('demonroute');
    expect(registered).toBeInstanceOf(DemonRouteAdapter);
    expect((registered!.metadata as { selfHosted?: boolean }).selfHosted ?? false).toBe(false);
    expect(ENV_VAR_BY_PROVIDER['demonroute']).toBe('DEMONROUTE_API_KEY');
  });

  it('never claims to detect a key — there is no documented prefix', () => {
    expect(adapter.detect('sk-anything-at-all')).toBe(false);
    expect(adapter.detect('')).toBe(false);
    expect(adapter.detect(KEY)).toBe(false);
  });
});

describe('validate + model discovery (GET /v1/models)', () => {
  it('validates against the models endpoint with Bearer auth', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(adapter.validate(KEY)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.demonroute.com/v1/models');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('classifies a 401 as an invalid key, not a network failure', async () => {
    stubFetch(() => new Response('nope', { status: 401 }));
    await expect(adapter.validate(KEY)).resolves.toEqual({ ok: false, error: 'Invalid API key (401)' });
  });

  it('reports an unreachable service as a network error naming the provider', async () => {
    stubFetch(() => { throw new Error('fetch failed'); });
    const r = await adapter.validate(KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Network error');
    expect(r.error).toContain('Demon Route');
  });

  it('discovers models through /v1/models and marks them streaming', async () => {
    stubFetch(() => new Response(JSON.stringify({
      data: [{ id: 'glm-5.3-flash' }, { id: 'glm-5.3-uncensored' }],
    }), { status: 200 }));
    const models = await adapter.discoverModels(KEY);
    expect(models.map((m) => m.id)).toEqual(['glm-5.3-flash', 'glm-5.3-uncensored']);
    expect(models.every((m) => m.capabilities.streaming === true)).toBe(true);
  });

  it('discovers nothing when the endpoint refuses', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(adapter.discoverModels(KEY)).resolves.toEqual([]);
  });
});

describe('model validation against the registry', () => {
  const known = [
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', capabilities: {} },
    { id: 'glm-5.3-uncensored', name: 'glm-5.3-uncensored', capabilities: {} },
  ];

  it('resolves the declared default when it is among the discovered models', () => {
    expect(resolveModel('demonroute', undefined, known)).toBe('glm-5.3-flash');
    expect(resolveModel('demonroute', 'glm-5.3-uncensored', known)).toBe('glm-5.3-uncensored');
  });

  it('falls back to the declared default before discovery has run', () => {
    expect(resolveModel('demonroute', undefined, [])).toBe('glm-5.3-flash');
  });
});

describe('runtime: chat completions over the shared OpenAI-compatible path', () => {
  it('posts a non-streaming completion with the default model and parses usage', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({
      model: 'glm-5.3-flash',
      choices: [{ finish_reason: 'stop', message: { content: 'Hi there' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }), { status: 200 }));
    const runtime = adapter.createRuntime(KEY);
    const out = await runtime.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out.content).toBe('Hi there');
    expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.demonroute.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0].body!);
    expect(body.model).toBe('glm-5.3-flash');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('streams SSE deltas with stream: true and finishes on [DONE]', async () => {
    const calls = stubFetch(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const runtime = adapter.createRuntime(KEY);
    const chunks: { delta: string; done: boolean }[] = [];
    for await (const chunk of runtime.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push({ delta: chunk.delta, done: chunk.done });
    }
    expect(chunks).toEqual([
      { delta: 'Hello', done: false },
      { delta: ' world', done: false },
      { delta: '', done: true },
    ]);
    const body = JSON.parse(calls[0].body!);
    expect(body.stream).toBe(true);
  });

  it('surfaces an HTTP refusal as a structured provider error', async () => {
    stubFetch(() => new Response('bad key', { status: 401 }));
    const runtime = adapter.createRuntime(KEY);
    await expect(runtime.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(ProviderHttpError);
    await expect(runtime.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 401, providerName: 'Demon Route' });
  });
});
