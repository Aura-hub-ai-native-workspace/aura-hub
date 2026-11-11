import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

const g = globalThis as unknown as { window?: Record<string, unknown> };

beforeEach(() => { vi.resetModules(); invokeMock.mockClear(); });
afterEach(() => { delete g.window; });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('crash records from the window', () => {
  it('sends an error to the shell once, even when it repeats', async () => {
    g.window = { __TAURI_INTERNALS__: {} };
    const { recordError } = await import('./crashRecords');
    const e = new Error('boom');
    recordError('render', e, 'component stack: at App');
    recordError('render', e);
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('record_renderer_error', expect.objectContaining({ kind: 'render', message: 'boom' }));
  });

  it('does nothing outside the desktop app', async () => {
    const { recordError, listCrashRecords } = await import('./crashRecords');
    recordError('error', 'x');
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(await listCrashRecords()).toBeNull();
  });
});
