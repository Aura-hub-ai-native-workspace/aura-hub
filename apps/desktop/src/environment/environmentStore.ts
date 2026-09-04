/**
 * environmentStore — the live Connected Environment.
 * ==================================================================
 * A thin host around `@aura/connected-environment`. Every transition is
 * computed by a pure function from that package; this store's only jobs
 * are holding the result and driving the transport.
 *
 * It holds **no mission state**. Missions live in Mission Control v3
 * (`MissionRecord`, served by the local service and surfaced by
 * `screens/missions/`), and capability gaps for a live mission are
 * derived by the Capability Fabric from that record — never from a
 * second copy kept here. See docs/CONSOLIDATION_MAP.md.
 *
 * Nothing persists. A relaunch starts from an unmeasured environment and
 * scans, because a cached "Docker is connected" that is no longer true
 * would be exactly the kind of confident wrong answer this architecture
 * exists to avoid.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import {
  appendLog,
  applyConnect,
  applyDisconnect,
  applyProbe,
  createEnvironment,
  environmentSummary,
  findGaps,
  setPermissions as withPermissions,
  type CapabilityGap,
  type CapabilityRequirement,
  type EnvironmentNode,
  type NodePermissions,
} from '@aura/connected-environment';
import {
  environmentClient,
  type DiscoveredTool,
  type InventoryCounts,
  type InventoryEntry,
  type InventorySource,
  type ItemKind,
  type DiscoveryMeta,
  type InstallResponse,
  type InventoryMeta,
  type NotInstalledNode,
  type OsPackage,
  type PackageEvidence,
} from './environmentClient';
import type { InvocationResultView } from '../ai/fabricClient';

interface EnvironmentState {
  nodes: EnvironmentNode[];
  /** A scan is in flight. */
  scanning: boolean;
  lastScanAt: string | null;
  /** Node ids with a connect/disconnect/install in flight. */
  busy: string[];
  /** Discovered unknown tools (PATH-based, honest) */
  discovered: DiscoveredTool[];
  packages: PackageEvidence[];
  osPackages: OsPackage[];
  notInstalled: NotInstalledNode[];
  /** How complete each layer is, so the UI can say so out loud. */
  discoveryMeta: DiscoveryMeta | null;
  packageSources: InventoryMeta[];
  osInventory: InventoryMeta | null;
  /** Set when the last scan could not measure anything. */
  scanError: string | null;

  /* ── complete machine inventory ─────────────────────────────── */
  /** Every installed thing the machine can authoritatively identify. */
  inventory: InventoryEntry[];
  inventoryCounts: InventoryCounts | null;
  inventorySources: InventorySource[];
  /** How many matched — `inventory` holds the pages loaded so far. */
  inventoryTotal: number;
  inventoryCollectedAt: string | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  /** Discovery ran but could not be refreshed; this is an older answer. */
  inventoryDegraded: boolean;
  loadInventory: (refresh?: boolean) => Promise<void>;
  loadMoreInventory: () => Promise<void>;

  scan: (refresh?: boolean) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => void;
  setNodePermissions: (id: string, partial: Partial<NodePermissions>) => void;
  /** Direct human install — bypasses Fabric approval gate. AI path remains via fabricClient.invoke('system.install'). */
  install: (id: string) => Promise<InvocationResultView>;
  /** Governed AI install (kept for model-initiated). */
  installGoverned?: (id: string) => Promise<InvocationResultView>;
}

/** Items fetched per page. Large enough to fill a screen, small enough
 *  that a machine with thousands of packages still answers immediately. */
const INVENTORY_PAGE = 400;

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  nodes: createEnvironment(),
  scanning: false,
  lastScanAt: null,
  busy: [],
  discovered: [],
  packages: [],
  osPackages: [],
  notInstalled: [],
  discoveryMeta: null,
  packageSources: [],
  osInventory: null,
  scanError: null,

  inventory: [],
  inventoryCounts: null,
  inventorySources: [],
  inventoryTotal: 0,
  inventoryCollectedAt: null,
  inventoryLoading: false,
  inventoryError: null,
  inventoryDegraded: false,

  loadInventory: async (refresh = false) => {
    if (get().inventoryLoading) return;
    set({ inventoryLoading: true, inventoryError: null });
    const outcome = await environmentClient.inventory({ refresh, limit: INVENTORY_PAGE });

    if (!outcome.ok) {
      // Keep whatever is on screen; it is the last thing actually measured.
      set({ inventoryLoading: false, inventoryError: outcome.reason });
      return;
    }
    const { response } = outcome;
    set({
      inventory: response.items,
      inventoryCounts: response.counts,
      inventorySources: response.sources,
      inventoryTotal: response.total,
      inventoryCollectedAt: response.collectedAt,
      inventoryDegraded: response.degraded,
      inventoryLoading: false,
      inventoryError: null,
    });
  },

  loadMoreInventory: async () => {
    const { inventory, inventoryTotal, inventoryLoading } = get();
    if (inventoryLoading || inventory.length >= inventoryTotal) return;
    set({ inventoryLoading: true });
    const outcome = await environmentClient.inventory({
      offset: inventory.length,
      limit: INVENTORY_PAGE,
    });
    if (!outcome.ok) {
      set({ inventoryLoading: false, inventoryError: outcome.reason });
      return;
    }
    set((s) => ({
      // Paging must never duplicate an item already on screen.
      inventory: [
        ...s.inventory,
        ...outcome.response.items.filter((item) => !s.inventory.some((seen) => seen.id === item.id)),
      ],
      inventoryTotal: outcome.response.total,
      inventoryLoading: false,
    }));
  },

  scan: async (refresh = false) => {
    if (get().scanning) return;
    set({ scanning: true, scanError: null });
    const outcome = await environmentClient.scan(undefined, refresh);

    if (!outcome.ok) {
      // Nothing was measured. Whatever is on screen stays — it is the last
      // thing we actually knew — but `lastScanAt` must not advance, because
      // moving it would date stale readings to this moment.
      set({ scanning: false, scanError: outcome.reason });
      return;
    }

    const response = outcome.response;
    set((s) => ({
      nodes: s.nodes.map((node) => {
        const result = response.results[node.id];
        return result ? applyProbe(node, result) : node;
      }),
      scanning: false,
      scanError: null,
      lastScanAt: response.scannedAt,
      discovered: response.discovered ?? [],
      packages: response.packages ?? [],
      osPackages: response.osPackages ?? [],
      notInstalled: response.notInstalled ?? [],
      discoveryMeta: response.discovery ?? null,
      packageSources: response.packageSources ?? [],
      osInventory: response.osInventory ?? null,
    }));
  },

  connect: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node || get().busy.includes(id)) return;
    set((s) => ({ busy: [...s.busy, id] }));

    try {
      const response = await environmentClient.connectDirect(id);
      const probeResult = response.result;
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? applyConnect(n, probeResult) : n)),
        busy: s.busy.filter((b) => b !== id),
      }));
    } catch {
      // Fallback to probe-only if direct endpoint unavailable
      try {
        const { transportFor } = await import('./transports');
        const n = get().nodes.find((x) => x.id === id);
        if (n) {
          const result = await transportFor(n.entry).connect(n.entry);
          set((s) => ({
            nodes: s.nodes.map((x) => (x.id === id ? applyConnect(x, result) : x)),
            busy: s.busy.filter((b) => b !== id),
          }));
          return;
        }
      } catch {}
      set((s) => ({ busy: s.busy.filter((b) => b !== id) }));
    }
  },

  disconnect: (id) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyDisconnect(n) : n)) }));
  },

  setNodePermissions: (id, partial) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? withPermissions(n, partial) : n)) }));
  },

  install: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) {
      return { invocationId: '', outcome: 'unsupported', detail: 'That node is not in the catalog.' };
    }
    if (get().busy.includes(id) || node.health.status === 'installing') {
      return { invocationId: '', outcome: 'unsupported', detail: 'An install is already in progress for this node.' };
    }
    if (!node.entry.install) {
      return {
        invocationId: '',
        outcome: 'unsupported',
        detail: `AURA has no verified way to install ${node.entry.name}, so it will not guess at one. See ${node.entry.homepage} for the project's own instructions.`,
      };
    }

    // Mark installing and busy before anything leaves the machine.
    set((s) => ({
      busy: [...s.busy, id],
      nodes: s.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              health: {
                status: 'installing',
                detail: 'Installation is running — AURA will look for it again when this finishes.',
                checkedAt: new Date().toISOString(),
                version: n.health.version,
              },
              log: appendLog(n.log, 'info', `Install requested for ${n.entry.name}.`),
            }
          : n,
      ),
    }));

    let direct: InstallResponse | null = null;
    let detailForFailure = '';
    try {
      direct = await environmentClient.install(id);
    } catch (e) {
      detailForFailure = (e as Error).message || 'The install request did not complete.';
      // Re-probe honestly before reporting the transport failure.
      try {
        const probeResult = await environmentClient.probe(id, true);
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
      } catch {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  health: { status: 'not-installed', detail: detailForFailure, checkedAt: new Date().toISOString() },
                  log: appendLog(n.log, 'error', detailForFailure),
                }
              : n,
          ),
        }));
      }
      set((s) => ({ busy: s.busy.filter((b) => b !== id) }));
      return { invocationId: '', outcome: 'failed', detail: detailForFailure };
    }

    // Direct human install succeeded in reaching the service — now apply verification.
    // The service already probed, but we do a second honest re-probe for UI consistency
    // (service probe is evidence; this second probe confirms registry update).
    if (direct && direct.probe) {
      // Use service-provided probe evidence
      const probeResult = {
        present: direct.probe.present,
        detail: direct.probe.detail,
        version: direct.probe.version,
        latencyMs: direct.probe.latencyMs,
      };
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
    } else {
      try {
        const probeResult = await environmentClient.probe(id, true);
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
      } catch {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  health: {
                    status: 'not-installed',
                    detail: direct?.detail || 'Installation finished, but the follow-up check did not complete. Scan again.',
                    checkedAt: new Date().toISOString(),
                    version: n.health.version,
                  },
                }
              : n,
          ),
        }));
      }
    }

    set((s) => ({ busy: s.busy.filter((b) => b !== id) }));

    // Map direct installOutcome to InvocationResultView for existing UI branches
    // NodeCard branches on output.installOutcome, never on ok/outcome alone.
    if (!direct) {
      return { invocationId: '', outcome: 'failed', detail: detailForFailure || 'Install did not complete.' };
    }
    if (direct.installOutcome === 'unavailable') {
      return { invocationId: '', outcome: 'unsupported', detail: direct.detail || direct.why || 'Install unavailable.' };
    }
    if (direct.installOutcome === 'guided') {
      return {
        invocationId: '',
        outcome: 'succeeded',
        detail: direct.detail || direct.why || '',
        output: direct as unknown as Record<string, unknown>,
      };
    }
    if (direct.installOutcome === 'installed') {
      return {
        invocationId: '',
        outcome: 'succeeded',
        detail: direct.detail || '',
        output: direct as unknown as Record<string, unknown>,
      };
    }
    // failed / unverified
    return {
      invocationId: '',
      outcome: 'failed',
      detail: direct.detail || direct.why || 'Install failed.',
      output: direct as unknown as Record<string, unknown>,
    };
  },
}));

/* ── selectors ──────────────────────────────────────────────────── */

/**
 * `environmentSummary` builds a fresh object, so it must be computed
 * *outside* the selector — a selector returning a new object on every
 * call breaks `useSyncExternalStore`'s snapshot caching.
 */
export function useEnvironmentSummary() {
  const nodes = useEnvironmentStore((s) => s.nodes);
  return useMemo(() => environmentSummary(nodes), [nodes]);
}

/**
 * Live capability gaps for an arbitrary requirement list. The caller owns
 * the requirements — for a real mission they come from the Fabric reading
 * the authoritative `MissionRecord`, so connecting a node re-derives the
 * gaps with no mission state duplicated into this store.
 */
export function useCapabilityGaps(required: CapabilityRequirement[]): CapabilityGap[] {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const key = required.map((r) => `${r.capability}:${(r.taskIds ?? []).join(',')}`).join('|');
  // `key` collapses the requirement list to a primitive so a caller passing
  // a freshly-built array each render does not re-run the scan.
  return useMemo(() => findGaps(required, nodes), [key, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
}

export type InventoryStatus = 'verified' | 'unverified' | 'degraded';

export interface InventoryItem {
  id: string;
  logicalId: string;
  name: string;
  version: string | null;
  category: string;
  status: InventoryStatus;
  verified: boolean;
  present: boolean;
  executable: string | null;
  realPath: string | null;
  /** How it got here: npm-global, pipx, cargo, venv, os-package, unknown. */
  origin: string | null;
  packageId: string | null;
  manager: string | null;
  /** What the package manager claims, when it differs from the executable. */
  packageVersion: string | null;
  versionConflict: boolean;
  /** Other command names for the same tool. */
  aliases: string[];
  /** Same-named files further along PATH that this one shadows. */
  shadowed: string[];
  sources: string[];
  detail: string;
  /** True when AURA deliberately did not run it (no provenance, or unsafe). */
  unexecuted: boolean;
  homepage?: string;
  catalogId?: string;
  connected?: boolean;
  packageEvidence?: PackageEvidence | null;
}

export interface NormalizedInventory {
  /** PRIMARY: every usable tool — one card per logical tool. */
  verified: InventoryItem[];
  /** Present on disk, but AURA cannot vouch for it. */
  unverified: InventoryItem[];
  /** Catalogued, measured, genuinely absent. */
  knownNotInstalled: NotInstalledNode[];
  /** A package with no executable AURA could match. Evidence, not inventory. */
  packageOnly: InventoryItem[];
  osEvidence: OsPackage[];
  counts: {
    verified: number;
    unverified: number;
    knownNotInstalled: number;
    packageOnly: number;
    os: number;
    totalReal: number;
  };
  /** How complete this picture is. Never implied — always stated. */
  meta: {
    discovery: DiscoveryMeta | null;
    packageSources: InventoryMeta[];
    osInventory: InventoryMeta | null;
  };
}

/**
 * Identity keys for one tool, strongest first.
 *
 * Deduplication used to be a lowercase-name match, which both split one tool
 * across several cards (`wrangler`/`wrangler2`/`cf-wrangler`) and risked
 * merging two unrelated tools that happened to share a name. The backend now
 * reports the resolved file and the owning package, so identity is a fact
 * rather than a guess: the same file, or the same package, is the same tool —
 * and nothing else is.
 */
function identityKeys(item: {
  realPath?: string | null;
  manager?: string | null;
  packageId?: string | null;
}): string[] {
  const keys: string[] = [];
  if (item.realPath) keys.push(`path:${item.realPath}`);
  if (item.manager && item.packageId) keys.push(`pkg:${item.manager}/${item.packageId}`);
  return keys;
}

/** Register every identity an item answers to, without clobbering earlier claims. */
function claim(index: Map<string, InventoryItem>, item: InventoryItem): void {
  for (const key of identityKeys(item)) {
    if (!index.has(key)) index.set(key, item);
  }
}

function findExisting(
  index: Map<string, InventoryItem>,
  candidate: { realPath?: string | null; manager?: string | null; packageId?: string | null },
): InventoryItem | undefined {
  for (const key of identityKeys(candidate)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return undefined;
}

function mergeAliases(target: InventoryItem, names: string[]): void {
  for (const name of names) {
    if (name && name !== target.name && !target.aliases.includes(name)) target.aliases.push(name);
  }
}

export interface InventoryInputs {
  nodes: EnvironmentNode[];
  discovered: DiscoveredTool[];
  packages: PackageEvidence[];
  notInstalled: NotInstalledNode[];
  osPackages: OsPackage[];
  discoveryMeta: DiscoveryMeta | null;
  packageSources: InventoryMeta[];
  osInventory: InventoryMeta | null;
}

/**
 * Normalized machine inventory — THE primary view model.
 *
 * Merges the catalog results, PATH discovery, package inventories and the
 * not-installed view into one deduplicated list: one real tool, one card.
 *
 * Pure, and exported separately from the hook so the merge can be exercised
 * directly against real backend payloads rather than only through React.
 */
export function normalizeInventory(input: InventoryInputs): NormalizedInventory {
  const {
    nodes,
    discovered,
    packages,
    notInstalled,
    osPackages,
    discoveryMeta,
    packageSources,
    osInventory,
  } = input;
  {
    const index = new Map<string, InventoryItem>();
    const verified: InventoryItem[] = [];
    const unverified: InventoryItem[] = [];

    // 1. Catalog nodes AURA measured. Hub subsystems are AURA's own
    //    capabilities, not machine inventory, and are shown separately.
    for (const node of nodes) {
      if (node.entry.category === 'hub') continue;
      const usable = node.health.status === 'available' || node.health.status === 'connected';
      const degraded = node.health.status === 'degraded';
      if (!usable && !degraded) continue;

      const item: InventoryItem = {
        id: node.id,
        logicalId: node.id,
        name: node.entry.name,
        version: node.health.version ?? null,
        category: node.entry.category,
        status: usable ? 'verified' : 'degraded',
        verified: usable,
        present: usable,
        executable: node.health.executable ?? null,
        realPath: node.health.executable ?? null,
        origin: node.health.origin ?? null,
        packageId: node.health.package ?? null,
        manager: node.health.manager ?? null,
        packageVersion: node.health.packageVersion ?? null,
        versionConflict: Boolean(node.health.versionConflict),
        aliases: [],
        shadowed: [],
        sources: ['catalog'],
        detail: node.health.detail,
        unexecuted: false,
        homepage: node.entry.homepage,
        catalogId: node.id,
        connected: node.connected,
        packageEvidence: null,
      };
      (usable ? verified : unverified).push(item);
      claim(index, item);
    }

    // 2. Tools found on PATH that the catalog does not describe.
    for (const tool of discovered) {
      const existing = findExisting(index, {
        realPath: tool.realPath,
        manager: tool.manager,
        packageId: tool.package,
      });
      if (existing) {
        mergeAliases(existing, [tool.name, ...tool.aliases]);
        if (!existing.executable) existing.executable = tool.executable;
        if (!existing.version && tool.version) existing.version = tool.version;
        if (!existing.sources.includes('PATH')) existing.sources.push('PATH');
        continue;
      }

      const isVerified = tool.status === 'verified';
      const item: InventoryItem = {
        id: tool.id,
        logicalId: tool.realPath || tool.id,
        name: tool.name,
        version: tool.version ?? null,
        category: tool.category,
        status: isVerified
          ? 'verified'
          : tool.status === 'timeout' || tool.status === 'failed' || tool.status === 'tampered'
            ? 'degraded'
            : 'unverified',
        verified: isVerified,
        present: isVerified,
        executable: tool.executable,
        realPath: tool.realPath,
        origin: tool.origin,
        packageId: tool.package ?? null,
        manager: tool.manager ?? null,
        packageVersion: tool.packageVersion ?? null,
        versionConflict: Boolean(tool.versionConflict),
        aliases: [...tool.aliases],
        shadowed: [...(tool.shadowed ?? [])],
        sources: tool.manager ? ['PATH', tool.manager] : ['PATH'],
        detail: tool.detail,
        unexecuted: !tool.executed,
        connected: false,
        packageEvidence: null,
      };
      (isVerified ? verified : unverified).push(item);
      claim(index, item);
    }

    // 3. Attach package evidence by exact identity.
    const claimedPackages = new Set<string>();
    for (const pkg of packages) {
      const match = findExisting(index, { manager: pkg.manager, packageId: pkg.package });
      if (!match) continue;
      claimedPackages.add(`${pkg.manager}/${pkg.package}`);
      if (!match.packageEvidence) match.packageEvidence = pkg;
      if (!match.sources.includes(pkg.manager)) match.sources.push(pkg.manager);
      if (!match.version && pkg.version) match.version = pkg.version;
    }

    // 4. Packages whose executable AURA never matched. Evidence, not inventory.
    const packageOnly: InventoryItem[] = packages
      .filter((p) => !claimedPackages.has(`${p.manager}/${p.package}`))
      .map((p) => ({
        id: `pkg:${p.manager}:${p.package}`,
        logicalId: `pkg:${p.manager}:${p.package}`,
        name: p.package,
        version: p.version ?? null,
        category: 'package',
        status: 'unverified' as const,
        verified: false,
        present: false,
        executable: p.executable ?? null,
        realPath: null,
        origin: p.manager,
        packageId: p.package,
        manager: p.manager,
        packageVersion: p.version ?? null,
        versionConflict: false,
        aliases: [],
        shadowed: [],
        sources: [p.manager],
        detail: `Installed by ${p.manager}, but AURA did not match it to a command on PATH.`,
        unexecuted: true,
        connected: false,
        packageEvidence: p,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const byName = (a: InventoryItem, b: InventoryItem) => a.name.localeCompare(b.name);
    verified.sort(byName);
    unverified.sort(byName);

    return {
      verified,
      unverified,
      knownNotInstalled: notInstalled,
      packageOnly,
      osEvidence: osPackages,
      counts: {
        verified: verified.length,
        unverified: unverified.length,
        knownNotInstalled: notInstalled.length,
        packageOnly: packageOnly.length,
        os: osPackages.length,
        totalReal: verified.length + unverified.length,
      },
      meta: { discovery: discoveryMeta, packageSources, osInventory },
    };
  }
}

export function useNormalizedInventory(): NormalizedInventory {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const discovered = useEnvironmentStore((s) => s.discovered);
  const packages = useEnvironmentStore((s) => s.packages);
  const notInstalled = useEnvironmentStore((s) => s.notInstalled);
  const osPackages = useEnvironmentStore((s) => s.osPackages);
  const discoveryMeta = useEnvironmentStore((s) => s.discoveryMeta);
  const packageSources = useEnvironmentStore((s) => s.packageSources);
  const osInventory = useEnvironmentStore((s) => s.osInventory);

  const normalized = useMemo(
    () =>
      normalizeInventory({
        nodes,
        discovered,
        packages,
        notInstalled,
        osPackages,
        discoveryMeta,
        packageSources,
        osInventory,
      }),
    [nodes, discovered, packages, notInstalled, osPackages, discoveryMeta, packageSources, osInventory],
  );

  // Append inventory items (e.g. npm global packages) to unverified so they appear
  // in the Machine Environment even when not in the catalog.
  const inventory = useEnvironmentStore((s) => s.inventory);
  const inventoryItems: InventoryItem[] = inventory.map((entry) => ({
    id: entry.id,
    logicalId: entry.id,
    name: entry.name,
    version: entry.version ?? null,
    category: entry.category ?? 'unknown',
    status: entry.verified && entry.executablePath != null ? 'verified' : 'unverified',
    verified: entry.verified && entry.executablePath != null,
    present: entry.verified && entry.executablePath != null,
    executable: entry.executablePath ?? null,
    realPath: entry.executablePath ?? null,
    origin: entry.origin ?? null,
    packageId: entry.packageName ?? null,
    manager: entry.packageManager ?? null,
    packageVersion: entry.packageVersion ?? null,
    versionConflict: entry.versionConflict,
    aliases: entry.aliases ?? [],
    shadowed: entry.shadowed ?? [],
    sources: entry.sources ?? [],
    detail: entry.detail ?? '',
    unexecuted: !entry.verified,
    connected: entry.connected ?? false,
  }));

  return {
    ...normalized,
    unverified: [...normalized.unverified, ...inventoryItems.filter((item) => !item.verified)],
  };
}

/** The machine inventory grouped the way the screen presents it. */
export interface GroupedInventory {
  groups: { id: ItemKind | 'other'; label: string; items: InventoryEntry[] }[];
  counts: InventoryCounts | null;
  sources: InventorySource[];
  total: number;
  loaded: number;
  collectedAt: string | null;
  degraded: boolean;
}

const KIND_ORDER: { id: ItemKind; label: string }[] = [
  { id: 'application', label: 'Applications' },
  { id: 'cli', label: 'CLI Tools' },
  { id: 'runtime', label: 'Runtimes' },
  { id: 'sdk', label: 'SDKs' },
  { id: 'package', label: 'Packages' },
  { id: 'library', label: 'Libraries' },
];

export function useMachineInventoryGroups(): GroupedInventory {
  const inventory = useEnvironmentStore((s) => s.inventory);
  const counts = useEnvironmentStore((s) => s.inventoryCounts);
  const sources = useEnvironmentStore((s) => s.inventorySources);
  const total = useEnvironmentStore((s) => s.inventoryTotal);
  const collectedAt = useEnvironmentStore((s) => s.inventoryCollectedAt);
  const degraded = useEnvironmentStore((s) => s.inventoryDegraded);

  return useMemo(() => {
    const buckets = new Map<string, InventoryEntry[]>();
    for (const item of inventory) {
      const key = KIND_ORDER.some((k) => k.id === item.kind) ? item.kind : 'other';
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
    const groups = [
      ...KIND_ORDER.map((kind) => ({
        id: kind.id as ItemKind | 'other',
        label: kind.label,
        items: buckets.get(kind.id) ?? [],
      })),
      { id: 'other' as const, label: 'Other Installed Software', items: buckets.get('other') ?? [] },
    ].filter((group) => group.items.length > 0);

    return {
      groups,
      counts,
      sources,
      total,
      loaded: inventory.length,
      collectedAt,
      degraded,
    };
  }, [inventory, counts, sources, total, collectedAt, degraded]);
}

// Back-compat: verified list alone (used by older UI if any)
export function useMachineInventory(): InventoryItem[] {
  return useNormalizedInventory().verified;
}
