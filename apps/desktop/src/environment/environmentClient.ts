/**
 * environmentClient — the desktop's window onto real machine state.
 * ==================================================================
 * Thin fetch wrappers over the local service's `/environment` routes,
 * matching `missionClient.ts` in style (reuse `aiClient.base` rather than
 * re-deriving the URL, resolve rather than throw on transport failure).
 *
 * A failed request here is not an error condition — the service may
 * simply not be running. Every call resolves to an honest "could not
 * measure" result so the environment degrades to "unknown", never to a
 * broken screen or a fabricated status.
 */

import type { ProbeResult } from '@aura/connected-environment';
import { aiClient } from '../ai/aiClient';

const BASE = aiClient.base;

export type ToolStatus = 'verified' | 'unverified' | 'failed' | 'timeout' | 'blocked';

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
  probeCommand?: string | null;
  /** Other names for the same tool, already merged into this entry. */
  aliases: string[];
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

const UNREACHABLE: ProbeResult = {
  present: false,
  detail: 'The local AURA service is not answering, so nothing could be measured. Start it with `npm run ai` and scan again.',
};

/**
 * Scan the machine for the nodes the service can genuinely measure.
 * `ids` narrows the scan; omitting it scans everything measurable.
 */
async function scan(ids?: string[], refresh = false): Promise<ScanOutcome> {
  try {
    const res = await fetch(`${BASE}/environment/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, refresh }),
      // A full scan runs many subprocesses. Without a deadline a wedged
      // backend leaves the UI saying "Scanning…" for the rest of the session.
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `The local AURA service answered ${res.status}.` };
    return { ok: true, response: (await res.json()) as ScanResponse };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'TimeoutError';
    return {
      ok: false,
      reason: aborted
        ? 'The scan did not finish in time, so nothing was measured.'
        : UNREACHABLE.detail,
    };
  }
}

/** Probe one node. Used by Connect, where the user is waiting on a result. */
async function probe(id: string, refresh = true): Promise<ProbeResult> {
  try {
    const res = await fetch(`${BASE}/environment/probe`, {
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
  const res = await fetch(`${BASE}/environment/install`, {
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
  const res = await fetch(`${BASE}/environment/connect`, {
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

export const environmentClient = { scan, probe, install, connectDirect };
