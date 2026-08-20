/**
 * The MCP server registry - the user's own allow-list.
 * ==================================================================
 * An MCP server is an arbitrary command or URL. Nothing in AURA's three
 * binary allow-lists (`SAFE_BINARIES`, `AGENT_BINARIES`,
 * `INSTALLER_BINARIES`) covers `npx some-mcp-server`, and adding a fourth
 * general-purpose list would be exactly the merge invariant 8 forbids,
 * dressed up as a new constant.
 *
 * The honest model is different and simpler: AURA runs an MCP server
 * because THE USER REGISTERED IT. The registry file is the allow-list,
 * it is authored by the user rather than shipped by us, and registering a
 * server is itself the authorising act. That is what
 * `ProcessSession`'s required `authority` field records.
 *
 * File: `~/.aura/mcp/servers.json`
 *
 * ```json
 * {
 *   "servers": [
 *     { "id": "filesystem", "transport": "stdio",
 *       "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"],
 *       "enabled": true },
 *     { "id": "docs", "transport": "http", "url": "https://mcp.example.com/mcp" }
 *   ]
 * }
 * ```
 *
 * A server that is not in this file does not run. A server that is in it
 * and disabled does not run. There is no discovery, no auto-install and
 * no default server list: AURA does not decide on the user's behalf which
 * third-party processes may speak to their machine.
 */

import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { McpClient, StdioTransport, HttpTransport, type McpTool, type McpServerInfo } from './client';

export interface McpServerConfig {
  /** Stable id. Namespaces this server's tools: `mcp:<id>/<tool>`. */
  id: string;
  transport: 'stdio' | 'http';
  /** stdio only. */
  command?: string;
  args?: string[];
  cwd?: string;
  /**
   * Extra environment for a stdio server.
   *
   * This is where an API key for a third-party MCP server lives, which is
   * why nothing in this module ever logs, summarises or renders it. It is
   * passed to the child and otherwise untouched.
   */
  env?: Record<string, string>;
  /** http only. */
  url?: string;
  headers?: Record<string, string>;
  /** Absent is treated as enabled; only an explicit `false` disables. */
  enabled?: boolean;
  /** The user's own note about why this server is here. */
  note?: string;
}

export interface McpRegistryFile {
  servers: McpServerConfig[];
}

const FILE = () => homePath('mcp', 'servers.json');

export function loadMcpRegistry(): McpRegistryFile {
  const raw = readJsonFile<McpRegistryFile>(FILE(), { servers: [] });
  return { servers: Array.isArray(raw?.servers) ? raw.servers.filter(isUsable) : [] };
}

export function saveMcpRegistry(file: McpRegistryFile): void {
  writeJsonFile(FILE(), file);
}

/** Registry path, for a UI or an error message that has to name it. */
export const mcpRegistryPath = FILE;

function isUsable(s: McpServerConfig): boolean {
  if (!s?.id || typeof s.id !== 'string') return false;
  if (s.transport === 'stdio') return typeof s.command === 'string' && s.command.length > 0;
  if (s.transport === 'http') return typeof s.url === 'string' && /^https?:\/\//i.test(s.url);
  return false;
}

export const isEnabled = (s: McpServerConfig): boolean => s.enabled !== false;

/* -- Connections ------------------------------------------------------- */

export interface McpConnection {
  config: McpServerConfig;
  client: McpClient;
  info: McpServerInfo;
  tools: McpTool[];
  connectedAt: string;
}

export interface McpConnectionFailure {
  config: McpServerConfig;
  reason: string;
}

/**
 * Every registered, enabled server, connected once and kept.
 *
 * A failure to connect is recorded as a failure, not as an absence: "the
 * docs server is configured and would not start, because npx is not on
 * PATH" is actionable, and silently having no tools is not.
 */
export class McpConnectionPool {
  private readonly connections = new Map<string, McpConnection>();
  private readonly failures = new Map<string, McpConnectionFailure>();

  async connectAll(): Promise<{ connected: McpConnection[]; failed: McpConnectionFailure[] }> {
    const registry = loadMcpRegistry();
    for (const config of registry.servers) {
      if (!isEnabled(config)) continue;
      if (this.connections.has(config.id)) continue;
      await this.connect(config);
    }
    return { connected: [...this.connections.values()], failed: [...this.failures.values()] };
  }

  async connect(config: McpServerConfig): Promise<McpConnection | null> {
    this.failures.delete(config.id);
    const authority = `the user registered MCP server "${config.id}" in ${FILE()}`;
    const transport = config.transport === 'stdio'
      ? new StdioTransport(config.id, config.command!, config.args ?? [], { cwd: config.cwd, env: config.env, authority })
      : new HttpTransport(config.id, config.url!, config.headers ?? {});
    const client = new McpClient(config.id, transport);
    try {
      const info = await client.connect();
      const tools = await client.listTools();
      const connection: McpConnection = { config, client, info, tools, connectedAt: new Date().toISOString() };
      this.connections.set(config.id, connection);
      return connection;
    } catch (err) {
      await client.close().catch(() => { /* nothing to clean up */ });
      this.failures.set(config.id, { config, reason: (err as Error).message });
      return null;
    }
  }

  get(id: string): McpConnection | undefined {
    return this.connections.get(id);
  }

  list(): McpConnection[] {
    return [...this.connections.values()];
  }

  listFailures(): McpConnectionFailure[] {
    return [...this.failures.values()];
  }

  /** Every tool across every connected server, namespaced by server id. */
  allTools(): { serverId: string; tool: McpTool; qualifiedName: string }[] {
    const out: { serverId: string; tool: McpTool; qualifiedName: string }[] = [];
    for (const c of this.connections.values()) {
      for (const tool of c.tools) {
        out.push({ serverId: c.config.id, tool, qualifiedName: `${c.config.id}/${tool.name}` });
      }
    }
    return out;
  }

  async closeAll(): Promise<void> {
    for (const c of this.connections.values()) await c.client.close().catch(() => { /* already gone */ });
    this.connections.clear();
  }
}
