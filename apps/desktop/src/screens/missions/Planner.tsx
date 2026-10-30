/**
 * Planner — turn a goal into a structured, editable plan.
 * ------------------------------------------------------------------
 * Scoped to the open project. The Planner plans; it never executes.
 * A plan is made in one short run (see the service's
 * mission/orchestrator.ts): a goal that names one file is planned
 * directly, anything bigger by a single model call — then checked.
 * The person reviews and edits it, and hands it to Workspace with
 * Send to Workspace. Workspace can also be used directly, without a plan.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { useMissions } from './useMissions';
import { PlanView } from './PlanView';
import { CreationProgress } from './CreationProgress';
import { relTime } from './missionMeta';
import { useLayoutStore } from '../../ops/layoutStore';

const EXAMPLE_GOAL = 'Add a short NOTES.md file';

export function Planner() {
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const planner = useMissions(openId);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');

  const { refreshList, selectMission } = planner;
  useEffect(() => { void refreshList(); }, [openId, refreshList]);

  // A plan handed here from Let's Chat ("Send to Planner") opens on that plan.
  const focusedPlan = useLayoutStore((s) => s.focused.missionId);
  useEffect(() => { if (focusedPlan && openId) void selectMission(focusedPlan); }, [focusedPlan, openId, selectMission]);

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyState icon="deploy" title="Open a project to plan" description="The Planner turns a goal into an editable plan for the project you have open, then hands it to Workspace." />
      </div>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t || planner.creating) return;
    setText('');
    void planner.createMission(t);
  };

  const needle = q.trim().toLowerCase();
  const plans = planner.missions.filter((m) => !needle || m.text.toLowerCase().includes(needle));

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-line">
        <div className="shrink-0 border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Icon name="deploy" size={15} className="text-accent" />
            <span className="text-[13px] font-semibold text-text">Planner</span>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-text-muted">{project.name}</p>
        </div>

        <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            placeholder={`Describe a goal… e.g. "${EXAMPLE_GOAL}"`}
            rows={3}
            aria-label="Goal"
            className="w-full resize-none rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
          />
          <Button size="sm" variant="primary" icon="plus" loading={planner.creating} disabled={!text.trim() || planner.creating} onClick={submit} className="w-full">
            Plan it
          </Button>
        </div>

        <div className="shrink-0 border-b border-line px-4 py-2.5">
          <div className="relative">
            <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-2 text-text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search plans…"
              className="w-full rounded-lg border border-line bg-canvas py-1.5 pl-7 pr-2.5 text-[12px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {planner.loadingList && !planner.missions.length && <div className="px-3 py-6 text-center text-[12px] text-text-subtle">Loading…</div>}
          {!planner.loadingList && !planner.missions.length && <div className="px-3 py-6 text-center text-[12px] text-text-subtle">No plans yet.</div>}
          {planner.missions.length > 0 && !plans.length && <div className="px-3 py-6 text-center text-[12px] text-text-subtle">No plans match.</div>}
          {plans.map((m) => (
            <button
              key={m.id}
              onClick={() => void planner.selectMission(m.id)}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left transition-colors ${planner.active?.id === m.id ? 'bg-surface-active' : 'hover:bg-surface-active/50'}`}
            >
              <div className="line-clamp-2 text-[12.5px] font-medium text-text">{m.text}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-text-subtle">
                {m.taskCount === 0 ? <Badge tone="neutral">no tasks</Badge> : <span>{m.taskCount} task{m.taskCount === 1 ? '' : 's'}</span>}
                <span>· {relTime(m.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {planner.creating ? (
          <CreationProgress stage={planner.creation.stage} waiting={planner.creation.waiting} />
        ) : planner.active ? (
          <PlanView planner={planner} />
        ) : planner.creation.stage === 'error' ? (
          <div className="grid h-full place-items-center p-10">
            <EmptyState icon="deploy" title="Planning did not finish" description={planner.creation.errorMessage ?? 'The service reported no reason.'} />
          </div>
        ) : (
          <div className="grid h-full place-items-center p-10">
            <EmptyState
              icon="deploy"
              title="Describe a goal to plan it"
              description={`e.g. "${EXAMPLE_GOAL}". Review and edit the plan, then Send to Workspace — or skip planning and ask Workspace directly.`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
