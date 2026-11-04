import { cn } from '@aura/core';
import { useRunObserver } from '../../../ai/useRunObserver';
import { completionLine, type CheckState, type RunView } from '../../../ai/runObserver';

/**
 * RunObserverPanel — the live account of a Workspace run. Every row comes from
 * a backend event or the stored report; nothing is inferred. Shown under the
 * turn that started the work, and still there after a reload.
 */
const MARK: Record<CheckState, string> = { pending: '○', running: '…', verification: '◐', verified: '✓', failed: '✕', blocked: '•', cancelled: '–' };
const TONE: Record<CheckState, string> = {
  pending: 'text-text-subtle', running: 'text-neon-cyan', verification: 'text-neon-cyan', verified: 'text-neon-success',
  failed: 'text-neon-danger', blocked: 'text-neon-warning', cancelled: 'text-text-subtle',
};

export function RunObserverPanel({ sessionId, live }: { sessionId: string | null | undefined; live: boolean }) {
  const view = useRunObserver(sessionId, live);
  return <RunObserverView view={view} />;
}

export function RunObserverView({ view }: { view: RunView }) {
  if (view.checklist.length === 0 && view.timeline.length === 0) return null;
  const done = completionLine(view);
  const current = view.checklist.find((c) => c.taskId === view.currentTask);
  return (
    <section data-testid="run-observer" aria-label="Run progress" className="mt-2.5 space-y-3 rounded-xl border border-[rgba(152, 152, 152,0.2)] bg-[var(--ws-card)] px-3.5 py-3 text-[12.5px]">
      {!view.finished && (view.phase || view.waitingFor) && (
        <p data-testid="run-current" className="text-text-muted">
          <span className="font-semibold text-text">{view.waitingFor ? `Waiting for ${view.waitingFor}` : view.phase}</span>
          {current && !view.waitingFor ? ` · ${current.title}` : ''}
          {view.currentWorker && !view.waitingFor ? ` · ${view.currentWorker}` : ''}
        </p>
      )}
      {done && (
        <p data-testid="run-summary" data-tone={done.tone} className={cn('font-semibold', done.tone === 'ok' ? 'text-neon-success' : done.tone === 'warn' ? 'text-neon-warning' : 'text-neon-danger')}>{done.text}</p>
      )}

      {view.checklist.length > 0 && (
        <ul data-testid="run-checklist" className="space-y-1">
          {view.checklist.map((c) => (
            <li key={c.taskId} data-state={c.state} className="flex items-start gap-2">
              <span className={cn('w-3 shrink-0 text-center font-semibold', TONE[c.state])}>{MARK[c.state]}</span>
              <span className="min-w-0 text-text-muted">
                <span className="text-text">{c.title}</span> <span className="text-text-subtle">— {c.state}{c.worker ? ` · ${c.worker}` : ''}</span>
                {c.detail && (c.state === 'failed' || c.state === 'blocked') ? <span className="block text-[11.5px] text-text-subtle">{c.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {view.files.length > 0 && (
        <div data-testid="run-files"><div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Files changed (observed)</div>
          <ul className="space-y-0.5 font-mono text-[11.5px] text-text-muted">{view.files.map((f) => <li key={`${f.taskId}:${f.path}`}>{f.op} · {f.path}</li>)}</ul></div>
      )}
      {(view.toolsInstalled.length + view.toolsReused.length + view.toolsBlocked.length) > 0 && (
        <div data-testid="run-tools" className="text-[11.5px] text-text-muted">
          {view.toolsInstalled.length > 0 && <p>Installed for this run: {view.toolsInstalled.map((t) => t.name).join(', ')}</p>}
          {view.toolsReused.length > 0 && <p>Already on this machine: {view.toolsReused.map((t) => t.name).join(', ')}</p>}
          {view.toolsBlocked.map((t) => <p key={t.nodeId} className="text-neon-warning">{t.name}: {t.stage}{t.reason || t.detail ? ` — ${t.reason || t.detail}` : ''}</p>)}
        </div>
      )}
      {view.handoffs.length > 0 && (
        <ul data-testid="run-handoffs" className="space-y-0.5 text-[11.5px] text-text-muted">
          {view.handoffs.map((h, i) => <li key={i}>Handed over {h.from ?? 'a worker'} → {h.to ?? 'another worker'}: {h.reason}</li>)}
        </ul>
      )}
      {view.errors.length > 0 && (
        <ul data-testid="run-errors" className="space-y-0.5 text-[11.5px]">
          {view.errors.map((e) => <li key={e.id} className={e.status === 'resolved' ? 'text-neon-success' : 'text-neon-warning'}>Error {e.id.slice(0, 10)} ({e.status}){e.summary ? `: ${e.summary}` : ''}</li>)}
        </ul>
      )}

      {view.timeline.length > 0 && (
        <details data-testid="run-timeline" open={!view.finished}>
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Timeline ({view.timeline.length})</summary>
          <ol className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto text-[11.5px]">
            {view.timeline.map((t) => (
              <li key={t.id} className={cn(t.tone === 'bad' ? 'text-neon-danger' : t.tone === 'warn' ? 'text-neon-warning' : t.tone === 'ok' ? 'text-neon-success' : 'text-text-muted')}>
                <span className="mr-2 tabular-nums text-text-subtle">{t.at.slice(11, 19)}</span>{t.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
