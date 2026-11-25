/**
 * An OpenCode task is sent only after OpenCode's own MCP client reports
 * Common Context connected.
 *
 * The first half drives `runOpenCodeTask` with scripted dependencies so each
 * outcome (delayed start, success, failure, timeout, cancellation) is exact.
 * The second half uses a stand-in `opencode` executable on PATH, so the real
 * allow-list, the real spawn and the real process-tree teardown are exercised.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentServer, ProcessOutput } from '../exec/process';
import {
  HTTP_BODY_LIMIT, KILO_SERVE_ARGS, McpNotReadyError, OPENCODE_SERVE_ARGS, VerifiedEndpoints, announcedPorts, configDeclaresServer,
  isTransportError, kiloGatedArgs, kiloStatus, readBounded, runKiloTask, runOpenCodeTask, serverStatus, type Endpoints,
  defaultDeps, kiloDeps, type OpenCodeMcpDeps,
} from './opencodeMcp';
import {
  IdentityMismatch, IdentityUnavailable, Lsof, Procfs, defaultBackend, ownsConnection, resolveServer, stillRunning, type IdentityBackend,
} from './serverIdentity';
import { fileURLToPath } from 'node:url';
import { contextRefusal } from './executors';

const CONFIGURED = JSON.stringify({ sources: [{ info: { mcp: { servers: { 'common-context': { type: 'local', command: ['common-context-mcp'] } } } } }] });
const NOT_CONFIGURED = JSON.stringify({ sources: [{ info: { mcp: { servers: {} } } }] });
// OpenCode 2.3.x `debug config`: the list of configuration layers it loaded, in
// load order. Recorded shape (paths and command shortened); only document
// layers carry `info`. Kept identical to the Python gate's fixture.
const LAYERED_CONFIGURED = JSON.stringify([
  { type: 'document', path: '/home/u/.config/opencode/opencode.json',
    info: { mcp: { servers: { 'common-context': {
      type: 'local', command: ['common-context-mcp'],
      environment: { CONTEXT_MCP_AGENT_ID: 'opencode' } } } } } },
  { type: 'directory', path: '/home/u/.config/opencode' },
]);
const LAYERED_NOT_CONFIGURED = JSON.stringify([
  { type: 'document', path: '/home/u/.config/opencode/opencode.json',
    info: { mcp: { servers: { other: { type: 'local' } } } } },
  { type: 'directory', path: '/home/u/.config/opencode' },
]);
const ok = (out: string): ProcessOutput => ({ out, code: 0 });

/**
 * TEST-ONLY stand-in for the verified relay: the scripted server's announced
 * URL as is. The scripted servers have no process or socket, so these tests
 * cover the readiness logic (waiting, failure, reconnect, cancellation). The
 * security boundary itself is covered by the real-process adversarial tests
 * at the end of this file, which use the production VerifiedEndpoints.
 */
const announcedEndpoints: Endpoints = {
  available: async () => ({ ok: true, detail: 'test stand-in' }),
  open: async (server, runtime) => {
    const ports = announcedPorts(server.output(), runtime);
    return ports.size === 1 ? { url: `http://127.0.0.1:${[...ports][0]}`, violations: [], close: async () => undefined } : undefined;
  },
};

interface Script {
  config?: ProcessOutput;
  /** One entry per `mcp list` call; the last entry repeats. */
  lists: ProcessOutput[];
  serverExitsAfterLists?: number;
  onList?: (call: number) => void;
  /** false: the server never announces its address. */
  announce?: boolean;
}

function scripted(script: Script) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  let listCalls = 0;
  let clock = 0;
  let stopped = 0;
  let serverStarted = false;
  const server: AgentServer = {
    pid: 4242,
    log: () => 'level=ERROR message="mcp transport error" server=common-context',
    output: () => (script.announce === false ? 'starting\n' : 'server listening on http://127.0.0.1:45678\n'),
    exited: () => script.serverExitsAfterLists !== undefined && listCalls >= script.serverExitsAfterLists,
    stop: async () => { stopped += 1; },
  };
  const deps: OpenCodeMcpDeps = {
    run: async (args, opts) => {
      calls.push(args);
      envs.push(opts.env);
      if (args.includes('debug')) return script.config ?? ok(CONFIGURED);
      if (args.includes('mcp') && args.includes('list')) {
        script.onList?.(listCalls);
        const reply = script.lists[Math.min(listCalls, script.lists.length - 1)];
        listCalls += 1;
        return reply;
      }
      return ok('task finished');
    },
    startServer: () => { serverStarted = true; return server; },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    password: () => 'one-time-test-password',
    endpoints: announcedEndpoints,
  };
  const taskCalls = () => calls.filter((a) => a.includes('run'));
  return { deps, calls, envs, taskCalls, stopped: () => stopped, serverStarted: () => serverStarted, listCalls: () => listCalls };
}

const PENDING = ok('No MCP servers configured\n');
const CONNECTED = ok('\u001b[32m✓\u001b[0m common-context  connected\n');
const FAILED = ok('✗ common-context  failed: spawn common-context-mcp ENOENT\n');

describe('reading OpenCode output', () => {
  it('finds the server in the resolved configuration, wherever it is nested', () => {
    expect(configDeclaresServer(CONFIGURED)).toBe(true);
    expect(configDeclaresServer(NOT_CONFIGURED)).toBe(false);
    expect(configDeclaresServer('not json')).toBe(false);
    expect(configDeclaresServer(JSON.stringify({ mcp: { servers: { 'common-context': { enabled: false } } } }))).toBe(false);
  });

  it('reads the OpenCode 2.3 list of configuration layers', () => {
    expect(configDeclaresServer(LAYERED_CONFIGURED)).toBe(true);
    expect(configDeclaresServer(LAYERED_NOT_CONFIGURED)).toBe(false);
    // Layers merge in load order, so a later layer that disables the server wins…
    const disabledLater = JSON.stringify([
      JSON.parse(LAYERED_CONFIGURED)[0],
      { type: 'document', path: '/p/opencode.json', info: { mcp: { servers: { 'common-context': { enabled: false } } } } },
    ]);
    expect(configDeclaresServer(disabledLater)).toBe(false);
    // …and a later layer can add the server to one that did not declare it.
    const addedLater = JSON.stringify([
      JSON.parse(LAYERED_NOT_CONFIGURED)[0],
      { type: 'document', path: '/p/opencode.json', info: { mcp: { servers: { 'common-context': { type: 'local' } } } } },
    ]);
    expect(configDeclaresServer(addedLater)).toBe(true);
    // Log text before the JSON is skipped, as for the object format.
    expect(configDeclaresServer(`INFO loading config\n${LAYERED_CONFIGURED}`)).toBe(true);
  });

  it('reads one server status and never mistakes another server for it', () => {
    expect(serverStatus(CONNECTED.out).state).toBe('connected');
    expect(serverStatus(FAILED.out)).toMatchObject({ state: 'failed' });
    expect(serverStatus(PENDING.out).state).toBe('pending');
    expect(serverStatus('✓ common-context-extra  connected\n').state).toBe('pending');
    expect(serverStatus('⚠ common-context  needs authentication\n').state).toBe('failed');
  });
});

describe('runOpenCodeTask', () => {
  it('waits through a delayed MCP start and sends the task only once connected', async () => {
    const s = scripted({ lists: [PENDING, PENDING, PENDING, CONNECTED] });
    const res = await runOpenCodeTask('build the footer', { cwd: '/p', model: 'opencode/some-model' }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(s.listCalls()).toBe(4);
    // The task is the last call, made after the connected report.
    expect(s.calls[1]).toEqual(['--server', 'http://127.0.0.1:45678', 'mcp', 'list']);
    expect(s.calls.at(-1)).toEqual(['--server', 'http://127.0.0.1:45678', 'run', '--model', 'opencode/some-model', 'build the footer']);
    expect(s.taskCalls()).toHaveLength(1);
    expect(s.stopped()).toBe(1);
  });

  it('sends the task straight away when already connected, with the password only in env', async () => {
    const s = scripted({ lists: [CONNECTED] });
    const res = await runOpenCodeTask('task', { cwd: '/p', env: { KEEP: '1' } }, s.deps);
    expect(res).toMatchObject({ mcp: 'connected', code: 0, out: 'task finished' });
    expect(res.args.join(' ')).not.toContain('one-time-test-password');
    expect(s.envs.at(-1)).toEqual({ KEEP: '1', OPENCODE_PASSWORD: 'one-time-test-password' });
    expect(s.stopped()).toBe(1);
  });

  it('does not send the task when the connection fails, and says why', async () => {
    const s = scripted({ lists: [PENDING, FAILED] });
    const err = await runOpenCodeTask('task', { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('failed');
    expect(err.message).toContain('ENOENT');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('does not send the task when the connection never arrives (timeout)', async () => {
    const s = scripted({ lists: [PENDING] });
    const err = await runOpenCodeTask('task', { cwd: '/p', readyTimeoutMs: 2_000 }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('timeout');
    expect(s.listCalls()).toBeGreaterThan(2);
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('does not treat a running server as connectivity when it exits first', async () => {
    const s = scripted({ lists: [PENDING], serverExitsAfterLists: 2 });
    const err = await runOpenCodeTask('task', { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('server-exited');
    expect(err.message).toContain('mcp transport error');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('stops waiting, sends nothing and cleans up when cancelled', async () => {
    const ac = new AbortController();
    const s = scripted({ lists: [PENDING], onList: (call) => { if (call === 1) ac.abort(); } });
    const err = await runOpenCodeTask('task', { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('cancelled');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('sends nothing and starts nothing when cancelled before it begins', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = scripted({ lists: [CONNECTED] });
    const err = await runOpenCodeTask('task', { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    expect(err.reason).toBe('cancelled');
    expect(s.calls).toHaveLength(0);
    expect(s.serverStarted()).toBe(false);
  });

  it('still ends the private server when the task itself throws', async () => {
    const s = scripted({ lists: [CONNECTED] });
    const run = s.deps.run;
    s.deps.run = async (args, opts) => { if (args.includes('run')) throw new Error('opencode is not installed'); return run(args, opts); };
    await expect(runOpenCodeTask('task', { cwd: '/p' }, s.deps)).rejects.toThrow('not installed');
    expect(s.stopped()).toBe(1);
  });

  it('runs without a private server when Common Context is not configured, and reports that', async () => {
    const s = scripted({ config: ok(NOT_CONFIGURED), lists: [CONNECTED] });
    const res = await runOpenCodeTask('task', { cwd: '/p', model: 'm' }, s.deps);
    expect(res.mcp).toBe('not-configured');
    expect(res.args).toEqual(['--standalone', 'run', '--model', 'm', 'task']);
    expect(s.serverStarted()).toBe(false);
    expect(s.listCalls()).toBe(0);
  });

  it('gates an OpenCode 2.3 layered configuration exactly like the object format', async () => {
    const s = scripted({ config: ok(LAYERED_CONFIGURED), lists: [PENDING, CONNECTED] });
    const res = await runOpenCodeTask('task', { cwd: '/p', model: 'm' }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(s.serverStarted()).toBe(true);
    expect(res.args.slice(0, 2)).toEqual(['--server', 'http://127.0.0.1:45678']);
  });

  it('runs an OpenCode 2.3 layered configuration without Common Context exactly as before', async () => {
    const s = scripted({ config: ok(LAYERED_NOT_CONFIGURED), lists: [CONNECTED] });
    const res = await runOpenCodeTask('task', { cwd: '/p', model: 'm' }, s.deps);
    expect(res.mcp).toBe('not-configured');
    expect(res.args).toEqual(['--standalone', 'run', '--model', 'm', 'task']);
    expect(s.serverStarted()).toBe(false);
    expect(s.listCalls()).toBe(0);
  });

  it('fails closed when resolved configuration cannot be read', async () => {
    for (const config of [
      { out: 'configuration error: invalid JSON', code: 1 },
      { out: 'not a resolved configuration', code: 0 },
      { out: '[]', code: 0 },
      { out: '[1, 2]', code: 0 },
      { out: '[{"type": "document", "path": "/x"}, "text"]', code: 0 },
      { out: '[{"type": "directory", "path": "/home/u/.config/opencode"}]', code: 0 },
    ]) {
      const s = scripted({ config, lists: [CONNECTED] });
      await expect(runOpenCodeTask('task', { cwd: '/p' }, s.deps))
        .rejects.toMatchObject({ name: 'McpNotReadyError', reason: 'config-error' });
      expect(s.taskCalls()).toHaveLength(0);
      expect(s.serverStarted()).toBe(false);
    }
  });
});

const posix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

/** The fake runtime shared with the Python tests: real server, real CLI, real impostor child. */
const ADVERSARY = fileURLToPath(new URL('../../../../backend/tests/fixtures/gate_adversary.py', import.meta.url));

/**
 * Install backend/tests/fixtures/gate_adversary.py as `runtime` in `dir`.
 * wrapper undefined: exec'd directly (the spawned process is the server);
 * 'node': an npm-style node launcher in front (as Kilo's bin/kilo);
 * 'node-two': a launcher that starts two processes (ambiguous).
 */
function installAdversary(dir: string, runtime: 'opencode' | 'kilo', cfg: Record<string, unknown> = {}, wrapper?: 'node' | 'node-two') {
  writeFileSync(path.join(dir, 'adv.json'), JSON.stringify({ dir, runtime, ...cfg }));
  const bin = path.join(dir, runtime);
  const env = `GATE_ADVERSARY=${JSON.stringify(path.join(dir, 'adv.json'))}`;
  if (!wrapper) {
    writeFileSync(bin, `#!/bin/sh\n${env} exec python3 ${JSON.stringify(ADVERSARY)} "$@"\n`);
  } else {
    const extra = wrapper === 'node-two' ? "spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], { stdio: 'ignore' });" : '';
    writeFileSync(bin, `#!${process.execPath}
const { spawn } = require('child_process');
process.env.GATE_ADVERSARY = ${JSON.stringify(path.join(dir, 'adv.json'))};
${extra}
const child = spawn('python3', [${JSON.stringify(ADVERSARY)}, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
child.on('exit', (code) => process.exit(code ?? 0));
`);
  }
  chmodSync(bin, 0o755);
}

/** The real server received the task, only after answering status requests, and every request it saw was authorised. */
function taskAfterConnected(dir: string): boolean {
  if (!existsSync(path.join(dir, 'task.json'))) return false;
  const log = readFileSync(path.join(dir, 'server.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return log[log.length - 1].path.endsWith('/task') && log.slice(0, -1).some((e) => e.path.endsWith('/mcp')) && log.every((e) => e.auth_ok);
}

describe.skipIf(!posix)('runOpenCodeTask with a real process (POSIX)', () => {
  let dir: string;
  let oldPath: string | undefined;
  const strays: number[] = [];

  /** A stand-in OpenCode: its MCP client "connects" `delay` seconds after serve starts, or never. */
  const install = (delay: number | 'never') => installAdversary(dir, 'opencode', { connect_delay: delay === 'never' ? null : delay });
  const pidOf = (name: string) => Number(readFileSync(path.join(dir, name), 'utf8').trim());

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aura-ocmcp-'));
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the task after a delayed connection and leaves no process behind', async () => {
    install(2);
    const res = await runOpenCodeTask('do the work', { cwd: dir });
    expect(res).toMatchObject({ mcp: 'connected', code: 0 });
    expect(taskAfterConnected(dir)).toBe(true);
    const server = pidOf('server.pid');
    const grandchild = pidOf('grandchild.pid');
    strays.push(server, grandchild);
    expect(await until(() => !alive(server) && !alive(grandchild))).toBe(true);
  }, 30_000);

  it('times out without sending the task and leaves no process behind', async () => {
    install('never');
    const err = await runOpenCodeTask('do the work', { cwd: dir, readyTimeoutMs: 1_500 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('timeout');
    expect(existsSync(path.join(dir, 'task.json'))).toBe(false);
    const server = pidOf('server.pid');
    const grandchild = pidOf('grandchild.pid');
    strays.push(server, grandchild);
    expect(await until(() => !alive(server) && !alive(grandchild))).toBe(true);
  }, 30_000);

  it('cancellation while waiting sends nothing and leaves no process behind', async () => {
    install('never');
    const ac = new AbortController();
    const pending = runOpenCodeTask('do the work', { cwd: dir, signal: ac.signal }).catch((e) => e);
    await until(() => existsSync(path.join(dir, 'grandchild.pid')) && readFileSync(path.join(dir, 'grandchild.pid'), 'utf8').trim() !== '');
    ac.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('cancelled');
    expect(existsSync(path.join(dir, 'task.json'))).toBe(false);
    const server = pidOf('server.pid');
    const grandchild = pidOf('grandchild.pid');
    strays.push(server, grandchild);
    expect(await until(() => !alive(server) && !alive(grandchild))).toBe(true);
  }, 30_000);
});

// ══ Kilo: the same gate with Kilo's runtime profile ══════════════════════════
//
// Kilo 7.5.14 (measured): servers are declared under `mcp.<name>`; a private
// `kilo serve` is protected by KILO_SERVER_PASSWORD; its GET /mcp answers, once
// each handshake has settled, with structured JSON; the task is sent with
// `kilo run --attach <url>`. A dropped connection is reported at once and not
// restored by Kilo itself, so exactly one reconnect is asked for before giving up.
// Kept case-for-case identical to backend/tests/unit/test_opencode_mcp_gate.py.

const KILO_CONFIGURED = JSON.stringify({ mcp: { 'common-context': { type: 'local', command: ['common-context-mcp'] } } });
const KILO_NOT_CONFIGURED = JSON.stringify({ mcp: { other: { type: 'local' } } });
const KILO_DISABLED = JSON.stringify({ mcp: { 'common-context': { type: 'local', enabled: false } } });
const KILO_TASK = ['run', '--dir', '/p', '--auto', 'do the work'];
type Answer = { status: number; body: string };
const mcp = (status: string, error = ''): Answer => ({ status: 200, body: JSON.stringify({ 'common-context': { status, ...(error ? { error } : {}) } }) });
const K_CONNECTED = mcp('connected');
const K_UNAVAILABLE = mcp('failed', "ENOENT: no such file or directory, posix_spawn '/x/common-context-mcp'");
const K_HANDSHAKE_TIMEOUT = mcp('failed', 'Operation timed out after 30000ms');
const K_LOST = mcp('failed', 'Connection closed');
/** What fetch actually throws when nothing is listening yet / a request times out or is aborted. */
const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

interface KiloScript {
  config?: ProcessOutput;
  /** One GET /mcp answer per call (the last repeats); an Error is thrown, a function is awaited. */
  gets: Array<Answer | Error | ((signal?: AbortSignal) => Promise<Answer>)>;
  serverExitsAfterGets?: number;
  reconnectOk?: boolean;
  onGet?: (call: number) => void;
  /** Reads of the server's stdout before it announces its address (null: never). */
  announceAfter?: number | null;
}

function kiloScripted(script: KiloScript) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const requests: Array<[string, string]> = [];
  const passwords = new Set<string>();
  let gets = script.gets;
  let getCalls = 0;
  let outputReads = 0;
  let clock = 0;
  let stopped = 0;
  let serverStarted = false;
  let serverArgs: string[] = [];
  let serverEnv: Record<string, string> | undefined;
  const server: AgentServer = {
    pid: 4343,
    log: () => 'level=ERROR message="mcp transport error" server=common-context',
    output: () => {
      outputReads += 1;
      if (script.announceAfter === null || outputReads <= (script.announceAfter ?? 0)) return 'INFO starting\n';
      return 'kilo server listening on http://127.0.0.1:45679\n';
    },
    exited: () => script.serverExitsAfterGets !== undefined && getCalls >= script.serverExitsAfterGets,
    stop: async () => { stopped += 1; },
  };
  const deps: OpenCodeMcpDeps = {
    run: async (args, opts) => {
      calls.push(args);
      envs.push(opts.env);
      if (args[0] === 'debug' && args[1] === 'config') return script.config ?? ok(KILO_CONFIGURED);
      return ok('task finished');
    },
    startServer: (args, opts) => { serverStarted = true; serverArgs = args; serverEnv = opts.env; return server; },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    password: () => 'one-time-kilo-test-password-0123456789',
    endpoints: announcedEndpoints,
    http: async (method, url, password, opts) => {
      requests.push([method, url]);
      passwords.add(password);
      if (method === 'POST') {
        if (script.reconnectOk ?? true) { gets = [K_CONNECTED]; getCalls = 0; }
        return { status: 200, body: 'true' };
      }
      script.onGet?.(getCalls);
      const reply = gets[Math.min(getCalls, gets.length - 1)];
      getCalls += 1;
      if (reply instanceof Error) { clock += 1_000; throw reply; }
      if (typeof reply === 'function') return reply(opts.signal);
      return reply;
    },
  };
  const taskCalls = () => calls.filter((a) => a[0] === 'run');
  return {
    deps, calls, envs, requests, passwords, taskCalls,
    stopped: () => stopped, serverStarted: () => serverStarted,
    serverArgs: () => serverArgs, serverEnv: () => serverEnv, getCalls: () => getCalls, outputReads: () => outputReads,
  };
}

describe('reading Kilo output', () => {
  it('finds the server only in its own runtime layout', () => {
    expect(configDeclaresServer(KILO_CONFIGURED, 'common-context', 'kilo')).toBe(true);
    expect(configDeclaresServer(KILO_NOT_CONFIGURED, 'common-context', 'kilo')).toBe(false);
    expect(configDeclaresServer(KILO_DISABLED, 'common-context', 'kilo')).toBe(false);
    // Each runtime reads only its own layout, so OpenCode's detection is unchanged.
    expect(configDeclaresServer(KILO_CONFIGURED)).toBe(false);
    expect(configDeclaresServer(CONFIGURED, 'common-context', 'kilo')).toBe(false);
  });

  it('reads the GET /mcp answer', () => {
    expect(kiloStatus(K_CONNECTED.status, K_CONNECTED.body)).toEqual({ state: 'connected', detail: 'connected' });
    expect(kiloStatus(K_UNAVAILABLE.status, K_UNAVAILABLE.body).state).toBe('failed');
    expect(kiloStatus(K_HANDSHAKE_TIMEOUT.status, K_HANDSHAKE_TIMEOUT.body)).toEqual({ state: 'failed', detail: 'failed: Operation timed out after 30000ms' });
    expect(kiloStatus(401, '').state).toBe('failed');
    expect(kiloStatus(503, '').state).toBe('pending');
    expect(kiloStatus(200, 'not json').state).toBe('pending');
    expect(kiloStatus(200, JSON.stringify({ other: { status: 'connected' } })).state).toBe('pending');
    expect(kiloStatus(mcp('disabled').status, mcp('disabled').body).state).toBe('failed');
  });

  it('attaches the task argv and keeps its directory', () => {
    expect(kiloGatedArgs(KILO_TASK, 'http://127.0.0.1:1')).toEqual(['run', '--attach', 'http://127.0.0.1:1', '--dir', '/p', '--auto', 'do the work']);
  });
});

describe('runKiloTask', () => {
  it('sends the task through --attach once connected, with the password only in env', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED] });
    const res = await runKiloTask(KILO_TASK, { cwd: '/p', env: { KILO_CONFIG: '/aura/kilo.jsonc', KEEP: '1' } }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(res.args).toEqual(['run', '--attach', 'http://127.0.0.1:45679', '--dir', '/p', '--auto', 'do the work']);
    expect(s.taskCalls()).toEqual([res.args]);
    const password = s.envs.at(-1)?.KILO_SERVER_PASSWORD;
    expect(password).toBe('one-time-kilo-test-password-0123456789');
    expect([...s.passwords]).toEqual([password]);
    // Never on any command line, never `--pure` (it would disable the governance plugin).
    expect([...s.calls, s.serverArgs()].flat().some((a) => a.includes(password!))).toBe(false);
    expect([...s.calls, s.serverArgs()].some((c) => c.includes('--pure'))).toBe(false);
    // The private server runs with the task's exact environment (KILO_CONFIG, plugin).
    expect(s.serverEnv()).toEqual({ KILO_CONFIG: '/aura/kilo.jsonc', KEEP: '1', KILO_SERVER_PASSWORD: password });
    expect(s.calls[0]).toEqual(['debug', 'config']);
    expect(s.requests[0]).toEqual(['GET', 'http://127.0.0.1:45679/mcp']);
    expect(s.stopped()).toBe(1);
  });

  it('waits while its server is not listening yet and sends the task last', async () => {
    const order: string[] = [];
    const s = kiloScripted({ gets: [netError('ECONNREFUSED'), netError('ECONNREFUSED'), K_CONNECTED], onGet: (n) => order.push(`get${n}`) });
    const run = s.deps.run;
    s.deps.run = async (args, opts) => { if (args[0] === 'run') order.push('task'); return run(args, opts); };
    const res = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(order.at(-1)).toBe('task');
    expect(order.filter((o) => o === 'task')).toHaveLength(1);
  });

  for (const [reply, needle] of [
    [K_UNAVAILABLE, 'ENOENT'],
    [K_HANDSHAKE_TIMEOUT, 'Operation timed out after 30000ms'],
    [{ status: 401, body: '' }, 'refused its one-time credentials'],
  ] as const) {
    it(`does not send the task when Common Context is unavailable (${needle})`, async () => {
      const s = kiloScripted({ gets: [reply] });
      const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
      expect(err).toBeInstanceOf(McpNotReadyError);
      expect(err.reason).toBe('failed');
      expect(err.message).toContain(needle);
      expect(s.taskCalls()).toHaveLength(0);
      expect(s.stopped()).toBe(1);
    });
  }

  it('times out without sending the task when no answer arrives within the deadline', async () => {
    const s = kiloScripted({ gets: [timeoutError()] });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p', readyTimeoutMs: 2_000 }, s.deps).catch((e) => e);
    expect(err.reason).toBe('timeout');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('does not treat a running server as connectivity when it exits first', async () => {
    const s = kiloScripted({ gets: [netError('ECONNREFUSED')], serverExitsAfterGets: 2 });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('server-exited');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('reconnects exactly once when the connection is lost before sending, then sends', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED, K_LOST] });
    const res = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(s.requests.filter(([m]) => m === 'POST')).toEqual([['POST', 'http://127.0.0.1:45679/mcp/common-context/connect']]);
    expect(s.taskCalls()).toHaveLength(1);
    // The reconnect was confirmed by a fresh read before the task went.
    expect(s.requests.at(-1)).toEqual(['GET', 'http://127.0.0.1:45679/mcp']);
  });

  it('does not send the task when the one reconnect fails', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED, K_LOST], reconnectOk: false });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('lost');
    expect(err.message).toContain('Connection closed');
    expect(s.requests.filter(([m]) => m === 'POST')).toHaveLength(1);
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('never retries an initial failure', async () => {
    const s = kiloScripted({ gets: [K_UNAVAILABLE, K_CONNECTED] });
    await expect(runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps)).rejects.toBeInstanceOf(McpNotReadyError);
    expect(s.requests.map(([m]) => m)).toEqual(['GET']);
    expect(s.taskCalls()).toHaveLength(0);
  });

  it('sends nothing and starts nothing when cancelled before it begins', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = kiloScripted({ gets: [K_CONNECTED] });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    expect(err.reason).toBe('cancelled');
    expect(s.calls).toHaveLength(0);
    expect(s.serverStarted()).toBe(false);
  });

  it('stops waiting on a blocked status request when cancelled, sends nothing and cleans up', async () => {
    const ac = new AbortController();
    // Kilo's GET /mcp blocks until the handshake settles; only the abort ends it here.
    const blocked = (signal?: AbortSignal) => new Promise<Answer>((_, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    const s = kiloScripted({ gets: [blocked] });
    const pending = runKiloTask(KILO_TASK, { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    await until(() => s.getCalls() > 0);
    ac.abort();
    const err = await pending;
    expect(err.reason).toBe('cancelled');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('sends nothing when cancelled before the reconnect', async () => {
    const ac = new AbortController();
    const s = kiloScripted({ gets: [K_CONNECTED, K_LOST], onGet: (n) => { if (n === 1) ac.abort(); } });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    expect(err.reason).toBe('cancelled');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  for (const [label, config] of [['not configured', KILO_NOT_CONFIGURED], ['explicitly disabled', KILO_DISABLED]] as const) {
    it(`runs exactly as before when Common Context is ${label}`, async () => {
      const s = kiloScripted({ config: ok(config), gets: [K_CONNECTED] });
      const res = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps);
      expect(res.mcp).toBe('not-configured');
      expect(res.args).toEqual(KILO_TASK);
      expect(s.calls.at(-1)).toEqual(KILO_TASK);
      expect(s.serverStarted()).toBe(false);
      expect(s.requests).toHaveLength(0);
    });
  }

  it('fails closed when resolved configuration cannot be read', async () => {
    for (const config of [
      { out: 'invalid configuration', code: 1 },
      { out: 'not JSON', code: 0 },
      { out: '[]', code: 0 },
      { out: '[1, 2]', code: 0 },
    ]) {
      const s = kiloScripted({ config, gets: [K_CONNECTED] });
      await expect(runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps))
        .rejects.toMatchObject({ name: 'McpNotReadyError', reason: 'config-error' });
      expect(s.taskCalls()).toHaveLength(0);
      expect(s.serverStarted()).toBe(false);
    }
  });
});

describe.skipIf(!posix)('runKiloTask with a real process (POSIX)', () => {
  let dir: string;
  let oldPath: string | undefined;
  const strays: number[] = [];

  /** A stand-in Kilo 7.5.14: real HTTP GET /mcp behind KILO_SERVER_PASSWORD; connects after `delay` s, or never. */
  const install = (mode: 'delayed' | 'never', delay = 0) => installAdversary(dir, 'kilo', { connect_delay: mode === 'never' ? null : delay });
  const pidOf = (name: string) => Number(readFileSync(path.join(dir, name), 'utf8').trim());
  const bothGone = async () => {
    const server = pidOf('server.pid');
    const grandchild = pidOf('grandchild.pid');
    strays.push(server, grandchild);
    return until(() => !alive(server) && !alive(grandchild));
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aura-kilomcp-'));
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the task after a delayed connection and leaves no process behind', async () => {
    install('delayed', 1.5);
    const res = await runKiloTask(['run', '--dir', dir, 'do the work'], { cwd: dir });
    expect(res).toMatchObject({ mcp: 'connected', code: 0 });
    const record = JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8'));
    expect(taskAfterConnected(dir)).toBe(true);
    expect(record.password_in_env).toBe(true);
    expect(record.argv.slice(0, 2)).toEqual(['run', '--attach']);
    expect(record.argv.slice(3, 5)).toEqual(['--dir', dir]);
    expect(record.argv).not.toContain('--pure');
    expect(JSON.parse(readFileSync(path.join(dir, 'serve-args.json'), 'utf8'))).not.toContain('--pure');
    expect(await bothGone()).toBe(true);
  }, 30_000);

  it('times out without sending the task and leaves no process behind', async () => {
    install('never');
    const err = await runKiloTask(['run', '--dir', dir, 'x'], { cwd: dir, readyTimeoutMs: 2_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('timeout');
    expect(existsSync(path.join(dir, 'task.json'))).toBe(false);
    expect(await bothGone()).toBe(true);
  }, 30_000);

  it('cancellation while waiting sends nothing and leaves no process behind', async () => {
    install('never');
    const ac = new AbortController();
    const pending = runKiloTask(['run', '--dir', dir, 'x'], { cwd: dir, signal: ac.signal }).catch((e) => e);
    await until(() => existsSync(path.join(dir, 'grandchild.pid')) && readFileSync(path.join(dir, 'grandchild.pid'), 'utf8').trim() !== '');
    await sleep(300);
    ac.abort();
    const err = await pending;
    expect(err.reason).toBe('cancelled');
    expect(existsSync(path.join(dir, 'task.json'))).toBe(false);
    expect(await bothGone()).toBe(true);
  }, 30_000);
});

// ══ Review findings: regression tests (case-for-case with the Python gate) ══

describe('M1: the address comes only from the server AURA started', () => {
  it('reads only loopback announcements in the runtime\'s own words', () => {
    expect(announcedPorts('kilo server listening on http://127.0.0.1:39637\n', 'kilo')).toEqual(new Set([39637]));
    expect(announcedPorts('server listening on http://127.0.0.1:39091', 'opencode')).toEqual(new Set([39091]));
    expect(announcedPorts('INFO boot\n\u001b[32mkilo server listening on http://127.0.0.1:5\u001b[0m\n', 'kilo')).toEqual(new Set([5]));
    expect(announcedPorts('server listening on http://127.0.0.1:1\r\n', 'opencode')).toEqual(new Set([1]));
    expect(announcedPorts('kilo server listening on http://127.0.0.1:65535\r\n', 'kilo')).toEqual(new Set([65535]));
    for (const text of ['server listening on http://0.0.0.0:4096', 'server listening on http://192.0.2.7:4096',
      'server listening on http://127.0.0.1:0', 'server listening on http://127.0.0.1:65536',
      'server listening on http://127.0.0.1.evil:80', 'plugin: server listening on http://127.0.0.1:9',
      '\tserver listening on http://127.0.0.1:9', 'opencode server listening on http://127.0.0.1:9',
      'kilo server listening on http://127.0.0.1:9', 'starting', '']) {
      expect(announcedPorts(text, 'opencode'), text).toEqual(new Set());
    }
    expect(announcedPorts('server listening on http://127.0.0.1:9', 'kilo')).toEqual(new Set());
    // Several announcements are all reported; which one is real is decided by the OS, not by the text.
    expect(announcedPorts('kilo server listening on http://127.0.0.1:7\nkilo server listening on http://127.0.0.1:8\n', 'kilo'))
      .toEqual(new Set([7, 8]));
  });

  it('lets both runtimes choose their own port, and never uses --pure', () => {
    expect(OPENCODE_SERVE_ARGS[OPENCODE_SERVE_ARGS.indexOf('--port') + 1]).toBe('0');
    expect(KILO_SERVE_ARGS[KILO_SERVE_ARGS.indexOf('--port') + 1]).toBe('0');
    expect(KILO_SERVE_ARGS).not.toContain('--pure');
  });

  it('waits for the Kilo server to announce itself and talks only to that address', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED], announceAfter: 3 });
    const res = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps);
    expect(res.mcp).toBe('connected');
    expect(s.outputReads()).toBeGreaterThanOrEqual(4);
    expect(new Set(s.requests.map(([, u]) => u))).toEqual(new Set(['http://127.0.0.1:45679/mcp']));
    expect(res.args.slice(0, 3)).toEqual(['run', '--attach', 'http://127.0.0.1:45679']);
    expect(s.serverArgs()).toEqual(KILO_SERVE_ARGS);
  });

  it('times out without a single request when the Kilo server never announces itself', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED], announceAfter: null });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p', readyTimeoutMs: 2_000 }, s.deps).catch((e) => e);
    expect(err.reason).toBe('timeout');
    expect(err.message).toContain('not listening yet');
    expect(s.requests).toHaveLength(0);
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('times out without probing when the OpenCode server never announces itself', async () => {
    const s = scripted({ lists: [CONNECTED], announce: false });
    const err = await runOpenCodeTask('task', { cwd: '/p', readyTimeoutMs: 2_000 }, s.deps).catch((e) => e);
    expect(err.reason).toBe('timeout');
    expect(s.listCalls()).toBe(0);
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });
});

describe('M2: a refused delegation records why', () => {
  it('returns a refusal whose output names the readiness reason', () => {
    const result = contextRefusal(new McpNotReadyError('lost', 'Kilo lost Common Context; the task was not sent.'),
      { nodeId: 'kilo-code', name: 'Kilo Code' }, ['run', '--dir', '/p', 't']);
    expect(result).toEqual({
      ok: false,
      detail: 'Kilo lost Common Context; the task was not sent.',
      output: { nodeId: 'kilo-code', agent: 'Kilo Code', args: ['run', '--dir', '/p', 't'], contextMcp: 'not-ready:lost' },
    });
  });
});

describe('M3: a server that cannot start is a clean refusal', () => {
  it('reports launch-failed and sends nothing', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED] });
    s.deps.startServer = () => { throw new Error("'kilo' is not on the coding-agent allow-list"); };
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotReadyError);
    expect(err.reason).toBe('launch-failed');
    expect(s.taskCalls()).toHaveLength(0);
  });
});

describe('M4: a Kilo without `debug config`', () => {
  for (const [out, code] of [['Error: Unknown command: debug', 1], ['error: unknown arguments: debug, config', 1]] as const) {
    it(`is refused and names the verified version (${out})`, async () => {
      const s = kiloScripted({ config: { out, code }, gets: [K_CONNECTED] });
      const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
      expect(err.reason).toBe('config-error');
      expect(err.message).toContain('7.5.14');
      expect(s.taskCalls()).toHaveLength(0);
      expect(s.serverStarted()).toBe(false);
    });
  }

  it('leaves the OpenCode config-error wording unchanged', async () => {
    const s = scripted({ config: { out: 'Error: Unknown command: debug', code: 1 }, lists: [CONNECTED] });
    const err = await runOpenCodeTask('task', { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.message).toBe("Could not read OpenCode's resolved configuration (exit 1); the task was not sent.");
  });
});

describe('L1/L2: cancellation and server exit are named for what they are', () => {
  it('reports cancellation during the confirming read after a reconnect as cancelled', async () => {
    const ac = new AbortController();
    const s = kiloScripted({ gets: [K_CONNECTED, K_LOST], reconnectOk: false, onGet: (n) => { if (n === 2) ac.abort(); } });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p', signal: ac.signal }, s.deps).catch((e) => e);
    expect(err.reason).toBe('cancelled');
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });

  it('reports a Kilo server that exits after verification as server-exited, not lost', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED], serverExitsAfterGets: 1 });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('server-exited');
    expect(s.requests.map(([m]) => m)).toEqual(['GET']);
    expect(s.taskCalls()).toHaveLength(0);
  });

  it('reports a Kilo server that exits before the reconnect as server-exited', async () => {
    const s = kiloScripted({ gets: [K_CONNECTED, K_LOST], reconnectOk: false, serverExitsAfterGets: 2 });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('server-exited');
    expect(s.requests.map(([m]) => m)).not.toContain('POST');
    expect(s.taskCalls()).toHaveLength(0);
  });

  it('never sends an OpenCode task to a server that exited after connecting', async () => {
    const s = scripted({ lists: [CONNECTED], serverExitsAfterLists: 1 });
    const err = await runOpenCodeTask('task', { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err.reason).toBe('server-exited');
    expect(s.taskCalls()).toHaveLength(0);
  });
});

describe('L3/L5: bounded bodies, and errors that are not hidden', () => {
  it('reads a response body only up to the limit', async () => {
    const big = 'x'.repeat(HTTP_BODY_LIMIT + 5_000);
    expect((await readBounded(new Response(big), HTTP_BODY_LIMIT)).length).toBe(HTTP_BODY_LIMIT);
    expect(await readBounded(new Response('{"a":1}'), HTTP_BODY_LIMIT)).toBe('{"a":1}');
    expect(await readBounded(new Response(null), HTTP_BODY_LIMIT)).toBe('');
  });

  it('treats only network failures, timeouts and aborts as "not ready yet"', () => {
    expect(isTransportError(netError('ECONNREFUSED'))).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransportError(timeoutError())).toBe(true);
    expect(isTransportError(abortError())).toBe(true);
    expect(isTransportError(new TypeError("Cannot read properties of undefined (reading 'status')"))).toBe(false);
    expect(isTransportError(new RangeError('bug'))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });

  it('does not hide a programming error while reading status as "not ready"', async () => {
    const s = kiloScripted({ gets: [new RangeError('bug')] });
    const err = await runKiloTask(KILO_TASK, { cwd: '/p' }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(s.taskCalls()).toHaveLength(0);
    expect(s.stopped()).toBe(1);
  });
});

// ══ The security boundary: adversarial real-process tests ═══════════════════
//
// The production gate (VerifiedEndpoints: the AURA-owned relay that forwards a
// connection only after the OS shows the server side of that exact connection
// held by the server process AURA started) against
// backend/tests/fixtures/gate_adversary.py — the same adversary the Python
// tests face: a real server, a real CLI and a real impostor child that
// inherits the server's environment (it knows the one-time password), shares
// its stdout (it prints exact announcements) and speaks the full protocol. The
// impostor records every byte it ever receives. Each scenario runs with the
// Linux /proc method and with the lsof method macOS uses.

const linux = process.platform === 'linux';
const haveLsof = posix && spawnSync('lsof', ['-v']).error === undefined && spawnSync('ps', ['-o', 'pid=']).error === undefined;
const BACKENDS: Array<'procfs' | 'lsof'> = [...(linux ? ['procfs' as const] : []), ...(haveLsof ? ['lsof' as const] : [])];
const SECRET_TASK = 'the secret task text';
const backendOf = (name: 'procfs' | 'lsof'): IdentityBackend => (name === 'procfs' ? new Procfs() : new Lsof());

function impostorTraffic(dir: string): { accepted: number; bytes: number; text: string } {
  const file = path.join(dir, 'impostor.log');
  if (!existsSync(file)) return { accepted: 0, bytes: 0, text: '' };
  const entries = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    accepted: entries.filter((e) => e.accepted).length,
    bytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0),
    text: entries.map((e) => e.text ?? '').join(''),
  };
}

/** No process started for this test (its environment names the test's directory) is still alive. */
async function noProcessLeft(dir: string): Promise<boolean> {
  if (!linux) return true;
  const left = () => readdirSync('/proc').filter((e) => /^\d+$/.test(e) && Number(e) !== process.pid).filter((e) => {
    try { return readFileSync(`/proc/${e}/environ`).includes(dir); } catch { return false; }
  });
  return until(() => left().length === 0);
}

function gate(runtime: 'opencode' | 'kilo', dir: string, backend: IdentityBackend | null, extra: { readyTimeoutMs?: number; signal?: AbortSignal } = {}) {
  // Never let a test reach a real runtime: the fake must be what PATH resolves first.
  const first = path.join((process.env.PATH ?? '').split(path.delimiter)[0], runtime);
  if (!existsSync(first) || !readFileSync(first, 'utf8').includes('gate_adversary.py')) {
    throw new Error(`refusing to run: ${runtime} on PATH is not the test adversary`);
  }
  const swap = backend ? { endpoints: new VerifiedEndpoints(backend) } : {};
  return runtime === 'kilo'
    ? runKiloTask(['run', '--dir', dir, SECRET_TASK], { cwd: dir, ...extra }, { ...kiloDeps, ...swap })
    : runOpenCodeTask(SECRET_TASK, { cwd: dir, ...extra }, { ...defaultDeps, ...swap });
}

describe.skipIf(!posix || BACKENDS.length === 0)('the security boundary against a real adversary (POSIX)', () => {
  let dir: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aura-gate-adv-'));
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    await noProcessLeft(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const exists = (name: string) => existsSync(path.join(dir, name));
  const read = (name: string) => readFileSync(path.join(dir, name), 'utf8');
  const nothingReachedTheImpostor = () => {
    const t = impostorTraffic(dir);
    return t.bytes === 0 && !t.text.includes(SECRET_TASK);
  };

  for (const backend of BACKENDS) {
    for (const runtime of ['opencode', 'kilo'] as const) {
      it(`[${runtime}/${backend}] a forged announcement before the real one never reaches the impostor`, async () => {
        installAdversary(dir, runtime, { attack: 'forge_first', attack_delay: 1.0 });
        const res = await gate(runtime, dir, backendOf(backend), { readyTimeoutMs: 15_000 });
        expect(res).toMatchObject({ mcp: 'connected', code: 0 });
        expect(exists('impostor.port')).toBe(true);           // the attack really ran
        expect(taskAfterConnected(dir)).toBe(true);           // the task reached the real server
        expect(impostorTraffic(dir)).toMatchObject({ accepted: 0, bytes: 0 });
        expect(await noProcessLeft(dir)).toBe(true);
      }, 30_000);

      it(`[${runtime}/${backend}] port reuse between a check and a connection delivers nothing`, async () => {
        installAdversary(dir, runtime, { attack: 'port_reuse_after', after_gets: 1, connect_delay: 1.0 });
        const err = await gate(runtime, dir, backendOf(backend), { readyTimeoutMs: 15_000 }).catch((e) => e);
        expect(err).toBeInstanceOf(McpNotReadyError);
        expect(err.reason).toBe('unverified-server');
        expect(read('impostor.port')).toBe(read('server.port'));
        expect(exists('task.json')).toBe(false);
        expect(nothingReachedTheImpostor()).toBe(true);
        expect(await noProcessLeft(dir)).toBe(true);
      }, 30_000);
    }

    it(`[kilo/${backend}] a reconnect cannot reach a different listener`, async () => {
      installAdversary(dir, 'kilo', { lose_once: true, attack: 'port_reuse_after', after_gets: 2 });
      const err = await gate('kilo', dir, backendOf(backend), { readyTimeoutMs: 15_000 }).catch((e) => e);
      expect(err.reason).toBe('unverified-server');
      expect(read('server.log')).not.toContain('/connect');   // the reconnect never reached anyone
      expect(exists('task.json')).toBe(false);
      expect(nothingReachedTheImpostor()).toBe(true);
    }, 30_000);

    it(`[kilo/${backend}] a dual-stack server is verified through its IPv4-mapped socket`, async () => {
      installAdversary(dir, 'kilo', { dual_stack: true });
      const res = await gate('kilo', dir, backendOf(backend));
      expect(res.mcp).toBe('connected');
      expect(taskAfterConnected(dir)).toBe(true);
    }, 30_000);
  }

  const main = BACKENDS[0];

  for (const runtime of ['opencode', 'kilo'] as const) {
    it(`[${runtime}] a forged announcement after the real one is ignored`, async () => {
      installAdversary(dir, runtime, { attack: 'forge_late', connect_delay: 0.5 });
      const res = await gate(runtime, dir, backendOf(main));
      expect(res.mcp).toBe('connected');
      expect(taskAfterConnected(dir)).toBe(true);
      expect(impostorTraffic(dir)).toMatchObject({ accepted: 0, bytes: 0 });
    }, 30_000);

    it(`[${runtime}] an SO_REUSEPORT hijacker on the same port gets no byte`, async () => {
      installAdversary(dir, runtime, { attack: 'reuseport', connect_delay: 0.5 });
      for (let round = 0; round < 3; round++) {
        for (const name of ['task.json', 'impostor.log', 'server.log', 'impostor.port']) rmSync(path.join(dir, name), { force: true });
        const outcome = await gate(runtime, dir, backendOf(main)).catch((e) => e);
        if (outcome instanceof Error) expect((outcome as McpNotReadyError).reason).toBe('unverified-server');
        expect(read('impostor.port')).toBe(read('server.port'));
        expect(nothingReachedTheImpostor()).toBe(true);
        expect(await noProcessLeft(dir)).toBe(true);
      }
    }, 60_000);

    it(`[${runtime}] cancellation while identifying the server sends nothing and cleans up`, async () => {
      installAdversary(dir, runtime, { attack: 'no_listen' });
      const ac = new AbortController();
      const pending = gate(runtime, dir, backendOf(main), { signal: ac.signal }).catch((e) => e);
      await until(() => exists('grandchild.pid'));
      await sleep(300);
      ac.abort();
      const err = await pending;
      expect(err.reason).toBe('cancelled');
      expect(exists('task.json')).toBe(false);
      expect(await noProcessLeft(dir)).toBe(true);
    }, 30_000);
  }

  it.each([[undefined], ['forge_first']])('follows an npm node launcher to the one server it starts (attack: %s)', async (attack) => {
    installAdversary(dir, 'kilo', { attack, attack_delay: 1.0 }, 'node');
    const res = await gate('kilo', dir, backendOf(main), { readyTimeoutMs: 15_000 });
    expect(res.mcp).toBe('connected');
    expect(taskAfterConnected(dir)).toBe(true);
    expect(impostorTraffic(dir)).toMatchObject({ accepted: 0, bytes: 0 });
  }, 30_000);

  it('refuses a launcher that starts more than one process', async () => {
    installAdversary(dir, 'kilo', {}, 'node-two');
    const err = await gate('kilo', dir, backendOf(main), { readyTimeoutMs: 10_000 }).catch((e) => e);
    expect(err.reason).toBe('unverified-server');
    expect(err.message).toContain('cannot be identified');
    expect(exists('server.log') || exists('task.json')).toBe(false);
  }, 30_000);

  it('never contacts an IPv6-only listener', async () => {
    installAdversary(dir, 'kilo', { ipv6_only: true });
    const err = await gate('kilo', dir, backendOf(main), { readyTimeoutMs: 2_000 }).catch((e) => e);
    expect(err.reason).toBe('timeout');
    expect(err.message).toContain('not listening');
    expect(exists('server.log') || exists('task.json')).toBe(false);
  }, 30_000);

  it('reports a server that dies while receiving the task, and cleans up', async () => {
    installAdversary(dir, 'kilo', { exit_on_task: true });
    const res = await gate('kilo', dir, backendOf(main));
    expect(res.mcp).toBe('connected');
    expect(res.code).not.toBe(0);                       // the CLI saw the server go away
    expect(exists('task.json')).toBe(true);             // it reached only the real server
    expect(impostorTraffic(dir)).toMatchObject({ accepted: 0, bytes: 0 });
  }, 30_000);

  it.skipIf(!linux)('refuses the run when socket ownership cannot be read', async () => {
    class Denied extends Procfs {
      override async listenPorts(): Promise<Set<number>> { throw new IdentityUnavailable('the sockets of process 1 cannot be inspected'); }
    }
    installAdversary(dir, 'kilo');
    const err = await gate('kilo', dir, new Denied()).catch((e) => e);
    expect(err.reason).toBe('identity-unavailable');
    expect(exists('server.log') || exists('task.json')).toBe(false);
  }, 30_000);
});

describe('a platform without socket-ownership verification', () => {
  it('refuses before starting anything, for both runtimes', async () => {
    const o = scripted({ lists: [CONNECTED] });
    const err = await runOpenCodeTask('t', { cwd: '/p' }, { ...o.deps, endpoints: new VerifiedEndpoints(defaultBackend('win32')) }).catch((e) => e);
    expect(err.reason).toBe('identity-unavailable');
    expect(err.message).toContain('win32');
    expect(o.serverStarted()).toBe(false);
    const k = kiloScripted({ gets: [K_CONNECTED] });
    const kerr = await runKiloTask(KILO_TASK, { cwd: '/p' }, { ...k.deps, endpoints: new VerifiedEndpoints(defaultBackend('win32')) }).catch((e) => e);
    expect(kerr.reason).toBe('identity-unavailable');
    expect(k.serverStarted()).toBe(false);
    expect(k.requests).toHaveLength(0);
  });

  it('reports missing lsof as unavailable, never as verified', async () => {
    expect((await new Lsof(null, null).available()).ok).toBe(false);
    expect((await new Lsof('/nonexistent/lsof', 'ps').available()).ok).toBe(false);
  });
});

describe.skipIf(!posix || BACKENDS.length === 0)('identity primitives against real processes and sockets', () => {
  for (const backend of BACKENDS) {
    it(`[${backend}] names exactly the process holding the server side of a connection`, async () => {
      const b = backendOf(backend);
      const child = spawn('python3', ['-c', "import socket,time;s=socket.socket();s.bind(('127.0.0.1',0));s.listen(8);print(s.getsockname()[1],flush=True);c=s.accept()[0];time.sleep(30)"]);
      try {
        const port = await new Promise<number>((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
        const start = await b.startTime(child.pid!);
        const owner = { pid: child.pid!, start: start! };
        expect(await resolveServer(b, child.pid!)).toEqual(owner);
        expect(await b.listenPorts(owner)).toEqual(new Set([port]));
        const client = net.connect({ host: '127.0.0.1', port });
        await new Promise((r) => client.once('connect', r));
        const cport = client.localPort!;
        const end = Date.now() + 5_000;
        while ((await ownsConnection(b, owner, port, cport)) !== true && Date.now() < end) await sleep(20);
        expect(await ownsConnection(b, owner, port, cport)).toBe(true);
        // Another live process (this test runner) does not hold that socket.
        const me = { pid: process.pid, start: (await b.startTime(process.pid))! };
        expect(await ownsConnection(b, me, port, cport)).not.toBe(true);
        // A reused PID: same number, different start time — never the server.
        expect(await stillRunning(b, { pid: child.pid!, start: '0' })).toBe(false);
        expect(await ownsConnection(b, { pid: child.pid!, start: '0' }, port, cport)).toBe(false);
        client.destroy();
        child.kill('SIGKILL');
        await new Promise((r) => child.once('exit', r));
        // An exited process is never the server.
        expect(await stillRunning(b, owner)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }, 30_000);
  }

  it.skipIf(!linux)('reads IPv4 and IPv4-mapped /proc rows, and not ::1', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aura-procfs-'));
    try {
      mkdirSync(path.join(root, 'net'));
      const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      writeFileSync(path.join(root, 'net', 'tcp'), `${header}   0: 0100007F:1F90 0100007F:C350 01 0:0 0:0 0 1000 0 111\n`);
      writeFileSync(path.join(root, 'net', 'tcp6'), `${header}   0: 0000000000000000FFFF00000100007F:1F91 0000000000000000FFFF00000100007F:C351 01 0:0 0:0 0 1000 0 222\n`
        + '   1: 00000000000000000000000001000000:1F92 00000000000000000000000001000000:C352 01 0:0 0:0 0 1000 0 333\n');
      mkdirSync(path.join(root, '7', 'fd'), { recursive: true });
      ['111', '222', '333'].forEach((inode, n) => symlinkSync(`socket:[${inode}]`, path.join(root, '7', 'fd', String(n))));
      writeFileSync(path.join(root, '7', 'stat'), `7 (x) S 1 ${Array(17).fill('0').join(' ')} 4242 0 0\n`); // field 22: starttime
      const b = new Procfs(root);
      const p = { pid: 7, start: '4242' };
      expect(await b.startTime(7)).toBe('4242');
      expect(await ownsConnection(b, p, 0x1f90, 0xc350)).toBe(true);
      expect(await ownsConnection(b, p, 0x1f91, 0xc351)).toBe(true);
      expect(await ownsConnection(b, p, 0x1f92, 0xc352)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows exactly one launcher child and refuses ambiguity', async () => {
    const tree = (procs: Record<number, [string, number[]]>): IdentityBackend => ({
      name: 'tree',
      available: async () => ({ ok: true, detail: '' }),
      exeName: async (pid) => procs[pid]?.[0],
      children: async (pid) => procs[pid][1],
      startTime: async (pid) => (procs[pid] ? `t${pid}` : undefined),
      listenPorts: async () => new Set(),
      connectionOwner: async () => undefined,
    });
    expect(await resolveServer(tree({ 1: ['opencode', [2]] }), 1)).toEqual({ pid: 1, start: 't1' });
    expect(await resolveServer(tree({ 1: ['node', [2]], 2: ['.kilo', [3]], 3: ['node', []] }), 1)).toEqual({ pid: 2, start: 't2' });
    expect(await resolveServer(tree({ 1: ['cmd.exe', [2]], 2: ['node.exe', [3]], 3: ['kilo.exe', []] }), 1)).toEqual({ pid: 3, start: 't3' });
    expect(await resolveServer(tree({ 1: ['node', []] }), 1)).toBeUndefined();
    await expect(resolveServer(tree({ 1: ['node', [2, 3]], 2: ['kilo', []], 3: ['evil', []] }), 1)).rejects.toBeInstanceOf(IdentityMismatch);
    await expect(resolveServer(tree({ 1: ['node', [2]], 2: ['node', [3]], 3: ['node', [4]], 4: ['node', [5]], 5: ['kilo', []] }), 1))
      .rejects.toBeInstanceOf(IdentityMismatch);
  });
});
