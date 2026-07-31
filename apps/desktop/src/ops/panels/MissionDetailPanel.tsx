/**
 * MissionDetailPanel — the workspace panel for the *focused* mission.
 * ------------------------------------------------------------------
 * Reuses the real MissionControl detail surface (`MissionDetail`) —
 * this panel never re-implements mission logic, it just wires the
 * global focus (`layoutStore.focused`) into the existing hook + screen.
 */
import { useEffect } from 'react';
import { Badge, Icon } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { useMissions } from '../../screens/missions/useMissions';
import { MissionDetail } from '../../screens/missions/MissionDetail';
import { CATEGORY_LABEL, CATEGORY_TONE, relTime } from '../../screens/missions/missionMeta';
import { useLayoutStore } from '../layoutStore';
import { EmptyState } from '../../components/EmptyState';

export default function MissionDetailPanel() {
  const focused = useLayoutStore((s) => s.focused);
  const setFocused = useLayoutStore((s) => s.setFocused);
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === (focused.projectId ?? s.openId)));
  const profile = useWorkspace((s) => s.profile);

  const projectId = focused.projectId ?? openId;
  const missions = useMissions(projectId);

  useEffect(() => {
    if (focused.missionId && projectId) void missions.selectMission(focused.missionId);
    else void missions.refreshList();
    // Intentionally runs on project/mission focus change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, focused.missionId]);

  if (!projectId || !project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="deploy" title="Open a project to see missions" description="Pick a mission from Mission Control, or open a project and create one." />
      </div>
    );
  }

  if (!missions.active) {
    const list = missions.missions;
    return (
      <div className="h-full min-h-0 overflow-y-auto p-3">
        <div className="mb-3 text-[12px] font-semibold text-text">{project.name} — missions</div>
        {list.length === 0 && (
          <p className="px-1 py-6 text-center text-[12px] text-text-subtle">
            No missions yet. Open Mission Control to create one.
          </p>
        )}
        <div className="space-y-1.5">
          {list.map((m) => (
            <button
              key={m.id}
              onClick={() => setFocused({ projectId: projectId, missionId: m.id })}
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-hover"
            >
              <Icon name="deploy" size={14} className="text-text-subtle" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{m.text}</span>
              <Badge tone={CATEGORY_TONE[m.category]}>{CATEGORY_LABEL[m.category]}</Badge>
              <span className="shrink-0 text-[10px] text-text-subtle">{relTime(m.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const projectPath = profile?.path ?? project.path;
  return <MissionDetail projectPath={projectPath} missions={missions} />;
}
