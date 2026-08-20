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
import { launchSpec, resolveExecutable, spawnFlags } from './exec/which';
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

/* ══════════════════════════════════════════════════════════════════
   Application discovery
   ══════════════════════════════════════════════════════════════════

   The second thing this module measures, and it lives HERE rather than
   in a module of its own for one reason: there is exactly one
   environment scanner in this codebase, and adding a second file that
   also spawns probes to decide what is on the machine would make that
   sentence false. `scanEnvironment` answers "which catalogued nodes are
   present"; `scanApplications` answers "which catalogued applications
   are present". Same authority, same cache discipline, same refusal to
   guess.

   Two properties carried over deliberately from the node probes above:

     • The command and its arguments come from the adapter looked up by
       id, never from a request body. A client may ask "discover the
       applications AURA knows about"; it can never ask "run this
       string". With `execFile` and no shell, there remains no path from
       an HTTP request to arbitrary execution.

     • Absence is a real answer. Most applications are absent from most
       machines. Nothing here infers presence from a plausible name.

   And one that is new: **sensitivity is assigned here, at the scanner.**
   The adapter declares what observing it discloses; the scanner stamps
   that onto every record it produces and reports the highest sensitivity
   the scan actually reached. A caller that asked for an inventory and
   swept a confidential entry is told so, whether or not that entry was
   found — because looking is the part that happened. */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  APPLICATION_ADAPTERS,
  applicationAdapter,
  higherSensitivity,
  targetPlatformOf,
  type ApplicationAdapter,
  type ApplicationScan,
  type DetectionSource,
  type DiscoveredApplication,
  type ObservationSensitivity,
} from '@aura/connected-environment';
import { desktopTierRegistry } from './desktop/drivers';
import { runDesktopCommand } from './desktop/session';

/** One positive detection: what answered, and the evidence for it. */
type Hit = { via: DetectionSource; evidence: string } | null;

/** Directory listing that treats "not there" and "not readable" alike. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * XDG application directories, in specification precedence order.
 *
 * `$XDG_DATA_HOME` first (the user's own installs win), then
 * `$XDG_DATA_DIRS`. Both have defaults that must be applied when unset —
 * and on this project's development machine `XDG_DATA_DIRS` IS unset,
 * so a scanner that skipped the default would find nothing at all in
 * `/usr/share/applications` and report a machine full of software as
 * empty.
 */
function xdgApplicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [dataHome, ...dataDirs].map((d) => join(d, 'applications'));
}

function detectLinux(adapter: ApplicationAdapter): Hit {
  const spec = adapter.detect.linux;
  if (!spec) return null;

  for (const dir of xdgApplicationDirs()) {
    const files = new Set(listDir(dir));
    for (const entry of spec.desktopEntries ?? []) {
      const file = `${entry}.desktop`;
      if (files.has(file)) return { via: 'desktop-entry', evidence: join(dir, file) };
    }
  }
  for (const binary of spec.binaries ?? []) {
    const resolved = resolveExecutable(binary);
    if (resolved) return { via: 'path-binary', evidence: resolved };
  }
  return null;
}

/**
 * macOS detection, Launch Services first.
 *
 * `path to application id` in AppleScript is the scriptable face of
 * `LSCopyApplicationURLsForBundleIdentifier` — it asks the same database
 * the Finder uses, so it finds a bundle wherever the user actually put
 * it. Listing `/Applications` is only the fallback, because a listing
 * finds a bundle in exactly one place and users move bundles.
 *
 * `~/Applications` is included in the fallback for the same reason the
 * Windows branch reads `HKCU`: a per-user install is invisible to the
 * machine-wide location, and reporting it absent is a confident wrong
 * answer about somebody's own machine.
 */
async function detectDarwin(adapter: ApplicationAdapter): Promise<Hit> {
  const spec = adapter.detect.darwin;
  if (!spec) return null;

  const osascript = resolveExecutable('osascript');
  if (osascript) {
    for (const bundleId of spec.bundleIds ?? []) {
      const out = await runDesktopCommand(osascript, [
        '-e',
        `POSIX path of (path to application id ${JSON.stringify(bundleId)})`,
      ]);
      // Launch Services answers a path or errors; an error arrives as a
      // message on stderr, which is never a path, so a leading slash is
      // the test rather than mere non-emptiness.
      if (out && out.startsWith('/')) return { via: 'app-bundle', evidence: out };
    }
  }

  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    const files = new Set(listDir(dir));
    for (const name of spec.appNames ?? []) {
      if (files.has(`${name}.app`)) return { via: 'app-bundle', evidence: join(dir, `${name}.app`) };
    }
  }

  for (const binary of spec.binaries ?? []) {
    const resolved = resolveExecutable(binary);
    if (resolved) return { via: 'path-binary', evidence: resolved };
  }
  return null;
}

/**
 * The three uninstall keys Windows actually uses.
 *
 * All three, always. `HKLM` alone misses every per-user install;
 * `WOW6432Node` alone misses every 64-bit one; `HKCU` is where a
 * user-scope installer (which is what VS Code and Cursor default to)
 * writes. Reading fewer than three is how a scanner confidently tells
 * somebody the editor they are reading this in is not installed.
 */
const UNINSTALL_KEYS = [
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function startMenuDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  if (env.ProgramData) dirs.push(join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

/** Every `.lnk` under a Start Menu tree, which is nested by publisher. */
function walkShortcuts(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const name of listDir(dir)) {
    const full = join(dir, name);
    if (name.toLowerCase().endsWith('.lnk')) out.push(full);
    else if (!name.includes('.')) out.push(...walkShortcuts(full, depth + 1));
  }
  return out;
}

async function detectWin32(adapter: ApplicationAdapter): Promise<Hit> {
  const spec = adapter.detect.win32;
  if (!spec) return null;

  const reg = resolveExecutable('reg');
  if (reg && spec.uninstallNames?.length) {
    for (const key of UNINSTALL_KEYS) {
      // `/s` recurses the subkeys, `/v DisplayName` returns only that
      // value, `/f` filters server-side. The needle is an adapter
      // constant, never request input.
      for (const needle of spec.uninstallNames) {
        const out = await runDesktopCommand(reg, ['query', key, '/s', '/v', 'DisplayName', '/f', needle]);
        const line = out?.split(/\r?\n/).find((l) => l.includes('DisplayName') && l.includes(needle));
        if (line) return { via: 'registry-uninstall', evidence: line.trim() };
      }
    }
  }

  if (spec.startMenuNames?.length) {
    for (const dir of startMenuDirs()) {
      const shortcuts = walkShortcuts(dir);
      for (const name of spec.startMenuNames) {
        const hit = shortcuts.find((s) => s.toLowerCase().endsWith(`\\${name.toLowerCase()}.lnk`));
        if (hit) return { via: 'start-menu', evidence: hit };
      }
    }
  }

  for (const binary of spec.binaries ?? []) {
    const resolved = resolveExecutable(binary);
    if (resolved) return { via: 'path-binary', evidence: resolved };
  }
  return null;
}

/**
 * Discover the applications AURA has adapters for.
 *
 * `ids` narrows the sweep — and narrowing genuinely matters here in a way
 * it does not for nodes, because the sensitivity of a scan is the
 * sensitivity of what it *reached*. A caller that only needs to know
 * whether an editor is installed should ask about the editor, and get an
 * `inventory` answer, rather than sweep everything and be handed a
 * `confidential` one it did not want and now has to handle.
 */
export async function scanApplications(ids?: string[], refresh = false): Promise<ApplicationScan> {
  const platform = targetPlatformOf(process.platform);

  const adapters = ids?.length
    ? ids.map(applicationAdapter).filter((a): a is ApplicationAdapter => Boolean(a))
    : APPLICATION_ADAPTERS;

  // Probed once for the whole scan rather than per application: tier
  // availability is a property of the session, not of the application,
  // and re-probing the accessibility bus per adapter would spawn a
  // process per entry to learn the same fact each time.
  const tierProbes = await desktopTierRegistry.probeAll(refresh);
  const probeFor = new Map(tierProbes.map((p) => [p.tier, p]));

  const applications: DiscoveredApplication[] = [];
  let sensitivity: ObservationSensitivity = 'inventory';
  let undetectableCount = 0;

  for (const adapter of adapters) {
    // The sweep's sensitivity is what it REACHED, not what it found.
    // Determining that Tor Browser is absent still required looking.
    sensitivity = higherSensitivity(sensitivity, adapter.observationSensitivity);

    const claimsThisPlatform = Boolean(platform && adapter.detect[platform]);
    if (!claimsThisPlatform) undetectableCount += 1;

    let hit: Hit = null;
    if (claimsThisPlatform) {
      if (platform === 'linux') hit = detectLinux(adapter);
      else if (platform === 'darwin') hit = await detectDarwin(adapter);
      else if (platform === 'win32') hit = await detectWin32(adapter);
    }

    applications.push({
      id: adapter.id,
      name: adapter.name,
      category: adapter.category,
      present: hit !== null,
      via: hit?.via ?? null,
      evidence: hit?.evidence ?? null,
      // Stamped here, on every record, present or not — the record is
      // what travels, and a sensitivity that has to be looked up again
      // downstream is one that will be dropped downstream.
      sensitivity: adapter.observationSensitivity,
      /**
       * The measured availability of every rung this application
       * declares, intersected with what the drivers found on this
       * machine.
       *
       * An adapter that declares a rung the driver registry does not
       * cover (tiers 1–4, which are Phase 4's) reports `unknown` for it
       * rather than `available` — an unprobed tier is never assumed to
       * work, and this is the seam where that rule earns its keep.
       */
      tiers: adapter.tiers.map((t) => {
        const probed = probeFor.get(t.tier);
        const declaration = platform ? t.platforms.find((p) => p.platform === platform) : undefined;
        if (declaration && !declaration.supported) {
          return {
            tier: t.tier,
            availability: 'unsupported' as const,
            platform,
            detail: declaration.note,
          };
        }
        /**
         * An application that is not installed has no available rung —
         * whatever the session-level probe says.
         *
         * The driver probes measure the SESSION: "can AURA read an
         * accessibility tree at all", "is there an X11 window list".
         * Both can be `available` on a machine where a particular
         * application is absent, and reporting that application's tier 5
         * as available would be the ladder's own failure mode: a
         * confident claim that AURA can reach software that is not there.
         */
        if (!hit) {
          return {
            tier: t.tier,
            availability: 'unavailable' as const,
            platform,
            missing: [adapter.name],
            detail: `${adapter.name} was not found on this machine, so there is nothing to reach at tier ${t.tier}${
              probed && probed.availability === 'available'
                ? ' — even though this session could support that tier for an application that was installed'
                : ''
            }.`,
          };
        }
        if (!probed) {
          return {
            tier: t.tier,
            availability: 'unknown' as const,
            platform,
            detail: `No driver is registered for tier ${t.tier} here, so its availability was not measured and is not assumed.`,
          };
        }
        /**
         * Installed is still not running, and tiers 5 and 6 need running.
         *
         * An accessibility tree and a window exist only while the process
         * does. The scan does not start applications to find out — that
         * would make an observation into an action — so it says plainly
         * that this is a session-level answer and the application must be
         * open for it to hold. The rung stays `available`, because the
         * question a caller asks a scan is "could this work here", and
         * `selectTier` is re-run at invocation time when "is it running"
         * is actually answerable.
         */
        if (probed.availability === 'available' && t.tier >= 5) {
          return {
            ...probed,
            detail: `${probed.detail} ${adapter.name} must be running for this rung to answer; the scan does not start it.`,
          };
        }
        return probed;
      }),
      undetectableHere: !claimsThisPlatform,
    });
  }

  return {
    at: new Date().toISOString(),
    platform,
    applications,
    sensitivity,
    undetectableCount,
  };
}
