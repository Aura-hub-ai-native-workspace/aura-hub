/**
 * verify → save — persistence must not re-prove the network.
 *
 * Reproducible Windows/ngrok failure this pins down:
 *
 *   ✓ Address looks valid · ✓ reachable · ✓ model list · ✓ model served
 *   ✓ Model answered a real prompt · ✗ Configuration saved —
 *   "Cannot reach the configured Ollama server ... (fetch failed)"
 *
 * Root cause: after verification had already proved reachability,
 * identity, the model list AND a real streamed generation with the exact
 * address, the save stage called `connectProvider`, whose first act is a
 * second, identical `validate` over the network. Any connection-level
 * flake on that redundant request — a keep-alive socket torn down by the
 * SSE stream that just finished, an ngrok edge churning connections —
 * fails onboarding with the paradox above: reachable, then "unreachable".
 *
 * The fix: the save stage (`connectVerifiedProvider`) writes down exactly
 * what verification proved — local disk writes only — and activation
 * resolves against the just-stored list with best-effort discovery that
 * can never fail the save.
 *
 * The stub below encodes the failure deterministically: it answers
 * `/api/tags` twice (validate + discover) and the generation stream
 * fully, then destroys every further socket — the shape of the poisoned
 * pool / churning edge. Save must still succeed, and the persisted
 * address must be byte-identical to the verified one.
 *
 * Runs with `npm run test:service` from the repo root, against an
 * isolated AURA_HOME so no real user state is touched.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceManager } from '../workspace';
import { getActive, getAllProviderStores, getKey } from './credentialStore';

const MODEL = 'test-model:latest';

interface Stub {
  server: Server;
  base: string;
  /** How many GET /api/tags to answer before destroying sockets. Infinity = healthy. */
  tagsHitsAllowed: number;
  tagsHits: number;
}

function startStub(tagsHitsAllowed: number): Promise<Stub> {
  return new Promise((resolve) => {
    const stub = { tagsHitsAllowed, tagsHits: 0 } as Stub;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        stub.tagsHits += 1;
        if (stub.tagsHits > stub.tagsHitsAllowed) {
          // Connection-level failure AFTER verification's own requests:
          // undici surfaces this as "fetch failed", exactly like the
          // recycled-socket / edge-churn condition on Windows+ngrok.
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: MODEL, details: { parameter_size: '4B', quantization_level: 'Q4' } }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        // A real streamed generation: one token chunk, then done.
        // Only this exact path is served — posting anywhere else 404s,
        // which is what pins the endpoint-format handling.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: {"choices":[{"delta":{"content":"AURA_CONNECTION_OK"}}]}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      (stub as Stub).server = server;
      (stub as Stub).base = `http://127.0.0.1:${port}`;
      resolve(stub as Stub);
    });
  });
}

beforeEach(() => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-verify-save-test-'));
});

describe('verifySelfHosted save stage', () => {
  it('verifies, saves, and persists the exact verified URL and model', async () => {
    const stub = await startStub(Infinity);
    try {
      const manager = new WorkspaceManager({});
      // The ngrok report used a /v1-suffixed address — keep the suffix:
      // endpoint-format handling is part of what is under test.
      const input = `${stub.base}/v1`;
      const r = await manager.verifySelfHosted('ollama', input, MODEL);

      expect(r.ok).toBe(true);
      expect(r.stage).toBeUndefined();
      expect(r.chunks).toBeGreaterThan(0);

      // The persisted address is byte-identical to the verified one —
      // not a re-normalised equivalent that names a different route.
      expect(getKey('ollama')).toBe(input);
      // The fingerprint (the UI-visible identity) is the address.
      expect(getAllProviderStores().find((s) => s.id === 'ollama')?.fingerprint).toBe(stub.base);
      // The stored model list is the verified one.
      expect(getAllProviderStores().find((s) => s.id === 'ollama')?.models.map((m) => m.id)).toContain(MODEL);
      // Active pointer: this provider, exactly this model — never swapped.
      expect(getActive()).toEqual({ providerId: 'ollama', model: MODEL });
      expect(manager.pipeline.runtimeManager.getProviderId()).toBe('ollama');
      expect(manager.pipeline.runtimeManager.getModel()).toBe(MODEL);
    } finally {
      stub.server.close();
    }
  });

  it('saves successfully when the server goes dark after the generation', async () => {
    // Two /api/tags answers cover verification's own validate+discover.
    // Everything after the generation stream gets a destroyed socket.
    const stub = await startStub(2);
    try {
      const manager = new WorkspaceManager({});
      const input = `${stub.base}/v1`;
      const r = await manager.verifySelfHosted('ollama', input, MODEL);

      // The save must not depend on re-reaching the server: verification
      // already proved it with a real streamed answer.
      expect(r).toEqual(expect.objectContaining({ ok: true }));
      expect(r.stage).toBeUndefined();

      expect(getKey('ollama')).toBe(input);
      expect(getActive()).toEqual({ providerId: 'ollama', model: MODEL });
      expect(manager.pipeline.runtimeManager.getProviderId()).toBe('ollama');
    } finally {
      stub.server.close();
    }
  });
});
