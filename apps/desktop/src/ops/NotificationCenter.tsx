/**
 * NotificationCenter — the engineering notification center.
 * ------------------------------------------------------------------
 * Renders the persisted notification store newest-first, with per-kind
 * icons/tones, mark-read on open, and bulk actions. Clicking a
 * notification navigates to the thing it's about: a mission opens the
 * Mission Detail panel (focused), a diagnosis opens the Diagnostics
 * panel (focused). Pure consumer of ops/notificationsStore.
 */
import { Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { useAppStore } from '@aura/core';
import { useLayoutStore } from './layoutStore';
import { NOTIFICATION_KIND_META, unreadCount, useNotificationsStore, type AuraNotification } from './notificationsStore';
import { relTime } from '../screens/missions/missionMeta';
import { VirtualList } from '../editor/VirtualList';
import { PanelBody, PanelHeader } from './panelFrame';

export function NotificationCenter({ embedded = false, onNavigate }: { embedded?: boolean; onNavigate?: () => void }) {
  const items = useNotificationsStore((s) => s.items);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clearRead = useNotificationsStore((s) => s.clearRead);
  const clearAll = useNotificationsStore((s) => s.clearAll);

  const unread = unreadCount(items);

  if (items.length === 0) {
    return (
      <PanelBody padded={!embedded}>
        {!embedded && <PanelHeader title="Notifications" hint="your engineering inbox" />}
        <div className="grid place-items-center py-14 text-center">
          <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-line bg-surface text-text-subtle">
            <Icon name="bell" size={22} />
          </span>
          <p className="text-[13px] font-medium text-text">All caught up</p>
          <p className="mt-1 max-w-xs text-[12px] text-text-muted">
            Approvals, reviews, completed missions and diagnosis results land here — and survive a restart.
          </p>
        </div>
      </PanelBody>
    );
  }

  return (
    <PanelBody padded={false} className="flex flex-col">
      {/* `shrink-0` keeps the bulk actions pinned: without it the flex
          column compresses the header first when the list is long, and the
          actions scroll away with the rows. */}
      <div className="shrink-0 px-3 pt-3">
        <PanelHeader title="Notifications" hint={unread > 0 ? `${unread} unread` : 'all read'} />
        <div className="mb-2 flex items-center gap-1.5">
          <ActionChip icon="check" label="Mark all read" onClick={markAllRead} disabled={unread === 0} />
          <ActionChip icon="refresh" label="Clear read" onClick={clearRead} />
          <ActionChip icon="close" label="Clear all" onClick={clearAll} tone="danger" />
        </div>
      </div>
      {/* VirtualList scrolls itself — it owns the `onScroll` that drives
          windowing, but takes its overflow from the caller (see FileTree).
          Without `overflow-y-auto` here the rows spilled into PanelBody's
          scroller, which scrolled the header along with them and left the
          windowing inert. */}
      <VirtualList
        items={items}
        itemHeight={58}
        className="min-h-0 flex-1 overflow-y-auto"
        renderItem={(n) => <NotificationRow n={n} onNavigate={onNavigate} />}
      />
    </PanelBody>
  );
}

function NotificationRow({ n, onNavigate }: { n: AuraNotification; onNavigate?: () => void }) {
  const markRead = useNotificationsStore((s) => s.markRead);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const setFocused = useLayoutStore((s) => s.setFocused);
  const setNav = useAppStore((s) => s.setNav);
  const meta = NOTIFICATION_KIND_META[n.kind];

  const open = () => {
    if (!n.read) markRead(n.id);
    if (n.missionId) {
      setFocused({ projectId: n.projectId ?? null, missionId: n.missionId });
      setNav('workspace');
      openPanel('mission-detail');
      onNavigate?.();
    } else if (n.diagnosisId) {
      setFocused({ projectId: n.projectId ?? null, diagnosisId: n.diagnosisId });
      setNav('workspace');
      openPanel('diagnostics');
      onNavigate?.();
    }
  };

  return (
    <button onClick={open} className="group flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover">
      <span
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
        style={{
          background: 'var(--surface-active)',
          color: meta.tone === 'positive' ? 'var(--positive)' : meta.tone === 'critical' ? 'var(--danger)' : meta.tone === 'attention' ? 'var(--attention)' : meta.tone === 'info' ? 'var(--accent)' : 'var(--text-muted)',
        }}
      >
        <Icon name={meta.icon as IconName} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          <span className={`truncate text-[12px] font-medium ${n.read ? 'text-text-muted' : 'text-text'}`}>{n.title}</span>
          <span className="ml-auto shrink-0 text-[10px] text-text-subtle">{relTime(n.at)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-text-subtle">{n.detail}</span>
      </span>
    </button>
  );
}

function ActionChip({ icon, label, onClick, disabled, tone }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; tone?: 'danger' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-text-muted hover:bg-surface-hover hover:text-text'
      }`}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
}
