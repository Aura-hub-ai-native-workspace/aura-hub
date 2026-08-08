/**
 * MissionInspector — "Mission Properties": the mission currently focused
 * via `layoutStore.focused.missionId` (set when a Mission Detail window is
 * opened from Mission Control). Fetches through the same `missionClient`
 * every other mission surface uses.
 */
import { useEffect, useState } from 'react';
import { Badge, PanelSection, PropertyRow } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { useLayoutStore } from '../layoutStore';
import { missionClient, type MissionRecord } from '../../ai/missionClient';

const APPROVAL_TONE = { pending: 'attention', approved: 'positive', rejected: 'critical' } as const;

export default function MissionInspector() {
  const openId = useWorkspace((s) => s.openId);
  const missionId = useLayoutStore((s) => s.focused.missionId);
  const [mission, setMission] = useState<MissionRecord | null>(null);

  useEffect(() => {
    if (!openId || !missionId) { setMission(null); return; }
    let cancelled = false;
    missionClient
      .get(openId, missionId)
      .then((m) => { if (!cancelled && !('error' in m && m.error)) setMission(m as MissionRecord); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [openId, missionId]);

  if (!missionId || !mission) {
    return (
      <PanelSection title="Mission Properties" icon="clipboard">
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">No mission focused</div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Mission Properties" icon="clipboard">
      <p className="mb-2 line-clamp-3 text-[12.5px] text-text">{mission.text}</p>
      <div className="space-y-2">
        <PropertyRow label="Category" value={mission.classification?.category ?? 'unknown'} />
        <PropertyRow label="Approval" value={<Badge tone={APPROVAL_TONE[mission.approval.status]} dot>{mission.approval.status}</Badge>} />
        <PropertyRow label="Tasks" value={String(mission.taskRuns.length)} />
        {mission.execution && <PropertyRow label="Execution" value={mission.execution.status ?? '—'} />}
      </div>
    </PanelSection>
  );
}
