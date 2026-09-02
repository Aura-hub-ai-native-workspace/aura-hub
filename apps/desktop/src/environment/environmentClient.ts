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

export interface ScanResponse {
  results: Record<string, ProbeResult>;
  scannedAt: string;
  found: number;
}

const UNREACHABLE: ProbeResult = {
  present: false,
  detail: 'The local AURA service is not answering, so nothing could be measured. Start it with `npm run ai` and scan again.',
};

/**
 * Scan the machine for the nodes the service can genuinely measure.
 * `ids` narrows the scan; omitting it scans everything measurable.
 */
async function scan(ids?: string[], refresh = false): Promise<ScanResponse> {
  try {
    const res = await fetch(`${BASE}/environment/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, refresh }),
    });
    if (!res.ok) return { results: {}, scannedAt: new Date().toISOString(), found: 0 };
    return (await res.json()) as ScanResponse;
  } catch {
    return { results: {}, scannedAt: new Date().toISOString(), found: 0 };
  }
}

/** Probe one node. Used by Connect, where the user is waiting on a result. */
async function probe(id: string, refresh = true): Promise<ProbeResult> {
  try {
    const res = await fetch(`${BASE}/environment/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, refresh }),
    });
    if (!res.ok) return UNREACHABLE;
    const body = (await res.json()) as { result?: ProbeResult };
    return body.result ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

export const environmentClient = { scan, probe };
