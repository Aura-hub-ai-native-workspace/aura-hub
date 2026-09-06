/**
 * ConnectedEnvironment — the execution layer, as one screen.
 * ==================================================================
 * Two modes, one surface:
 *
 *   No mission  → the environment itself. What is here, what is
 *                 connected, what could be. This is the resting state.
 *   Mission open → the board takes the left column and the environment
 *                 compresses to the right, because once work is running
 *                 the question changes from "what do I have" to "what is
 *                 happening".
 *
 * Node windows float above both. A window is for *inspecting* a node
 * while the mission keeps running behind it — the workspace stays clean
 * and nothing is hidden behind a modal.
 *
 * Deliberately not a wiring canvas. n8n, Zapier, Make and Node-RED all
 * ask the user to draw the pipeline; the premise here is that they
 * shouldn't have to. What is worth showing is state and progress, so
 * that is what the layout spends its space on.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import {
  CATEGORY_LABELS,
  describeEnvironment,
  type EnvironmentNode,
  type NodeCategory,
} from '@aura/connected-environment';
import {
  useCapabilityGaps,
  useEnvironmentStore,
  useEnvironmentSummary,
  useMachineInventoryGroups,
  useNormalizedInventory,
  type InventoryItem,
} from './environmentStore';
import type { InventoryEntry } from './environmentClient';
import { FABRIC_CORE_REQUIREMENTS } from './fabricRequirements';
import { GapPanel } from './GapPanel';
import { NodeCard } from './NodeCard';
import { NodeInspector } from './NodeInspector';
import { FloatingSurface } from './windows/FloatingSurface';
import { useWindowManager } from './windows/windowManager';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from './presentation';

type Filter = 'connected' | 'here' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'connected', label: 'Connected' },
  { id: 'here', label: 'On this machine' },
  { id: 'all', label: 'Everything' },
];

export function ConnectedEnvironment() {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const scanError = useEnvironmentStore((s) => s.scanError);
  const busy = useEnvironmentStore((s) => s.busy);
  const scan = useEnvironmentStore((s) => s.scan);
  const connect = useEnvironmentStore((s) => s.connect);
  const disconnect = useEnvironmentStore((s) => s.disconnect);

  const summary = useEnvironmentSummary();
  // What the execution layer still needs to be fully operational. Real
  // gaps against the real environment — not tied to any mission, so this
  // screen never holds mission state.
  const coreGaps = useCapabilityGaps(FABRIC_CORE_REQUIREMENTS);
  const openWindow = useWindowManager((s) => s.open);
  const canvasRef = useRef<HTMLDivElement>(null);
  const setCanvas = useWindowManager((s) => s.setCanvas);

  const [filter, setFilter] = useState<Filter>('connected');

  // One scan on first mount. The environment starts unmeasured on every
  // launch by design — a remembered "Docker is connected" that is no
  // longer true is worse than not knowing.
  useEffect(() => { void scan(); }, [scan]);

  // The machine inventory is read from authoritative sources and is the
  // primary view; the catalog scan above enriches it and drives Connect.
  const loadInventory = useEnvironmentStore((s) => s.loadInventory);
  useEffect(() => { void loadInventory(); }, [loadInventory]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setCanvas(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setCanvas]);

  const visible = useMemo(() => filterNodes(nodes, filter), [nodes, filter]);
  const grouped = useMemo(() => groupByCategory(visible), [visible]);

  // The canvas is the *non-scrolling* frame; content scrolls inside it.
  // Node windows are positioned against the frame, so a scroll never drags
  // a floating window off with it.
  return (
    <div ref={canvasRef} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1320px] px-6 py-7">
        <Header
          summary={summary}
          scanning={scanning}
          lastScanAt={lastScanAt}
          scanError={scanError}
          onScan={() => void scan(true)}
        />

        <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <div className="min-w-0 space-y-4 lg:order-2">
            <div>
              <h2 className="text-[13px] font-semibold text-text">Execution readiness</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                What the Capability Fabric still needs before it can carry the core execution surface —
                files, terminal, source control, code hosting and browser verification.
              </p>
            </div>
            <GapPanel
              gaps={coreGaps}
              busy={busy}
              onConnect={(id) => void connect(id)}
              onInspect={openWindow}
            />
          </div>

          <div className="min-w-0 space-y-4 lg:order-1">
            <MachineInventoryComplete />
            <MachineInventoryPrimary />
            <MachineInventorySecondary />
            <section className="rounded-xl border border-dashed border-line bg-surface/50 p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Known AURA Capabilities</h2>
                <span className="text-[10.5px] text-text-subtle">
                  {visible.length} known · {summary.internal} built in
                </span>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={cn(
                        'rounded-lg px-2 py-1 text-[10.5px] font-medium transition-colors',
                        filter === f.id ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text',
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-[11px] leading-relaxed text-text-subtle">
                Catalog of tools AURA understands — not the machine inventory. For the real machine, see above.
              </p>
              {visible.length === 0 ? (
                <EmptyFilter filter={filter} onShowAll={() => setFilter('all')} />
              ) : (
                <div className="space-y-4 opacity-90">
                  {grouped.map(([category, list]) => (
                    <div key={category}>
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <Icon name={CATEGORY_ICON[category]} size={10} className="text-text-subtle" />
                        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                          {CATEGORY_LABELS[category]}
                        </h3>
                        <span className="text-[10px] text-text-subtle">{list.length}</span>
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {list.map((node) => (
                          <NodeCard
                            key={node.id}
                            node={node}
                            busy={busy.includes(node.id)}
                            onConnect={() => void connect(node.id)}
                            onDisconnect={() => disconnect(node.id)}
                            onInspect={() => openWindow(node.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      </div>

      <NodeWindows canvasRef={canvasRef} />
      <WindowTray />
    </div>
  );
}

/* ── header ─────────────────────────────────────────────────────── */

function Header({
  summary,
  scanning,
  lastScanAt,
  scanError,
  onScan,
}: {
  summary: { connected: number; available: number; catalogued: number; running: number; internal: number };
  scanning: boolean;
  lastScanAt: string | null;
  scanError: string | null;
  onScan: () => void;
}) {
  return (
    <header className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-text">Connected Environment</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-muted">
          Everything outside AURA Hub is a node here. You describe the outcome; the Hub reads the request, plans it,
          routes each step to whichever node can actually do it, and tells you what it assumed along the way.
        </p>
        <p className="mt-2 text-[11.5px] text-text-subtle">
          {describeEnvironment(summary)}
          {lastScanAt
            ? ` Last measured ${new Date(lastScanAt).toLocaleTimeString()}.`
            : ' Nothing has been measured yet.'}
        </p>
        {scanError && (
          <p className="mt-1.5 text-[11.5px] text-attention">
            {scanError} Anything below is from the last successful measurement
            {lastScanAt ? ` at ${new Date(lastScanAt).toLocaleTimeString()}` : ''}, not from now.
          </p>
        )}
      </div>
      <button
        onClick={onScan}
        disabled={scanning}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[12px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
      >
        <Icon name="refresh" size={13} className={scanning ? 'animate-spin' : undefined} />
        {scanning ? 'Scanning…' : 'Scan this machine'}
      </button>
    </header>
  );
}

/* ── PRIMARY: the complete machine inventory ──────────────────── */

const STATE_BADGES: { key: keyof InventoryEntry; label: string; tone: string }[] = [
  { key: 'connected', label: 'Connected', tone: 'bg-positive text-white' },
  { key: 'verified', label: 'Verified', tone: 'bg-positive/15 text-positive' },
  { key: 'installed', label: 'Installed', tone: 'bg-surface-active text-text-muted' },
];

function MachineInventoryComplete() {
  const { groups, counts, sources, total, loaded, collectedAt, degraded } =
    useMachineInventoryGroups();
  const loading = useEnvironmentStore((s) => s.inventoryLoading);
  const error = useEnvironmentStore((s) => s.inventoryError);
  const loadInventory = useEnvironmentStore((s) => s.loadInventory);
  const loadMore = useEnvironmentStore((s) => s.loadMoreInventory);
  const [open, setOpen] = useState<Record<string, boolean>>({ application: true, cli: true, runtime: true });
  const [showSources, setShowSources] = useState(false);

  if (!loaded && !loading && !error) return null;

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon name="research" size={14} className="text-text-subtle" />
            <h2 className="text-[13px] font-semibold text-text">Machine Inventory</h2>
            <span className="rounded-full bg-surface-active px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              {total} installed
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-text-muted">
            Everything this machine can authoritatively identify as installed — read from package
            databases, application manifests and PATH. Nothing here was executed to be listed;
            a few were run afterwards to confirm a version.
          </p>
          {counts && (
            <p className="mt-1 text-[10.5px] text-text-subtle">
              {counts.installed} installed · {counts.verified} verified · {counts.applications} applications ·{' '}
              {counts.cli} CLI · {counts.runtimes} runtimes · {counts.libraries} libraries
              {collectedAt && ` · read ${new Date(collectedAt).toLocaleTimeString()}`}
            </p>
          )}
          {degraded && (
            <p className="mt-1 text-[10.5px] text-attention">
              A source could not be read this time, so this is an earlier inventory.
            </p>
          )}
          {error && <p className="mt-1 text-[10.5px] text-attention">{error}</p>}
        </div>
        <button
          onClick={() => void loadInventory(true)}
          disabled={loading}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
        >
          <Icon name="refresh" size={11} className={loading ? 'animate-spin' : undefined} />
          {loading ? 'Reading…' : 'Re-read machine'}
        </button>
      </div>

      {groups.map((group) => (
        <div key={group.id} className="mt-3">
          <button
            onClick={() => setOpen((o) => ({ ...o, [group.id]: !o[group.id] }))}
            className="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text"
          >
            <Icon name={open[group.id] ? 'chevron-down' : 'chevron-right'} size={10} />
            {group.label}
            <span className="font-normal text-text-subtle">({group.items.length})</span>
          </button>
          {open[group.id] && (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {group.items.map((item) => (
                <InventoryEntryCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      ))}

      {loaded < total && (
        <button
          onClick={() => void loadMore()}
          disabled={loading}
          className="mt-3 w-full rounded-lg border border-dashed border-line py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
        >
          {loading ? 'Loading…' : `Show more — ${loaded} of ${total} loaded`}
        </button>
      )}

      {sources.length > 0 && (
        <div className="mt-4 border-t border-line pt-2.5">
          <button
            onClick={() => setShowSources((v) => !v)}
            className="flex items-center gap-1.5 text-[10.5px] font-medium text-text-muted hover:text-text"
          >
            <Icon name={showSources ? 'chevron-down' : 'chevron-right'} size={10} />
            Inventory sources
            <span className="font-normal text-text-subtle">
              ({sources.filter((s) => s.available).length} of {sources.length} available)
            </span>
          </button>
          {showSources && (
            <div className="mt-2 space-y-1">
              {sources.map((source) => (
                <div key={source.name} className="flex flex-wrap items-baseline gap-x-2 text-[10.5px]">
                  <span className={cn('font-medium', source.available ? 'text-text' : 'text-text-subtle')}>
                    {source.name}
                  </span>
                  {source.available ? (
                    <span className="text-text-subtle">
                      {source.items} of {source.total} item{source.total === 1 ? '' : 's'}
                      {source.truncated ? ' (truncated)' : ''} · {source.durationMs}ms
                    </span>
                  ) : (
                    // Not installed is not the same as "nothing of this kind
                    // exists", and the difference has to survive to here.
                    <span className="text-text-subtle">not available — {source.detail || source.error}</span>
                  )}
                  {source.available && source.detail && (
                    <span className="text-text-subtle">· {source.detail}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function InventoryEntryCard({ item }: { item: InventoryEntry }) {
  const badge = STATE_BADGES.find((b) => item[b.key] === true);
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface-active/30 p-2">
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1">
            <span className="truncate text-[12px] font-medium text-text">{item.displayName}</span>
            {item.version && (
              <span className="shrink-0 text-[10px] tabular-nums text-text-subtle">· {item.version}</span>
            )}
            {badge && (
              <span className={cn('shrink-0 rounded px-1 py-0.5 text-[8.5px] font-semibold uppercase tracking-wider', badge.tone)}>
                {badge.label}
              </span>
            )}
            {/* Deliberately not run: said out loud, never dressed up. */}
            {!item.executionPerformed && item.trustLevel === 'untrusted' && (
              <span
                className="shrink-0 rounded bg-surface-active px-1 py-0.5 text-[8.5px] font-semibold uppercase tracking-wider text-text-muted"
                title={item.trustReason}
              >
                Not run
              </span>
            )}
          </span>
          {item.versionConflict && item.versions.length > 1 && (
            <span className="mt-0.5 block text-[10px] text-attention" title={item.versions.join(' · ')}>
              sources disagree: {item.versions.join(' · ')}
            </span>
          )}
          <span className="mt-0.5 block truncate text-[10px] text-text-subtle">
            {item.sources.join(' + ')}
            {item.packageName && item.packageName !== item.name ? ` · ${item.packageName}` : ''}
          </span>
          {(item.executablePath || item.installLocation) && (
            <span
              className="mt-0.5 block truncate font-mono text-[9.5px] text-text-subtle"
              title={item.executablePath || item.installLocation || ''}
            >
              {item.executablePath || item.installLocation}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/* ── normalized catalog view ──────────────────────────────────── */

type EnvSection = 'verified' | 'unverified' | 'notInstalled';

function MachineInventoryPrimary() {
  const { verified, unverified, knownNotInstalled, counts, meta } = useNormalizedInventory();
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  // Single-open accordion, all collapsed by default: the page stays a
  // compact list of drawer rows no matter how many tools are on screen.
  const [openSection, setOpenSection] = useState<EnvSection | null>(null);
  const toggle = (id: EnvSection) => setOpenSection((o) => (o === id ? null : id));

  if (!verified.length && !unverified.length && !knownNotInstalled.length) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <Icon name="research" size={14} className="text-text-subtle" />
          <h2 className="text-[13px] font-semibold text-text">Machine Environment</h2>
          <span className="text-[11px] text-text-subtle">{scanning ? 'Scanning…' : 'No scan yet'}</span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
          What actually exists on this machine — verified executables, not the catalog.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Icon name="research" size={14} className="text-text-subtle" />
            <h2 className="text-[13px] font-semibold text-text">Machine Environment</h2>
            <span className="rounded-full bg-positive/10 px-1.5 py-0.5 text-[10px] font-medium text-positive">
              {counts.verified} verified
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
            What actually exists on this machine. A tool is <strong>verified</strong> only when it ran, exited
            cleanly and reported a version. Tools with no package manager behind them are listed but never run.
            {lastScanAt && ` Last measured ${new Date(lastScanAt).toLocaleTimeString()}.`}
          </p>
          <p className="mt-1 text-[10.5px] text-text-subtle">
            {counts.verified} verified · {counts.unverified} detected · {counts.knownNotInstalled} known not installed
            {scanning ? ' · Scanning…' : ''}
          </p>
          {meta.discovery?.degraded && (
            <p className="mt-1 text-[10.5px] text-attention">
              Discovery could not run this time, so the tools below are from an earlier
              measurement. The catalog results above are current.
            </p>
          )}
          {meta.discovery && (
            <p className="mt-1 text-[10.5px] text-text-subtle">
              {meta.discovery.totalCandidates} programs found across {meta.discovery.directoriesScanned} PATH
              directories; {meta.discovery.scannedCandidates} had provenance AURA could verify
              {meta.discovery.truncated
                ? `, and ${meta.discovery.reportedCandidates ?? 0} are listed here — this scan hit its bounds, so the rest are counted but not shown`
                : ''}.
            </p>
          )}
        </div>
        <span className="hidden sm:block text-[10.5px] text-text-subtle">Discovery via PATH + package managers (bounded, no shell)</span>
      </div>

      {/* Verified & Usable — drawer row, collapsed by default */}
      {verified.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => toggle('verified')}
            aria-expanded={openSection === 'verified'}
            aria-controls="env-section-verified"
            data-testid="env-section-verified"
            className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text outline-none transition-colors hover:bg-surface-active/50 focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Icon name={openSection === 'verified' ? 'chevron-down' : 'chevron-right'} size={10} />
            Verified &amp; Usable <span className="font-normal text-text-subtle">({verified.length})</span>
          </button>
          {openSection === 'verified' && (
            <div id="env-section-verified" className="mt-1 max-h-[60vh] overflow-y-auto pr-1">
              <p className="text-[11px] leading-relaxed text-text-subtle">
                One card per logical tool: aliases and package evidence are merged by resolved path and package
                identity, so the same program never appears twice.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {verified.map((item) => (
                  <InventoryCard key={item.logicalId} item={item} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {unverified.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => toggle('unverified')}
            aria-expanded={openSection === 'unverified'}
            aria-controls="env-section-unverified"
            data-testid="env-section-unverified"
            className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text outline-none transition-colors hover:bg-surface-active/50 focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Icon name={openSection === 'unverified' ? 'chevron-down' : 'chevron-right'} size={10} />
            Detected but Unverified <span className="font-normal text-text-subtle">({unverified.length})</span>
          </button>
          {openSection === 'unverified' && (
            <div id="env-section-unverified" className="mt-1 max-h-[60vh] overflow-y-auto pr-1">
              <p className="text-[11px] leading-relaxed text-text-subtle">
                Present on this machine, but not vouched for. Most were never run: AURA only executes a discovered
                program when a package manager says a person installed it. Nothing is hidden — only unverified.
              </p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {unverified.map((item) => (
                  <InventoryCard key={item.logicalId} item={item} compact />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {knownNotInstalled.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => toggle('notInstalled')}
            aria-expanded={openSection === 'notInstalled'}
            aria-controls="env-section-not-installed"
            data-testid="env-section-not-installed"
            className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text outline-none transition-colors hover:bg-surface-active/50 focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Icon name={openSection === 'notInstalled' ? 'chevron-down' : 'chevron-right'} size={10} />
            Known but Not Installed <span className="font-normal text-text-subtle">({knownNotInstalled.length})</span>
          </button>
          {openSection === 'notInstalled' && (
            <div id="env-section-not-installed" className="mt-1 max-h-[40vh] overflow-y-auto pr-1">
              <p className="text-[11px] leading-relaxed text-text-subtle">
                Catalog tools AURA understands and measured for, but did not find here.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {knownNotInstalled.map((n) => (
                  <a
                    key={n.id}
                    href={n.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-dashed border-line bg-surface px-2.5 py-1 text-[10.5px] text-text-muted transition-colors hover:border-line-strong hover:text-text"
                    title={`${n.detail} — ${n.homepage}`}
                  >
                    {n.name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MachineInventorySecondary() {
  const { packageOnly, osEvidence, meta } = useNormalizedInventory();
  const [showOs, setShowOs] = useState(false);
  const [showPkg, setShowPkg] = useState(false);

  if (!packageOnly.length && !osEvidence.length) return null;

  return (
    <section className="rounded-xl border border-line bg-surface/50 p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Discovery Evidence</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-text-subtle">
        Package-manager and operating-system inventories. This is supporting evidence, not a second inventory:
        a tool above already carries its package when one owns it.
      </p>
      {meta.packageSources.length > 0 && (
        <p className="mt-1 text-[10px] text-text-subtle">
          {meta.packageSources
            .map((src) =>
              src.available
                ? `${src.manager}: ${src.returned} of ${src.total}${src.truncated ? ' (truncated)' : ''}`
                : `${src.manager}: not installed`,
            )
            .join(' · ')}
        </p>
      )}

      {packageOnly.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowPkg((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted hover:text-text"
          >
            <Icon name={showPkg ? 'chevron-down' : 'chevron-right'} size={10} />
            Package-only <span className="font-normal text-text-subtle">({packageOnly.length}) — installed package, no executable matched</span>
          </button>
          {showPkg && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {packageOnly.slice(0, 30).map((p) => (
                <span key={p.logicalId} className="rounded-full border border-line bg-surface-active px-2 py-1 text-[10.5px] text-text-muted" title={p.version ?? ''}>
                  {p.sources[0]}:{p.name} {p.version && `· ${p.version}`}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {osEvidence.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowOs((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted hover:text-text"
          >
            <Icon name={showOs ? 'chevron-down' : 'chevron-right'} size={10} />
            OS Packages{' '}
            <span className="font-normal text-text-subtle">
              {meta.osInventory
                ? `(showing ${meta.osInventory.returned} of ${meta.osInventory.total} ${meta.osInventory.manager} packages${
                    meta.osInventory.truncated ? ', truncated' : ''
                  })`
                : `(${osEvidence.length})`}
            </span>
          </button>
          {showOs && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {osEvidence.slice(0, 60).map((p, i) => (
                <span key={`${p.manager}:${p.package}:${i}`} className="rounded-full border border-line bg-surface-active px-2 py-1 text-[10.5px] text-text-muted">
                  {p.manager}:{p.package} {p.version && `· ${p.version}`}
                </span>
              ))}
              {osEvidence.length > 60 && (
                <span className="text-[10.5px] text-text-subtle">+{osEvidence.length - 60} more in this page</span>
              )}
            </div>
          )}
          <p className="mt-1 text-[10px] text-text-subtle">
            An installed OS package is not the same thing as a usable command — this list is evidence, not inventory.
            {meta.osInventory?.truncated
              ? ' Packages matching a tool AURA knows about are listed first.'
              : ''}
          </p>
        </div>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = {
  verified: 'Verified',
  unverified: 'Detected',
  degraded: 'Needs attention',
};

function InventoryCard({ item, compact }: { item: InventoryItem; compact?: boolean }) {
  const isUnknown = !item.catalogId;
  const isVerified = item.verified;
  const tone = isVerified ? 'bg-positive' : 'bg-attention';
  const sources = item.sources.join(' + ');

  // icon by category — unknown uses research, known uses category icon
  const iconName = isUnknown ? 'research' : (CATEGORY_ICON[item.category as keyof typeof CATEGORY_ICON] ?? 'code');

  return (
    <div className={cn('flex flex-col rounded-xl border bg-surface-active/40 p-2.5', isVerified ? 'border-line' : 'border-line bg-surface/60')}>
      <div className="flex items-start gap-2">
        <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border', isVerified ? 'border-positive/20 bg-positive/10 text-positive' : 'border-line bg-surface text-text-subtle')}>
          <Icon name={iconName as any} size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1">
            <span className="truncate text-[12.5px] font-semibold text-text">{item.name}</span>
            {item.version && <span className="shrink-0 text-[10.5px] tabular-nums text-text-subtle">· {item.version}</span>}
            {item.connected && <span className="shrink-0 rounded-full bg-positive px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">Connected</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            {isUnknown && <span className="rounded bg-surface-active px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted">Unknown</span>}
            <span
              className={cn(
                'rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                isVerified ? 'bg-positive/15 text-positive' : 'bg-attention/15 text-attention',
              )}
            >
              {STATUS_LABEL[item.status] ?? 'Detected'}
            </span>
            {item.unexecuted && (
              <span
                className="rounded bg-surface-active px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted"
                title={item.detail}
              >
                Not run
              </span>
            )}
            <span className="text-[10px] text-text-subtle">{item.category}</span>
          </span>
          {item.versionConflict && item.packageVersion && (
            <span
              className="mt-0.5 block text-[10px] text-attention"
              title="The tool and its package report different versions — often a stale shim, or a second copy earlier on PATH."
            >
              {item.manager ?? 'package'} says {item.packageVersion}
            </span>
          )}
          {item.shadowed.length > 0 && (
            <span
              className="mt-0.5 block truncate text-[10px] text-text-subtle"
              title={`Also present, but shadowed on PATH: ${item.shadowed.join(', ')}`}
            >
              Shadows {item.shadowed.length} other cop{item.shadowed.length === 1 ? 'y' : 'ies'}
            </span>
          )}
          {item.aliases.length > 0 && (
            <span className="mt-0.5 block truncate text-[10px] text-text-subtle" title={item.aliases.join(', ')}>
              Also: {item.aliases.join(', ')}
            </span>
          )}
          {/* The resolved file, always. A version with no path behind it is
              exactly how a PATH surprise stays invisible. */}
          {item.executable && (
            <span className="mt-1 block truncate text-[10px] font-mono text-text-subtle" title={item.executable}>
              {item.executable}
            </span>
          )}
          <span className="mt-1 block text-[10px] text-text-subtle">
            Sources: {sources}
            {item.origin && item.origin !== 'unknown' ? ` · ${item.origin}` : ''}
          </span>
          {!compact && item.detail && (
            <span className="mt-1 block text-[10px] leading-relaxed text-text-subtle">{item.detail}</span>
          )}
          {item.packageEvidence && (
            <span className="block truncate text-[10px] text-text-subtle">
              {item.packageEvidence.manager}:{item.packageEvidence.package}
              {item.packageEvidence.version && ` · ${item.packageEvidence.version}`}
            </span>
          )}
          {item.homepage && (
            <a href={item.homepage} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text">
              <Icon name="link" size={9} /> {new URL(item.homepage).host}
            </a>
          )}
        </span>
        <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', tone)} title={item.detail} />
      </div>
    </div>
  );
}

function EmptyFilter({ filter, onShowAll }: { filter: Filter; onShowAll: () => void }) {
  const copy =
    filter === 'connected'
      ? 'Nothing is connected yet. Scan this machine to find what is already installed, or browse everything the Hub can plan against.'
      : 'Nothing was found on this machine for that filter. Everything the Hub knows about is still available to plan against.';
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 text-center">
      <p className="text-[12.5px] text-text-muted">{copy}</p>
      <button
        onClick={onShowAll}
        className="mt-2.5 rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-text transition-colors hover:border-line-strong"
      >
        Show everything
      </button>
    </div>
  );
}

/* ── node windows ───────────────────────────────────────────────── */

function NodeWindows({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const windows = useWindowManager((s) => s.windows);
  const nodes = useEnvironmentStore((s) => s.nodes);
  const busy = useEnvironmentStore((s) => s.busy);
  const connect = useEnvironmentStore((s) => s.connect);
  const disconnect = useEnvironmentStore((s) => s.disconnect);
  const setNodePermissions = useEnvironmentStore((s) => s.setNodePermissions);

  return (
    <AnimatePresence>
      {windows.map((win) => {
        const node = nodes.find((n) => n.id === win.contentId);
        if (!node) return null;
        const tone = STATUS_TONE[node.health.status];
        return (
          <FloatingSurface
            key={win.id}
            window={win}
            canvasRef={canvasRef}
            title={node.entry.name}
            icon={CATEGORY_ICON[node.entry.category]}
            subtitle={node.health.version}
            toneClass={TONE_DOT[tone]}
          >
            <NodeInspector
              node={node}
              busy={busy.includes(node.id)}
              onConnect={() => void connect(node.id)}
              onDisconnect={() => disconnect(node.id)}
              onPermissions={(partial) => setNodePermissions(node.id, partial)}
            />
          </FloatingSurface>
        );
      })}
    </AnimatePresence>
  );
}

/** Dock for open node windows — mirrors the Workspace's tray vocabulary. */
function WindowTray() {
  const windows = useWindowManager((s) => s.windows);
  const focusedId = useWindowManager((s) => s.focusedId);
  const focus = useWindowManager((s) => s.focus);
  const minimize = useWindowManager((s) => s.minimize);
  const closeAll = useWindowManager((s) => s.closeAll);
  const nodes = useEnvironmentStore((s) => s.nodes);

  if (!windows.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.smooth}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-line bg-surface/90 p-1.5 shadow-lg backdrop-blur-xl">
        {windows.map((win) => {
          const node = nodes.find((n) => n.id === win.contentId);
          if (!node) return null;
          const active = focusedId === win.id && !win.minimized;
          return (
            <button
              key={win.id}
              onClick={() => (active ? minimize(win.id) : focus(win.id))}
              title={node.entry.name}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-xl transition-all hover:scale-105',
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Icon name={CATEGORY_ICON[node.entry.category] as IconName} size={14} />
            </button>
          );
        })}
        <span className="mx-0.5 h-5 w-px bg-line" />
        <button
          onClick={closeAll}
          title="Close all windows"
          className="grid h-8 w-8 place-items-center rounded-xl text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </motion.div>
  );
}

/* ── grouping ───────────────────────────────────────────────────── */

function filterNodes(nodes: EnvironmentNode[], filter: Filter): EnvironmentNode[] {
  if (filter === 'all') return nodes;
  if (filter === 'connected') return nodes.filter((n) => n.connected);
  return nodes.filter((n) => n.connected || n.health.status === 'available');
}

const CATEGORY_ORDER: NodeCategory[] = ['hub', 'development', 'cloud', 'ai', 'design', 'productivity', 'browser'];

function groupByCategory(nodes: EnvironmentNode[]): [NodeCategory, EnvironmentNode[]][] {
  return CATEGORY_ORDER
    .map((category) => [category, nodes.filter((n) => n.entry.category === category)] as [NodeCategory, EnvironmentNode[]])
    .filter(([, list]) => list.length > 0);
}
