/** `/health` must never make the app wait on a slow or unreachable provider. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let PipelineManager: typeof import('./pipeline').PipelineManager;
beforeAll(async () => {
  process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-health-'));
  ({ PipelineManager } = await import('./pipeline'));
});
afterEach(() => vi.useRealTimers());

function managerWith(health: () => Promise<unknown>) {
  const pm = new PipelineManager();
  const calls = { n: 0 };
  (pm.runtimeManager as unknown as { active: unknown }).active = {
    type: 'byoak', providerId: 'ollama', model: 'm',
    runtime: { cancel: vi.fn(), health: () => { calls.n++; return health(); } },
  };
  return { pm, calls };
}

const never = () => new Promise(() => {});

describe('provider health', () => {
  it('answers quickly when the provider does not answer at all', async () => {
    const { pm } = managerWith(never);
    const start = Date.now();
    const h = await pm.health();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(h).toMatchObject({ ok: false, status: 'offline' });
  });

  it('reuses the last answer and refreshes it in the background', async () => {
    let ok = true;
    const { pm, calls } = managerWith(async () => ({ ok, status: ok ? 'connected' : 'offline', latencyMs: 1 }));
    expect(await pm.health()).toMatchObject({ ok: true });
    ok = false;
    expect(await pm.health()).toMatchObject({ ok: true }); // cached, no new round trip
    expect(calls.n).toBe(1);
  });

  it('a fresh check (Test connection) always asks the provider', async () => {
    let ok = true;
    const { pm, calls } = managerWith(async () => ({ ok, status: 'connected', latencyMs: 1 }));
    await pm.health();
    ok = false;
    expect(await pm.health({ fresh: true })).toMatchObject({ ok: false });
    expect(calls.n).toBe(2);
  });

  it('a provider that throws is reported, not raised', async () => {
    const { pm } = managerWith(async () => { throw new Error('boom'); });
    expect(await pm.health({ fresh: true })).toMatchObject({ ok: false, status: 'error', error: 'boom' });
  });
});
