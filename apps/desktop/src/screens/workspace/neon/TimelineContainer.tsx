import { useMemo, useState } from 'react';
import { Icon } from '@aura/ui';
import { SkeletonCard } from '@aura/ui';
import { EmptyState } from '../../../components/EmptyState';
import type { MissionRecord } from '../../../ai/missionClient';
import type { ProjectRecord } from '../../../ai/aiClient';
import type { CreationState } from '../../missions/useMissions';
import type { HubProgress } from '../../../workspace/hubPhase';
import { useWorkspace } from '../../../data/useWorkspace';
import { AgentRunPanel } from './AgentRunPanel';
import { TimelineStepCard } from './TimelineStepCard';
import { toTimelineSteps } from './timelineSteps';

/**
 * TimelineContainer — right execution rail, two real views.
 *
 * "Mission" is the existing mission timeline, unchanged: a pure adapter
 * over MissionRecord. "AURA Agent" is the governed delegation loop —
 * plan, worker selection, governed actions, verification, final answer —
 * driven entirely by the Central Agent's own events.
 *
 * They are separate views rather than one merged feed because they are
 * two different engines with two different authorities, and pretending
 * otherwise would put a second orchestrator on screen.
 */
export function TimelineContainer({
  active,
  creation,
  progress,
  projects,
  projectId,
  onSelectProject,
  busy,
  error,
  projectPath,
  onWorkerActivity,
}: {
  active: MissionRecord | null;
  creation: CreationState;
  progress: HubProgress;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  busy: boolean;
  error: string | null;
  /** Absolute path of the active project; the agent runs against it. */
  projectPath: string | null;
  onWorkerActivity?: (activity: Map<string, string>) => void;
}) {
  const [view, setView] = useState<'agent' | 'mission'>('agent');
  const refreshProjects = useWorkspace((st) => st.refresh);
  const refreshing = useWorkspace((st) => st.loading);
  const steps = useMemo(() => toTimelineSteps(active, creation, progress), [active, creation, progress]);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <section aria-label="Execution timeline" className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-[rgba(125,146,255,0.22)] bg-[rgba(7,11,20,0.85)] px-4 py-3 backdrop-blur-md">
        <span className="grid h-9 w-9 place-items-center rounded-xl border border-[rgba(122,92,255,0.4)] bg-[rgba(122,92,255,0.12)] text-[#b7a6ff]">
          <Icon name="spark" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text">
            AURA Agent Workspace
          </h2>
          <p className="truncate text-[11.5px] text-text-muted">Plan · Delegate · Supervise · Verify</p>
        </span>
        <label className="inline-flex items-center gap-2 rounded-lg border border-[rgba(125,146,255,0.3)] bg-[rgba(16,24,43,0.9)] px-2.5 py-1.5 text-[12px] text-text">
          <Icon name="folder" size={14} className="text-text-subtle" />
          <span className="sr-only">Select project</span>
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
        {/* A real action, not a placeholder menu: this re-reads the
            project list the selector beside it renders. The control that
            used to sit here was an unwired "Workspace actions" button —
            an affordance that looked live and did nothing. */}
        <button
          type="button"
          onClick={() => void refreshProjects()}
          disabled={refreshing}
          aria-label="Refresh projects"
          title="Refresh projects"
          data-testid="workspace-refresh-projects"
          className="neon-focus grid h-8 w-8 place-items-center rounded-lg border border-[rgba(125,146,255,0.3)] text-text-muted transition-colors duration-150 hover:bg-white/5 hover:text-text disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
        </button>
      </header>

      <div role="tablist" aria-label="Workspace view" className="flex gap-1 border-b border-[rgba(125,146,255,0.18)] px-4 py-2">
        {([['agent', 'AURA Agent'], ['mission', 'Mission']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            data-testid={`workspace-tab-${id}`}
            onClick={() => setView(id)}
            className={
              view === id
                ? 'neon-focus rounded-md border border-[rgba(125,146,255,0.4)] bg-[rgba(77,124,255,0.14)] px-2.5 py-1 text-[11.5px] font-semibold text-text'
                : 'neon-focus rounded-md px-2.5 py-1 text-[11.5px] text-text-muted transition-colors hover:text-text'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'agent' && (
        <AgentRunPanel
          projectId={projectId}
          projectPath={projectPath}
          onWorkerActivity={onWorkerActivity}
        />
      )}

      {view === 'mission' && (
      <div role="log" aria-live="polite" aria-label="Agent activity" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
            title={projectName ? `Ready in ${projectName}` : 'No mission yet'}
            description={
              projectName
                ? 'Describe the outcome you want on the left — AURA will plan, build, and report back here.'
                : 'Choose a project above, then describe what you want to build.'
            }
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
      )}
    </section>
  );
}
