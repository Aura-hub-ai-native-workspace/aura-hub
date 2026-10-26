import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/* The shell's answers, controlled per test, dispatched by command the way the
 * real shell answers: `backend_session` for everything, `backend_verify` for one. */
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

type Endpoint = { port: number; verified: boolean; token: string; reason: string };
type Session = { ai: Endpoint; python: Endpoint };

const OWNED: Session = {
  ai: { port: 4319, verified: true, token: 'launch-token-ai', reason: '' },
  python: { port: 4320, verified: true, token: 'launch-token-py', reason: '' },
};
const FOREIGN_AI: Session = {
  ai: { port: 4319, verified: false, token: '', reason: 'presented a proof for a different AURA instance' },
  python: { port: 4320, verified: true, token: 'launch-token-py', reason: '' },
};

type Mod = typeof import('./backendSession');
let mod: Mod;
let fetchSpy: MockInstance<typeof fetch>;
/** What the shell would answer right now. Tests change this to model the world. */
let shell: Session;

function inTauri(on: boolean) {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  if (on) g.window = { __TAURI_INTERNALS__: {} };
  else delete g.window;
}

function answerFromShell() {
  invokeMock.mockImplementation(async (cmd: string, args?: { kind?: 'ai' | 'python' }) => {
    if (cmd === 'backend_session') return shell;
    if (cmd === 'backend_verify') return shell[args?.kind ?? 'ai'];
    throw new Error(`unexpected command ${cmd}`);
  });
}

beforeEach(async () => {
  vi.resetModules();
  invokeMock.mockReset();
  shell = OWNED;
  answerFromShell();
  mod = await import('./backendSession');
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  inTauri(false);
});

const tokenSentTo = (call: number) =>
  new Headers((fetchSpy.mock.calls[call][1] as RequestInit).headers).get(mod.TOKEN_HEADER);

describe('outside the desktop shell', () => {
  it('refuses every backend, and sends nothing', async () => {
    inTauri(false);
    await expect(mod.backendFetch(`${mod.AI_BASE}/workflows`, { method: 'POST' }))
      .rejects.toBeInstanceOf(mod.BackendRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ownership before any request', () => {
  it('connects to its own backend and attaches the launch token', async () => {
    inTauri(true);
    await mod.backendFetch(`${mod.AI_BASE}/health`);
    expect(invokeMock).toHaveBeenCalledWith('backend_verify', { kind: 'ai' });
    expect(tokenSentTo(0)).toBe('launch-token-ai');
  });

  it('a foreign backend on the expected port is refused and receives zero writes', async () => {
    inTauri(true);
    shell = FOREIGN_AI;
    await expect(mod.backendFetch(`${mod.AI_BASE}/workflows`, { method: 'POST', body: '{}' }))
      .rejects.toThrow(/Backend identity mismatch — connection refused\./);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a backend that reports healthy is still refused without proof', async () => {
    inTauri(true);
    shell = FOREIGN_AI;
    await expect(mod.backendFetch(`${mod.AI_BASE}/health`)).rejects.toBeInstanceOf(mod.BackendRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a stale identity is rejected on the very next request', async () => {
    inTauri(true);
    await mod.backendFetch(`${mod.AI_BASE}/health`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    shell = { ...OWNED, ai: { ...OWNED.ai, verified: false, token: '', reason: 'nothing answered on the port' } };
    await expect(mod.backendFetch(`${mod.AI_BASE}/workflows`, { method: 'POST' })).rejects.toBeInstanceOf(mod.BackendRefusedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a verified answer without a token is not treated as verified', async () => {
    inTauri(true);
    shell = { ...OWNED, ai: { ...OWNED.ai, token: '' } };
    await expect(mod.backendFetch(`${mod.AI_BASE}/health`)).rejects.toBeInstanceOf(mod.BackendRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a shell that cannot answer refuses the request', async () => {
    inTauri(true);
    invokeMock.mockRejectedValue(new Error('no shell'));
    await expect(mod.backendFetch(`${mod.AI_BASE}/health`)).rejects.toBeInstanceOf(mod.BackendRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('takeover: a foreign listener after the owned child exits', () => {
  it('no request carries the old token once the owned backend is gone', async () => {
    inTauri(true);
    // Before: the owned Python backend answers, so the request is sent with its token.
    await mod.backendFetch(`${mod.AGENT_BASE}/agent/chat`, { method: 'POST', body: '{}' });
    expect(tokenSentTo(0)).toBe('launch-token-py');

    // The owned child exits and a foreign listener takes port 4320. The shell
    // now refuses the python endpoint, because its child is no longer running.
    shell = {
      ...OWNED,
      python: { port: 4320, verified: false, token: '', reason: 'the process AURA started is no longer running' },
    };
    await expect(mod.backendFetch(`${mod.AGENT_BASE}/agent/chat`, { method: 'POST', body: '{}' }))
      .rejects.toBeInstanceOf(mod.BackendRefusedError);
    await expect(mod.backendFetch(`${mod.AGENT_BASE}/agent/sessions/x/events`))
      .rejects.toBeInstanceOf(mod.BackendRefusedError);

    // Only the first request ever reached a network; none after the takeover.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('every request proves ownership again, so a cached answer is never used to send', async () => {
    inTauri(true);
    await mod.backendFetch(`${mod.AI_BASE}/a`);
    await mod.backendFetch(`${mod.AI_BASE}/b`);
    await mod.backendFetch(`${mod.AI_BASE}/c`);
    const verifies = invokeMock.mock.calls.filter((c) => c[0] === 'backend_verify').length;
    expect(verifies).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('status display', () => {
  it('a refresh reports both backends from one shell answer', async () => {
    inTauri(true);
    shell = FOREIGN_AI;
    const view = await mod.refreshBackendSession();
    expect(view.ai.ok).toBe(false);
    expect(view.ai.message).toMatch(/Backend identity mismatch — connection refused\./);
    expect(view.python.ok).toBe(true);
  });
});

describe('routing', () => {
  it('classifies the three bases and refuses everything else', () => {
    expect(mod.kindOfUrl(`${mod.AI_BASE}/workflows`)).toBe('ai');
    expect(mod.kindOfUrl(`${mod.AGENT_BASE}/agent/sessions`)).toBe('python');
    expect(mod.kindOfUrl(`${mod.ENVIRONMENT_BASE}/environment/inventory`)).toBe('python');
    expect(mod.kindOfUrl('https://example.com/collect')).toBeNull();
    expect(mod.kindOfUrl(`${mod.AI_BASE}.evil.example/x`)).toBeNull();
  });

  it('refuses a URL that is not one of AURA’s backends, before any network', async () => {
    inTauri(true);
    await expect(mod.backendFetch('https://example.com/collect')).rejects.toThrow(/outside AURA's backends/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('startup verdict: a service the shell could not start is not waited for', () => {
  const PORT_TAKEN = (port: number) =>
    `Port ${port} is already in use, so AURA cannot start its local service on it. Nothing was sent.`;

  it('reads the shell status for the right backend', async () => {
    inTauri(true);
    invokeMock.mockImplementation(async (cmd: string) => ({ state: 'starting', message: cmd }));
    expect((await mod.serviceStartup('ai'))?.message).toBe('service_status');
    expect((await mod.serviceStartup('python'))?.message).toBe('environment_backend_status');
  });

  it('outside the shell there is no verdict, and the screen keeps waiting', async () => {
    inTauri(false);
    expect(await mod.serviceStartup('ai')).toBeNull();
    expect(mod.startupVerdict(null, new Error('x'))).toEqual({ kind: 'waiting' });
  });

  it.each([4319, 4320])('a foreign listener on %i ends the wait as an identity mismatch', (port) => {
    const refused = new mod.BackendRefusedError(port === 4319 ? 'ai' : 'python', 'has no identity check');
    const verdict = mod.startupVerdict({ state: 'failed', message: PORT_TAKEN(port), port }, refused);
    expect(verdict.kind).toBe('failed');
    if (verdict.kind !== 'failed') return;
    expect(verdict.message.startsWith(mod.IDENTITY_MISMATCH)).toBe(true);
    expect(verdict.message).toContain(`Port ${port} is already in use`);
  });

  it('a backend still starting, or already proved, is waited for and never failed', () => {
    const refused = new mod.BackendRefusedError('ai', 'nothing answered on the port');
    expect(mod.startupVerdict({ state: 'starting', message: '' }, refused)).toEqual({ kind: 'waiting' });
    expect(mod.startupVerdict({ state: 'ready', message: '' }, refused)).toEqual({ kind: 'waiting' });
  });

  it('a failed start that is not a refusal keeps the shell reason without the identity label', () => {
    const verdict = mod.startupVerdict({ state: 'failed', message: 'bundle is missing' }, new Error('x'));
    expect(verdict).toEqual({ kind: 'failed', message: 'bundle is missing' });
  });
});
