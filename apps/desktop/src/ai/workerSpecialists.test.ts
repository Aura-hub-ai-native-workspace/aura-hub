import { afterEach, describe, expect, it, vi } from 'vitest';

const { backendFetch } = vi.hoisted(() => ({ backendFetch: vi.fn() }));
vi.mock('../backend/backendSession', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  backendFetch: (...a: unknown[]) => backendFetch(...a),
}));

const { fetchSpecialists } = await import('./workerClient');

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => backendFetch.mockReset());

describe('fetchSpecialists', () => {
  it('returns the roster from /agent/specialists', async () => {
    const roster = [{ id: 'researcher', name: 'Researcher', runtime: 'opencode', runtimeName: 'OpenCode', runtimeAvailable: false, focus: 'x', responsibilities: [] }];
    backendFetch.mockResolvedValueOnce(json(200, { specialists: roster }));
    await expect(fetchSpecialists()).resolves.toEqual({ specialists: roster });
    expect(String(backendFetch.mock.calls[0][0])).toMatch(/\/agent\/specialists$/);
  });

  it('reports an HTTP failure instead of an empty "all fine" roster', async () => {
    backendFetch.mockResolvedValueOnce(json(503, {}));
    await expect(fetchSpecialists()).resolves.toEqual({ specialists: [], error: 'request failed (503)' });
  });

  it('reports an unreachable service and tolerates a malformed body', async () => {
    backendFetch.mockRejectedValueOnce(new Error('connection refused'));
    await expect(fetchSpecialists()).resolves.toEqual({ specialists: [], error: 'connection refused' });
    backendFetch.mockResolvedValueOnce(json(200, { specialists: 'nope' }));
    await expect(fetchSpecialists()).resolves.toEqual({ specialists: [] });
  });
});
