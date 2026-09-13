import { useMemo, useState } from 'react';
import { Icon, SkeletonCard } from '@aura/ui';
import { EmptyState } from '../../../components/EmptyState';
import type { MissionRecord } from '../../../ai/missionClient';
import type { ProjectRecord } from '../../../ai/aiClient';
import type { CreationState } from '../../missions/useMissions';
import type { HubProgress } from '../../../workspace/hubPhase';
import { useWorkspace } from '../../../data/useWorkspace';
import { AgentRunPanel } from './AgentRunPanel';
import { TimelineStepCard } from './TimelineStepCard';
import { toTimelineSteps } from './timelineSteps';
import { GlowButton } from './GlowButton';
import type { AgentRun } from './useAgentRun';

/**
 * TimelineContainer — the AURA Agent workspace, and the older Mission
 * timeline behind it.
 *
 * The agent run is the workspace: it fills the panel and needs no tab to
 * find. Missions are a different engine with a different authority, so
 * they stay reachable — but as a secondary view rather than a peer, and
 * their composer lives inside that view. Two equally-prominent prompts on
 * one screen made the user guess which one AURA was listening to; there
 * is now exactly one place to talk to AURA, and it is the rail.
 */
export function TimelineContainer({
  run,
  active,
  creation,
  progress,
  projects,
  projectId,
  onSelectProject,
  busy,
  error,
  mission,
  onMissionSubmit,
  onMissionApprove,
  onMissionStart,
}: {
  run: AgentRun;
  active: MissionRecord | null;
  creation: CreationState;
  progress: HubProgress;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  busy: boolean;
  error: string | null;
  mission: MissionRecord | null;
  onMissionSubmit: (text: string) => void;
  onMissionApprove: () => void;
  onMissionStart: () => void;
}) {
  const [view, setView] = useState<'agent' | 'mission'>('agent');
  const [missionText, setMissionText] = useState('');
  const refreshProjects = useWorkspace((st) => st.refresh);
  const refreshing = useWorkspace((st) => st.loading);
  const steps = useMemo(
    () => toTimelineSteps(active, creation, progress),
    [active, creation, progress],
  );
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <section aria-label="Execution timeline" className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-[rgba(125,146,255,0.22)] bg-[rgba(7,11,20,0.85)] px-6 py-4 backdrop-blur-md">
        <span className="grid h-11 w-11 place-items-center rounded-xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] text-[#c9bcff]">
          <Icon name="spark" size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <h2 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-text">
            AURA Agent Workspace
          </h2>
          <p className="truncate text-[12px] text-text-muted">
            Thinking. Collaborating. Building.
          </p>
        </span>

        <label className="inline-flex items-center gap-2 rounded-xl border border-[rgba(125,146,255,0.3)] bg-[rgba(16,24,43,0.9)] px-3 py-2 text-[12.5px] text-text">
          <Icon name="folder" size={14} className="text-text-subtle" />
          <span className="sr-only">Select project</span>
          <span className="text-text-subtle">Project:</span>
          <select
            value={projectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value || null)}
            aria-label="Select project"
            className="neon-focus max-w-[180px] truncate bg-transparent outline-none"
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        {/* Secondary: the older Mission engine, and a real refresh. */}
        <button
          type="button"
          onClick={() => setView((v) => (v === 'agent' ? 'mission' : 'agent'))}
          data-testid={view === 'agent' ? 'workspace-tab-mission' : 'workspace-tab-agent'}
          className="neon-focus rounded-xl border border-[rgba(125,146,255,0.3)] px-3 py-2 text-[11.5px] font-medium text-text-muted transition-colors hover:bg-white/5 hover:text-text"
        >
          {view === 'agent' ? 'Missions' : 'AURA Agent'}
        </button>
        <button
          type="button"
          onClick={() => void refreshProjects()}
          disabled={refreshing}
          aria-label="Refresh projects"
          title="Refresh projects"
          data-testid="workspace-refresh-projects"
          className="neon-focus grid h-9 w-9 place-items-center rounded-xl border border-[rgba(125,146,255,0.3)] text-text-muted transition-colors duration-150 hover:bg-white/5 hover:text-text disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
        </button>
      </header>

      {view === 'agent' && <AgentRunPanel run={run} />}

      {view === 'mission' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="log"
            aria-live="polite"
            aria-label="Mission activity"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4"
          >
            {error && (
              <div role="alert" className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-3 py-2 text-[12px] text-neon-danger">
                {error}
              </div>
            )}

            {busy && !active && (
              <>
                <SkeletonCard className="border-[rgba(125,146,255,0.25)] bg-[rgba(16,24,43,0.7)]" />
                <SkeletonCard className="border-[rgba(125,146,255,0.25)] bg-[rgba(16,24,43,0.7)]" />
              </>
            )}

            {!busy && steps.length === 0 && (
              <EmptyState
                icon="cpu"
                title={projectName ? `No mission in ${projectName}` : 'No mission yet'}
                description="Missions plan against real files on disk. This is the older engine — to delegate work to AI workers, use the AURA Agent."
              />
            )}

            {steps.map((s, i) => (
              <div key={s.id} className="relative pl-6">
                <span
                  aria-hidden
                  className="absolute left-[7px] top-10 bottom-[-12px] w-px bg-gradient-to-b from-[rgba(122,92,255,0.6)] to-[rgba(77,124,255,0.15)] last:hidden"
                />
                <span
                  aria-hidden
                  className="absolute left-1 top-5 h-[9px] w-[9px] rounded-full border border-[rgba(140,170,255,0.7)] bg-neon-base"
                  style={{ boxShadow: i === 0 ? '0 0 12px rgba(122,92,255,0.8)' : undefined }}
                />
                <TimelineStepCard step={s} />
              </div>
            ))}
          </div>

          {/* The Mission composer lives with its own engine, not beside
              the AURA composer, so the two can never be mistaken. */}
          <div className="border-t border-[rgba(125,146,255,0.2)] px-6 py-3">
            <div className="rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(13,19,38,0.8)] p-3">
              <label htmlFor="mission-composer" className="sr-only">Describe a mission</label>
              <textarea
                id="mission-composer"
                rows={2}
                value={missionText}
                disabled={progress.busy || !projectId}
                onChange={(e) => setMissionText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && missionText.trim()) {
                    e.preventDefault();
                    onMissionSubmit(missionText.trim());
                    setMissionText('');
                  }
                }}
                data-testid="hub-composer"
                placeholder={projectId ? 'Describe a mission…' : 'Choose a project first…'}
                className="neon-focus w-full resize-none bg-transparent text-[13px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-[10.5px] text-text-subtle">
                  {progress.busy ? progress.detail : 'Missions plan against real files on disk.'}
                </span>
                <span className="flex items-center gap-2">
                  {mission?.approval.status === 'pending' && (
                    <GlowButton size="sm" icon="check" onClick={onMissionApprove} data-testid="hub-approve">
                      Approve plan
                    </GlowButton>
                  )}
                  {mission?.approval.status === 'approved' && (
                    <GlowButton size="sm" icon="arrow-right" onClick={onMissionStart} data-testid="hub-start">
                      Start
                    </GlowButton>
                  )}
                  <GlowButton
                    size="sm"
                    onClick={() => {
                      if (!missionText.trim()) return;
                      onMissionSubmit(missionText.trim());
                      setMissionText('');
                    }}
                    disabled={progress.busy || !projectId || !missionText.trim()}
                    data-testid="hub-submit"
                    aria-label="Create mission"
                  >
                    <Icon name="arrow-right" size={15} />
                  </GlowButton>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
