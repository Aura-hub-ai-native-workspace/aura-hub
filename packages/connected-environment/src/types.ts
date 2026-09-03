/**
 * types — the Connected Environment domain model.
 * ==================================================================
 * SCOPE (post-consolidation — see docs/CONSOLIDATION_MAP.md):
 *
 * This package answers exactly one question: **what can this machine
 * actually do right now, and through what.** It owns nodes, their
 * capabilities, their health and their permissions.
 *
 * It deliberately does NOT own:
 *   • missions      → `MissionRecord`      (ai-service/src/mission/types.ts)
 *   • task graphs   → `ExecutionDag`       (ai-service/src/mission/execution)
 *   • task states   → `ExecutionTaskStatus`(ai-service/src/mission/execution)
 *   • intent        → `IntentClassification`/`ExtractedIntent`
 *   • process spawn → `safeShell`/`git`    (ai-service/src/workflow/nodes.ts)
 *
 * Those all already exist and are authoritative. A second copy of any of
 * them was removed from this package rather than maintained alongside.
 *
 * Nothing here imports React, Node, or any host API — the domain must be
 * usable from the desktop app, the local service, or a test unchanged.
 */

import type { CapabilityId } from './capabilities';

/* ══════════════════════════════════════════════════════════════════
   1. Nodes
   ══════════════════════════════════════════════════════════════════ */

export type NodeCategory =
  | 'development'
  | 'cloud'
  | 'design'
  | 'productivity'
  | 'ai'
  | 'browser'
  | 'hub';

/**
 * How the Hub actually reaches a system. This is the honesty boundary of
 * the whole architecture — a node's transport says exactly how real its
 * connection is, and the UI never claims more than the transport can do.
 *
 *   internal       — an AURA subsystem, reached through `WorkspaceManager`.
 *                    Always live, no auth, no network.
 *   local-process  — a program on this machine, probed and run through the
 *                    local service bridge. Real detection, real versions.
 *   http           — a documented HTTP endpoint reachable without user
 *                    credentials (health/version probes only).
 *   api-key        — needs a user-supplied key. The Hub can hold and route
 *                    it, but only where a real client exists.
 *   oauth          — needs an OAuth app registration that this project does
 *                    not have. Catalogued and plannable, not connectable.
 */
export type TransportKind = 'internal' | 'local-process' | 'http' | 'api-key' | 'oauth';

export type AuthKind = 'none' | 'cli-session' | 'api-key' | 'oauth';

export type LicenseKind = 'open-source' | 'free-tier' | 'commercial';

/**
 * A catalog entry is *knowledge about a system*, independent of whether
 * this machine has it. It never changes at runtime.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  category: NodeCategory;
  /** What this system can do. Drives all routing and tool discovery. */
  capabilities: CapabilityId[];
  transport: TransportKind;
  auth: AuthKind;
  license: LicenseKind;
  /** Runs on Windows, macOS and Linux alike. */
  crossPlatform: boolean;
  /** Actively maintained upstream, to the best of the catalog's knowledge. */
  maintained: boolean;
  /** One line the UI can show without needing a network call. */
  summary: string;
  homepage: string;
  /**
   * For `local-process` nodes: the command to probe and the argument that
   * makes it print a version. Absent for every other transport.
   */
  probe?: { command: string; args: string[] };
  /** For `http` nodes: a public endpoint that answers a liveness check. */
  endpoint?: string;
  /**
   * How AURA could install this, if it can (§25).
   *
   * Optional on purpose: an entry without it is simply not installable by
   * AURA and says so. Absence is an honest answer, not a gap to paper over
   * with a guessed package name.
   */
  install?: InstallSpec;
}

/**
 * How a tool is installed — catalogue knowledge, never request input.
 *
 * The package name lives here rather than travelling with the invocation.
 * That is the whole security argument for `system.install`: the caller
 * names a NODE, and the command is assembled from trusted data. It mirrors
 * the same invariant that keeps probing safe.
 */
export interface InstallSpec {
  method: InstallMethod;
  /** The package as its own ecosystem names it. */
  package: string;
  /**
   * The privilege floor declared by the catalogue.
   *
   * A FLOOR, not a verdict. `npm-global` is userspace on a machine whose
   * npm prefix is user-owned and root on one where it is `/usr`, so the
   * runtime probes writability and may only ever RAISE this (§25.2 C1).
   * Nothing may lower it — escalation is safe, de-escalation is not.
   */
  privilege: InstallPrivilege;
  /** Package name per distro where it differs from `package`. */
  distro?: Record<string, string>;
}

export type InstallMethod =
  | 'npm-global'
  | 'pipx'
  | 'cargo'
  | 'gh-extension'
  | 'system-package';

export type InstallPrivilege = 'user' | 'root';

/**
 * The live state of one node. Every field is either measured or explicitly
 * unknown — nothing here is ever optimistic.
 */
export type NodeStatus =
  /** Never probed in this session. */
  | 'unknown'
  /** Probed and present, ready to be connected. */
  | 'available'
  /** Connected and usable right now. */
  | 'connected'
  /** Reachable but reporting a problem (e.g. daemon down). */
  | 'degraded'
  /** Probed and genuinely not present on this machine. */
  | 'not-installed'
  /**
   * A governed install is running right now (§25).
   *
   * The one forward transition out of `not-installed`, and deliberately
   * transient: it is never persisted and never a resting state. Only a
   * real post-install probe moves a node on to `available`, so this can
   * never be mistaken for "installed".
   */
  | 'installing'
  /** Present but needs credentials the Hub does not hold. */
  | 'needs-auth'
  /** Catalogued, but no connector has been built for it yet. */
  | 'no-connector';

export interface NodeHealth {
  status: NodeStatus;
  /** Plain-language, forward-moving explanation. Never a bare error. */
  detail: string;
  /** Version string when the probe produced one. */
  version?: string;
  /** Probe round-trip in ms, when measured. */
  latencyMs?: number;
  checkedAt: string;
  /**
   * Evidence from the last probe. `status` keeps the distinctions
   * `NodeStatus` collapses (a timeout is not an absence), and the remaining
   * fields say *what* was measured — the file that answered and the package
   * that installed it — so the UI can show provenance instead of asserting
   * a version from nowhere.
   */
  probeStatus?: ProbeStatus;
  executable?: string;
  origin?: string;
  package?: string;
  manager?: string;
}

export type ActivityState = 'queued' | 'running' | 'succeeded' | 'blocked' | 'idle';

/**
 * One unit of work a node is currently carrying. `missionId`/`taskId`
 * reference the **existing** `MissionRecord`/`MissionTask` ids — this is a
 * pointer into the authoritative mission model, never a copy of it.
 */
export interface NodeActivity {
  id: string;
  missionId: string;
  taskId: string;
  label: string;
  state: ActivityState;
  /** 0–100. Derived from real execution progress, never invented. */
  progress: number;
  startedAt: string;
  endedAt?: string;
}

export interface NodeLogEntry {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Permissions are declared per node and checked by the policy engine
 * before every invocation. An execution layer without a permission model
 * is a liability.
 */
export interface NodePermissions {
  /** May the node read project files? */
  read: boolean;
  /** May the node modify project files? */
  write: boolean;
  /** May the node run commands / make outbound calls? */
  execute: boolean;
  /** May the node act without a per-action human confirmation? */
  autonomous: boolean;
}

export interface EnvironmentNode {
  /** Same id as the catalog entry it instantiates. */
  id: string;
  entry: CatalogEntry;
  health: NodeHealth;
  permissions: NodePermissions;
  /** Work currently bound to this node. */
  activity: NodeActivity[];
  log: NodeLogEntry[];
  /** True once the user has explicitly connected it. */
  connected: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   2. Transports — the only place side effects enter the domain
   ══════════════════════════════════════════════════════════════════ */

/**
 * The distinct conclusions a probe can reach. `present` alone cannot carry
 * them: a tool that timed out and a tool that is genuinely absent are both
 * "not present", and only one of them should be reported as not installed.
 */
export type ProbeStatus =
  | 'verified'
  | 'unverified'
  | 'not-found'
  | 'failed'
  | 'timeout'
  | 'blocked'
  | 'internal'
  | 'needs-auth'
  | 'unsupported';

export interface ProbeResult {
  present: boolean;
  version?: string;
  latencyMs?: number;
  /** Why the probe concluded what it concluded. Shown verbatim to users. */
  detail: string;
  /** Present on results from the Python backend; absent from older fakes. */
  status?: ProbeStatus;
  /** The file that was actually run, so a PATH surprise is visible. */
  executable?: string;
  exitCode?: number;
  /** Which package installed that file, when one can be named. */
  origin?: string;
  package?: string;
  manager?: string;
}

/**
 * A transport is the *only* way this package touches the outside world.
 * The desktop supplies an implementation backed by the local service; a
 * test supplies a fake. Nothing else here performs I/O.
 *
 * Note there is no `execute` here. Running work is the Capability
 * Fabric's job (`@aura/capability-fabric`), which is policy-gated,
 * verified and audited; a transport only establishes whether a node is
 * reachable. Keeping the two separate is what stops "can I see it" from
 * silently becoming "may I drive it".
 */
export interface NodeTransport {
  kind: TransportKind;
  /** Determine whether the system exists and is usable. */
  probe(entry: CatalogEntry): Promise<ProbeResult>;
  /**
   * Perform the connection handshake. For `local-process` this is a probe;
   * for credentialed transports it is where a key/token is exchanged.
   * Returning `present: false` is a normal, expected outcome — not an error.
   */
  connect(entry: CatalogEntry, secret?: string): Promise<ProbeResult>;
}

/* ══════════════════════════════════════════════════════════════════
   3. Tool discovery
   ══════════════════════════════════════════════════════════════════ */

export interface Candidate {
  entry: CatalogEntry;
  /** 0–100. Higher is a better fit — see resolver.ts for the weighting. */
  score: number;
  /** Why this candidate ranked where it did, in plain language. */
  rationale: string[];
  /** Whether the Hub can actually complete a connection for it today. */
  connectable: boolean;
}

export interface CapabilityGap {
  capability: CapabilityId;
  /**
   * Ids of the **existing** `MissionTask`s waiting on this capability.
   * Empty when the gap was computed from a capability list rather than a
   * live mission.
   */
  taskIds: string[];
  /** Ranked options, best first. Empty only if the catalog knows nothing. */
  candidates: Candidate[];
  /** The forward-moving sentence the UI shows. Never a dead end. */
  message: string;
}

/* ══════════════════════════════════════════════════════════════════
   4. Agent roles — accountability labels only
   ══════════════════════════════════════════════════════════════════
   These do NOT schedule anything. Ordering is `ExecutionDag`'s job and
   `MissionTask.owner`/`automationLevel` already say who runs a task.
   A role is metadata on a fabric invocation so the audit log can answer
   "which specialist was accountable for this action".
   ══════════════════════════════════════════════════════════════════ */

export type AgentRole =
  | 'planner'
  | 'architect'
  | 'designer'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'security'
  | 'testing'
  | 'devops'
  | 'deployment'
  | 'documentation'
  | 'reviewer'
  | 'debugger'
  | 'optimizer';
