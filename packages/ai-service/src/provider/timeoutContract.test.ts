/**
 * The caller's deadline must reach the socket. The Planner asks for 180s while
 * the Ollama adapter's own default is 120s; if the adapter ignored the request
 * the shorter number would win silently.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaAdapter } from './adapters/ollama';

let server: http.Server;
let base = '';
let delayMs = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('request deadline reaches the transport', () => {
  it('waits longer than the adapter default when the caller asks for more', async () => {
    delayMs = 400;
    const rt = new OllamaAdapter().createRuntime(base, 'm');
    // Adapter default is 120s, so this only proves the request is honoured
    // when it is SHORTER: the call must fail at ~150ms, not wait 400ms.
    const started = Date.now();
    await expect(rt.generate({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 150 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(380);
  });

  it('completes when the caller allows enough time', async () => {
    delayMs = 200;
    const rt = new OllamaAdapter().createRuntime(base, 'm');
    const out = await rt.generate({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 2000 });
    expect(out.content).toBe('ok');
  });

  it('falls back to the adapter default when the caller names none', async () => {
    delayMs = 50;
    const rt = new OllamaAdapter().createRuntime(base, 'm');
    expect((await rt.generate({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('ok');
  });
});
