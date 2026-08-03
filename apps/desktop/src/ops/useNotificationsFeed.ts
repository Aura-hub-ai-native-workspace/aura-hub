/**
 * useNotificationsFeed — the poll that turns real engine state into
 * notifications. Runs on mount (App shell) and then on a 15s cadence.
 * ------------------------------------------------------------------
 * Every notification is derived from a public engine response:
 *   · mission lists  → approval-required / review-required / mission-completed
 *   · mission detail → architecture-warning, documentation-outdated (from real signals)
 *   · diagnosis list → diagnosis-ready
 *   · health endpoint → health-changed (fired only on state transitions)
 * Dedupe keys make each event fire exactly once, and the store persists
 * across restarts, so relaunching never re-fires old events.
 */
import { useEffect, useRef } from 'react';
import { useWorkspace } from '../data/useWorkspace';
import { missionClient, type MissionSummary } from '../ai/missionClient';
import { diagnosisClient } from '../ai/diagnosisClient';
import { aiClient } from '../ai/aiClient';
import { useNotificationsStore, unreadCount } from './notificationsStore';

export function useNotificationsFeed(intervalMs = 15000) {
  const { projects } = useWorkspace();
  const notify = useNotificationsStore((s) => s.notify);
  const lastHealth = useRef<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const seenByPoll = new Set<string>();
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

    const poll = async () => {
      // Health transition
      try {
        const h = await aiClient.health();
        const ok = h.health.ok;
        if (alive && lastHealth.current !== null && lastHealth.current !== ok) {
          notify({
            key: `health:${ok ? 'ok' : 'down'}`,
            kind: ok ? 'health-changed' : 'health-changed',
            title: ok ? 'Backend recovered' : 'Backend unreachable',
            detail: ok
              ? `AI runtime healthy (${h.health.latencyMs}ms)`
              : h.health.error ?? 'The local AI service stopped responding.',
          });
        }
        if (alive) lastHealth.current = ok;
      } catch {
        if (alive && lastHealth.current !== false) {
          notify({
            key: 'health:down',
            kind: 'health-changed',
            title: 'Backend unreachable',
            detail: 'The local AI service stopped responding.',
          });
          lastHealth.current = false;
        }
      }

      const targets = projects.length ? projects : [];      for (const project of targets) {
        const pid = project.id;

        // Missions → approval / review / completion / signals
        let missions: MissionSummary[] = [];
        try {
          const res = await missionClient.list(pid);
          missions = res.missions ?? [];
        } catch {
          continue;
        }

        const inflight = missions.filter(
          (m) => m.execution && m.execution.status !== 'completed' && m.execution.status !== 'cancelled' && m.execution.status !== 'failed',
        );

        for (const m of missions.slice(0, 40)) {
          const name = projectName(pid);
          if (m.approval.status === 'pending' && !seenByPoll.has(`approve:${pid}:${m.id}`)) {
            seenByPoll.add(`approve:${pid}:${m.id}`);
            notify({
              key: `approve:${pid}:${m.id}`,
              kind: 'approval-required',
              title: 'Approval required',
              detail: `${name} · ${m.text}`,
              at: m.createdAt,
              projectId: pid,
              missionId: m.id,
            });
          }
          if (m.execution?.status === 'reviewing' && !seenByPoll.has(`review:${pid}:${m.id}`)) {
            seenByPoll.add(`review:${pid}:${m.id}`);
            notify({
              key: `review:${pid}:${m.id}`,
              kind: 'review-required',
              title: 'Mission in review',
              detail: `${name} · ${m.text}`,
              at: m.execution.lastUpdatedAt,
              projectId: pid,
              missionId: m.id,
            });
          }
          if (m.execution?.status === 'completed' && !seenByPoll.has(`done:${pid}:${m.id}`)) {
            seenByPoll.add(`done:${pid}:${m.id}`);
            notify({
              key: `done:${pid}:${m.id}`,
              kind: 'mission-completed',
              title: 'Mission completed',
              detail: `${name} · ${m.text}`,
              at: m.execution.completedAt ?? m.execution.lastUpdatedAt,
              projectId: pid,
              missionId: m.id,
            });
          }
        }

        // In-flight mission details → architecture / documentation signals
        for (const m of inflight.slice(0, 3)) {
          try {
            const rec = await missionClient.get(pid, m.id);
            if ('error' in rec) continue;
            const issues = rec.signals?.healthIssues ?? [];
            if (
              issues.some((i) => i.severity === 'critical' && /architect/i.test(i.category)) &&
              !seenByPoll.has(`arch:${pid}:${m.id}`)
            ) {
              seenByPoll.add(`arch:${pid}:${m.id}`);
              notify({
                key: `arch:${pid}:${m.id}`,
                kind: 'architecture-warning',
                title: 'Architecture warning',
                detail: `${projectName(pid)} · ${issues.find((i) => i.severity === 'critical' && /architect/i.test(i.category))?.message}`,
                at: m.execution?.lastUpdatedAt,
                projectId: pid,
                missionId: m.id,
              });
            }
            if (
              (rec.signals?.verificationRecommendations ?? []).some((r) => /doc(umentation)?/i.test(r)) &&
              !seenByPoll.has(`docs:${pid}:${m.id}`)
            ) {
              seenByPoll.add(`docs:${pid}:${m.id}`);
              notify({
                key: `docs:${pid}:${m.id}`,
                kind: 'documentation-outdated',
                title: 'Documentation outdated',
                detail: `${projectName(pid)} · ${m.text}`,
                at: m.execution?.lastUpdatedAt,
                projectId: pid,
                missionId: m.id,
              });
            }
          } catch {
            /* skip — single mission detail failed */
          }
        }

        // Diagnoses → diagnosis-ready
        try {
          const res = await diagnosisClient.list(pid);
          for (const d of res.diagnoses) {
            if (d.decision.status === 'pending' && !seenByPoll.has(`diag:${pid}:${d.id}`)) {
              seenByPoll.add(`diag:${pid}:${d.id}`);
              notify({
                key: `diag:${pid}:${d.id}`,
                kind: 'diagnosis-ready',
                title: 'Diagnosis ready for review',
                detail: `${projectName(pid)} · ${d.filePath}`,
                at: d.createdAt,
                projectId: pid,
                diagnosisId: d.id,
              });
            }
          }
        } catch {
          /* skip */
        }
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [projects, notify, intervalMs]);
}

export function useUnreadCount() {
  return useNotificationsStore((s) => unreadCount(s.items));
}
