import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

const g = globalThis as unknown as { window?: Record<string, unknown> };

beforeEach(() => { vi.resetModules(); invokeMock.mockClear(); });
afterEach(() => { delete g.window; });


describe('crash records from the window', () => {
  it('sends an error to the shell once, even when it repeats', async () => {
    g.window = { __TAURI_INTERNALS__: {} };
    const { recordError } = await import('./crashRecords');
    const e = new Error('boom');
    recordError('render', e, 'component stack: at App');
    recordError('render', e);
    // The shell call goes through a dynamic import; on a slow machine that
    // takes longer than one tick, so wait for it rather than for a tick.
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('record_renderer_error', expect.objectContaining({ kind: 'render', message: 'boom' }));
  });

  it('does nothing outside the desktop app', async () => {
    const { recordError, listCrashRecords } = await import('./crashRecords');
    recordError('error', 'x');
    await new Promise((r) => setTimeout(r, 50));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(await listCrashRecords()).toBeNull();
  });
});
