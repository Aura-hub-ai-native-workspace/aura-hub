import { useEffect, useRef, useState } from 'react';
import { cn } from '@aura/core';
import { Icon, IconButton, type IconName } from '@aura/ui';
import type { EnvironmentNode } from '@aura/connected-environment';
import type { ProjectRecord } from '../../../ai/aiClient';
import type { MissionRecord } from '../../../ai/missionClient';
import type { HubProgress, NodeActivityPhase } from '../../../workspace/hubPhase';
import { ACTIVITY_LABEL } from '../../../workspace/hubPhase';
import { CATEGORY_ICON, STATUS_LABEL, STATUS_TONE, TONE_DOT } from '../../../environment/presentation';
import { GlassCard } from './GlassCard';
import { GlowButton } from './GlowButton';

function MiniCard({
  node,
  role,
  activity,
  onInspect,
}: {
  node: EnvironmentNode;
  role: string;
  /** Live execution phase — pulses only while a real task is in flight. */
  activity: NodeActivityPhase;
  onInspect: () => void;
}) {
  const tone = STATUS_TONE[node.health.status];
  const live = activity !== 'idle';
  return (
    <button
      type="button"
      onClick={onInspect}
      data-testid="hub-node"
      data-node-id={node.id}
      data-status={node.health.status}
      data-activity={activity}
      className="neon-focus group flex flex-col items-center gap-1.5 rounded-md border border-[rgba(125,146,255,0.25)] bg-[rgba(13,19,38,0.85)] px-2 py-3 text-center transition-colors duration-150 hover:border-[rgba(125,146,255,0.5)]"
      title={`${node.entry.name} — ${STATUS_LABEL[node.health.status]}${live ? ` · ${ACTIVITY_LABEL[activity]}` : ''}`}
    >
      <span className="relative grid h-10 w-10 place-items-center rounded-xl border border-white/5 bg-black/30 text-text">
        <Icon name={CATEGORY_ICON[node.entry.category]} size={20} />
        {live && <span className="aura-live absolute inset-0 text-neon-cyan" aria-hidden />}
      </span>
      <span className="w-full truncate text-[11.5px] font-semibold text-text">{node.entry.name}</span>
      <span className="text-[10.5px] text-text-subtle">{live ? ACTIVITY_LABEL[activity] : role}</span>
      <span className={cn('flex items-center gap-1 text-[10px]', tone === 'positive' ? 'text-neon-success' : tone === 'attention' ? 'text-neon-warning' : 'text-text-subtle')}>
        <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />
        {STATUS_LABEL[node.health.status]}
      </span>
    </button>
  );
}

/**
 * LeftControlPanel — brand, real capability cards, agent hub, composer, dock.
 * Presentational only: all state/actions come from WorkspaceScreen props
 * (same contract as HubSurface), so no business logic is duplicated.
 */
export interface RailReadiness {
  connected: number;
  available: number;
  missing: number;
  unscanned: number;
}

export function LeftControlPanel({
  nodes,
  scanning,
  readiness,
  lastScanAt,
  gaps,
  projects,
  projectId,
  onSelectProject,
  progress,
  mission,
  error,
  onSubmit,
  onApprove,
  onStart,
  onScan,
  onAddNode,
  onRelayout,
  activity,
  onInspect,
}: {
  nodes: EnvironmentNode[];
  scanning: boolean;
  /** Measured counts for the placed nodes only — same probe source as before. */
  readiness: RailReadiness;
  lastScanAt: string | null;
  /** Real capability gaps from the Fabric annotation (never guessed). */
  gaps: { node: EnvironmentNode; capabilityId: string }[];
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  progress: HubProgress;
  mission: MissionRecord | null;
  error: string | null;
  onSubmit: (text: string) => void;
  onApprove: () => void;
  onStart: () => void;
  onScan: () => void;
  onAddNode: () => void;
  onRelayout: () => void;
  /** Live execution phase per placed node id (empty map when idle). */
  activity: Map<string, NodeActivityPhase>;
  onInspect: (nodeId: string) => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  const top = nodes.slice(0, 3);
  const bottom = nodes.slice(3, 6);
  const roles = ['Reasoning', 'Analysis', 'Multimodal', 'Executor', 'Integration', 'Tools & APIs'];

  return (
    <aside
      aria-label="Agent controls"
      data-testid="hub-surface"
      data-phase={progress.phase}
      className="flex min-h-0 w-full flex-col gap-3"
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet text-white shadow-glow-blue">
          <Icon name="spark" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-text">
            AURA <span className="text-neon-blue">Hub</span>
          </span>
          <span className="block truncate text-[11px] text-text-subtle">One Prompt. Multiple Minds.</span>
        </span>
        <IconButton icon="panel" label="Toggle panel" size="sm" onClick={onRelayout} />
      </div>

      {/* Capability cards → agent hub */}
      <GlassCard className="p-3">
        <div className="grid grid-cols-3 gap-2" role="list" aria-label="Connected capabilities">
          {top.length === 0 && (
            <p className="col-span-3 py-2 text-center text-[11.5px] text-text-subtle">
              {scanning ? 'Reading your environment…' : 'No capabilities placed yet.'}
            </p>
          )}
          {top.map((n, i) => (
            <div key={n.id} role="listitem">
              <MiniCard
                node={n}
                role={roles[i] ?? n.entry.category}
                activity={activity.get(n.id) ?? 'idle'}
                onInspect={() => onInspect(n.id)}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center py-2" aria-hidden>
          <span className="grid h-14 w-14 place-items-center rounded-2xl border border-[rgba(77,124,255,0.5)] bg-[rgba(10,16,34,0.95)] text-text shadow-glow-blue">
            <Icon name="cpu" size={30} />
          </span>
          <span className="mt-1.5 text-[14px] font-semibold text-text">AURA Agent</span>
          <span className="text-[11px] text-text-subtle">Plan • Use Tools • Get Results</span>
          <span className="mt-0.5 max-w-full truncate text-[11px] text-neon-cyan">{progress.busy ? progress.detail : progress.label}</span>
        </div>

        <div className="grid grid-cols-3 gap-2" role="list" aria-label="Tool integrations">
          {bottom.map((n, i) => (
            <div key={n.id} role="listitem">
              <MiniCard
                node={n}
                role={roles[i + 3] ?? n.entry.category}
                activity={activity.get(n.id) ?? 'idle'}
                onInspect={() => onInspect(n.id)}
              />
            </div>
          ))}
        </div>

        {mission?.approval.status === 'pending' && (
          <GlowButton block size="sm" icon="check" onClick={onApprove} className="mt-3" data-testid="hub-approve">
            Approve plan
          </GlowButton>
        )}
        {mission?.approval.status === 'approved' && mission.execution?.status === 'approved' && (
          <GlowButton block size="sm" icon="deploy" onClick={onStart} className="mt-3" data-testid="hub-start">
            Start execution
          </GlowButton>
        )}
        {error && (
          <p role="alert" data-testid="hub-error" className="mt-2 rounded-md border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-2.5 py-1.5 text-[11.5px] text-neon-danger">
            {error}
          </p>
        )}

        {gaps.slice(0, 3).map(({ node, capabilityId }) => (
          <p
            key={`${node.id}:${capabilityId}`}
            className="mt-2 rounded-md border border-[rgba(255,181,71,0.4)] bg-[rgba(255,181,71,0.08)] px-2.5 py-1.5 text-[11.5px] text-neon-warning"
          >
            <span className="font-semibold">{node.entry.name}</span> is required but{' '}
            {node.health.status === 'not-installed' ? "isn't installed" : 'is not connected'}.
          </p>
        ))}

        <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2.5 text-[10.5px] text-text-subtle" aria-label="Environment readiness">
          <span>
            <span className="font-semibold text-neon-success">{readiness.connected}</span> connected
            {' · '}
            <span className="font-semibold text-neon-blue">{readiness.available}</span> found
            {' · '}
            <span className="font-semibold text-neon-warning">{readiness.missing}</span> missing
            {' · '}
            <span className="font-semibold">{readiness.unscanned}</span> unscanned
          </span>
          <button
            type="button"
            onClick={onScan}
            disabled={scanning}
            data-testid="hub-scan"
            className="neon-focus inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-text-muted transition-colors duration-150 hover:text-text disabled:opacity-50"
          >
            <Icon name="refresh" size={12} />
            {scanning ? 'Scanning…' : lastScanAt ? 'Rescan' : 'Scan'}
          </button>
        </div>
      </GlassCard>

      {/* Composer */}
      <GlassCard className="p-3">
        <label htmlFor="neon-composer" className="sr-only">Type your message</label>
        <textarea
          id="neon-composer"
          ref={taRef}
          rows={3}
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
          placeholder={hasProject ? 'Type your message…' : 'Choose a project first…'}
          className="neon-focus w-full resize-none bg-transparent text-[13px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[10.5px] text-text-subtle">
            {progress.busy ? progress.detail : hasProject ? 'Enter to send · Shift+Enter for new line' : 'Missions plan against real files on disk.'}
          </span>
          <GlowButton size="sm" onClick={submit} disabled={!canSubmit} data-testid="hub-submit" aria-label="Send message">
            <Icon name="arrow-right" size={15} />
          </GlowButton>
        </div>
        {!hasProject && projects.length > 0 && (
          <label className="mt-2 flex items-center gap-2 text-[11.5px] text-text-subtle">
            <Icon name="folder" size={13} />
            <span className="sr-only">Select project</span>
            <select
              value={projectId ?? ''}
              onChange={(e) => onSelectProject(e.target.value || null)}
              data-testid="hub-project"
              className="neon-focus min-w-0 flex-1 truncate rounded-md border border-[rgba(125,146,255,0.3)] bg-transparent px-2 py-1 text-text outline-none"
            >
              <option value="">Choose a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
      </GlassCard>

      {/* Dock */}
      <div className="mt-auto flex items-center gap-2" role="toolbar" aria-label="Quick actions">
        {(
          [
            { icon: 'plus' as const, label: 'Add capability node', fn: onAddNode, testId: 'add-node-open' },
            { icon: 'command' as const, label: 'Scan environment', fn: onScan, testId: undefined },
            { icon: 'file' as const, label: 'Re-arrange workspace', fn: onRelayout, testId: undefined },
            { icon: 'settings' as const, label: 'Workspace settings', fn: onRelayout, testId: undefined },
          ]
        ).map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.fn}
            aria-label={a.label}
            title={a.label}
            data-testid={a.testId}
            className="neon-focus grid h-10 flex-1 place-items-center rounded-md border border-[rgba(125,146,255,0.25)] bg-[rgba(13,19,38,0.85)] text-text-muted transition-colors duration-150 hover:border-[rgba(125,146,255,0.5)] hover:text-text"
          >
            <Icon name={a.icon} size={17} />
          </button>
        ))}
      </div>
    </aside>
  );
}

export type LeftDockIcon = IconName;
