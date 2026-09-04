/**
 * HubSurface — the AURA Agent Workspace control center.
 * =================================================================
 * The Hub is a *surface*, not a node, not a window and not an engine. It
 * owns no mission state: the composer calls the existing
 * `missionClient.create()` → `runMissionCreation()` pipeline, and every
 * phase it displays is derived from the authoritative `MissionRecord` by
 * `hubPhase.ts`. There is deliberately no second mission model here, and
 * no status string that Mission Control does not already compute.
 *
 * Missions plan against real files on disk, so they are project-scoped
 * (`workspace.ts:672` throws without a registered project). The Hub is a
 * global surface, so it asks which project rather than inventing one —
 * submitting never creates a folder as a side effect.
 *
 * The environment readiness shown here is real: those counts come from
 * actual `execFile` probes of the local machine.
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import type { EnvironmentNode } from '@aura/connected-environment';
import type { ProjectRecord } from '../ai/aiClient';
import type { MissionRecord } from '../ai/missionClient';
import type { HubPhase, HubProgress, UnattributedWork } from './hubPhase';
import { useEnvironmentSummary } from '../environment/environmentStore';

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

/** Phase → dot colour. Purely presentational; the phase itself is derived. */
const PHASE_TONE: Record<HubPhase, string> = {
  idle: 'bg-text-subtle',
  understanding: 'bg-accent',
  planning: 'bg-accent',
  preparing: 'bg-attention',
  'awaiting-approval': 'bg-attention',
  executing: 'bg-accent',
  verifying: 'bg-accent',
  completed: 'bg-positive',
  failed: 'bg-danger',
};

/** Prompt placeholder text. */
const PLACEHOLDERS = {
  hasProject: 'Describe the outcome you want…',
  noProject: 'Choose a project first…',
};

export function HubSurface({
  readiness,
  scanning,
  lastScanAt,
  onScan,
  projects,
  projectId,
  onSelectProject,
  progress,
  mission,
  missing,
  unattributed,
  error,
  onSubmit,
  onApprove,
  onStart,
  viewMode,
}: {
  readiness: HubReadiness;
  scanning: boolean;
  lastScanAt: string | null;
  onScan: () => void;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  progress: HubProgress;
  mission: MissionRecord | null;
  /** Placed nodes a planned mission needs but cannot use, from real gaps. */
  missing: { node: EnvironmentNode; capabilityId: string }[];
  /** In-flight work that could not be pinned to one node. Never guessed. */
  unattributed: UnattributedWork[];
  error: string | null;
  onSubmit: (text: string) => void;
  onApprove: () => void;
  onStart: () => void;
  viewMode: 'grid' | 'list';
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the prompt, but never past the Hub's own footprint — the
  // Hub is a fixed object on a canvas, not a page that reflows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const hasProject = !!projectId;
  const canSubmit = hasProject && text.trim().length > 0 && !progress.busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(text.trim());
    setText('');
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring.gentle}
      data-testid="hub-surface"
      data-phase={progress.phase}
      className="pointer-events-auto w-full max-w-[420px] rounded-2xl border border-line bg-surface/95 p-5 shadow-md backdrop-blur-xl"
    >
      <div className="flex items-center gap-2.5">
        <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-accent text-white">
          <Icon name="spark" size={18} />
          {(scanning || progress.busy) && (
            <span className="absolute -inset-1 animate-ping rounded-2xl border border-accent/40" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text">
            {progress.phase === 'idle' ? 'AURA Agent Workspace' : progress.label}
          </h2>
          <p className="truncate text-[11.5px] text-text-muted" data-testid="hub-detail">
            {scanning && progress.phase === 'idle'
              ? 'Reading your environment…'
              : error === progress.detail
                ? ''
                : progress.detail}
          </p>
        </div>
        {progress.phase !== 'idle' && (
          <span className={cn('h-2 w-2 shrink-0 rounded-full', PHASE_TONE[progress.phase])} />
        )}
      </div>

      {/* Which project this mission plans against. */}
      <div className="mt-3.5 flex items-center gap-2">
        <Icon name="folder" size={13} className="shrink-0 text-text-subtle" />
        <select
          value={projectId ?? ''}
          onChange={(e) => onSelectProject(e.target.value)}
          data-testid="hub-project"
          className="min-w-0 flex-1 truncate rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
        >
          <option value="">Choose a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Composer — live. */}
      <div
        className={cn(
          'mt-2.5 rounded-2xl border bg-canvas px-3 py-2.5 transition-colors',
          progress.busy ? 'border-line opacity-60' : 'border-line focus-within:border-accent',
        )}
      >
        <textarea
          ref={taRef}
          rows={2}
          value={text}
          disabled={progress.busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="hub-composer"
          placeholder={hasProject ? PLACEHOLDERS.hasProject : PLACEHOLDERS.noProject}
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-[10.5px] text-text-subtle">
            {progress.busy ? progress.detail : hasProject ? 'Enter to send · Shift+Enter for a new line' : 'Missions plan against real files on disk.'}
          </span>
          <button
            onClick={submit}
            disabled={!canSubmit}
            data-testid="hub-submit"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            {progress.busy ? <Icon name="refresh" size={12} className="animate-spin" /> : <Icon name="arrow-right" size={12} />}
            {progress.busy ? 'Working' : 'Send'}
          </button>
        </div>
      </div>

      {/* Honest failure. Never swallowed, never turned into a fake result. */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            data-testid="hub-error"
            className="mt-2 overflow-hidden"
          >
            <div className="flex items-start gap-1.5 rounded-xl border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              <Icon name="close" size={12} className="mt-px shrink-0" />
              <span className="min-w-0">{error}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Real capability gaps, from the Fabric's own annotation. */}
      {missing.length > 0 && (
        <div className="mt-2 space-y-1" data-testid="hub-gaps">
          {missing.slice(0, 3).map(({ node, capabilityId }) => (
            <div
              key={`${node.id}:${capabilityId}`}
              className="flex items-start gap-1.5 rounded-xl border border-attention/30 bg-attention/10 px-2.5 py-1.5 text-[11px] text-attention"
            >
              <Icon name="link" size={12} className="mt-px shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">{node.entry.name}</span> is required but{' '}
                {node.health.status === 'not-installed' ? "isn't installed" : 'is not connected'}.
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Work in flight that no executor claimed. */}
      {unattributed.length > 0 && (
        <div
          data-testid="hub-unattributed"
          className="mt-2 flex items-start gap-1.5 rounded-xl border border-line bg-surface-active px-2.5 py-1.5 text-[11px] text-text-muted"
        >
          <Icon name="dot" size={12} className="mt-px shrink-0" />
          <span className="min-w-0">
            {unattributed.length} task{unattributed.length === 1 ? '' : 's'} running on an
            unidentified node — {unattributed[0].candidates.length} could have run{' '}
            <span className="font-medium">{unattributed[0].capabilityId}</span>.
          </span>
        </div>
      )}

      {/* The mission's own gates. */}
      {mission?.goalGraph && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {mission.approval.status === 'pending' && (
            <button
              onClick={onApprove}
              data-testid="hub-approve"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium text-accent text-white transition-colors hover:opacity-90"
            >
              <Icon name="check" size={12} />
              Approve plan
            </button>
          )}
          {mission.approval.status === 'approved' && mission.execution?.status === 'approved' && (
            <button
              onClick={onStart}
              data-testid="hub-start"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium text-accent text-white transition-colors hover:opacity-90"
            >
              <Icon name="deploy" size={12} />
              Start execution
            </button>
          )}
          <span className="truncate text-[10.5px] text-text-subtle">
            {mission.goalGraph.goals.length} goals · {mission.goalGraph.tasks.length} tasks
          </span>
        </div>
      )}

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