/**
 * notificationsStore — the engineering notification center.
 * ------------------------------------------------------------------
 * Notifications are *persisted* (survive restart), *deduplicated* by a
 * stable key (a notification fires once per real event, never on every
 * poll), and *derived exclusively from public engine output* — the feed
 * that fills this store lives in ops/useNotificationsFeed.ts and only
 * consumes mission/diagnosis/health APIs.
 */
import { create } from 'zustand';
import { subscribeToSpine } from '../events/spineClient';

export type NotificationKind =
  | 'approval-required'
  | 'mission-completed'
  | 'review-required'
  | 'diagnosis-ready'
  | 'health-changed'
  | 'documentation-outdated'
  | 'architecture-warning'
  | 'update-available';

export interface AuraNotification {
  id: string;
  /** Stable dedupe key — same event always maps to the same key. */
  key: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  at: string;
  read: boolean;
  projectId?: string;
  missionId?: string;
  diagnosisId?: string;
}

const KEY = 'aura.ops.notifications';
const CAP = 200;

function load(): AuraNotification[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AuraNotification[]) : [];
  } catch {
    return [];
  }
}

export interface NotificationInput {
  key: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  at?: string;
  projectId?: string;
  missionId?: string;
  diagnosisId?: string;
}

interface NotificationsState {
  items: AuraNotification[];
  /** Add a notification if its dedupe key has never fired. Returns the
   *  notification when new, null when it already exists. */
  notify: (input: NotificationInput) => AuraNotification | null;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearRead: () => void;
  clearAll: () => void;
  dismiss: (key: string) => void;
  /** Forget a dedupe key without removing the item (used after restore). */
  seen: (key: string) => boolean;
}

let seq = 0;

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: load(),

  notify: (input) => {
    const { items } = get();
    if (items.some((n) => n.key === input.key)) return null;
    seq += 1;
    const notification: AuraNotification = {
      id: `${input.key}:${seq}`,
      key: input.key,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      at: input.at ?? new Date().toISOString(),
      read: false,
      projectId: input.projectId,
      missionId: input.missionId,
      diagnosisId: input.diagnosisId,
    };
    const next = [notification, ...items].slice(0, CAP);
    set({ items: next });
    persistNotifications(next);
    return notification;
  },

  markRead: (id) => {
    const items = get().items.map((n) => (n.id === id ? { ...n, read: true } : n));
    set({ items });
    persistNotifications(items);
  },

  markAllRead: () => {
    const items = get().items.map((n) => ({ ...n, read: true }));
    set({ items });
    persistNotifications(items);
  },

  clearRead: () => {
    const items = get().items.filter((n) => !n.read);
    set({ items });
    persistNotifications(items);
  },

  clearAll: () => {
    set({ items: [] });
    persistNotifications([]);
  },

  dismiss: (key) => {
    const items = get().items.filter((n) => n.key !== key);
    set({ items });
    persistNotifications(items);
  },

  seen: (key) => get().items.some((n) => n.key === key),
}));

export function unreadCount(items: AuraNotification[]): number {
  return items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}

export function persistNotifications(items: AuraNotification[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export const NOTIFICATION_KIND_META: Record<NotificationKind, { label: string; icon: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }> = {
  'approval-required': { label: 'Approval required', icon: 'shield', tone: 'attention' },
  'mission-completed': { label: 'Mission completed', icon: 'check', tone: 'positive' },
  'review-required': { label: 'Review required', icon: 'eye', tone: 'attention' },
  'diagnosis-ready': { label: 'Diagnosis ready', icon: 'bug', tone: 'info' },
  'health-changed': { label: 'Health changed', icon: 'activity', tone: 'critical' },
  'documentation-outdated': { label: 'Documentation outdated', icon: 'doc', tone: 'attention' },
  'architecture-warning': { label: 'Architecture warning', icon: 'architecture', tone: 'critical' },
  'update-available': { label: 'Update available', icon: 'deploy', tone: 'info' },
};

/* ── the push channel ──────────────────────────────────────────────
   Backend-initiated events become notifications here.

   This is the point of the Event Spine made visible: an approval an
   autonomous agent needs answered used to have no way to reach the
   person who must answer it — the renderer only ever learned about
   backend state by asking again on a timer, and there was no timer
   watching for this. Now the Fabric raises the question and it appears.

   Deduplicated by the approval/campaign id, so a reconnect that replays
   the backlog re-renders the same notification rather than stacking
   copies of it. */

interface ApprovalRequestBrief {
  id: string;
  summary?: string;
  target?: string;
  projectId?: string;
  missionId?: string;
  items?: { title: string }[];
}

export function startSpineNotifications(): () => void {
  const notify = () => useNotificationsStore.getState().notify;

  return subscribeToSpine(['approval', 'agent'], (event) => {
    if (event.type === 'approval.required') {
      const request = (event.payload as { request: ApprovalRequestBrief }).request;
      if (!request?.id) return;
      notify()({
        key: `approval:${request.id}`,
        kind: 'approval-required',
        title: request.items?.[0]?.title
          ? `${request.items[0].title} needs your go-ahead`
          : 'An action needs your go-ahead',
        detail: request.summary ?? 'Nothing has run. Review it in Governance.',
        at: event.at,
        projectId: request.projectId ?? event.projectId ?? undefined,
        missionId: request.missionId,
      });
      return;
    }

    if (event.type === 'agent.notification') {
      const payload = event.payload as {
        kind: NotificationKind; title: string; detail: string; projectId: string | null; missionId?: string;
      };
      notify()({
        // The agent's notifications are already keyed by campaign id in
        // their detail; the title+detail pair is the stable identity of
        // the moment, and a replayed backlog must not duplicate it.
        key: `agent:${payload.kind}:${payload.title}:${payload.detail}`,
        kind: payload.kind,
        title: payload.title,
        detail: payload.detail,
        at: event.at,
        projectId: payload.projectId ?? undefined,
        missionId: payload.missionId,
      });
    }
  });
}
