/**
 * The MCP driver - one implementation, every server.
 * ==================================================================
 * Registers the connection pool as a tier-3 (IPC) `CapabilityDriver`,
 * and supplies the three `mcp.*` executors the manifest declares.
 *
 * Three, not thirty. AURA does not mint a capability per third-party
 * tool: the server declares its own schemas, so the argument shape is
 * validated at call time against what the server actually sent, by
 * `validateAgainstSchema` below. That is the difference between a driver
 * class and thirty bespoke drivers with a shared name.
 *
 * -- Everything a server returns is untrusted --------------------------
 * `resultAsContextItem()` is the boundary. It is the only place an MCP
 * result becomes context, and it assigns `trust: 'untrusted'` there,
 * once, exactly as a web page or a repository file does. A tool result
 * is somebody else's output arriving over a protocol from a server AURA
 * did not write; it is data, and the composer fences it.
 */

import type { Executor, ExecutorResult } from '@aura/capability-fabric';
import type { CapabilityDriver } from '@aura/capability-fabric';
import type { ContextItem } from '../context/item';
import { fromToolResult } from '../context/item';
import { McpConnectionPool, mcpRegistryPath, type McpConnection } from './registry';
import type { McpTool, McpToolResult } from './client';

/* -- Argument validation against the SERVER's schema ------------------- */

export interface SchemaViolation {
  path: string;
  problem: string;
}

/**
 * Validate arguments against the JSON Schema the server declared.
 *
 * Deliberately a small structural check rather than a full JSON Schema
 * implementation: it enforces `required`, `type` and `enum` at the top
 * two levels, which is what MCP tool schemas actually use, and it
 * reports what is wrong rather than throwing a boolean.
 *
 * It is not a security boundary - the server validates its own input and
 * is entitled to refuse. It exists so that a mistake is caught before a
 * governed, approved, audited invocation is spent on it, and so the
 * error names the field instead of arriving as someone else's stack
 * trace.
 */
export function validateAgainstSchema(schema: Record<string, unknown>, args: Record<string, unknown>): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      out.push({ path: key, problem: 'is required by the server\'s schema and was not supplied' });
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      if (schema.additionalProperties === false) {
        out.push({ path: key, problem: 'is not a property the server\'s schema allows' });
      }
      continue;
    }
    const expected = spec.type;
    if (typeof expected === 'string' && !matchesType(value, expected)) {
      out.push({ path: key, problem: `should be ${expected}, but ${describe(value)} was supplied` });
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value as never)) {
      out.push({ path: key, problem: `must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}` });
    }
  }
  return out;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    default: return true; // a type we do not model is not a violation we can assert
  }
}

const describe = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`;

/* -- The boundary ------------------------------------------------------ */

/**
 * An MCP tool result, turned into context. The ONLY place that happens.
 *
 * `trust: 'untrusted'` is assigned here and never re-derived downstream.
 * A tool result that could instruct the model is a third party with a
 * write to AURA's own reasoning, which is precisely the attack the trust
 * field exists to close.
 */
export function resultAsContextItem(serverId: string, tool: string, result: McpToolResult): ContextItem<string> {
  return fromToolResult({
    capabilityId: `mcp:${serverId}/${tool}`,
    output: result.isError ? `[the tool reported an error]\n${result.text}` : result.text,
    nodeId: `mcp:${serverId}`,
  });
}

/* -- The driver -------------------------------------------------------- */

/**
 * Tier 3 - IPC. A local protocol with real schemas, but schemas AURA did
 * not write, arriving from a process AURA did not author. More direct
 * than a browser; less direct than an API AURA owns.
 */
export function mcpDriver(pool: McpConnectionPool): CapabilityDriver {
  return {
    id: 'mcp',
    tier: 3,
    nodes: ['*'],
    capabilities: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
    async available() {
      const connected = pool.list();
      const failed = pool.listFailures();
      if (connected.length === 0 && failed.length === 0) {
        return { ok: false, detail: `No MCP servers are registered. Add one to ${mcpRegistryPath()} — AURA does not discover or install servers on its own.` };
      }
      if (connected.length === 0) {
        return { ok: false, detail: `Every registered MCP server failed to connect: ${failed.map((f) => `${f.config.id} (${f.reason})`).join('; ')}` };
      }
      return { ok: true, detail: `${connected.length} MCP server(s) connected, offering ${pool.allTools().length} tool(s).` };
    },
  };
}

/* -- Executors --------------------------------------------------------- */

const ok = (detail: string, output?: unknown): ExecutorResult => ({ ok: true, detail, output });
const no = (detail: string, effectStarted = false): ExecutorResult => ({ ok: false, detail, effectStarted });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function describeConnection(c: McpConnection) {
  return {
    id: c.config.id,
    transport: c.config.transport,
    server: c.info.name,
    version: c.info.version,
    protocolVersion: c.info.protocolVersion,
    connectedAt: c.connectedAt,
    toolCount: c.tools.length,
    note: c.config.note ?? null,
  };
}

const describeTool = (serverId: string, t: McpTool) => ({
  server: serverId,
  name: t.name,
  qualifiedName: `${serverId}/${t.name}`,
  description: t.description,
  inputSchema: t.inputSchema,
});

export function mcpExecutors(pool: McpConnectionPool): Executor[] {
  return [
    {
      capabilityId: 'mcp.list_servers',
      tier: 3,
      async run() {
        const connected = pool.list().map(describeConnection);
        const failed = pool.listFailures().map((f) => ({ id: f.config.id, transport: f.config.transport, reason: f.reason }));
        if (connected.length === 0 && failed.length === 0) {
          return ok(`No MCP servers are registered. They are declared in ${mcpRegistryPath()}; AURA never adds one on its own.`, { connected, failed, registry: mcpRegistryPath() });
        }
        return ok(
          `${connected.length} MCP server(s) connected${failed.length ? `, ${failed.length} failed to connect` : ''}.`,
          { connected, failed, registry: mcpRegistryPath() },
        );
      },
    },

    {
      capabilityId: 'mcp.list_tools',
      tier: 3,
      async run(inv) {
        const serverId = str(inv.input.serverId);
        if (serverId) {
          const c = pool.get(serverId);
          if (!c) {
            const failure = pool.listFailures().find((f) => f.config.id === serverId);
            return no(failure
              ? `MCP server "${serverId}" is registered but did not connect: ${failure.reason}`
              : `No MCP server named "${serverId}" is connected. Registered servers live in ${mcpRegistryPath()}.`);
          }
          const tools = c.tools.map((t) => describeTool(serverId, t));
          return ok(`${tools.length} tool(s) on ${serverId}.`, { tools });
        }
        const tools = pool.allTools().map((e) => describeTool(e.serverId, e.tool));
        return ok(`${tools.length} tool(s) across ${pool.list().length} connected server(s).`, { tools });
      },
    },

    {
      capabilityId: 'mcp.call_tool',
      tier: 3,
      async run(inv) {
        const serverId = str(inv.input.serverId);
        const toolName = str(inv.input.tool);
        const connection = pool.get(serverId);
        if (!connection) {
          const failure = pool.listFailures().find((f) => f.config.id === serverId);
          return no(failure
            ? `MCP server "${serverId}" is registered but did not connect: ${failure.reason}. Nothing was called.`
            : `No MCP server named "${serverId}" is connected, so nothing was called. Registered servers live in ${mcpRegistryPath()}.`);
        }
        const tool = connection.tools.find((t) => t.name === toolName);
        if (!tool) {
          return no(`Server "${serverId}" does not advertise a tool called "${toolName}". It advertises: ${connection.tools.map((t) => t.name).join(', ') || '(none)'}.`);
        }

        let args: Record<string, unknown> = {};
        const rawArgs = inv.input.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          try {
            const parsed = JSON.parse(rawArgs) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              return no('`arguments` must be a JSON object. Nothing was called.');
            }
            args = parsed as Record<string, unknown>;
          } catch (err) {
            return no(`\`arguments\` is not valid JSON: ${(err as Error).message}. Nothing was called.`);
          }
        } else if (rawArgs && typeof rawArgs === 'object') {
          args = rawArgs as Record<string, unknown>;
        }

        /* Validated against the SERVER's schema, before the call. A
           governed, approved invocation is not spent discovering that a
           required field was missing. */
        const violations = validateAgainstSchema(tool.inputSchema, args);
        if (violations.length) {
          return no(
            `Arguments do not match the schema ${serverId} declared for ${toolName}: ` +
            violations.map((v) => `\`${v.path}\` ${v.problem}`).join('; ') + '. Nothing was called.',
          );
        }

        try {
          const result = await connection.client.callTool(toolName, args);
          const item = resultAsContextItem(serverId, toolName, result);
          if (result.isError) {
            /* The tool RAN and said no. That is a result, not a protocol
               failure, and `effectStarted` is true because whatever it did
               before failing, it did. */
            return { ok: false, detail: `${serverId}/${toolName} reported an error: ${result.text.slice(0, 400)}`, effectStarted: true, output: { item, isError: true, text: result.text } };
          }
          return ok(`${serverId}/${toolName} returned ${result.text.length} characters of untrusted output.`, {
            nodeId: `mcp:${serverId}`,
            tier: 3,
            item,
            text: result.text,
            isError: false,
          });
        } catch (err) {
          /* A protocol or transport failure. `effectStarted` is left
             undefined rather than claimed false: a request that timed out
             is the case where the tool most likely DID run and simply
             never reported back, and claiming otherwise would let the
             Fabric auto-retry something irreversible. */
          return { ok: false, detail: `${serverId}/${toolName} failed at the protocol level: ${(err as Error).message}` };
        }
      },
    },
  ];
}
