import { cn } from '@aura/core';
import type { MissionView, Tone } from '../../../ai/missionStatus';

/**
 * MissionStatusPanel — what AURA understood, what each worker did, and
 * whether the mission met its acceptance criteria.
 *
 * Rendered under an assistant message only when the run recorded mission
 * detail. The worker lines and the mission verdict are separate on purpose:
 * a worker can be "Done" while the mission reads "Mission not verified".
 */

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-neon-success',
  bad: 'text-neon-danger',
  working: 'text-neon-cyan',
  waiting: 'text-neon-warning',
  neutral: 'text-text-subtle',
};

const TONE_MARK: Record<Tone, string> = {
  ok: '✓',
  bad: '✕',
  working: '…',
  waiting: '•',
  neutral: '–',
};

export function MissionStatusPanel({ view }: { view: MissionView | null }) {
  if (!view) return null;
  return (
    <section
      data-testid="mission-status"
      aria-label="Mission status"
      className="mt-2.5 rounded-xl border border-[rgba(152, 152, 152,0.2)] bg-[var(--ws-card)] px-3.5 py-2.5 text-[12.5px]"
    >
      {view.understanding && (
        <p className="text-text-muted" data-testid="mission-understanding">
          <span className="font-semibold text-text">Understood: </span>
          {view.understanding}
        </p>
      )}

      {view.tasks.length > 0 && (
        <ul className="mt-2 space-y-1.5" data-testid="mission-tasks">
          {view.tasks.map((t) => (
            <li key={t.taskId} className="flex items-start gap-2" data-tone={t.tone}>
              <span className={cn('mt-px w-3 shrink-0 text-center font-semibold', TONE_TEXT[t.tone])}>
                {TONE_MARK[t.tone]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-text">{t.title}</span>
                {t.byline && <span className="text-text-subtle"> · {t.byline}</span>}
                <span className={cn('block', TONE_TEXT[t.tone])}>
                  {t.stateLabel}
                  {t.waitingOn && <span className="text-text-subtle"> — after {t.waitingOn}</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {view.verdict && (
        <p
          className={cn('mt-2.5 border-t border-[rgba(152, 152, 152,0.15)] pt-2 font-semibold', TONE_TEXT[view.verdict.tone])}
          data-testid="mission-verdict"
          data-tone={view.verdict.tone}
        >
          {view.verdict.text}
        </p>
      )}
    </section>
  );
}
