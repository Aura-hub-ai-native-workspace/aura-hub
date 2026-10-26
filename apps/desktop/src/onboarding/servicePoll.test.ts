import { describe, expect, it, vi } from 'vitest';
import { BackendRefusedError, IDENTITY_MISMATCH, type ServiceStartup } from '../backend/backendSession';
import { pollForService, WAITING_MESSAGE } from './servicePoll';

/** Drains pending promise callbacks. No timers: attempts run only when the test steps them. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function harness<R>(request: () => Promise<R>, startups: (ServiceStartup | null)[]) {
  const scheduled: (() => void)[] = [];
  const calls = { ready: [] as R[], waiting: [] as string[], failed: [] as string[] };
  const startup = vi.fn(async () => startups.length > 1 ? startups.shift()! : startups[0]);
  const stop = pollForService({
    request,
    startup,
    onReady: (r) => calls.ready.push(r),
    onWaiting: (m) => calls.waiting.push(m),
    onFailed: (m) => calls.failed.push(m),
    schedule: (next) => { scheduled.push(next); return () => { scheduled.length = 0; }; },
  });
  const step = async () => { scheduled.shift()?.(); await settle(); };
  return { calls, scheduled, startup, stop, step };
}

const refused = () => Promise.reject(new BackendRefusedError('ai', 'has no identity check'));
const FOREIGN: ServiceStartup = {
  state: 'failed', port: 4319,
  message: 'Port 4319 is already in use, so AURA cannot start its local service on it.',
};

describe('onboarding wait for the local service', () => {
  it('a foreign listener ends the loading state with an identity mismatch, once', async () => {
    const request = vi.fn(refused);
    const h = harness(request, [FOREIGN]);
    await settle();
    expect(h.calls.failed).toHaveLength(1);
    expect(h.calls.failed[0].startsWith(IDENTITY_MISMATCH)).toBe(true);
    expect(h.calls.failed[0]).toContain('Port 4319 is already in use');
    expect(h.calls.waiting).toEqual([]);
    expect(h.scheduled).toHaveLength(0); // no further attempt is queued
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a slow but owned start is waited for, then proceeds', async () => {
    let attempts = 0;
    const request = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new BackendRefusedError('ai', 'nothing answered on the port');
      return 'providers';
    });
    const h = harness(request, [{ state: 'starting', message: '' }]);
    await settle();
    expect(h.calls.waiting).toEqual([WAITING_MESSAGE]);
    await h.step();
    await h.step();
    expect(h.calls.ready).toEqual(['providers']);
    expect(h.calls.failed).toEqual([]);
    expect(h.calls.waiting).toHaveLength(2);
  });

  it('a start that fails while waiting stops the wait at that point', async () => {
    const request = vi.fn(refused);
    const h = harness(request, [{ state: 'starting', message: '' }, FOREIGN]);
    await settle();
    expect(h.calls.waiting).toHaveLength(1);
    await h.step();
    expect(h.calls.failed).toHaveLength(1);
    expect(h.scheduled).toHaveLength(0);
  });

  it('owned services that answer at once never show a waiting or failed state', async () => {
    const h = harness(async () => 'providers', [FOREIGN]);
    await settle();
    expect(h.calls.ready).toEqual(['providers']);
    expect(h.startup).not.toHaveBeenCalled();
    expect(h.calls.waiting).toEqual([]);
    expect(h.calls.failed).toEqual([]);
  });

  it('stopping cancels the pending attempt', async () => {
    const request = vi.fn(refused);
    const h = harness(request, [{ state: 'starting', message: '' }]);
    await settle();
    h.stop();
    expect(h.scheduled).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
