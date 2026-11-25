/**
 * Streamed token usage, end to end through the PRODUCTION consumers.
 *
 * `openaiCompatibleStream.test.ts` pins the parser; this pins what users
 * see: `PipelineManager.generate({ stream: true })` (→ collectStream) and
 * `PipelineManager.streamEvents` (→ the `done` event) driven by the real
 * shared OpenAI-compatible runtime of a registered adapter. Only `fetch`
 * is stubbed — the wire bytes are the standard `include_usage` ending:
 *
 *   …content… → {finish_reason:"stop"} → {choices:[], usage:{…}} → [DONE]
 *
 * Before the fix both consumers reported zero / missing usage, because the
 * parser ended the stream at `finish_reason`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let PipelineManager: typeof import('./pipeline').PipelineManager;
let getAdapter: typeof import('./provider/registry').getAdapter;
type StreamEmit = import('./pipeline').StreamEmit;

beforeAll(async () => {
  // Credential store path is fixed at import: isolate before importing.
  process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pipe-usage-'));
  ({ PipelineManager } = await import('./pipeline'));
  ({ getAdapter } = await import('./provider/registry'));
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

const USAGE = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"usage":null}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
  'data: [DONE]\n\n',
];

function stubChatCompletions(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (!url.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const p of SSE) c.enqueue(enc.encode(p)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return urls;
}

/** A pipeline whose active runtime is the real OpenAI adapter runtime. */
function pipelineOnOpenAI() {
  const pm = new PipelineManager();
  const runtime = getAdapter('openai')!.createRuntime('test-key-not-a-real-secret', 'gpt-4o');
  (pm.runtimeManager as unknown as { active: unknown }).active = { type: 'byoak', providerId: 'openai', model: 'gpt-4o', runtime };
  return pm;
}

describe('streamed usage reaches the production consumers', () => {
  it('generate({ stream: true }) — collectStream — reports the trailing usage', async () => {
    const urls = stubChatCompletions();
    const out = await pipelineOnOpenAI().generate({ user: 'hi', stream: true, timeoutMs: 10_000, maxRetries: 0 });
    expect(out).toEqual({ ok: true, text: 'Hello world', usage: USAGE, finishReason: 'stop' });
    expect(urls.every((u) => u.startsWith('https://api.openai.com/v1/'))).toBe(true);
  });

  it('streamEvents emits the tokens and exactly one done event carrying usage and finish reason', async () => {
    stubChatCompletions();
    const events: StreamEmit[] = [];
    await pipelineOnOpenAI().streamEvents('hi', (e) => events.push(e));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([]);
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(tokens).toBe('Hello world');
    const done = events.filter((e) => e.type === 'done') as { usage?: unknown; finishReason?: string }[];
    expect(done).toHaveLength(1);
    expect(done[0].usage).toEqual(USAGE);
    expect(done[0].finishReason).toBe('stop');
  });
});
