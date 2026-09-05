/**
 * environmentClient — the desktop's window onto real machine state.
 * ==================================================================
 * Thin fetch wrappers over the `/environment` routes of the canonical
 * Python backend, resolving rather than throwing on transport failure.
 *
 * ONE origin, deliberately. The Python backend is the sole authority on
 * what is installed on this machine: it owns discovery, the inventory,
 * the safe-probe boundary and install/connect. The Node AI service keeps
 * its own `/environment/scan` and `/environment/probe` for the Fabric's
 * internal view of node availability, and it has no `/environment/install`,
 * no `/environment/connect` and no inventory at all — so a client that
 * split these calls across the two origins would silently 404 half of
 * them and read machine state from a backend that does not collect it.
 * Every route below therefore goes to `ENVIRONMENT_BASE`, and the desktop
 * shell is what makes that origin exist (src-tauri/src/service.rs).
 *
 * The Node scan was not merely a second opinion, it was an incomplete one:
 * it returns `results` and nothing else, while this screen also renders
 * discovery evidence, package sources, OS packages and known-but-absent
 * nodes — fields only the Python scan produces. Those panels were reading
 * a payload that never carried them.
 *
 * One consequence, recorded rather than hidden: the Node service refreshed
 * its Fabric's node-availability set whenever the desktop asked it to
 * scan. It no longer receives that request, so that set is now as fresh as
 * its own start-up scan. Restoring the refresh would mean scanning the
 * machine twice, from two backends, to keep a cache in one of them
 * current — which is the coupling this file exists to remove.
 *
 * A failed request here is not an error condition — the backend may
 * simply not be running. Every call resolves to an honest "could not
 * measure" result so the environment degrades to "unknown", never to a
 * broken screen or a fabricated status.
 */

import type { ProbeResult } from '@aura/connected-environment';

const ENV = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * The canonical Python backend. `VITE_ENVIRONMENT_URL` overrides it for a
 * developer running the backend somewhere else; the default is the port
 * the desktop shell supervises (`service::PYTHON_PORT`).
 */
export const ENVIRONMENT_BASE =
  ENV.VITE_ENVIRONMENT_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4320';

export type ToolStatus =
  | 'verified'
  | 'unverified'
  | 'failed'
  | 'timeout'
  | 'blocked'
  /** The file changed between being vetted and being run; nothing ran. */
  | 'tampered';

export interface DiscoveredTool {
  id: string;
  name: string;
  executable: string;
  /** Symlinks followed. Two names sharing this are one tool. */
  realPath: string;
  source: string;
  status: ToolStatus;
  present: boolean;
  version?: string | null;
  detail: string;
  latencyMs?: number | null;
  category: string;
  /** How it got here: npm-global, pipx, cargo, venv, os-package, unknown. */
  origin: string;
  package?: string | null;
  manager?: string | null;
  /** The owning package's own claim, kept beside the executable's. */
  packageVersion?: string | null;
  /** The two disagree — usually a stale shim or a second copy on PATH. */
  versionConflict?: boolean;
  probeCommand?: string | null;
  /** Other names for the same tool, already merged into this entry. */
  aliases: string[];
  /** Same-named files further along PATH that this one takes precedence over. */
  shadowed: string[];
  /** False when AURA deliberately did not run it. */
  executed: boolean;
}

export interface PackageEvidence {
  manager: string;
  package: string;
  version?: string | null;
  executable?: string | null;
}

export interface OsPackage {
  manager: string;
  package: string;
  version?: string | null;
}

/** How complete one inventory is. Truncation is stated, never implied. */
export interface InventoryMeta {
  manager: string | null;
  available: boolean;
  returned: number;
  total: number;
  truncated: boolean;
  error?: string | null;
}

export interface DiscoveryMeta {
  /** Discovery failed and an older answer is being shown instead. */
  degraded?: boolean;
  /** Every program found on PATH, whether or not it is listed. */
  totalCandidates: number;
  /** How many were executed to establish a version. */
  scannedCandidates: number;
  /** How many are present in `discovered`. */
  reportedCandidates?: number;
  truncated: boolean;
  directoriesScanned: number;
  skippedDirectories: { directory: string; reason: string }[];
}

export interface NotInstalledNode {
  id: string;
  name: string;
  category: string;
  homepage: string;
  reason: string;
  detail: string;
  installable: boolean;
}

export interface ScanResponse {
  results: Record<string, ProbeResult>;
  scannedAt: string;
  found: number;
  discovered?: DiscoveredTool[];
  discoveredCount?: number;
  verifiedCount?: number;
  discovery?: DiscoveryMeta;
  packages?: PackageEvidence[];
  packagesCount?: number;
  packageSources?: InventoryMeta[];
  osPackages?: OsPackage[];
  osPackagesCount?: number;
  osInventory?: InventoryMeta;
  notInstalled?: NotInstalledNode[];
  notInstalledCount?: number;
}

/**
 * A scan either measured the machine or it did not. Collapsing "the service
 * is down" into an empty successful result is what let the UI show the
 * previous scan's data under a freshly-stamped "last scanned" time.
 */
export type ScanOutcome =
  | { ok: true; response: ScanResponse }
  | { ok: false; reason: string };

/* ── complete machine inventory ─────────────────────────────────── */

export type ItemKind =
  | 'application'
  | 'cli'
  | 'runtime'
  | 'sdk'
  | 'library'
  | 'package'
  | 'unknown';

export type TrustLevel = 'trusted' | 'untrusted' | 'blocked' | 'unknown';

export interface InventoryEvidence {
  source: string;
  kind: string;
  package?: string | null;
  version?: string | null;
  location?: string | null;
  detail: string;
}

/**
 * One installed thing, however many sources reported it. The five states are
 * deliberately separate: a package database establishes `installed` without
 * anything being executed, and only a safe probe establishes `verified`.
 */
export interface InventoryEntry {
  id: string;
  name: string;
  displayName: string;
  kind: ItemKind;
  category: string;
  version: string | null;
  versions: string[];
  versionConflict: boolean;
  installLocation: string | null;
  executablePath: string | null;
  command: string | null;
  packageManager: string | null;
  packageName: string | null;
  packageVersion: string | null;
  publisher: string | null;
  description: string | null;
  installed: boolean;
  detected: boolean;
  verified: boolean;
  usable: boolean;
  connected: boolean;
  executionAllowed: boolean;
  executionPerformed: boolean;
  trustLevel: TrustLevel;
  trustReason: string;
  origin: string | null;
  detail: string | null;
  aliases: string[];
  shadowed: string[];
  sources: string[];
  evidence: InventoryEvidence[];
  catalogId: string | null;
  lastSeen: string;
}

/** How completely one source was able to answer. */
export interface InventorySource {
  name: string;
  kind: string;
  available: boolean;
  items: number;
  total: number;
  truncated: boolean;
  durationMs: number;
  error?: string | null;
  detail?: string | null;
}

export interface InventoryCounts {
  total: number;
  installed: number;
  detected: number;
  verified: number;
  usable: number;
  connected: number;
  applications: number;
  cli: number;
  runtimes: number;
  libraries: number;
  packages: number;
}

export interface InventoryResponse {
  items: InventoryEntry[];
  /** How many matched, not how many were returned. */
  total: number;
  returned: number;
  offset: number;
  truncated: boolean;
  counts: InventoryCounts;
  sources: InventorySource[];
  collectedAt: string;
  durationMs: number;
  degraded: boolean;
}

export type InventoryOutcome =
  | { ok: true; response: InventoryResponse }
  | { ok: false; reason: string };

export type InstallOutcome = 'installed' | 'guided' | 'failed' | 'unverified' | 'unavailable';

export interface InstallResponse {
  installOutcome: InstallOutcome;
  nodeId: string;
  privilege: 'user' | 'root';
  requiresUserAction: boolean;
  command?: string;
  why?: string;
  detail?: string;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  probe?: ProbeResult;
}

export interface ConnectResponse {
  connected: boolean;
  result: ProbeResult;
  detail: string;
}

/** Generous: the backend's own probe budget is 12s per tool. */
const SCAN_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 30_000;
/** A cold inventory reads every package database on the machine. */
const INVENTORY_TIMEOUT_MS = 120_000;

/**
 * One sentence, used everywhere the backend does not answer.
 *
 * It names the backend that is actually missing and the command that
 * starts it. The previous text pointed at `npm run ai` — the Node AI
 * service — which is the wrong instruction: that service does not collect
 * machine state, so following it changed nothing while looking like a fix.
 */
const UNREACHABLE_DETAIL =
  `The Python environment backend is not answering on ${ENVIRONMENT_BASE}, so nothing `
  + 'could be measured. Start it with `npm run environment:api` and scan again.';

const UNREACHABLE: ProbeResult = {
  present: false,
  detail: UNREACHABLE_DETAIL,
};

/**
 * Scan the machine for the nodes the service can genuinely measure.
 * `ids` narrows the scan; omitting it scans everything measurable.
 */
async function scan(ids?: string[], refresh = false): Promise<ScanOutcome> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/environment/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, refresh }),
      // A full scan runs many subprocesses. Without a deadline a wedged
      // backend leaves the UI saying "Scanning…" for the rest of the session.
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `The Python environment backend answered ${res.status}.` };
    return { ok: true, response: (await res.json()) as ScanResponse };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'TimeoutError';
    return {
      ok: false,
      reason: aborted
        ? 'The scan did not finish in time, so nothing was measured.'
        : UNREACHABLE_DETAIL,
    };
  }
}

/** Probe one node. Used by Connect, where the user is waiting on a result. */
async function probe(id: string, refresh = true): Promise<ProbeResult> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/environment/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, refresh }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return UNREACHABLE;
    const body = (await res.json()) as { result?: ProbeResult };
    return body.result ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

async function install(id: string): Promise<InstallResponse> {
  const res = await fetch(`${ENVIRONMENT_BASE}/environment/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const body = (await res.json()) as InstallResponse & { error?: string };
  if (!res.ok) {
    // Guided/unavailable still come with 400 but carry payload
    if (body.installOutcome) return body;
    throw new Error(body.error || body.detail || `Install failed (${res.status})`);
  }
  return body;
}

async function connectDirect(id: string): Promise<ConnectResponse> {
  const res = await fetch(`${ENVIRONMENT_BASE}/environment/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const body = (await res.json()) as ConnectResponse & { error?: string };
  if (!res.ok) {
    if (body.result) return body as ConnectResponse;
    throw new Error(body.error || `Connect failed (${res.status})`);
  }
  return body as ConnectResponse;
}

/* ────── complete machine inventory ─────────────────────────────────── */
async function inventory(options: {
  refresh?: boolean;
  offset?: number;
  limit?: number;
  kinds?: ItemKind[];
  query?: string;
  verify?: boolean;
} = {}): Promise<InventoryOutcome> {
  try {
    const res = await fetch(`${ENVIRONMENT_BASE}/environment/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: "The Python environment backend answered " + res.status };
    return { ok: true, response: (await res.json()) as InventoryResponse };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "TimeoutError";
    return {
      ok: false,
      reason: aborted
        ? "Reading the machine inventory did not finish in time."
        : UNREACHABLE_DETAIL,
    };
  }
}

export const environmentClient = { scan, probe, install, connectDirect, inventory };
