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

export type NotificationKind =
  | 'approval-required'
  | 'mission-completed'
  | 'review-required'
  | 'diagnosis-ready'
  | 'health-changed'
  | 'documentation-outdated'
  | 'architecture-warning';

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
    set({ items: [notification, ...items].slice(0, CAP) });
    return notification;
  },

  markRead: (id) =>
    set((s) => ({ items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)) })),

  markAllRead: () => set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })) })),

  clearRead: () => set((s) => ({ items: s.items.filter((n) => !n.read) })),

  clearAll: () => set({ items: [] }),

  dismiss: (key) => set((s) => ({ items: s.items.filter((n) => n.key !== key) })),

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
};
