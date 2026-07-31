/**
 * ActivityFeed — a compact, live-friendly stream of the mission's
 * activity entries (the same event set as the timeline, but flat and
 * message-shaped, ready for a auto-refreshing side panel).
 */
import { Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { ActivityEntry, TimelineType } from '../../ai/missionClient';
import { relTime } from './missionMeta';

const TYPE_ICON: Record<TimelineType, IconName> = {
  created: 'plus', approved: 'check', 'rejected-plan': 'close',
  'execution-started': 'activity', 'execution-paused': 'dot',
  'task-started': 'code', 'task-proposed': 'spark', 'task-accepted': 'check',
  'task-rejected': 'close', 'task-completed': 'check', 'task-failed': 'bug',
  'task-retried': 'refresh', checkpoint: 'shield', 'review-passed': 'eye',
  completed: 'check', cancelled: 'close', note: 'note',
};

const ACTOR_COLOR: Record<ActivityEntry['actor'], string> = {
  ai: 'var(--positive)', human: 'var(--accent)', system: 'var(--text-muted)',
};

export function ActivityFeed({ activity, limit = 60 }: { activity: ActivityEntry[]; limit?: number }) {
  if (!activity.length) {
    return <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-subtle">No activity yet.</div>;
  }
  const sorted = [...activity].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  return (
    <div className="rounded-xl border border-line bg-canvas p-3">
      <ul className="space-y-1">
        {sorted.map((a) => (
          <li key={a.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-hover">
            <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-active">
              <Icon name={TYPE_ICON[a.kind]} size={11} style={{ color: ACTOR_COLOR[a.actor] }} />
            </span>
            <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-text-muted">{a.message}</span>
            <span className="shrink-0 text-[10px] text-text-subtle">{relTime(a.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
