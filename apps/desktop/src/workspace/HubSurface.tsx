/**
 * HubSurface — the one object the user talks to.
 * ==================================================================
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
import type { HubPhase, HubProgress } from './hubPhase';

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
  error,
  onSubmit,
  onApprove,
  onStart,
}: {
  readiness: HubReadiness;
  scanning: boolean;
  lastScanAt: string | null;
  onScan: () => void;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string) => void;
  progress: HubProgress;
  mission: MissionRecord | null;
  /** Placed nodes a planned mission needs but cannot use, from real gaps. */
  missing: { node: EnvironmentNode; capabilityId: string }[];
  error: string | null;
  onSubmit: (text: string) => void;
  onApprove: () => void;
  onStart: () => void;
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
      className="pointer-events-auto w-[380px] rounded-3xl border border-line bg-surface/95 p-5 shadow-lg backdrop-blur-xl"
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
            {progress.phase === 'idle' ? 'Hub' : progress.label}
          </h2>
          <p className="truncate text-[11.5px] text-text-muted" data-testid="hub-detail">
            {/* When the banner below already carries this exact text, the
                header steps out of the way rather than repeating it. */}
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

      {/* Which project this mission plans against. Missions read real files,
          so there is no sensible default and none is invented. */}
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
            // Enter submits; Shift+Enter is a newline. Matches the rest of
            // AURA's composers.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="hub-composer"
          placeholder={hasProject ? 'Describe the outcome you want…' : 'Choose a project first…'}
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

      {/* The mission's own gates. These call the existing endpoints; the
          Hub decides nothing on the user's behalf. */}
      {mission?.goalGraph && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {mission.approval.status === 'pending' && (
            <GateButton label="Approve plan" icon="check" onClick={onApprove} testId="hub-approve" primary />
          )}
          {mission.approval.status === 'approved' && mission.execution?.status === 'approved' && (
            <GateButton label="Start execution" icon="deploy" onClick={onStart} testId="hub-start" primary />
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

function GateButton({
  label,
  icon,
  onClick,
  testId,
  primary,
}: {
  label: string;
  icon: 'check' | 'deploy';
  onClick: () => void;
  testId: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors',
        primary
          ? 'bg-accent text-white hover:opacity-90'
          : 'border border-line bg-surface text-text-muted hover:bg-surface-hover hover:text-text',
      )}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
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
