/**
 * MissionReplay — scrub through the mission's execution frame by frame.
 * ------------------------------------------------------------------
 * Frames are captured by the engine on every state change (capped at
 * 4000), so playback is a faithful re-trace of what the engine did:
 * execution status, wave/batch index, checkpoint gates, and each task's
 * runtime state at that moment.
 */
import { useEffect, useState } from 'react';
import { Button, Icon } from '@aura/ui';
import type { ExecutionTaskStatus, MissionReplayPayload } from '../../ai/missionClient';
import { EXECUTION_STATUS_LABEL, RUNTIME_STATUS_LABEL } from './missionMeta';
import { runtimeFill } from './WorkflowCanvas';

const TASK_STATUSES: ExecutionTaskStatus[] = ['queued', 'waiting', 'blocked', 'running', 'paused', 'review', 'completed', 'rejected', 'cancelled', 'retrying', 'failed', 'rollback'];

export function MissionReplay({ replay, loadReplay }: { replay: MissionReplayPayload | null; loadReplay: () => void }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const frames = replay?.frames ?? [];
  useEffect(() => { setIdx(0); setPlaying(false); }, [replay]);
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const t = setInterval(() => {
      setIdx((i) => {
        if (i >= frames.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, Math.max(60, 300 / speed));
    return () => clearInterval(t);
  }, [playing, frames.length, speed]);

  if (!replay) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line bg-canvas p-8 text-center">
        <Icon name="refresh" size={22} className="text-text-muted" />
        <p className="text-[12px] text-text-muted">Replay the mission's execution from the engine's captured frames.</p>
        <Button size="sm" variant="secondary" icon="activity" onClick={loadReplay}>Load replay</Button>
      </div>
    );
  }

  const frame = frames[Math.min(idx, frames.length - 1)];
  const total = frames.length;
  const counts = new Map<ExecutionTaskStatus, number>(TASK_STATUSES.map((s) => [s, 0]));
  if (frame) for (const s of Object.values(frame.snapshot.taskStates)) counts.set(s, (counts.get(s) ?? 0) + 1);

  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-text">Execution replay</span>
        <span className="text-[11px] text-text-subtle">{total} frames</span>
      </div>

      {/* scrubber */}
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" variant="secondary" icon={playing ? 'dot' : 'activity'} className={playing ? '!text-accent' : ''}
          onClick={() => (playing ? setPlaying(false) : idx >= frames.length - 1 ? (setIdx(0), setPlaying(true)) : setPlaying(true))} title={playing ? 'Pause' : 'Play'}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="secondary" disabled={idx <= 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>Step back</Button>
        <Button size="sm" variant="secondary" disabled={idx >= frames.length - 1} onClick={() => setIdx((i) => Math.min(frames.length - 1, i + 1))}>Step fwd</Button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-text outline-none focus:border-accent">
          {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span className="ml-auto whitespace-nowrap text-[11px] text-text-muted">frame {idx + 1}/{total}</span>
      </div>
      <input
        type="range" min={0} max={Math.max(0, frames.length - 1)} value={idx}
        onChange={(e) => { setIdx(Number(e.target.value)); setPlaying(false); }}
        className="mt-3 w-full cursor-pointer" style={{ accentColor: 'var(--accent)' }}
      />

      {frame ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span className="rounded-lg border border-line bg-surface px-2 py-0.5">status: <strong className="text-text">{EXECUTION_STATUS_LABEL[frame.snapshot.executionStatus]}</strong></span>
              <span className="rounded-lg border border-line bg-surface px-2 py-0.5">wave {frame.snapshot.batchIndex + 1}</span>
              <span className="rounded-lg border border-line bg-surface px-2 py-0.5">{frame.snapshot.completedCount}/{frame.snapshot.totalTasks} tasks done</span>
            </div>
            <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-active">
              {TASK_STATUSES.map((s) => {
                const n = counts.get(s) ?? 0;
                if (n === 0) return null;
                return <div key={s} title={`${RUNTIME_STATUS_LABEL[s]}: ${n}`} style={{ width: `${(n / Math.max(1, frame.snapshot.totalTasks)) * 100}%`, background: runtimeFill(s) }} />;
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {TASK_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
                <span key={s} className="inline-flex items-center gap-1 text-[10px] text-text-subtle">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: runtimeFill(s) }} />
                  {RUNTIME_STATUS_LABEL[s]} <strong className="text-text">{counts.get(s)}</strong>
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 sm:w-[200px]">
            {frame.snapshot.checkpointStates && Object.entries(frame.snapshot.checkpointStates).map(([k, v]) => (
              <span key={k} className="inline-flex items-center justify-between rounded-lg border border-line bg-surface px-2 py-1 text-[10.5px]">
                <span className="text-text-muted">{k}</span>
                <strong className="text-text">{v}</strong>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 text-[11.5px] text-text-subtle">No frames captured.</div>
      )}
    </div>
  );
}
