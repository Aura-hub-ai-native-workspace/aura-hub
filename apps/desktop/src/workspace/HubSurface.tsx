/**
 * HubSurface — the one object the user talks to.
 * ==================================================================
 * The Hub is a *surface*, not a node, not a window and not an engine. It
 * owns no mission state: when the mission wiring lands (phase 3, see
 * docs/WORKSPACE_EXECUTION_ARCHITECTURE.md §17) the composer will call the
 * existing `runMissionCreation()` pipeline through `missionClient`, and
 * every phase it displays will be derived from the authoritative
 * `MissionRecord`. There is deliberately no second mission model here.
 *
 * In this first slice the composer is **honestly disabled**. The
 * environment readiness it shows, however, is entirely real — those counts
 * come from actual `execFile` probes of the local machine.
 */

import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import type { EnvironmentNode } from '@aura/connected-environment';

export interface HubReadiness {
  connected: number;
  available: number;
  missing: number;
  unscanned: number;
}

export function readinessOf(nodes: EnvironmentNode[]): HubReadiness {
  const readiness: HubReadiness = { connected: 0, available: 0, missing: 0, unscanned: 0 };
  for (const node of nodes) {
    switch (node.health.status) {
      case 'connected':
        readiness.connected += 1;
        break;
      case 'available':
      case 'needs-auth':
        readiness.available += 1;
        break;
      case 'not-installed':
        readiness.missing += 1;
        break;
      default:
        readiness.unscanned += 1;
    }
  }
  return readiness;
}

export function HubSurface({
  readiness,
  scanning,
  lastScanAt,
  onScan,
}: {
  readiness: HubReadiness;
  scanning: boolean;
  lastScanAt: string | null;
  onScan: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring.gentle}
      data-testid="hub-surface"
      className="pointer-events-auto w-[380px] rounded-3xl border border-line bg-surface/95 p-5 shadow-lg backdrop-blur-xl"
    >
      <div className="flex items-center gap-2.5">
        <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-accent text-white">
          <Icon name="spark" size={18} />
          {scanning && (
            <span className="absolute -inset-1 animate-ping rounded-2xl border border-accent/40" />
          )}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text">Hub</h2>
          <p className="truncate text-[11.5px] text-text-muted">
            {scanning ? 'Reading your environment…' : 'Where AURA plans and orchestrates'}
          </p>
        </div>
      </div>

      {/* Composer — present, and honest about not being wired yet. */}
      <div className="mt-4 rounded-2xl border border-line bg-canvas px-3 py-2.5">
        <textarea
          disabled
          rows={2}
          data-testid="hub-composer"
          placeholder="Describe the outcome you want…"
          className="w-full resize-none bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-text-subtle">
          <Icon name="activity" size={11} />
          Mission execution through the Hub lands in the next phase — the environment below is live now.
        </div>
      </div>

      {/* Real, measured readiness. */}
      <div className="mt-4 grid grid-cols-4 gap-1.5">
        <Stat label="Connected" value={readiness.connected} tone="text-positive" />
        <Stat label="Found" value={readiness.available} tone="text-accent" />
        <Stat label="Missing" value={readiness.missing} tone="text-attention" />
        <Stat label="Unscanned" value={readiness.unscanned} tone="text-text-subtle" />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-text-subtle">
          {lastScanAt ? `Measured ${new Date(lastScanAt).toLocaleTimeString()}` : 'Not yet measured'}
        </span>
        <button
          onClick={onScan}
          disabled={scanning}
          data-testid="hub-scan"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          <Icon name="refresh" size={12} />
          {scanning ? 'Scanning…' : 'Scan environment'}
        </button>
      </div>
    </motion.div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl bg-surface-active px-2 py-1.5 text-center">
      <div className={cn('text-[15px] font-semibold tabular-nums', tone)}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wide text-text-subtle">{label}</div>
    </div>
  );
}
