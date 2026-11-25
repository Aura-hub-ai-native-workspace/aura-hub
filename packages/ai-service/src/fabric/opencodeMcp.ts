/**
 * fabric/opencodeMcp — run an OpenCode task only after its Common Context
 * MCP connection is real.
 * ==================================================================
 * OpenCode 2.x connects a project's MCP servers asynchronously, a moment
 * after the first request for that project. `opencode --standalone run`
 * builds its first model request without waiting for that, so a mission
 * prompt can reach the model with no Common Context tools at all — and the
 * agent then works without shared memory while everything looks normal.
 * (Measured with OpenCode 2.2.6: an MCP server that took 6 s to start was
 * still unconnected when the first model step began.)
 *
 * So when the user's OpenCode configuration declares the `common-context`
 * server, the task is run against a private `opencode serve` instead:
 *
 *   1. start the private server (free local port, one-time password),
 *   2. ask OpenCode's own MCP client, over that server, until it reports
 *      `common-context` as connected,
 *   3. only then send the task with `opencode --server <url> run`,
 *   4. end the server and everything it started.
 *
 * A spawned server, a parsed configuration or a listening port is never
 * treated as connectivity; only the client's own "connected" report is.
 * When the connection fails, times out or is cancelled, the task is NOT
 * sent and the caller gets the reason.
 *
 * Every request to the private server, the gate's own and the runtime CLIs',
 * goes through an AURA-owned loopback relay (`serverIdentity.ts`) that
 * forwards a connection only after the operating system shows the server
 * side of that exact connection held by the process AURA started. The
 * address printed on stdout is not trusted (the server's children share that
 * pipe); it only selects among the server's own listeners when it has more
 * than one. No credential, status request or task is sent before that check;
 * a failed check refuses the run (`unverified-server`), and where the OS
 * cannot be asked (Windows, missing tools, permission denied) the run is
 * refused (`identity-unavailable`) rather than sent unverified. This binds
 * connections to a process, not to code: a plugin inside the server or a
 * compromised runtime is out of scope (docs/COMMON_CONTEXT_GATE_SECURITY.md).
 *
 * When `common-context` is not configured for OpenCode there is nothing to
 * wait for, and the task runs with plain `--standalone run` as before. The
 * private server is never the user's background service in either case.
 *
 * Kilo Code (an OpenCode-lineage engine) is gated by the same code with its
 * own runtime profile (`runKiloTask`): its configuration declares servers
 * under `mcp.<name>`, its private `kilo serve` is protected by
 * `KILO_SERVER_PASSWORD`, connectivity is read from that server's own
 * `GET /mcp` (structured JSON), and the task is sent with
 * `kilo run --attach <url>` (its `--dir` kept). Because a Kilo task then runs
 * inside the private server, the server gets the task's exact environment
 * (`KILO_CONFIG` and AURA's governance plugin) and is never started with
 * `--pure`, which would disable plugins. A connected Common Context proves
 * context connectivity only; it does not prove that policy is enforced.
 *
 * Mirrors backend/aura/workers/opencode_mcp.py.
 */
import { randomBytes } from 'node:crypto';
import { runAgent, startAgentServer, type AgentServer, type ProcessOutput } from '../exec/process';
import { IdentityMismatch, IdentityUnavailable, VerifiedRelay, defaultBackend, resolveServer, type IdentityBackend, type Violation } from './serverIdentity';

export const CONTEXT_SERVER = 'common-context';
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 400;
const PROBE_TIMEOUT_MS = 15_000;
// Kilo settles an MCP handshake within its own 30 s limit (measured with Kilo
// 7.5.14), and its GET /mcp answers only once that has happened. One request
// may therefore take a little over 30 s; the readiness deadline leaves room.
const KILO_READY_TIMEOUT_MS = 40_000;
const KILO_HTTP_TIMEOUT_MS = 35_000;
const KILO_USERNAME = 'kilo';
export const HTTP_BODY_LIMIT = 1_000_000;
/** The oldest Kilo this gate was verified against (debug config, serve on a self-chosen port, GET /mcp, run --attach). */
export const KILO_MIN_VERIFIED = '7.5.14';
// The private server announces where it listens, e.g.
// "kilo server listening on http://127.0.0.1:39637" (Kilo 7.5.14) or
// "server listening on http://127.0.0.1:39091" (OpenCode 2.3.2). Each runtime's
// exact line, at the start of a line, on loopback. The announcement is NOT
// evidence of who listens (children share stdout); it only selects among
// listeners the OS shows the server itself holding. Mirrors
// `_OPENCODE_LISTENING` / `_KILO_LISTENING` in opencode_mcp.py.
const OPENCODE_LISTENING = /^server listening on (http:\/\/127\.0\.0\.1:(\d{1,5}))(?![\w.:])/m;
const KILO_LISTENING = /^kilo server listening on (http:\/\/127\.0\.0\.1:(\d{1,5}))(?![\w.:])/m;
// A CLI that does not know `debug config` (too old, or not this runtime).
const UNSUPPORTED_COMMAND = /unknown (command|argument|arguments)|not a valid command|unrecognized|invalid choice/i;
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Every port announced on stdout with `runtime`'s exact wording: only
 * `http://127.0.0.1:<port>` with 1 <= port <= 65535, at the start of a line
 * after ANSI colour codes are removed. Forged lines are expected and
 * harmless: a port counts only if the OS shows the server process holding it.
 */
export function announcedPorts(output: string, runtime: 'opencode' | 'kilo'): Set<number> {
  const clean = (output ?? '').replace(ANSI, '');
  const pattern = new RegExp((runtime === 'kilo' ? KILO_LISTENING : OPENCODE_LISTENING).source, 'gm');
  const ports = new Set<number>();
  for (const match of clean.matchAll(pattern)) {
    const port = Number(match[2]);
    if (port > 0 && port < 65536) ports.add(port);
  }
  return ports;
}

export type McpReadiness = 'connected' | 'not-configured';

/** Why the task was not sent. `message` is safe to show to the user. */
export class McpNotReadyError extends Error {
  constructor(
    readonly reason: 'config-error' | 'launch-failed' | 'failed' | 'timeout' | 'cancelled' | 'server-exited' | 'lost'
      | 'unverified-server' | 'identity-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'McpNotReadyError';
  }
}

export interface OpenCodeMcpDeps {
  run(args: string[], opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<ProcessOutput>;
  startServer(args: string[], opts: { cwd: string; env?: Record<string, string> }): AgentServer;
  sleep(ms: number): Promise<void>;
  now(): number;
  password(): string;
  /** One loopback HTTP request (Kilo's GET /mcp). Rejects on a transport failure. */
  http?(method: 'GET' | 'POST', url: string, password: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; body: string }>;
  /** How connections reach the server. Defaults to the verified relay; tests may substitute it. */
  endpoints?: Endpoints;
}

/** Where the gate and the runtime CLIs send their requests for one run. */
export interface Endpoint {
  url: string;
  /** Connections that were refused because the OS did not attribute them to the server. */
  violations: Array<Violation | { reason: 'unverified-server' | 'identity-unavailable'; message: string }>;
  close(): Promise<void>;
}

export interface Endpoints {
  available(): Promise<{ ok: boolean; detail: string }>;
  /** The endpoint, or undefined while the server is not listening yet. */
  open(server: AgentServer, runtime: 'opencode' | 'kilo'): Promise<Endpoint | undefined>;
}

/** Opens the verified relay for a started server (see serverIdentity.ts). */
export class VerifiedEndpoints implements Endpoints {
  constructor(readonly backend: IdentityBackend = defaultBackend()) {}

  available() { return this.backend.available(); }

  /**
   * The port is one the OS shows the server process itself listening on.
   * Only if it holds several is the announcement used, to choose among them;
   * an announced port the server does not hold is ignored.
   */
  async open(server: AgentServer, runtime: 'opencode' | 'kilo'): Promise<Endpoint | undefined> {
    if (server.pid === undefined) return undefined;
    const proc = await resolveServer(this.backend, server.pid);
    if (!proc) return undefined;
    let ports = await this.backend.listenPorts(proc);
    if (ports.size > 1) {
      const announced = announcedPorts(server.output(), runtime);
      ports = new Set([...ports].filter((p) => announced.has(p)));
    }
    if (ports.size !== 1) return undefined;
    const relay = new VerifiedRelay(this.backend, proc, [...ports][0]);
    try {
      await relay.start();
    } catch (e) {
      await relay.close();
      throw e;
    }
    return relay;
  }
}

async function loopbackHttp(method: 'GET' | 'POST', url: string, password: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; body: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${KILO_USERNAME}:${password}`).toString('base64')}` },
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  return { status: res.status, body: await readBounded(res, HTTP_BODY_LIMIT) };
}

/** The response body, read only up to `limit` bytes; the rest is never buffered. */
export async function readBounded(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.subarray(0, limit - size);
      parts.push(take);
      size += take.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).toString('utf8');
}

const NETWORK_CODES = /^(ECONN|EPIPE|ETIMEDOUT|EHOST|ENET|EAI_|UND_ERR_)/;

/**
 * What "not ready yet" may mean: the request was aborted or timed out, or the
 * connection failed (not listening yet, refused, reset). Anything else is a
 * defect and is not hidden. Mirrors `_TRANSPORT_ERRORS` in opencode_mcp.py.
 */
export function isTransportError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; message?: string; code?: unknown; cause?: { code?: unknown } };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = String(err.code ?? err.cause?.code ?? '');
  if (NETWORK_CODES.test(code)) return true;
  return err.name === 'TypeError' && err.message === 'fetch failed';
}

/** The production dependencies (exported so tests can swap a single one, e.g. the identity backend). */
export const defaultDeps: OpenCodeMcpDeps = {
  run: (args, opts) => runAgent('opencode', args, opts),
  startServer: (args, opts) => startAgentServer('opencode', args, opts),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  password: () => randomBytes(24).toString('hex'),
};

export const kiloDeps: OpenCodeMcpDeps = {
  ...defaultDeps,
  run: (args, opts) => runAgent('kilo', args, opts),
  startServer: (args, opts) => startAgentServer('kilo', args, opts),
  http: loopbackHttp,
};

/** Where a runtime declares its MCP servers: OpenCode `mcp.servers.<name>`, Kilo `mcp.<name>`. */
export type ConfigLayout = 'opencode' | 'kilo';

/** Does the resolved configuration declare this MCP server, enabled? */
export function configDeclaresServer(debugConfigOutput: string, server = CONTEXT_SERVER, layout: ConfigLayout = 'opencode'): boolean {
  const parsed = parseResolvedConfig(debugConfigOutput);
  if (!parsed) return false;
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 12) return false;
    const record = value as Record<string, unknown>;
    const mcp = record.mcp as Record<string, unknown> | undefined;
    const servers = (layout === 'kilo' ? mcp : mcp?.servers) as Record<string, { enabled?: boolean }> | undefined;
    const entry = servers && typeof servers === 'object' ? servers[server] : undefined;
    if (entry && typeof entry === 'object' && entry.enabled !== false) return true;
    return Object.values(record).some((child) => visit(child, depth + 1));
  };
  return visit(parsed, 0);
}

const KILO_FAILED = new Set(['failed', 'disabled', 'needs_auth', 'needs_client_registration']);

/**
 * One server's state from Kilo's `GET /mcp`, which answers once each server's
 * handshake has settled, e.g. `{"common-context":{"status":"connected"}}` or
 * `{"common-context":{"status":"failed","error":"Connection closed"}}`. A refused
 * credential is a failure (waiting cannot fix it); any other non-200 answer
 * or unreadable body is still pending.
 */
export function kiloStatus(httpCode: number, body: string, server = CONTEXT_SERVER): { state: 'connected' | 'failed' | 'pending'; detail: string } {
  if (httpCode === 401 || httpCode === 403) return { state: 'failed', detail: 'the private Kilo server refused its one-time credentials' };
  if (httpCode !== 200) return { state: 'pending', detail: '' };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { state: 'pending', detail: '' }; }
  const entry = isObject(parsed) ? parsed[server] : undefined;
  if (!isObject(entry)) return { state: 'pending', detail: '' };
  const status = String(entry.status ?? '').toLowerCase();
  const error = String(entry.error ?? '');
  if (status === 'connected') return { state: 'connected', detail: 'connected' };
  if (KILO_FAILED.has(status)) return { state: 'failed', detail: error ? `${status}: ${error}` : status };
  return { state: 'pending', detail: status };
}

/** A Kilo task argv attached to the private server; every other argument (`--dir`) kept. */
export function kiloGatedArgs(args: string[], url: string): string[] {
  const at = args.includes('run') ? args.indexOf('run') + 1 : 0;
  return [...args.slice(0, at), '--attach', url, ...args.slice(at)];
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The resolved configuration as one object, or undefined when it cannot be read.
 *
 * OpenCode up to 2.2.x prints one configuration object. OpenCode 2.3.x prints
 * the list of configuration layers it loaded, in load order, e.g.
 * `[{"type":"document","path":…,"info":{…config…}}, {"type":"directory","path":…}]`;
 * only document layers carry `info`. Those `info` objects are merged, later
 * layers taking precedence, into the same single object the old format gave.
 * Anything else (an empty list, a list holding a non-object, a list with no
 * configuration document, or text that is not JSON) is unreadable, and the
 * gate fails closed on it. Mirrors `_parse_resolved_config` in
 * backend/aura/workers/opencode_mcp.py.
 */
function parseResolvedConfig(output: string): JsonObject | undefined {
  let parsed: unknown;
  try {
    const start = output.indexOf('{');
    const alt = output.indexOf('[');
    const from = start === -1 ? alt : alt === -1 ? start : Math.min(start, alt);
    if (from === -1) return undefined;
    parsed = JSON.parse(from > 0 ? output.slice(from) : output);
  } catch {
    return undefined;
  }
  if (isObject(parsed)) return parsed;
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isObject)) return undefined;
  const documents = parsed.map((layer) => layer.info).filter(isObject);
  if (documents.length === 0) return undefined;
  const merged: JsonObject = {};
  for (const document of documents) mergeInto(merged, document);
  return merged;
}

/** Deep-merge `layer` into `target`; the later layer wins on a conflict. */
function mergeInto(target: JsonObject, layer: JsonObject): void {
  for (const [key, value] of Object.entries(layer)) {
    const existing = target[key];
    if (isObject(value) && isObject(existing)) mergeInto(existing, value);
    else target[key] = value;
  }
}

/** One server's line in `opencode mcp list`, with colour codes removed. */
export function serverStatus(listOutput: string, server = CONTEXT_SERVER): { state: 'connected' | 'failed' | 'pending'; detail: string } {
  const clean = listOutput.replace(/\u001b\[[0-9;]*m/g, '');
  const line = clean.split(/\r?\n/).find((l) => new RegExp(`(^|\\s)${server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(`${l} `));
  if (!line) return { state: 'pending', detail: '' };
  const detail = line.slice(line.indexOf(server) + server.length).trim();
  if (/^connected\b/i.test(detail)) return { state: 'connected', detail };
  if (/^(failed|needs authentication|disabled)/i.test(detail)) return { state: 'failed', detail };
  return { state: 'pending', detail };
}

export interface OpenCodeRunOptions {
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface OpenCodeRunResult extends ProcessOutput {
  /** What was established about Common Context before the task was sent. */
  mcp: McpReadiness;
  /** The argv the task was sent with (no password; that travels in env). */
  args: string[];
}

/** What differs between the runtimes the gate supports; the gate itself is shared. */
interface Runtime {
  name: string;
  /** Which exact announcement is this runtime's. */
  runtime: 'opencode' | 'kilo';
  configArgs: string[];
  layout: ConfigLayout;
  passwordEnv: string;
  /** Always `--port 0`: the server picks, then announces, its own port. */
  serveArgs: string[];
  readyTimeoutMs: number;
  /** true: read the private server's GET /mcp; false: `--server <url> mcp list`. */
  httpStatus: boolean;
  /** Named when the CLI does not know the config command. */
  minVerified?: string;
}

export const OPENCODE_SERVE_ARGS = ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'info'];
export const KILO_SERVE_ARGS = ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'INFO'];

const OPENCODE: Runtime = {
  name: 'OpenCode',
  runtime: 'opencode',
  configArgs: ['--standalone', 'debug', 'config'],
  layout: 'opencode',
  passwordEnv: 'OPENCODE_PASSWORD',
  serveArgs: OPENCODE_SERVE_ARGS,
  readyTimeoutMs: READY_TIMEOUT_MS,
  httpStatus: false,
};

// Never `--pure` anywhere here: it disables plugins, and AURA's governance is a plugin.
const KILO: Runtime = {
  name: 'Kilo',
  runtime: 'kilo',
  configArgs: ['debug', 'config'],
  layout: 'kilo',
  passwordEnv: 'KILO_SERVER_PASSWORD',
  serveArgs: KILO_SERVE_ARGS,
  readyTimeoutMs: KILO_READY_TIMEOUT_MS,
  httpStatus: true,
  minVerified: KILO_MIN_VERIFIED,
};

type Status = { state: 'connected' | 'failed' | 'pending'; detail: string };

/**
 * The shared gate: read the resolved configuration; when Common Context is
 * declared, start a private server, learn its address from that server's own
 * announcement, wait for the runtime's own MCP client to report Common Context
 * connected, and only then send the task to that server. Throws
 * `McpNotReadyError` — without sending the task — when it did not connect.
 */
async function runGated(
  rt: Runtime,
  plainArgs: string[],
  gatedArgs: (url: string) => string[],
  opts: OpenCodeRunOptions,
  deps: OpenCodeMcpDeps,
): Promise<OpenCodeRunResult> {
  const cancelled = () => new McpNotReadyError('cancelled', `The run was cancelled before ${rt.name} was ready, so the task was not sent.`);
  if (opts.signal?.aborted) throw cancelled();

  const config = await deps.run(rt.configArgs, { cwd: opts.cwd, timeoutMs: PROBE_TIMEOUT_MS, signal: opts.signal, env: opts.env });
  if (opts.signal?.aborted) throw cancelled();
  const parsedConfig = parseResolvedConfig(config.out);
  if (config.code !== 0 || !parsedConfig) {
    const hint = rt.minVerified && UNSUPPORTED_COMMAND.test(config.out.replace(ANSI, ''))
      ? ` This ${rt.name} does not appear to support \`${rt.configArgs.join(' ')}\`; AURA's readiness check was verified with ${rt.name} ${rt.minVerified} or newer.`
      : '';
    throw new McpNotReadyError('config-error', `Could not read ${rt.name}'s resolved configuration (exit ${config.code}); the task was not sent.${hint}`);
  }
  if (!configDeclaresServer(config.out, CONTEXT_SERVER, rt.layout)) {
    const res = await deps.run(plainArgs, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, env: opts.env });
    return { ...res, mcp: 'not-configured', args: plainArgs };
  }

  const endpoints = deps.endpoints ?? new VerifiedEndpoints();
  const support = await endpoints.available();
  if (!support.ok) {
    throw new McpNotReadyError('identity-unavailable', `${rt.name}'s private server cannot be verified on this system (${support.detail}), so the task was not sent.`);
  }
  const password = deps.password();
  const env = { ...(opts.env ?? {}), [rt.passwordEnv]: password };
  const readyTimeoutMs = opts.readyTimeoutMs ?? rt.readyTimeoutMs;
  const http = deps.http ?? loopbackHttp;
  let server: AgentServer;
  try {
    server = deps.startServer(rt.serveArgs, { cwd: opts.cwd, env });
  } catch (e) {
    throw new McpNotReadyError('launch-failed', `${rt.name}'s private server could not be started (${(e as Error).message.slice(0, 160)}); the task was not sent.`);
  }
  const exitedError = () => new McpNotReadyError('server-exited', `${rt.name}'s private server stopped before the task was sent, so the task was not sent.${tail(server.log())}`);
  let relay: Endpoint | undefined;

  /** Identify the server and open the relay; a cancellation does not wait for the OS inspection. */
  const openOrCancel = async (): Promise<Endpoint | undefined> => {
    const opening = endpoints.open(server, rt.runtime);
    const signal = opts.signal;
    if (!signal) return opening;
    let onAbort = () => {};
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const winner = await Promise.race([opening, aborted]);
      if (winner === 'aborted') {
        opening.then((late) => late?.close(), () => undefined);
        throw cancelled();
      }
      return winner;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  /** A connection the OS did not attribute to the server ends the run. */
  const refuseIfViolated = (): void => {
    const first = relay?.violations[0];
    if (first) throw new McpNotReadyError(first.reason, `${rt.name}: ${first.message}; no credentials or task were sent to it, and the task was not sent.`);
  };

  const probe = async (deadline: number, url: string): Promise<Status> => {
    if (rt.httpStatus) {
      const timeoutMs = Math.max(500, Math.min(KILO_HTTP_TIMEOUT_MS, deadline - deps.now()));
      try {
        const answer = await http('GET', `${url}/mcp`, password, { timeoutMs, signal: opts.signal });
        return kiloStatus(answer.status, answer.body);
      } catch (e) {
        // Not listening yet, reset, timed out or aborted (a cancellation is
        // checked by the caller): not ready. Anything else is a defect.
        if (isTransportError(e)) return { state: 'pending', detail: '' };
        throw e;
      }
    }
    const out = await deps.run(['--server', url, 'mcp', 'list'], { cwd: opts.cwd, timeoutMs: PROBE_TIMEOUT_MS, signal: opts.signal, env });
    return out.code === 0 ? serverStatus(out.out) : { state: 'pending', detail: '' };
  };

  try {
    const deadline = deps.now() + readyTimeoutMs;
    let last = '';
    for (;;) {
      if (opts.signal?.aborted) throw cancelled();
      if (server.exited()) throw exitedError();
      if (!relay) {
        try {
          relay = await openOrCancel();
        } catch (e) {
          if (e instanceof IdentityMismatch) throw new McpNotReadyError('unverified-server', `${rt.name}'s private server could not be identified (${e.message}), so the task was not sent.`);
          if (e instanceof IdentityUnavailable) throw new McpNotReadyError('identity-unavailable', `${rt.name}'s private server could not be verified (${e.message}), so the task was not sent.`);
          throw e;
        }
        if (opts.signal?.aborted) throw cancelled();
      }
      let status: Status;
      if (!relay) {
        status = { state: 'pending', detail: 'the private server is not listening yet' };
      } else {
        status = await probe(deadline, relay.url);
        refuseIfViolated();
      }
      if (opts.signal?.aborted) throw cancelled();
      if (status.state === 'connected') break;
      if (status.state === 'failed') {
        throw new McpNotReadyError('failed', `${rt.name} could not connect to Common Context (${status.detail.slice(0, 200)}), so the task was not sent.`);
      }
      last = status.detail;
      if (deps.now() >= deadline) {
        throw new McpNotReadyError('timeout', `${rt.name} did not connect to Common Context within ${Math.round(readyTimeoutMs / 1000)} seconds${last ? ` (${last.slice(0, 120)})` : ''}, so the task was not sent.`);
      }
      await deps.sleep(POLL_INTERVAL_MS);
    }
    // Fixed for the run: the relay's own address, never re-read from stdout.
    const target = relay!.url;

    if (rt.httpStatus) {
      // Kilo reports a dropped connection at once and does not restore it by
      // itself, so the connection is read once more right before the task
      // goes. If it was lost, exactly one reconnect is asked for, through the
      // same verified relay.
      if (server.exited()) throw exitedError();
      let status = await probe(deps.now() + KILO_HTTP_TIMEOUT_MS, target);
      refuseIfViolated();
      if (status.state !== 'connected') {
        if (opts.signal?.aborted) throw cancelled();
        if (server.exited()) throw exitedError();
        try {
          await http('POST', `${target}/mcp/${CONTEXT_SERVER}/connect`, password, { timeoutMs: KILO_HTTP_TIMEOUT_MS, signal: opts.signal });
        } catch (e) {
          // A failed reconnect is judged by the next read; a defect is not hidden.
          if (!isTransportError(e)) throw e;
        }
        if (opts.signal?.aborted) throw cancelled();
        refuseIfViolated();
        status = await probe(deps.now() + KILO_HTTP_TIMEOUT_MS, target);
        refuseIfViolated();
        if (opts.signal?.aborted) throw cancelled();
        if (server.exited()) throw exitedError();
        if (status.state !== 'connected') {
          throw new McpNotReadyError('lost', `${rt.name}'s Common Context connection was lost before the task was sent and one reconnect did not restore it (${status.detail.slice(0, 160) || 'no status'}), so the task was not sent.`);
        }
      }
    }

    if (opts.signal?.aborted) throw cancelled();
    if (server.exited()) throw exitedError();
    refuseIfViolated();
    const args = gatedArgs(target);
    const res = await deps.run(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, env });
    const during = relay!.violations[0];
    if (during) throw new McpNotReadyError(during.reason, `${rt.name}: during the task, ${during.message}. The result is not trusted.`);
    return { ...res, mcp: 'connected', args };
  } finally {
    try {
      await relay?.close();
    } finally {
      await server.stop();
    }
  }
}

/**
 * Run one OpenCode task. Throws `McpNotReadyError` — without sending the
 * task — when Common Context is configured but did not connect.
 */
export async function runOpenCodeTask(task: string, opts: OpenCodeRunOptions, deps: OpenCodeMcpDeps = defaultDeps): Promise<OpenCodeRunResult> {
  const modelArgs = opts.model ? ['--model', opts.model] : [];
  return runGated(OPENCODE, ['--standalone', 'run', ...modelArgs, task], (url) => ['--server', url, 'run', ...modelArgs, task], opts, deps);
}

/**
 * Run one Kilo task, given the argv AURA would otherwise run it with
 * (`run --dir <cwd> <task>`). Throws `McpNotReadyError` — without sending the
 * task — when Common Context is configured but did not connect. The password
 * travels only in env (`kilo run` reads KILO_SERVER_PASSWORD itself).
 */
export async function runKiloTask(args: string[], opts: Omit<OpenCodeRunOptions, 'model'>, deps: OpenCodeMcpDeps = kiloDeps): Promise<OpenCodeRunResult> {
  return runGated(KILO, args, (url) => kiloGatedArgs(args, url), opts, deps);
}

function tail(log: string): string {
  const lines = log.split(/\r?\n/).filter((l) => /error|mcp/i.test(l)).slice(-3).join(' | ');
  return lines ? ` Last server messages: ${lines.slice(0, 300)}` : '';
}
