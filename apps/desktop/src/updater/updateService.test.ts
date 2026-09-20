import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type UpdaterAdapter } from './updateService';
import type { UpdateState } from './types';

function fakeAdapter(): UpdaterAdapter {
  return {
    currentVersion: async () => '0.0.0-test',
    platform: async () => ({ os: 'linux', arch: 'x86_64' }),
    check: async () => null,
    relaunch: async () => {},
    sourceHost: () => 'github.com',
    installKind: async () => 'self-updating',
  };
}

describe('UpdateService.setAdapter', () => {
  it('keeps subscribers across the browser → native swap', async () => {
    const service = new UpdateService(fakeAdapter());
    const seen: UpdateState[] = [];
    service.subscribe((s) => seen.push(s));
    seen.length = 0;

    // The dynamic import resolving: same instance, new adapter.
    service.setAdapter(fakeAdapter());
    await service.check();

    const kinds = seen.map((s) => s.kind);
    // checking → up-to-date, delivered to the pre-swap subscriber.
    expect(kinds).toContain('checking');
    expect(kinds[kinds.length - 1]).toBe('up-to-date');
    expect(service.getState().kind).toBe('up-to-date');
  });

  it('unsubscribe still releases the listener after a swap', async () => {
    const service = new UpdateService(fakeAdapter());
    const listener = vi.fn();
    const unsub = service.subscribe(listener);
    service.setAdapter(fakeAdapter());
    unsub();
    await service.check();
    // subscribe() itself invokes once; nothing after unsub.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a cancel during check wins over the check answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter();
    adapter.check = async () => {
      await gate;
      return null;
    };
    const service = new UpdateService(adapter);
    const pending = service.check();
    // Let check() reach the adapter await, then cancel.
    await new Promise((r) => setTimeout(r, 10));
    await service.cancel();
    expect(service.getState().kind).toBe('cancelled');
    release();
    await pending;
    // The stale answer must not overwrite the cancellation.
    expect(service.getState().kind).toBe('cancelled');
  });

  it('a hung relaunch fails instead of pinning restarting', async () => {
    vi.useFakeTimers();
    try {
      const adapter = fakeAdapter();
      adapter.relaunch = () => new Promise<void>(() => {});
      const service = new UpdateService(adapter);
      // Candidate required before restart will run.
      (service as unknown as { candidate: unknown }).candidate = { version: '9.9.9' };
      const done = service.restart();
      expect(service.getState().kind).toBe('restarting');
      await vi.advanceTimersByTimeAsync(30_000);
      const state = await done;
      expect(state.kind).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
