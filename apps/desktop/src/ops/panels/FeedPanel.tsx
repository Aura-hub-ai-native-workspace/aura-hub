/**
 * FeedPanel — the engineering feed: real recent activity across every
 * project, merged from public mission / diagnosis / memory endpoints and
 * sorted newest-first. Purely read-only aggregation.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { missionClient } from '../../ai/missionClient';
import { diagnosisClient } from '../../ai/diagnosisClient';
import { aiClient } from '../../ai/aiClient';
import { CATEGORY_LABEL, relTime } from '../../screens/missions/missionMeta';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';

interface FeedItem {
  id: string;
  at: string;
  icon: IconName;
  title: string;
  detail: string;
  tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral';
}

export default function FeedPanel() {
  const projects = useWorkspace((s) => s.projects);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      const out: FeedItem[] = [];
      const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

      try {
        const dash = await missionClient.dashboard();
        for (const m of dash.recent) {
          const status = m.execution?.status;
          out.push({
            id: `mission:${m.id}`,
            at: m.execution?.lastUpdatedAt ?? m.createdAt,
            icon: 'deploy',
            title: status === 'completed' ? 'Mission completed' : `Mission ${status ?? m.approval.status}`,
            detail: `${m.text} · ${projectName(m.projectId)} · ${CATEGORY_LABEL[m.category]}`,
            tone: status === 'completed' ? 'positive' : status === 'running' || status === 'reviewing' ? 'attention' : 'info',
          });
        }
      } catch {
        /* mission feed unavailable */
      }

      for (const project of projects) {
        try {
          const res = await diagnosisClient.list(project.id);
          for (const d of res.diagnoses.slice(0, 5)) {
            out.push({
              id: `diagnosis:${d.id}`,
              at: d.createdAt,
              icon: 'bug',
              title: `Diagnosis: ${d.filePath.split('/').pop()}`,
              detail: `${projectName(project.id)} · ${d.category} · ${d.decision.status}`,
              tone: d.decision.status === 'pending' ? 'attention' : 'info',
            });
          }
        } catch {
          /* skip */
        }
        try {
          const res = await aiClient.listMemory(project.id);
          for (const m of res.items.slice(0, 5)) {
            out.push({
              id: `memory:${m.id}`,
              at: m.at,
              icon: 'memory',
              title: m.title,
              detail: `${projectName(project.id)} · ${m.kind}`,
              tone: 'neutral',
            });
          }
        } catch {
          /* skip */
        }
      }

      if (alive) {
        setItems(out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200));
        setLoading(false);
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projects]);

  const rows = useMemo(() => items, [items]);

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Engineering feed" hint="real activity across every project" />
      </div>
      {loading && rows.length === 0 && (
        <div className="space-y-2 px-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-active" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="px-4 py-10 text-center text-[12px] text-text-subtle">No engineering activity yet.</p>
      )}
      {rows.length > 0 && (
        <VirtualList
          items={rows}
          itemHeight={56}
          className="min-h-0 flex-1"
          renderItem={(item) => (
            <div className="flex items-start gap-2.5 px-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                <Icon name={item.icon} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-medium text-text">{item.title}</span>
                  <Badge tone={item.tone}>{relTime(item.at)}</Badge>
                </div>
                <div className="truncate text-[10.5px] text-text-subtle">{item.detail}</div>
              </div>
            </div>
          )}
        />
      )}
    </PanelBody>
  );
}
