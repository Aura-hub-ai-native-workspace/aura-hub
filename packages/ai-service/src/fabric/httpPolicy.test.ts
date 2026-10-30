/**
 * http.request destination policy, Node side (F-20).
 *
 * An autonomous request may only GET or HEAD a loopback, private or otherwise
 * non-public address; a user-initiated request is not limited; cloud metadata
 * addresses are refused for everyone. The check is made on the resolved
 * address at connection time and again on every redirect hop. GET and HEAD
 * are not claimed to be side-effect free.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Invocation } from '@aura/capability-fabric';
import { checkAddress, DestinationRefused, isAutonomous, policedRequest } from './httpPolicy';
import { allExecutors } from './executors';

const hits: { method: string; url: string }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    if ((req.url ?? '').startsWith('/redir?')) {
      res.writeHead(302, { location: (req.url ?? '').split('to=')[1] });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': req.method === 'HEAD' ? '0' : '6' });
    res.end(req.method === 'HEAD' ? undefined : 'served');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const run = (url: string, method: string, actor: unknown, body?: string) => {
  const exe = allExecutors({} as never).find((e) => e.capabilityId === 'http.request')!;
  return exe.run({ input: { url, method, ...(body ? { body } : {}) }, context: { actor } } as unknown as Invocation);
};
const AGENT = { kind: 'agent', id: 'central-agent' };
const HUMAN = { kind: 'human', id: 'user' };

describe('what an autonomous request may do', () => {
  it.each(['GET', 'HEAD'])('reads a local service with %s', async (method) => {
    hits.length = 0;
    const r = await run(`${base}/models`, method, AGENT);
    expect(r.ok).toBe(true);
    expect(hits).toEqual([{ method, url: '/models' }]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('cannot %s a local service, and nothing is sent', async (method) => {
    hits.length = 0;
    const r = await run(`${base}/api/delete`, method, AGENT, '{}');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('GET or HEAD');
    expect(hits).toEqual([]);
  });

  it.each([undefined, null, 'human', { id: 'no-kind' }, { kind: 'service' }])(
    'treats actor %j as autonomous', async (actor) => {
      hits.length = 0;
      expect((await run(`${base}/x`, 'POST', actor, '{}')).ok).toBe(false);
      expect(hits).toEqual([]);
    });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not limit a user-initiated %s', async (method) => {
    hits.length = 0;
    const r = await run(`${base}/api/thing`, method, HUMAN, '{}');
    expect(r.ok).toBe(true);
    expect(hits).toEqual([{ method, url: '/api/thing' }]);
  });
});

describe('resolution and redirects cannot get around it', () => {
  const port = () => new URL(base).port;
  const opts = (method: string, resolve: (h: string) => Promise<string[]>) => ({
    method, autonomous: true, signal: new AbortController().signal, maxBytes: 1024, resolve,
  });

  it('judges a name by the address it resolves to', async () => {
    hits.length = 0;
    await expect(policedRequest(`http://internal.test:${port()}/x`, opts('POST', async () => ['127.0.0.1'])))
      .rejects.toBeInstanceOf(DestinationRefused);
    expect(hits).toEqual([]);
    const ok = await policedRequest(`http://internal.test:${port()}/x`, opts('GET', async () => ['127.0.0.1']));
    expect(ok.status).toBe(200);
  });

  it('refuses a mixed answer for an unsafe method', async () => {
    hits.length = 0;
    await expect(policedRequest(`http://mixed.test:${port()}/x`, opts('POST', async () => ['93.184.216.34', '127.0.0.1'])))
      .rejects.toBeInstanceOf(DestinationRefused);
    expect(hits).toEqual([]);
  });

  it('resolves once and connects to that answer', async () => {
    let calls = 0;
    const r = await policedRequest(`http://once.test:${port()}/x`, opts('GET', async () => { calls++; return ['127.0.0.1']; }));
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
  });

  it.each([AGENT, HUMAN])('refuses a name that resolves to cloud metadata for %j', async (actor) => {
    await expect(policedRequest('http://meta.test/latest', {
      ...opts('GET', async () => ['169.254.169.254']), autonomous: isAutonomous(actor),
    })).rejects.toBeInstanceOf(DestinationRefused);
  });

  it.each([AGENT, HUMAN])('refuses a redirect to cloud metadata for %j', async (actor) => {
    const r = await run(`${base}/redir?to=http://169.254.169.254/latest/meta-data/`, 'GET', actor);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('metadata');
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const r = await run(`${base}/redir?to=file:///etc/passwd`, 'GET', AGENT);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('root:');
  });

  it('still follows a redirect between local services as a read', async () => {
    hits.length = 0;
    const r = await run(`${base}/redir?to=${base}/landed`, 'GET', AGENT);
    expect(r.ok).toBe(true);
    expect(hits.map((h) => h.url)).toEqual([`/redir?to=${base}/landed`, '/landed']);
  });
});

describe('address classes', () => {
  const NON_PUBLIC = ['127.0.0.1', '127.8.8.8', '::1', '10.0.0.5', '172.16.1.1', '192.168.1.1', '169.254.1.1',
    '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'fc00::1', 'fe80::1', 'fe80::1%eth0'];
  const PUBLIC = ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'];

  it.each(NON_PUBLIC)('%s allows only safe methods for an agent', (addr) => {
    expect(() => checkAddress(addr, 'GET', true)).not.toThrow();
    expect(() => checkAddress(addr, 'HEAD', true)).not.toThrow();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => checkAddress(addr, m, true)).toThrow(DestinationRefused);
      expect(() => checkAddress(addr, m, false)).not.toThrow();
    }
  });

  it.each(PUBLIC)('%s is not limited by this policy', (addr) => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(() => checkAddress(addr, m, true)).not.toThrow();
  });

  it.each(['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '100.100.100.200', 'fd00:ec2::254'])(
    'metadata address %s is refused for every actor', (addr) => {
      for (const autonomous of [true, false]) {
        for (const m of ['GET', 'HEAD', 'POST']) expect(() => checkAddress(addr, m, autonomous)).toThrow(DestinationRefused);
      }
    });
});
