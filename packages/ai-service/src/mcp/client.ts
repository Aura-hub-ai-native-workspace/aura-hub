/**
 * MCP - the Model Context Protocol, as a driver class.
 * ==================================================================
 * There was zero MCP anywhere in this repository. Every integration was
 * bespoke: a driver written by hand, for one system, that has to be
 * maintained forever and reaches exactly that system.
 *
 * MCP inverts the economics. One driver implementation yields every
 * server the ecosystem produces, and each one arrives carrying its own
 * tool schemas rather than needing schemas written for it here. It is
 * therefore the DEFAULT integration path, and a bespoke driver is what
 * you write when MCP genuinely cannot reach something - the local
 * process surface, the filesystem, git, the browser, all of which need a
 * governed primitive that a remote protocol has no business owning.
 *
 * -- What this file is -------------------------------------------------
 * A real JSON-RPC 2.0 client speaking MCP over two transports:
 *
 *   stdio  - the common case. A child process, spoken to in
 *            newline-delimited JSON, through the one long-lived process
 *            primitive in `exec/session.ts`.
 *
 *   http   - the streamable-HTTP transport. Plain `fetch`, with the
 *            session id the server assigns carried on subsequent calls.
 *
 * -- Everything it returns is untrusted --------------------------------
 * A tool result is somebody else's output, arriving over a protocol,
 * from a server AURA did not write. It is data. `toolResultText()`
 * flattens it to text and the caller turns it into a `ContextItem` with
 * `trust: 'untrusted'`; nothing in this file ever treats a server's reply
 * as an instruction, and the tier this driver reports (3, IPC) is what
 * tells the journal and the user how it got there.
 */

import { ProcessSession } from '../exec/session';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/* -- JSON-RPC ---------------------------------------------------------- */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A protocol-level failure, distinct from a tool that ran and said no. */
export class McpProtocolError extends Error {
  readonly code = 'MCP_PROTOCOL_ERROR' as const;
  constructor(readonly server: string, message: string, readonly rpcCode?: number) {
    super(`MCP server "${server}": ${message}`);
    this.name = 'McpProtocolError';
  }
}

/* -- Transports -------------------------------------------------------- */

export interface McpTransport {
  readonly kind: 'stdio' | 'http';
  readonly describe: string;
  open(): Promise<void>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * stdio transport. Newline-delimited JSON-RPC over a child process's
 * stdin/stdout, which is what the overwhelming majority of published MCP
 * servers speak.
 */
export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;
  private session: ProcessSession | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly name: string,
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly opts: { cwd?: string; env?: Record<string, string>; authority: string },
  ) {}

  get describe(): string {
    return `stdio: ${this.command} ${this.args.join(' ')}`;
  }

  async open(): Promise<void> {
    const session = new ProcessSession(this.command, this.args, {
      authority: this.opts.authority,
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    session.onLine((line) => this.receive(line));
    session.start();
    this.session = session;

    /* If the process dies, every in-flight request must fail with the
       reason rather than hanging until its timeout. A server that exits
       on startup (a missing dependency, a bad path) is the common case,
       and "it timed out after 30s" hides a message stderr already has. */
    void session.waitForExit().then((exit) => {
      const detail = exit.stderr.trim().split('\n').slice(-4).join(' | ') || `exit code ${exit.code}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new McpProtocolError(this.name, `the server process exited before replying — ${detail}`));
      }
      this.pending.clear();
    });
  }

  private receive(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      /* Servers legitimately print banners to stdout before speaking
         protocol. A line that is not JSON is not an error; a line that is
         JSON and malformed would be, and JSON.parse tells them apart. */
      return;
    }
    if (typeof msg.id !== 'number') return; // a notification from the server
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpProtocolError(this.name, msg.error.message, msg.error.code));
    else p.resolve(msg.result);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.session?.running) {
      return Promise.reject(new McpProtocolError(this.name, 'the transport is not open'));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpProtocolError(this.name, `${method} did not reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.session!.write(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpProtocolError(this.name, (err as Error).message));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.session?.running) return;
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    this.session.write(JSON.stringify(payload));
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    await this.session?.stop();
    this.session = null;
  }
}

/**
 * Streamable-HTTP transport. One POST per request; the session id the
 * server assigns on initialize is echoed on everything after it.
 *
 * A server may answer with `text/event-stream` rather than JSON, so the
 * SSE framing is parsed for the `data:` payload carrying the response to
 * this request id.
 */
export class HttpTransport implements McpTransport {
  readonly kind = 'http' as const;
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  get describe(): string {
    return `http: ${this.url}`;
  }

  async open(): Promise<void> {
    if (!/^https?:\/\//i.test(this.url)) {
      throw new McpProtocolError(this.name, `"${this.url}" is not an http(s) URL`);
    }
  }

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    let res: Response;
    try {
      res = await this.post(payload, timeoutMs);
    } catch (err) {
      throw new McpProtocolError(this.name, (err as Error).name === 'AbortError' ? `${method} timed out after ${timeoutMs}ms` : (err as Error).message);
    }
    const assigned = res.headers.get('mcp-session-id');
    if (assigned) this.sessionId = assigned;
    if (!res.ok) throw new McpProtocolError(this.name, `${method} returned HTTP ${res.status}`);

    const text = await res.text();
    const parsed = parseJsonOrSse(text, id);
    if (!parsed) throw new McpProtocolError(this.name, `${method} returned no JSON-RPC response for id ${id}`);
    if (parsed.error) throw new McpProtocolError(this.name, parsed.error.message, parsed.error.code);
    return parsed.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    try {
      await this.post(payload, 10_000);
    } catch {
      /* A notification has no reply by definition, so a transport error
         here cannot be reported to anyone who could act on it. */
    }
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}

/** Accepts either a bare JSON body or an SSE stream, and finds our id. */
function parseJsonOrSse(text: string, id: number): JsonRpcResponse | null {
  const tryParse = (s: string): JsonRpcResponse | null => {
    try {
      const v = JSON.parse(s) as JsonRpcResponse | JsonRpcResponse[];
      const list = Array.isArray(v) ? v : [v];
      return list.find((m) => m && m.id === id) ?? null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const found = tryParse(line.slice(5).trim());
    if (found) return found;
  }
  return null;
}

/* -- The client -------------------------------------------------------- */

export interface McpTool {
  name: string;
  description: string;
  /** The server's own JSON Schema for the tool's arguments. Not ours. */
  inputSchema: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface McpToolResult {
  /** True when the TOOL reported failure. Protocol failures throw instead. */
  isError: boolean;
  /** Flattened text of the result. Always untrusted. */
  text: string;
  /** The raw content blocks, for a caller that wants structure. */
  content: unknown[];
}

export class McpClient {
  private info: McpServerInfo | null = null;
  private tools: McpTool[] | null = null;

  constructor(
    readonly name: string,
    private readonly transport: McpTransport,
  ) {}

  get transportDescription(): string {
    return this.transport.describe;
  }

  get serverInfo(): McpServerInfo | null {
    return this.info;
  }

  /**
   * Open the transport and complete the MCP handshake.
   *
   * The version the SERVER reports is kept, not the one we asked for.
   * A server that negotiates down is telling us what it actually speaks,
   * and recording our request instead would put a claim in the journal
   * that the wire does not support.
   */
  async connect(): Promise<McpServerInfo> {
    await this.transport.open();
    const result = await this.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'aura-hub', version: '1' },
    }) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
    };

    await this.transport.notify('notifications/initialized');

    this.info = {
      name: result?.serverInfo?.name ?? this.name,
      version: result?.serverInfo?.version ?? 'unknown',
      protocolVersion: result?.protocolVersion ?? 'unreported',
      capabilities: result?.capabilities ?? {},
    };
    return this.info;
  }

  /** The tools this server advertises, with the server's own schemas. */
  async listTools(refresh = false): Promise<McpTool[]> {
    if (this.tools && !refresh) return this.tools;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    /* Paginated by the protocol. Bounded so a server that returns a
       cursor forever cannot spin here. */
    for (let page = 0; page < 20; page++) {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}) as {
        tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[];
        nextCursor?: string;
      };
      for (const t of result?.tools ?? []) {
        if (!t?.name) continue;
        out.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object' },
        });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    this.tools = out;
    return out;
  }

  /**
   * Call one tool.
   *
   * A tool that RAN and reported failure comes back as
   * `{ isError: true }`. A transport or protocol failure throws. The
   * distinction matters: the first is a result the model should read, the
   * second is an execution that did not happen and must never be
   * reported as one.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    const result = await this.transport.request('tools/call', { name, arguments: args }, timeoutMs) as {
      content?: unknown[];
      isError?: boolean;
    };
    const content = Array.isArray(result?.content) ? result.content : [];
    return { isError: result?.isError === true, text: toolResultText(content), content };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * Flatten MCP content blocks to text.
 *
 * Non-text blocks are described rather than dropped: "AURA received an
 * image it cannot read" is information; silently returning nothing is a
 * result that looks like an empty answer.
 */
export function toolResultText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; mimeType?: string; uri?: string; resource?: { uri?: string; text?: string } };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'resource' && typeof b.resource?.text === 'string') parts.push(`[resource ${b.resource.uri ?? ''}]\n${b.resource.text}`);
    else if (b.type === 'resource_link' && b.uri) parts.push(`[resource link: ${b.uri}]`);
    else if (b.type) parts.push(`[${b.type} content${b.mimeType ? `, ${b.mimeType}` : ''} — not readable as text]`);
  }
  return parts.join('\n\n');
}
