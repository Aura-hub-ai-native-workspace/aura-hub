/**
 * environment — the Connected Environment's real transport.
 * ==================================================================
 * This is where the architecture stops being a model and touches the
 * machine. Everything here is genuine: `docker --version` really runs,
 * a real version string comes back, and a tool that is absent really is
 * absent. Nothing is simulated and no result is invented.
 *
 * Security boundary — read this before adding anything:
 *
 *   The command and arguments ALWAYS come from the catalog entry looked
 *   up by id, never from the request body. A client can ask "probe the
 *   node called `docker`"; it can never ask "run this string". Combined
 *   with `execFile` (no shell) this means there is no path from an HTTP
 *   request to arbitrary command execution, which matters a great deal
 *   for a service that binds a local port.
 *
 * Probes are cheap but not free, so results are cached briefly. A user
 * who just installed something can force a fresh read with `refresh`.
 */

import { execFile } from 'node:child_process';
import { launchSpec, spawnFlags } from './exec/which';
import { CATALOG, catalogEntry } from '@aura/connected-environment';
import type { CatalogEntry, ProbeResult } from '@aura/connected-environment';

const PROBE_TIMEOUT_MS = 4000;
const HTTP_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30_000;
/** Keep the scan from spawning a hundred processes at once on a laptop. */
const CONCURRENCY = 8;

interface CacheEntry {
  at: number;
  result: ProbeResult;
}

const cache = new Map<string, CacheEntry>();

/**
 * Pull a version out of whatever the tool decided to print. Tools are
 * wildly inconsistent here (`git version 2.43.0`, `Docker version 27.0.3,
 * build ...`, `v20.11.1`, `Python 3.12.3`), so this takes the first
 * dotted number sequence and gives up gracefully rather than guessing.
 */
function extractVersion(output: string): string | undefined {
  const line = output.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return undefined;
  // No leading \b: in `v24.7.0` there is no word boundary between `v` and
  // `2` (both are word characters), so a leading \b would skip the major
  // version entirely and report `7.0`. Match the first digit run instead.
  const match = line.match(/\d+\.\d+(\.\d+)?([-.][0-9A-Za-z.]+)?/);
  return match ? match[0] : line.slice(0, 40);
}

function runProbe(entry: CatalogEntry): Promise<ProbeResult> {
  const probe = entry.probe;
  if (!probe) {
    return Promise.resolve({
      present: false,
      detail: 'No dependable way to detect this tool across platforms, so the Hub does not guess.',
    });
  }
  const started = Date.now();
  /**
   * Resolve the probe command to a real file before spawning it.
   *
   * On Unix this changes nothing — the resolved path is the same program
   * the OS would have found. On Windows it is the difference between a
   * true and a false answer: `gh`, `opencode`, `npm` and everything else
   * npm installs are `.cmd` shims, which Node will not spawn directly, so
   * without this every one of them would report ENOENT and AURA would
   * tell the user a tool they have installed is missing.
   */
  let target;
  try {
    ({ target } = launchSpec(probe.command, probe.args));
  } catch (e) {
    // A catalogue probe the platform's interpreter would rewrite. One
    // unprobeable entry must not take the whole scan down with it.
    return Promise.resolve({
      present: false,
      detail: `${entry.name} could not be probed safely on this platform: ${(e as Error).message}`,
    });
  }
  return new Promise((resolve) => {
    execFile(
      target.file,
      target.args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, ...spawnFlags(target) },
      (error, stdout, stderr) => {
        const latencyMs = Date.now() - started;
        // Several tools (notably `java -version`) print to stderr and some
        // exit non-zero while still being perfectly present, so presence is
        // decided by "did we get recognisable output", not by exit code.
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (output) {
          const version = extractVersion(output);
          resolve({
            present: true,
            version,
            latencyMs,
            detail: version ? `Found ${entry.name} ${version} on this machine.` : `Found ${entry.name} on this machine.`,
          });
          return;
        }
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
          resolve({
            present: false,
            latencyMs,
            detail: `${probe.command} is not on PATH. Install ${entry.name}, or connect something else that provides the same capability.`,
          });
          return;
        }
        resolve({
          present: false,
          latencyMs,
          detail: `${entry.name} did not answer the version check${code ? ` (${code})` : ''}. It may be installed but not on PATH for this session.`,
        });
      },
    );
  });
}

async function runHttpProbe(entry: CatalogEntry): Promise<ProbeResult> {
  const endpoint = entry.endpoint;
  if (!endpoint) {
    return { present: false, detail: 'No endpoint is defined for this node.' };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        present: false,
        latencyMs,
        detail: `${entry.name} is reachable but answered ${res.status}. Start it, or the Hub will route model work elsewhere.`,
      };
    }
    const body = await res.text();
    return {
      present: true,
      latencyMs,
      version: extractVersion(body),
      detail: `${entry.name} is running locally and answering on ${endpoint}.`,
    };
  } catch {
    return {
      present: false,
      latencyMs: Date.now() - started,
      detail: `${entry.name} is not answering on ${endpoint}. Start it and scan again, or connect a hosted provider instead.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one catalogued node. Transports the service cannot complete
 * (OAuth services, credentialed providers) return an honest, non-failing
 * result rather than a fabricated status — the desktop decides how to
 * present them, and `api-key` nodes are answered by the existing BYOAK
 * provider system rather than duplicated here.
 */
export async function probeNode(id: string, refresh = false): Promise<ProbeResult> {
  const entry = catalogEntry(id);
  if (!entry) {
    return { present: false, detail: 'That node is not in the catalog.' };
  }

  if (!refresh) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  }

  let result: ProbeResult;
  switch (entry.transport) {
    case 'local-process':
      result = await runProbe(entry);
      break;
    case 'http':
      result = await runHttpProbe(entry);
      break;
    case 'internal':
      result = { present: true, detail: 'Built into AURA Hub.' };
      break;
    case 'api-key':
      result = {
        present: false,
        detail: 'Connect this provider in AI Settings — the Hub reuses that key rather than asking for a second one.',
      };
      break;
    case 'oauth':
      result = {
        present: false,
        detail: 'Catalogued for planning. No connector has been built for this service yet.',
      };
      break;
  }

  cache.set(id, { at: Date.now(), result });
  return result;
}

/** Run a batch of probes with a bounded number in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface ScanResult {
  results: Record<string, ProbeResult>;
  scannedAt: string;
  /** How many of the scanned nodes were actually found. */
  found: number;
}

/**
 * Scan the machine. By default this only touches nodes the service can
 * genuinely measure (`local-process` with a probe, and `http` with an
 * endpoint) — probing 130 catalog entries to tell the user 90 of them are
 * "not installed" would be noise dressed up as information.
 */
export async function scanEnvironment(ids?: string[], refresh = false): Promise<ScanResult> {
  const entries = (ids?.length ? ids.map(catalogEntry).filter((e): e is CatalogEntry => Boolean(e)) : CATALOG)
    .filter((e) => (e.transport === 'local-process' && e.probe) || (e.transport === 'http' && e.endpoint) || e.transport === 'internal');

  const probed = await mapLimit(entries, CONCURRENCY, (e) => probeNode(e.id, refresh));

  const results: Record<string, ProbeResult> = {};
  let found = 0;
  entries.forEach((entry, i) => {
    results[entry.id] = probed[i];
    if (probed[i].present) found += 1;
  });

  return { results, scannedAt: new Date().toISOString(), found };
}
