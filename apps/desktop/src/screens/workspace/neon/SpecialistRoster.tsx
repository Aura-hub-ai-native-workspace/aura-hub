import type { Specialist } from '../../../ai/workerClient';

/**
 * SpecialistRoster — AURA's six permanent agents and the runtime each runs on.
 *
 * Presentational. Availability is the backend's own answer about whether the
 * assigned runtime is connected right now; `null` means the backend could not
 * tell, and is shown as unknown, never as ready.
 */
export function SpecialistRoster({ specialists, error }: { specialists: Specialist[]; error?: string | null }) {
  if (error) {
    return (
      <p data-testid="specialist-roster-error" className="text-[11px] text-text-subtle">
        AURA&apos;s agents could not be read: {error}
      </p>
    );
  }
  if (specialists.length === 0) return null;
  return (
    <section data-testid="specialist-roster" aria-label="AURA agents" className="space-y-1.5">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">AURA agents</h3>
      <ul className="space-y-1">
        {specialists.map((s) => {
          const state = s.runtimeAvailable === true ? 'ready' : s.runtimeAvailable === false ? 'unavailable' : 'unknown';
          const label = state === 'ready'
            ? `on ${s.runtimeName}`
            : state === 'unavailable'
              ? `${s.runtimeName} not connected`
              : `${s.runtimeName} · status unknown`;
          return (
            <li key={s.id} data-testid={`specialist-${s.id}`} data-state={state} title={s.focus}
              className="flex items-center gap-2 text-[11.5px]">
              <span aria-hidden className={
                state === 'ready' ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-neon-success'
                  : state === 'unavailable' ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-neon-warning'
                    : 'h-1.5 w-1.5 shrink-0 rounded-full bg-text-subtle'
              } />
              <span className="min-w-0 flex-1 truncate text-text">{s.name}</span>
              <span className="shrink-0 text-text-subtle">{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
