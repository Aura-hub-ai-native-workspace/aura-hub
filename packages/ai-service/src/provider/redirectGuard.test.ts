import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeRedirect, pinnedFetch, RedirectBlocked } from './redirectGuard';

/**
 * Real servers on real ports, not a mocked `fetch`.
 *
 * The behaviour under test is what happens on the wire — whether a hop is
 * followed, and to where — so a stub that returns a fabricated Response
 * would only be testing the stub. Two servers make cross-host and
 * cross-port genuinely different destinations.
 */
function serve(handler: http.RequestListener): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

let primary: Awaited<ReturnType<typeof serve>>;
let secondary: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  secondary = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'moved-here:1b' }] }));
  });
  primary = await serve((req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'real:1b' }] }));
      return;
    }
    if (url === '/safe-redirect') { res.writeHead(302, { location: '/api/tags' }); res.end(); return; }
    if (url === '/cross-host') { res.writeHead(302, { location: 'http://127.0.0.2:11434/api/tags' }); res.end(); return; }
    if (url === '/cross-port') { res.writeHead(302, { location: secondary.url + '/api/tags' }); res.end(); return; }
    if (url === '/loop-a') { res.writeHead(302, { location: '/loop-b' }); res.end(); return; }
    if (url === '/loop-b') { res.writeHead(302, { location: '/loop-a' }); res.end(); return; }
    if (url === '/no-location') { res.writeHead(302); res.end(); return; }
    if (url === '/stream-redirect') { res.writeHead(307, { location: secondary.url + '/v1/chat/completions' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
});

afterAll(async () => { await primary.close(); await secondary.close(); });

describe('pinnedFetch', () => {
  it('passes a plain response straight through', async () => {
    const res = await pinnedFetch(`${primary.url}/api/tags`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ models: [{ name: 'real:1b' }] });
  });

  it('follows a redirect that stays on the same server', async () => {
    const res = await pinnedFetch(`${primary.url}/safe-redirect`);
    expect(res.status).toBe(200);
    // Followed to the real endpoint, not to the other server.
    await expect(res.json()).resolves.toMatchObject({ models: [{ name: 'real:1b' }] });
  });

  it('refuses a redirect to another host', async () => {
    await expect(pinnedFetch(`${primary.url}/cross-host`)).rejects.toMatchObject({
      name: 'RedirectBlocked', reason: 'cross-host',
    });
  });

  it('refuses a redirect to another port on the same host', async () => {
    await expect(pinnedFetch(`${primary.url}/cross-port`)).rejects.toMatchObject({
      name: 'RedirectBlocked', reason: 'cross-port',
    });
  });

  it('refuses a redirect loop rather than spinning', async () => {
    await expect(pinnedFetch(`${primary.url}/loop-a`)).rejects.toMatchObject({
      name: 'RedirectBlocked', reason: 'loop',
    });
  });

  it('refuses a 3xx with no destination', async () => {
    await expect(pinnedFetch(`${primary.url}/no-location`)).rejects.toMatchObject({
      name: 'RedirectBlocked', reason: 'no-location',
    });
  });

  it('refuses a redirect on the streaming inference path too', async () => {
    // 307 preserves the method, which is what a POST to /v1/chat/completions
    // would receive — and it must be refused exactly like any other hop.
    await expect(pinnedFetch(`${primary.url}/stream-redirect`, { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ name: 'RedirectBlocked', reason: 'cross-port' });
  });
});

describe('assertSafeRedirect', () => {
  const origin = new URL('https://gpu.college.edu:11434/api/tags');

  it('allows a path rewrite on the configured server', () => {
    const next = assertSafeRedirect(origin, origin, '/ollama/api/tags');
    expect(next.host).toBe('gpu.college.edu:11434');
    expect(next.pathname).toBe('/ollama/api/tags');
  });

  it('refuses an HTTPS to HTTP downgrade', () => {
    expect(() => assertSafeRedirect(origin, origin, 'http://gpu.college.edu:11434/api/tags'))
      .toThrow(/HTTPS to plain HTTP/i);
    try {
      assertSafeRedirect(origin, origin, 'http://gpu.college.edu:11434/api/tags');
    } catch (e) {
      expect((e as RedirectBlocked).reason).toBe('downgrade');
    }
  });

  it('names an inward redirect for what it is', () => {
    try {
      assertSafeRedirect(origin, origin, 'https://127.0.0.1:11434/api/tags');
      throw new Error('should have refused');
    } catch (e) {
      expect((e as RedirectBlocked).reason).toBe('cross-host');
      expect((e as RedirectBlocked).message).toMatch(/private address/i);
    }
  });

  it('compares against the ORIGINAL destination, not the previous hop', () => {
    // A chain must not walk away one permissible-looking step at a time.
    const hop = new URL('https://gpu.college.edu:11434/step');
    expect(() => assertSafeRedirect(origin, hop, 'https://elsewhere.example.com/api/tags'))
      .toThrow(/different host/i);
  });

  it('treats a default port as equal to the explicit one', () => {
    const https = new URL('https://gpu.college.edu/api/tags');
    expect(() => assertSafeRedirect(https, https, 'https://gpu.college.edu:443/api/tags')).not.toThrow();
  });
});
