import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import {
  centralAgentClient,
  type AgentEventFrame,
  type AgentResult,
} from '../../../ai/centralAgentClient';
import { GlassCard } from './GlassCard';
import { GlowButton } from './GlowButton';

/**
 * AgentRunPanel — the live AURA Agent workspace.
 *
 * "Plan • Delegate • Supervise • Verify", showing the backend's own run
 * state and nothing else. Every line below is rendered from an event the
 * Central Agent actually emitted on its existing bus, or from the
 * terminal AgentResult. There is no second event stream, no polling
 * loop, and deliberately no progress bar: AURA does not know what
 * fraction of a worker's task is done, so it does not draw one. Between
 * events the panel shows the correct waiting state instead.
 *
 * The frontend is not the authority here. It sends the user's intent and
 * displays what came back; worker selection, authorisation, governance,
 * verification and the final verdict all happen in the backend.
 */

interface PlanTask {
  id: string;
  state: string;
  verified: boolean | null;
  detail: string;
  worker: string;
  lifecycle: string;
}

interface GovernedAction {
  key: string;
  tool: string;
  actionType: string;
  target: string;
  decision: string;
  reason: string;
  worker: string;
}

const TASK_TONE: Record<string, string> = {
  done: 'text-neon-success',
  skipped: 'text-neon-success',
  'awaiting-approval': 'text-neon-warning',
  blocked: 'text-neon-warning',
  denied: 'text-neon-danger',
  failed: 'text-neon-danger',
  'timed-out': 'text-neon-danger',
};

const TASK_GLYPH: Record<string, string> = {
  done: '✓', skipped: '✓', 'awaiting-approval': '⏸', blocked: '⏸',
  denied: '✕', failed: '✕', 'timed-out': '✕',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function AgentRunPanel({
  projectId,
  projectPath,
  onWorkerActivity,
}: {
  projectId: string | null;
  projectPath: string | null;
  /** Lifts live worker lifecycle to the rail. Never invents a state. */
  onWorkerActivity?: (activity: Map<string, string>) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEventFrame[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => () => closeStream.current?.(), []);

  const submit = useCallback(async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setEvents([]);
    closeStream.current?.();
    try {
      const res = await centralAgentClient.submit(message, {
        projectId: projectId ?? undefined,
        projectPath: projectPath ?? undefined,
      });
      setSessionId(res.sessionId);
      setResult(res.result);
      setText('');
      if (res.sessionId) {
        // The backend replays this session's event tail and then closes
        // (the client reconnects with backoff and dedupes). Submit runs
        // to a terminal-or-parked outcome server-side, so for THIS turn
        // the frames arrive after the fact — that is the honest shape of
        // the existing transport, and nothing here pretends otherwise by
        // animating progress AURA never observed.
        closeStream.current = centralAgentClient.events(res.sessionId, (frame) =>
          setEvents((prev) => (prev.length > 400 ? prev : [...prev, frame])),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the AURA service could not be reached');
    } finally {
      setBusy(false);
    }
  }, [text, busy, projectId, projectPath]);

  /* ── derived, AURA-owned run state ─────────────────────────────── */

  const plan = useMemo<PlanTask[]>(() => {
    const order: string[] = [];
    const byId = new Map<string, PlanTask>();
    for (const f of events) {
      const p = f.payload ?? {};
      if (f.type === 'plan.created' && Array.isArray(p.tasks)) {
        for (const raw of p.tasks as unknown[]) {
          const id = str(raw);
          if (!id || byId.has(id)) continue;
          order.push(id);
          byId.set(id, { id, state: 'pending', verified: null, detail: '', worker: '', lifecycle: 'IDLE' });
        }
      }
      if (f.type === 'invocation.observed' && p.taskId) {
        const id = str(p.taskId);
        const prev = byId.get(id) ?? { id, state: 'pending', verified: null, detail: '', worker: '', lifecycle: 'IDLE' };
        if (!byId.has(id)) order.push(id);
        byId.set(id, {
          ...prev,
          state: str(p.state) || prev.state,
          verified: typeof p.verified === 'boolean' ? p.verified : prev.verified,
          detail: str(p.detail) || prev.detail,
        });
      }
      if (f.type === 'worker.lifecycle' && p.taskId) {
        const id = str(p.taskId);
        const prev = byId.get(id) ?? { id, state: 'pending', verified: null, detail: '', worker: '', lifecycle: 'IDLE' };
        if (!byId.has(id)) order.push(id);
        byId.set(id, {
          ...prev,
          worker: str(p.worker) || str(p.nodeId) || prev.worker,
          lifecycle: str(p.lifecycle) || prev.lifecycle,
        });
      }
    }
    return order.map((id) => byId.get(id)!).filter(Boolean);
  }, [events]);

  const actions = useMemo<GovernedAction[]>(() => {
    const out: GovernedAction[] = [];
    events.forEach((f, i) => {
      if (f.type !== 'worker.action') return;
      const p = f.payload ?? {};
      if (p.summary) return;
      out.push({
        key: `${i}-${str(p.sequence)}`,
        tool: str(p.tool),
        actionType: str(p.actionType),
        target: str(p.target) || str(p.command),
        decision: str(p.decision),
        reason: str(p.reason),
        worker: str(p.workerNodeId),
      });
    });
    return out;
  }, [events]);

  const supervisor = useMemo(() => {
    const allowed = actions.filter((a) => a.decision === 'ALLOW').length;
    const denied = actions.filter((a) => a.decision === 'DENY').length;
    const parked = plan.filter((t) => t.state === 'awaiting-approval' || t.state === 'blocked').length;
    return { observed: actions.length, allowed, denied, parked };
  }, [actions, plan]);

  // Lift live worker lifecycle so the worker rail can pulse the right
  // card. Keyed by node id — the same identity the backend routes on.
  useEffect(() => {
    if (!onWorkerActivity) return;
    const map = new Map<string, string>();
    for (const f of events) {
      if (f.type !== 'worker.lifecycle') continue;
      const nodeId = str(f.payload?.nodeId);
      if (nodeId) map.set(nodeId, str(f.payload?.lifecycle) || 'ACTIVE');
    }
    onWorkerActivity(map);
  }, [events, onWorkerActivity]);

  const waiting = busy && plan.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-testid="agent-run-panel">
      {/* Composer */}
      <GlassCard className="p-3">
        <label htmlFor="agent-composer" className="sr-only">Describe what you want AURA to do</label>
        <textarea
          id="agent-composer"
          rows={3}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          data-testid="agent-composer"
          placeholder="e.g. Implement token refresh in src/auth and have another AI review it"
          className="neon-focus w-full resize-none bg-transparent text-[13px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[10.5px] text-text-subtle">
            {busy ? 'AURA is planning, delegating and verifying…'
              : 'AURA plans the work, chooses the worker, and verifies the result.'}
          </span>
          <GlowButton
            size="sm"
            onClick={() => void submit()}
            disabled={busy || text.trim().length === 0}
            data-testid="agent-submit"
            aria-label="Send to AURA"
          >
            <Icon name="arrow-right" size={15} />
          </GlowButton>
        </div>
      </GlassCard>

      {error && (
        <p role="alert" data-testid="agent-error" className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-3 py-2 text-[12px] text-neon-danger">
          {error}
        </p>
      )}

      {/* PLAN */}
      {(plan.length > 0 || waiting) && (
        <GlassCard className="p-3" data-testid="agent-plan">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">Plan</p>
          {waiting && <p className="text-[12px] text-text-muted">Waiting for AURA's plan…</p>}
          <ul className="space-y-1.5">
            {plan.map((t) => (
              <li key={t.id} data-testid="agent-plan-task" data-task-state={t.state} className="flex items-baseline gap-2 text-[12px]">
                <span className={cn('w-3 shrink-0 font-semibold', TASK_TONE[t.state] ?? 'text-text-subtle')}>
                  {TASK_GLYPH[t.state] ?? '○'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-text">{t.id}</span>
                  {t.worker && <span className="text-text-muted"> — {t.worker}</span>}
                  <span className={cn('ml-1.5', TASK_TONE[t.state] ?? 'text-text-subtle')}>
                    {t.state}{t.verified === true ? ' · verified' : t.verified === false ? ' · unverified' : ''}
                  </span>
                  {t.detail && <span className="block truncate text-[11px] text-text-subtle">{t.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}

      {/* WORKER ACTIVITY + SUPERVISOR */}
      {actions.length > 0 && (
        <GlassCard className="p-3" data-testid="agent-supervisor">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            Supervisor
          </p>
          <p className="mb-2 text-[11.5px] text-text-muted">
            {supervisor.observed} action{supervisor.observed === 1 ? '' : 's'} observed ·{' '}
            <span className="text-neon-success">{supervisor.allowed} allowed</span> ·{' '}
            <span className={supervisor.denied ? 'text-neon-danger' : ''}>{supervisor.denied} denied</span> ·{' '}
            {supervisor.parked} parked
          </p>
          <ul className="space-y-1">
            {actions.slice(-8).map((a) => (
              <li key={a.key} data-testid="agent-action" data-decision={a.decision} className="flex items-baseline gap-2 text-[11.5px]">
                <span className={cn('shrink-0 font-semibold', a.decision === 'DENY' ? 'text-neon-danger' : 'text-neon-success')}>
                  {a.decision}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-muted">
                  [{a.tool || a.actionType}] {a.target}
                  {a.reason && <span className="text-text-subtle"> — {a.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}

      {/* AURA RESPONSE */}
      {result && (
        <GlassCard
          className="p-3"
          tint={result.outcome === 'completed' ? 'green' : result.outcome === 'awaiting-approval' ? 'amber' : 'red'}
          data-testid="agent-result"
          data-outcome={result.outcome}
        >
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            AURA response
          </p>
          <p className="text-[12.5px] leading-relaxed text-text">{result.summary}</p>
          <p className="mt-2 text-[11px] text-text-subtle">
            outcome: <span className="font-semibold">{result.outcome}</span>
            {result.performed.length > 0 && <> · performed: {result.performed.join(', ')}</>}
            {result.verified.length > 0 && <> · verified: {result.verified.join(', ')}</>}
            {result.failureReason && <> · {result.failureReason}</>}
          </p>
          {sessionId && (
            <p className="mt-1 truncate text-[10.5px] text-text-subtle">session {sessionId}</p>
          )}
        </GlassCard>
      )}
    </div>
  );
}
