/**
 * MissionTimeline — every significant moment in the mission's life,
 * newest first, grouped by day. Icons/tone follow the event type; the
 * actor badge distinguishes AI-driven, human-gated, and system steps.
 */
import { Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { TimelineEntry, TimelineType } from '../../ai/missionClient';
import { CHECKPOINT_LABEL, fmtClock, relTime } from './missionMeta';

const TYPE_META: Record<TimelineType, { icon: IconName; color: string }> = {
  created: { icon: 'plus', color: 'var(--text-muted)' },
  approved: { icon: 'check', color: 'var(--positive)' },
  'rejected-plan': { icon: 'close', color: 'var(--danger)' },
  'execution-started': { icon: 'activity', color: 'var(--accent)' },
  'execution-paused': { icon: 'dot', color: 'var(--attention)' },
  'task-started': { icon: 'code', color: 'var(--accent)' },
  'task-proposed': { icon: 'spark', color: 'var(--accent)' },
  'task-accepted': { icon: 'check', color: 'var(--positive)' },
  'task-rejected': { icon: 'close', color: 'var(--danger)' },
  'task-completed': { icon: 'check', color: 'var(--positive)' },
  'task-failed': { icon: 'bug', color: 'var(--danger)' },
  'task-retried': { icon: 'refresh', color: 'var(--attention)' },
  checkpoint: { icon: 'shield', color: 'var(--accent)' },
  'review-passed': { icon: 'eye', color: 'var(--positive)' },
  completed: { icon: 'check', color: 'var(--positive)' },
  cancelled: { icon: 'close', color: 'var(--text-muted)' },
  note: { icon: 'note', color: 'var(--text-muted)' },
};

const ACTOR_LABEL: Record<TimelineEntry['actor'], string> = { ai: 'AI', human: 'You', system: 'System' };

function dayKey(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function MissionTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (!entries.length) {
    return <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-subtle">No activity recorded yet.</div>;
  }
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? 1 : -1));
  const groups: { day: string; items: TimelineEntry[] }[] = [];
  for (const e of sorted) {
    const day = dayKey(e.at);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <div className="relative space-y-5">
        {groups.map((g) => (
          <div key={g.day}>
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">{g.day}</div>
            <div className="relative ml-2 space-y-4 border-l border-line pl-5">
              {g.items.map((e) => {
                const m = TYPE_META[e.type];
                return (
                  <div key={e.id} className="relative">
                    <span className="absolute -left-[26.5px] top-0 grid h-[15px] w-[15px] place-items-center rounded-full border border-line bg-surface">
                      <Icon name={m.icon} size={9} style={{ color: m.color }} />
                    </span>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[12px] font-medium text-text">{e.title}</span>
                      <span className={`rounded px-1.5 py-px text-[9.5px] font-semibold ${e.actor === 'human' ? 'bg-accent/15 text-accent' : e.actor === 'ai' ? 'bg-positive/15 text-positive' : 'bg-surface-active text-text-muted'}`}>
                        {ACTOR_LABEL[e.actor]}
                      </span>
                      {e.checkpoint && (
                        <span className="rounded bg-surface-active px-1.5 py-px text-[9.5px] text-text-muted">checkpoint · {CHECKPOINT_LABEL[e.checkpoint]}</span>
                      )}
                      <span className="ml-auto whitespace-nowrap text-[10.5px] text-text-subtle" title={new Date(e.at).toLocaleString()}>
                        {fmtClock(e.at)} · {relTime(e.at)}
                      </span>
                    </div>
                    {e.detail && <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{e.detail}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
