import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cycleText, goalForProject, goalStatusText, listGoals, startGoal, stopGoal,
  type Goal, type GoalMode,
} from './goalClient';

const POLL_MS = 5000;

/**
 * One goal for this project, worked on with no one in the loop: AURA builds,
 * tests, compares with the goal and re-plans until it is met or stopped.
 */
export function GoalControls({ projectPath }: { projectPath: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<GoalMode>('until-achieved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const active = goal?.state === 'running' || goal?.state === 'waiting';

  const refresh = useCallback(async () => {
    try {
      setGoal(goalForProject(await listGoals(), projectPath));
    } catch {
      // The backend may still be starting; the next poll tries again.
    }
  }, [projectPath]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!open && !active) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [open, active, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const run = async (fn: () => Promise<Goal>) => {
    setBusy(true);
    setError(null);
    try {
      setGoal(await fn());
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative" data-testid="goal-controls">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-text-muted hover:bg-surface-active hover:text-text">
        {active && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />}
        Goal
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[440px] rounded-lg border border-line bg-surface shadow-xl" data-testid="goal-panel">
          <div className="border-b border-line px-4 py-3">
            <div className="text-[13px] font-semibold text-text">Goal</div>
            <div className="text-[12px] text-text-muted">
              AURA builds, tests, compares with the goal and re-plans on its own until the goal is met.
            </div>
          </div>
          {goal && (
            <div className="border-b border-line px-4 py-3">
              <p className="break-words text-[13px] text-text">{goal.goal}</p>
              <p className="mt-1 text-[12px] text-text-muted" data-testid="goal-status">{goalStatusText(goal)}</p>
              {goal.cycles.length > 0 && (
                <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[12px] text-text-muted">
                  {goal.cycles.slice(-8).map((c) => (
                    <li key={c.n} title={c.summary}>{cycleText(c)}</li>
                  ))}
                </ol>
              )}
              {active && (
                <button type="button" disabled={busy} onClick={() => run(() => stopGoal(goal.goalId))}
                  className="mt-3 rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-text hover:bg-surface-active disabled:opacity-50">
                  Stop
                </button>
              )}
            </div>
          )}
          {!active && (
            <form className="space-y-3 px-4 py-3" onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void run(() => startGoal(text.trim(), projectPath, mode));
            }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000}
                placeholder="What should this project do when it is finished?" aria-label="Goal"
                className="w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-text outline-none focus:border-text-muted" />
              <div className="flex items-center justify-between gap-3">
                <select value={mode} onChange={(e) => setMode(e.target.value as GoalMode)} aria-label="When to stop"
                  className="rounded-md border border-line bg-canvas px-2 py-1.5 text-[12.5px] text-text">
                  <option value="until-achieved">Until the goal is met</option>
                  <option value="keep-improving">Keep improving after</option>
                </select>
                <button type="submit" disabled={busy || !text.trim()}
                  className="rounded-md bg-text px-3.5 py-1.5 text-[12.5px] font-semibold text-canvas hover:opacity-90 disabled:opacity-50">
                  Start
                </button>
              </div>
            </form>
          )}
          {error && <p className="px-4 pb-3 text-[12.5px] text-red-500" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
