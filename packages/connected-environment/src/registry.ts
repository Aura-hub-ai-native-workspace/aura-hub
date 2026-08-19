/**
 * registry — the live state of every node, as pure transitions.
 * ==================================================================
 * Deliberately not a store. Every function here takes state and returns
 * new state, so the same logic drives the desktop's Zustand store, a
 * headless runner, or a test with no host at all. All I/O happens in a
 * NodeTransport the caller owns; this file only interprets the results.
 *
 * The state machine:
 *
 *          ┌──────────── probe ────────────┐
 *          ▼                               │
 *   unknown ──▶ available ──▶ connected ──▶ degraded
 *          ├──▶ not-installed                  │
 *          ├──▶ needs-auth ───────────────────┘
 *          └──▶ no-connector   (terminal until a connector is built)
 *
 * `no-connector` is the honest terminal state and the reason this
 * architecture can catalogue 100+ systems without lying about any of
 * them: a node in that state is fully plannable and recommendable, and
 * visibly not connectable.
 */

import type { CapabilityId } from './capabilities';
import { CATALOG, isConnectable } from './catalog';
import type {
  CatalogEntry,
  EnvironmentNode,
  NodeActivity,
  NodeHealth,
  NodeLogEntry,
  NodePermissions,
  NodeStatus,
  ProbeResult,
} from './types';

const MAX_LOG = 60;

let logSeq = 0;
function logId(): string {
  logSeq += 1;
  return `log${Date.now().toString(36)}${logSeq}`;
}

/**
 * Least-privilege defaults. A node starts able to observe and, where it is
 * a local tool the user chose to install, to execute — but never to write
 * project files and never to act without confirmation. Widening any of
 * these is an explicit user action.
 */
export function defaultPermissions(entry: CatalogEntry): NodePermissions {
  return {
    read: true,
    write: false,
    execute: entry.transport === 'local-process' || entry.transport === 'internal',
    autonomous: false,
  };
}

/** The state a node holds before anything has been measured. */
export function initialHealth(entry: CatalogEntry): NodeHealth {
  const at = new Date().toISOString();
  if (entry.transport === 'internal') {
    return { status: 'connected', detail: 'Built into AURA Hub — always available.', checkedAt: at };
  }
  if (!isConnectable(entry)) {
    return {
      status: 'no-connector',
      detail:
        entry.transport === 'oauth'
          ? 'Catalogued for planning. A connector for this service has not been built yet, so missions can name it but the Hub cannot drive it.'
          : 'Catalogued for planning. This tool has no dependable command to detect it across platforms, so the Hub does not guess at its presence.',
      checkedAt: at,
    };
  }
  return { status: 'unknown', detail: 'Not checked yet in this session.', checkedAt: at };
}

export function createNode(entry: CatalogEntry): EnvironmentNode {
  const health = initialHealth(entry);
  return {
    id: entry.id,
    entry,
    health,
    permissions: defaultPermissions(entry),
    activity: [],
    log: [],
    connected: health.status === 'connected',
  };
}

/** The full environment, every node in its pre-measurement state. */
export function createEnvironment(): EnvironmentNode[] {
  return CATALOG.map(createNode);
}

/**
 * Interpret a probe. A missing tool is a normal, expected result — it
 * produces `not-installed` with a next step, never an error state.
 */
export function statusFromProbe(entry: CatalogEntry, result: ProbeResult): NodeStatus {
  if (!result.present) {
    if (entry.transport === 'http') return 'not-installed';
    if (entry.auth === 'oauth' || entry.auth === 'api-key') return 'needs-auth';
    return 'not-installed';
  }
  if (entry.auth === 'cli-session' || entry.auth === 'api-key' || entry.auth === 'oauth') {
    // Present on the machine, but the Hub has not verified a session. The
    // node is usable for anything unauthenticated and honest about the rest.
    return 'available';
  }
  return 'available';
}

export function applyProbe(node: EnvironmentNode, result: ProbeResult): EnvironmentNode {
  if (node.health.status === 'no-connector') return node;
  const status = statusFromProbe(node.entry, result);
  const health: NodeHealth = {
    status: node.connected && status === 'available' ? 'connected' : status,
    detail: result.detail,
    version: result.version ?? node.health.version,
    latencyMs: result.latencyMs,
    checkedAt: new Date().toISOString(),
  };
  return {
    ...node,
    health,
    connected: node.connected && status === 'available',
    log: appendLog(node.log, result.present ? 'info' : 'warn', result.detail),
  };
}

/** Mark a node connected after a successful handshake. */
export function applyConnect(node: EnvironmentNode, result: ProbeResult): EnvironmentNode {
  if (!result.present) {
    return {
      ...node,
      connected: false,
      health: {
        status: statusFromProbe(node.entry, result),
        detail: result.detail,
        version: node.health.version,
        checkedAt: new Date().toISOString(),
      },
      log: appendLog(node.log, 'warn', result.detail),
    };
  }
  return {
    ...node,
    connected: true,
    health: {
      status: 'connected',
      detail: result.detail,
      version: result.version ?? node.health.version,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
    },
    log: appendLog(node.log, 'info', `Connected. ${result.detail}`),
  };
}

export function applyDisconnect(node: EnvironmentNode): EnvironmentNode {
  if (node.entry.transport === 'internal') return node;
  return {
    ...node,
    connected: false,
    health: {
      ...node.health,
      status: node.health.status === 'connected' ? 'available' : node.health.status,
      detail: 'Disconnected. Reconnect whenever you need it again.',
      checkedAt: new Date().toISOString(),
    },
    activity: [],
    log: appendLog(node.log, 'info', 'Disconnected by the user.'),
  };
}

export function appendLog(log: NodeLogEntry[], level: NodeLogEntry['level'], message: string): NodeLogEntry[] {
  const next = [...log, { id: logId(), at: new Date().toISOString(), level, message }];
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
}

/**
 * The single entry point for work appearing on a node. Nothing calls it
 * yet — no transport implements `execute` (see the desktop's
 * transports.ts), so `activity` is always empty and the cards that render
 * it render nothing. That is the honest state of the system, not an
 * oversight: the moment an executor lands, it calls this and the live
 * cards start moving with no other change.
 */
export function upsertActivity(node: EnvironmentNode, entry: NodeActivity): EnvironmentNode {
  const idx = node.activity.findIndex((a) => a.id === entry.id);
  const activity = idx >= 0
    ? node.activity.map((a) => (a.id === entry.id ? entry : a))
    : [...node.activity, entry];
  return { ...node, activity };
}

export function setPermissions(node: EnvironmentNode, partial: Partial<NodePermissions>): EnvironmentNode {
  return { ...node, permissions: { ...node.permissions, ...partial } };
}

/* ── querying the environment ───────────────────────────────────── */

/** Nodes that are connected *right now* and provide `capability`. */
export function connectedProviders(nodes: EnvironmentNode[], capability: CapabilityId): EnvironmentNode[] {
  return nodes.filter((n) => n.connected && n.entry.capabilities.includes(capability));
}

/** A one-line summary for the environment header. */
export function environmentSummary(nodes: EnvironmentNode[]): {
  connected: number;
  available: number;
  catalogued: number;
  running: number;
} {
  let connected = 0;
  let available = 0;
  let running = 0;
  for (const n of nodes) {
    if (n.connected) connected += 1;
    else if (n.health.status === 'available') available += 1;
    running += n.activity.filter((a) => a.state === 'running').length;
  }
  return { connected, available, catalogued: nodes.length, running };
}
