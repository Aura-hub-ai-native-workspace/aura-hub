/**
 * The shared OpenAI-compatible SSE parser (`base.ts` → OpenAICompatibleRuntime.stream).
 *
 * Regression pinned here: with `stream_options.include_usage` (always
 * requested) a compliant server ends a stream as
 *
 *   …content… → {finish_reason:"stop"} → {choices:[], usage:{…}} → [DONE]
 *
 * and the parser returned at `finish_reason`, discarding the usage chunk —
 * every consumer (pipeline.collectStream, streamEvents) stops at the first
 * `done` chunk, so streamed answers reported zero tokens.
 *
 * Offline: `fetch` is stubbed with hand-built SSE bodies. Every test drives
 * the production runtime returned by a real registered adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime, StreamChunk } from '@aura/runtime';

import { BaseOpenAICompatible, STREAM_TRAILER_GRACE_MS } from './base';
import { getAdapter } from '../registry';
import { ProviderHttpError } from '../errorTranslator';

const KEY = 'test-key-not-a-real-secret';
const REQ = { messages: [{ role: 'user' as const, content: 'hi' }] };
const USAGE = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
const USAGE_EVENT = 'data: {"id":"x","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n';
const delta = (text: string) => `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}],"usage":null}\n\n`;
const FINISH = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n';
const DONE = 'data: [DONE]\n\n';

interface Body {
  /** Each entry is delivered as one separate read. */
  parts: string[];
  /** After the parts: close the body (default), keep it open, or error it. */
  end?: 'close' | 'hold' | Error;
}

/** Stub `fetch` with an SSE body that honours the request's abort signal like a real body does. */
function stubSse(body: Body): { bodies: string[] } {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    const enc = new TextEncoder();
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          try { controller.error(signal.reason ?? new DOMException('aborted', 'AbortError')); } catch { /* already closed */ }
        });
        for (const p of body.parts) controller.enqueue(enc.encode(p));
        const end = body.end ?? 'close';
        if (end === 'close') controller.close();
        // Error AFTER the queued parts are read, like a socket dying
        // mid-response (erroring synchronously would discard the queue).
        else if (end instanceof Error) setTimeout(() => { try { controller.error(end); } catch { /* closed */ } }, 20);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return { bodies };
}

async function drain(runtime: Runtime): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of runtime.stream(REQ)) out.push(c);
  return out;
}

/** What pipeline.collectStream does: stop at the first `done`, keep its usage/finishReason. */
async function collectLikePipeline(runtime: Runtime) {
  let content = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finishReason = 'stop';
  for await (const chunk of runtime.stream(REQ)) {
    if (chunk.delta) content += chunk.delta;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.done) break;
  }
  return { content, usage, finishReason };
}

const openai = () => getAdapter('openai')!.createRuntime(KEY);

/** A runtime with a short silence budget, so the trailer grace is testable in real time. */
class ShortTimeoutAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'short-timeout-test', name: 'Short Timeout', description: 'test only', defaultModel: 'm' };
  protected baseUrl = 'https://short-timeout.invalid/v1';
  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'm', timeoutMs: 300 });
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('trailing usage after finish_reason (the regression)', () => {
  it('content → finish_reason → usage-only → [DONE] yields the usage on the single final chunk', async () => {
    stubSse({ parts: [delta('Hello'), delta(' world'), FINISH, USAGE_EVENT, DONE] });
    expect(await drain(openai())).toEqual([
      { delta: 'Hello', done: false },
      { delta: ' world', done: false },
      { delta: '', done: true, finishReason: 'stop', usage: USAGE },
    ]);
  });

  it('correct final usage reporting through the pipeline consumer pattern', async () => {
    stubSse({ parts: [delta('Hello'), FINISH, USAGE_EVENT, DONE] });
    expect(await collectLikePipeline(openai())).toEqual({ content: 'Hello', usage: USAGE, finishReason: 'stop' });
  });

  it('a non-stop finish reason survives alongside usage', async () => {
    stubSse({ parts: [delta('cut'), FINISH.replace('"stop"', '"length"'), USAGE_EVENT, DONE] });
    const chunks = await drain(openai());
    expect(chunks.at(-1)).toEqual({ delta: '', done: true, finishReason: 'length', usage: USAGE });
  });

  it('usage carried on the finish chunk itself is reported too', async () => {
    stubSse({ parts: [delta('Hi'), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n', DONE] });
    expect((await drain(openai())).at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
  });

  it('a usage-only chunk with no finish_reason still terminates with usage (legacy shape)', async () => {
    stubSse({ parts: [delta('Hello'), USAGE_EVENT, DONE] });
    expect(await drain(openai())).toEqual([
      { delta: 'Hello', done: false },
      { delta: '', done: true, usage: USAGE },
    ]);
  });

  it('the same sequence yields usage for every shared-runtime adapter', async () => {
    for (const id of ['openai', 'groq', 'mistral', 'novita', 'cerebras', 'openrouter', 'nvidia', 'qwen', 'kimi']) {
      stubSse({ parts: [delta('ok'), FINISH, USAGE_EVENT, DONE] });
      const r = await collectLikePipeline(getAdapter(id)!.createRuntime(KEY));
      expect(r, id).toEqual({ content: 'ok', usage: USAGE, finishReason: 'stop' });
      vi.unstubAllGlobals();
    }
  });

  it('still asks for usage on the wire', async () => {
    const { bodies } = stubSse({ parts: [DONE] });
    await drain(openai());
    expect(JSON.parse(bodies[0])).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
});

describe('completion semantics: exactly one done chunk', () => {
  it('[DONE] termination without usage: finish reason on the final chunk', async () => {
    stubSse({ parts: [delta('a'), FINISH, DONE] });
    expect(await drain(openai())).toEqual([
      { delta: 'a', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ]);
  });

  it('[DONE] alone yields a bare done chunk (no invented finish reason or usage)', async () => {
    stubSse({ parts: [delta('a'), DONE] });
    expect(await drain(openai())).toEqual([{ delta: 'a', done: false }, { delta: '', done: true }]);
  });

  it('no trailer delay for a compliant server: [DONE] ends it at once even if the socket stays open', async () => {
    stubSse({ parts: [delta('a'), FINISH, USAGE_EVENT, DONE], end: 'hold' });
    const t0 = Date.now();
    expect((await drain(openai())).at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
    expect(Date.now() - t0).toBeLessThan(STREAM_TRAILER_GRACE_MS / 4);
  });

  it('no trailer delay when the body closes right after finishing', async () => {
    stubSse({ parts: [delta('a'), FINISH] });
    const t0 = Date.now();
    await drain(openai());
    expect(Date.now() - t0).toBeLessThan(STREAM_TRAILER_GRACE_MS / 4);
  });

  it('nothing after [DONE] is read or yielded', async () => {
    stubSse({ parts: [delta('a'), FINISH, DONE, delta('ghost'), DONE] });
    const chunks = await drain(openai());
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
    expect(chunks.map((c) => c.delta).join('')).toBe('a');
  });

  it('a repeated finish_reason does not produce a second done', async () => {
    stubSse({ parts: [delta('a'), FINISH, FINISH, USAGE_EVENT, DONE] });
    const chunks = await drain(openai());
    expect(chunks.filter((c) => c.done)).toEqual([{ delta: '', done: true, finishReason: 'stop', usage: USAGE }]);
  });

  it('content after finish_reason is not appended to the finished answer', async () => {
    stubSse({ parts: [delta('a'), FINISH, delta('late'), DONE] });
    expect((await drain(openai())).map((c) => c.delta).join('')).toBe('a');
  });

  it('a delta and finish_reason in the same chunk: the delta is kept', async () => {
    stubSse({ parts: ['data: {"choices":[{"delta":{"content":"last"},"finish_reason":"stop"}]}\n\n', DONE] });
    expect(await drain(openai())).toEqual([
      { delta: 'last', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ]);
  });
});

describe('stream closure without [DONE]', () => {
  it('after finish + usage: completes with both', async () => {
    stubSse({ parts: [delta('a'), FINISH, USAGE_EVENT] });
    expect((await drain(openai())).at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
  });

  it('after finish only: completes with the finish reason', async () => {
    stubSse({ parts: [delta('a'), FINISH] });
    expect(await drain(openai())).toEqual([{ delta: 'a', done: false }, { delta: '', done: true, finishReason: 'stop' }]);
  });

  it('a final event with no trailing newline is still parsed', async () => {
    stubSse({ parts: [delta('a'), FINISH, 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}'] });
    expect((await drain(openai())).at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
  });

  it('cut off mid-answer (no finish, no usage): ends WITHOUT claiming completion', async () => {
    stubSse({ parts: [delta('partial')] });
    expect(await drain(openai())).toEqual([{ delta: 'partial', done: false }]);
  });

  it('finished, then the server holds the connection open: done after the trailer grace, not an error', async () => {
    stubSse({ parts: [delta('a'), FINISH, USAGE_EVENT], end: 'hold' });
    const runtime = new ShortTimeoutAdapter().createRuntime(KEY);
    const t0 = Date.now();
    const chunks = await drain(runtime);
    expect(chunks.at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(STREAM_TRAILER_GRACE_MS).toBeGreaterThan(0);
  });
});

describe('framing: SSE events across and within reads', () => {
  it('multiple SSE events in one read', async () => {
    stubSse({ parts: [delta('Hello') + delta(' world') + FINISH + USAGE_EVENT + DONE] });
    expect(await drain(openai())).toEqual([
      { delta: 'Hello', done: false },
      { delta: ' world', done: false },
      { delta: '', done: true, finishReason: 'stop', usage: USAGE },
    ]);
  });

  it('events split across reads: inside the prefix, inside the JSON, between the blank lines', async () => {
    const whole = delta('Hello') + delta(' world') + FINISH + USAGE_EVENT + DONE;
    const firstEnd = delta('Hello').length; // index just past the first "\n\n"
    const cuts = [2, 13, 40, firstEnd - 1, firstEnd + 3, whole.length - 3];
    const parts = cuts.map((c, i) => whole.slice(i === 0 ? 0 : cuts[i - 1], c)).concat(whole.slice(cuts.at(-1)));
    expect(parts.join('')).toBe(whole);
    expect(parts[0]).toBe('da'); // split inside the `data:` prefix
    expect(parts[3].endsWith('\n')).toBe(true); // split between the two newlines of a separator
    stubSse({ parts });
    expect(await drain(openai())).toEqual([
      { delta: 'Hello', done: false },
      { delta: ' world', done: false },
      { delta: '', done: true, finishReason: 'stop', usage: USAGE },
    ]);
  });

  it('one byte per read reassembles identically', async () => {
    const whole = delta('Hé ✓') + FINISH + USAGE_EVENT + DONE;
    stubSse({ parts: whole.split('') });
    expect(await drain(openai())).toEqual([
      { delta: 'Hé ✓', done: false },
      { delta: '', done: true, finishReason: 'stop', usage: USAGE },
    ]);
  });

  it('CRLF framing and data: without a space are accepted', async () => {
    stubSse({ parts: ['data:{"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n', 'data: [DONE]\r\n\r\n'] });
    expect(await drain(openai())).toEqual([{ delta: 'a', done: false }, { delta: '', done: true, finishReason: 'stop' }]);
  });
});

describe('malformed input and errors', () => {
  it('malformed chunks, comments and non-data fields are skipped, never fatal', async () => {
    stubSse({ parts: [
      ': keep-alive\n\n', 'event: message\nid: 7\n', delta('a'),
      'data: {not json\n\n', 'data: null\n\n', 'data: 42\n\n', 'data: {"choices":[{}]}\n\n', 'data: {"choices":"nope"}\n\n',
      delta('b'), FINISH, USAGE_EVENT, DONE,
    ] });
    expect(await drain(openai())).toEqual([
      { delta: 'a', done: false },
      { delta: 'b', done: false },
      { delta: '', done: true, finishReason: 'stop', usage: USAGE },
    ]);
  });

  it('a mid-stream transport error propagates after the deltas already received, with no done', async () => {
    stubSse({ parts: [delta('partial')], end: new Error('socket hang up') });
    const seen: StreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const c of openai().stream(REQ)) seen.push(c);
    } catch (e) { caught = e; }
    expect(seen).toEqual([{ delta: 'partial', done: false }]);
    expect((caught as Error)?.message).toContain('socket hang up');
  });

  it('a reset AFTER finish_reason completes the finished answer instead of failing it', async () => {
    // Before the trailer was read, the parser had already returned at
    // finish_reason, so a later reset was never visible. Keep that: the
    // answer is complete; only the trailing usage is lost.
    stubSse({ parts: [delta('a'), FINISH], end: new Error('reset after finish') });
    expect(await drain(openai())).toEqual([{ delta: 'a', done: false }, { delta: '', done: true, finishReason: 'stop' }]);
  });

  it('a reset after finish_reason keeps usage that already arrived', async () => {
    stubSse({ parts: [delta('a'), FINISH, USAGE_EVENT], end: new Error('reset before [DONE]') });
    expect((await drain(openai())).at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop', usage: USAGE });
  });

  it('an HTTP refusal is a ProviderHttpError before any chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(drain(openai())).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('cancel() mid-stream aborts the read and ends the iteration with an error', async () => {
    stubSse({ parts: [delta('a')], end: 'hold' });
    const runtime = openai();
    const seen: StreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const c of runtime.stream(REQ)) { seen.push(c); runtime.cancel(); }
    } catch (e) { caught = e; }
    expect(seen).toEqual([{ delta: 'a', done: false }]);
    expect(caught).toBeDefined();
  });

  it('cancel() during the trailer wait ends promptly with the finished answer, without hanging', async () => {
    stubSse({ parts: [delta('a'), FINISH], end: 'hold' });
    const runtime = openai(); // 30s silence budget: only the cancel can end this quickly
    const seen: StreamChunk[] = [];
    const t0 = Date.now();
    for await (const c of runtime.stream(REQ)) { seen.push(c); setTimeout(() => runtime.cancel(), 20); }
    expect(Date.now() - t0).toBeLessThan(STREAM_TRAILER_GRACE_MS);
    expect(seen).toEqual([{ delta: 'a', done: false }, { delta: '', done: true, finishReason: 'stop' }]);
  });
});
