/**
 * PlanView — one plan in the Planner: read it, edit it, send it.
 * ------------------------------------------------------------------
 * The Planner never executes. This view shows the plan the planner
 * produced, lets the person change any task (title, details, target file,
 * related files, worker, dependencies), saves those edits as a new
 * revision, and hands the plan to Workspace through the one explicit
 * action at the bottom: Send to Workspace.
 *
 * Everything shown is real: how the plan was made (directly, or by which
 * model, in how long), the issues the service's validation found, the
 * execution order implied by the dependencies, and — once sent — what
 * Workspace itself reports about the run. Nothing here estimates,
 * scores, or animates progress that is not happening.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { MissionRecord, PlanTaskEdit } from '../../ai/missionClient';
import { useWorkerStore } from '../../workspace/useWorkers';
import type { useMissions } from './useMissions';
import { relTime } from './missionMeta';

type Planner = ReturnType<typeof useMissions>;

const AURA = 'aura';

interface Draft extends PlanTaskEdit { id: string; key: string }

let draftSeq = 0;
const newId = () => `task-new-${Date.now().toString(36)}${(draftSeq += 1)}`;

function draftOf(mission: MissionRecord): Draft[] {
  return (mission.goalGraph?.tasks ?? []).map((t) => ({
    id: t.id, key: t.id, title: t.title, description: t.description, targetFile: t.targetFile,
    files: t.files ?? [], dependencies: [...t.dependencies], worker: t.worker ?? AURA,
    expectedOutput: t.expectedOutput ?? '', verification: t.verification ?? '', requires: t.requires ?? [],
  }));
}

const same = (a: Draft[], b: Draft[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the task at `index` may swap places with its neighbour. Order in
 * the list is a presentation and tie-break order; what must hold is that a
 * task never ends up before something it depends on. So a swap is allowed
 * only when neither task depends on the other.
 */
export function canMove(tasks: { id: string; dependencies?: string[] }[], index: number, dir: -1 | 1): boolean {
  const j = index + dir;
  if (index < 0 || j < 0 || j >= tasks.length) return false;
  const a = tasks[index];
  const b = tasks[j];
  return !(a.dependencies ?? []).includes(b.id) && !(b.dependencies ?? []).includes(a.id);
}

export function moved<T extends { id: string; dependencies?: string[] }>(tasks: T[], index: number, dir: -1 | 1): T[] {
  if (!canMove(tasks, index, dir)) return tasks;
  const next = [...tasks];
  [next[index], next[index + dir]] = [next[index + dir], next[index]];
  return next;
}

const parseTools = (text: string): string[] =>
  [...new Set(text.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(t)))].slice(0, 6);

/** Dependency waves: tasks in one wave may run side by side in Workspace. */
function waves(tasks: Draft[]): { order: string[][]; cycle: boolean } {
  const ids = new Set(tasks.map((t) => t.id));
  const remaining = new Map(tasks.map((t) => [t.id, (t.dependencies ?? []).filter((d) => ids.has(d))] as const));
  const done = new Set<string>();
  const order: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.every((d) => done.has(d))).map(([id]) => id);
    if (!ready.length) return { order, cycle: true };
    order.push(ready);
    for (const id of ready) { done.add(id); remaining.delete(id); }
  }
  return { order, cycle: false };
}

/** What would stop the handoff, computed from the draft as it stands. */
function blockers(tasks: Draft[], cycle: boolean): string[] {
  const out: string[] = [];
  if (!tasks.length) out.push('Add at least one task.');
  for (const t of tasks) {
    if (!t.title.trim()) out.push('Every task needs a title.');
    // No target file needed: a connected coding agent is selected when the plan is sent.
  }
  if (cycle) out.push('Some tasks depend on each other in a loop.');
  return [...new Set(out)];
}

export function PlanView({ planner }: { planner: Planner }) {
  const mission = planner.active as MissionRecord;
  const workers = useWorkerStore((s) => s.workers);
  const refreshWorkers = useWorkerStore((s) => s.refresh);
  useEffect(() => { if (!workers.length) void refreshWorkers(); }, [workers.length, refreshWorkers]);
  const agentOptions = workers.filter((w) => w.connected && w.invocable);

  const baseline = useMemo(() => draftOf(mission), [mission]);
  const [draft, setDraft] = useState<Draft[]>(baseline);
  // A different plan, or a new saved revision, resets the editor.
  useEffect(() => { setDraft(baseline); }, [mission.id, mission.revision, baseline]);
  const acceptanceBaseline = useMemo(() => mission.acceptance ?? [], [mission]);
  const [acceptance, setAcceptance] = useState<string[]>(acceptanceBaseline);
  useEffect(() => { setAcceptance(acceptanceBaseline); }, [mission.id, mission.revision, acceptanceBaseline]);
  const dirty = !same(draft, baseline) || JSON.stringify(acceptance) !== JSON.stringify(acceptanceBaseline);

  const { order, cycle } = useMemo(() => waves(draft), [draft]);
  const blocking = blockers(draft, cycle);
  const indexOf = (id: string) => draft.findIndex((t) => t.id === id) + 1;

  const patch = (id: string, change: Partial<Draft>) =>
    setDraft((d) => d.map((t) => (t.id === id ? { ...t, ...change } : t)));
  const remove = (id: string) =>
    setDraft((d) => d.filter((t) => t.id !== id).map((t) => ({ ...t, dependencies: (t.dependencies ?? []).filter((x) => x !== id) })));
  const add = () => {
    const id = newId();
    setDraft((d) => [...d, { id, key: id, title: '', description: '', targetFile: '', files: [], dependencies: [], worker: AURA }]);
  };
  const edits = (): PlanTaskEdit[] => draft.map(({ key: _key, ...t }) => ({ ...t, targetFile: t.targetFile?.trim() || null }));
  const acceptanceEdits = () => acceptance.map((a) => a.trim()).filter(Boolean);
  const move = (id: string, dir: -1 | 1) => setDraft((d) => moved(d, d.findIndex((t) => t.id === id), dir));

  const planning = mission.planning;
  const running = planner.handoff.phase === 'saving' || planner.handoff.phase === 'sending';
  const failedPlanning = Boolean(mission.error) && !mission.goalGraph?.tasks.length;
  const serverIssues = planner.issues ?? mission.planIssues ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] space-y-4 px-6 py-5">
          {/* the goal and how this plan was made */}
          <div>
            <h1 className="text-[16px] font-semibold text-text">{mission.text}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <PlanStatus mission={mission} planner={planner} />
              <span>revision {mission.revision ?? 1}</span>
              <span>·</span>
              <span>{relTime(mission.createdAt)}</span>
              {planning?.durationMs != null && (
                <>
                  <span>·</span>
                  <span>
                    {planning.path === 'deterministic'
                      ? 'planned directly from the goal (no model call)'
                      : `planned by ${planning.model ?? 'the model'} in ${(planning.durationMs / 1000).toFixed(1)} s`}
                  </span>
                </>
              )}
            </div>
          </div>

          {failedPlanning && (
            <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
              <div className="flex items-start gap-2 text-[12.5px] text-danger">
                <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
                <span className="flex-1">{mission.error}</span>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon="refresh" loading={planner.creating} onClick={() => void planner.replan()}>Retry planning</Button>
                <Button size="sm" variant="secondary" icon="plus" onClick={add}>Write the tasks yourself</Button>
              </div>
            </div>
          )}

          {planner.error && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{planner.error}</div>
          )}

          {serverIssues.length > 0 && !dirty && (
            <div className="space-y-1 rounded-xl border border-attention/30 bg-attention/5 px-4 py-3">
              {serverIssues.map((i, n) => (
                <div key={n} className="flex items-start gap-2 text-[12px] text-text">
                  <Icon name={i.blocksHandoff ? 'shield' : 'eye'} size={13} className={`mt-0.5 shrink-0 ${i.blocksHandoff ? 'text-danger' : 'text-attention'}`} />
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* execution order implied by the dependencies */}
          {draft.length > 1 && !cycle && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span className="font-medium text-text">Order in Workspace:</span>
              {order.map((wave, w) => (
                <span key={w} className="inline-flex items-center gap-1.5">
                  {w > 0 && <Icon name="chevron-right" size={11} className="text-text-subtle" />}
                  <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 tabular-nums">
                    {wave.map((id) => `#${indexOf(id)}`).join(' + ')}
                  </span>
                </span>
              ))}
              {order.some((wv) => wv.length > 1) && <span className="text-text-subtle">(tasks joined by + can run side by side)</span>}
            </div>
          )}

          {/* the editable task list */}
          <div className="space-y-2.5">
            {draft.map((t, n) => (
              <TaskEditor
                key={t.key}
                index={n + 1}
                task={t}
                others={draft.filter((o) => o.id !== t.id)}
                indexOf={indexOf}
                agents={agentOptions.map((w) => ({ id: w.id, name: w.name }))}
                onChange={(c) => patch(t.id, c)}
                onRemove={() => remove(t.id)}
                canUp={canMove(draft, n, -1)}
                canDown={canMove(draft, n, 1)}
                onMove={(dir) => move(t.id, dir)}
              />
            ))}
            {!failedPlanning && (
              <button onClick={add} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2.5 text-[12px] text-text-muted transition-colors hover:border-line-strong hover:text-text">
                <Icon name="plus" size={13} /> Add task
              </button>
            )}
          </div>

          {/* what must be true for the goal to count as met */}
          <div className="space-y-2 rounded-xl border border-line bg-surface p-3" data-testid="acceptance">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text">Acceptance criteria</span>
              <button onClick={() => setAcceptance((a) => [...a, ''])} className="text-[11px] text-accent hover:underline">Add criterion</button>
            </div>
            {acceptance.length === 0 && <p className="text-[11.5px] text-text-subtle">None yet. Workspace still verifies each task by its own check; criteria describe when the whole goal is met.</p>}
            {acceptance.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={a} onChange={(e) => setAcceptance((all) => all.map((x, n) => (n === i ? e.target.value : x)))}
                  aria-label={`Acceptance criterion ${i + 1}`} placeholder="Something that must be true when this is done"
                  className="w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-subtle focus:border-accent" />
                <button onClick={() => setAcceptance((all) => all.filter((_, n) => n !== i))} aria-label={`Remove criterion ${i + 1}`} className="rounded p-1 text-text-subtle hover:text-danger"><Icon name="close" size={12} /></button>
              </div>
            ))}
          </div>

          {/* what the plan stands on, and what came before it */}
          {mission.context && (
            <details className="rounded-xl border border-line bg-surface p-3 text-[12px]" data-testid="plan-context">
              <summary className="cursor-pointer font-medium text-text">What this plan is based on ({mission.context.records} saved note{mission.context.records === 1 ? '' : 's'}{mission.context.sources.length ? `, ${mission.context.sources.length} source${mission.context.sources.length === 1 ? '' : 's'}` : ''})</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-2 font-mono text-[11px] text-text-muted">{mission.context.text}</pre>
              {mission.context.sources.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11.5px]">
                  {mission.context.sources.map((src) => <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{src.title || src.url}</a></li>)}
                </ul>
              )}
            </details>
          )}
          {(mission.history?.length ?? 0) > 0 && (
            <details className="rounded-xl border border-line bg-surface p-3 text-[12px]" data-testid="plan-history">
              <summary className="cursor-pointer font-medium text-text">Earlier versions ({mission.history!.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {[...mission.history!].reverse().map((h) => (
                  <li key={h.revision} className="text-[11.5px] text-text-muted">
                    <span className="font-medium text-text">Revision {h.revision}</span> · {relTime(h.at)} · {h.tasks.length} task{h.tasks.length === 1 ? '' : 's'}: {h.tasks.map((t) => t.title).join(' → ') || 'none'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {/* the one action: hand the plan to Workspace */}
      <div className="shrink-0 border-t border-line bg-canvas/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-3">
          <div className="min-w-[15rem] flex-1 text-[12px]">
            {dirty ? (
              <span className="text-attention">Unsaved changes — they are saved when you send, or <button className="underline" onClick={() => void planner.savePlan(edits(), acceptanceEdits())}>save now</button> · <button className="underline" onClick={() => { setDraft(baseline); setAcceptance(acceptanceBaseline); }}>discard</button></span>
            ) : planner.handoff.message ? (
              <span className={planner.handoff.phase === 'failed' ? 'text-danger' : 'text-text-muted'}>{planner.handoff.message}</span>
            ) : blocking.length ? (
              <span className="text-text-muted">{blocking[0]}</span>
            ) : (
              <span className="text-text-muted">Workspace runs the plan as soon as it is sent — no further approval.</span>
            )}
          </div>
          <Button
            variant="primary"
            icon="arrow-right"
            data-testid="send-to-workspace"
            loading={running}
            disabled={running || blocking.length > 0 || planner.creating || planner.saving}
            onClick={() => void planner.sendToWorkspace(dirty ? edits() : null, dirty ? acceptanceEdits() : undefined)}
          >
            Send to Workspace
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlanStatus({ mission, planner }: { mission: MissionRecord; planner: Planner }) {
  const run = planner.run;
  if (run) {
    const label = run.outcome
      ? run.outcome === 'completed' ? 'Completed in Workspace' : `Workspace: ${run.outcome}`
      : 'Running in Workspace';
    const tone = run.outcome === 'completed' ? 'positive' : run.outcome && run.outcome !== 'completed' ? 'critical' : 'info';
    return <Badge tone={tone}>{label}</Badge>;
  }
  if (mission.error && !mission.goalGraph?.tasks.length) return <Badge tone="critical">Planning failed</Badge>;
  if ((mission.planIssues ?? []).some((i) => i.blocksHandoff)) return <Badge tone="attention">Needs changes</Badge>;
  return <Badge tone="positive">Plan ready</Badge>;
}

function TaskEditor({ index, task, others, indexOf, agents, onChange, onRemove, canUp, canDown, onMove }: {
  canUp: boolean;
  canDown: boolean;
  onMove: (dir: -1 | 1) => void;
  index: number;
  task: Draft;
  others: Draft[];
  indexOf: (id: string) => number;
  agents: { id: string; name: string }[];
  onChange: (c: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const worker = task.worker ?? AURA;
  const field = 'w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-subtle focus:border-accent';
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-testid="plan-task">
      <div className="flex items-start gap-2">
        <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-active text-[10.5px] font-semibold tabular-nums text-text-muted">{index}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <input value={task.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="What this task does" aria-label={`Task ${index} title`} className={`${field} font-medium`} />
          <textarea value={task.description ?? ''} onChange={(e) => onChange({ description: e.target.value })} placeholder="Details Workspace should follow" rows={2} aria-label={`Task ${index} details`} className={`${field} resize-y`} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[10.5px] text-text-subtle">Target file
              <input value={task.targetFile ?? ''} onChange={(e) => onChange({ targetFile: e.target.value })} placeholder="e.g. NOTES.md" className={`${field} mt-0.5 font-mono`} />
            </label>
            <label className="block text-[10.5px] text-text-subtle">Done by
              <select value={worker} onChange={(e) => onChange({ worker: e.target.value })} className={`${field} mt-0.5`}>
                <option value={AURA}>Auto — Laya selects a connected coding agent</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                {worker !== AURA && !agents.some((a) => a.id === worker) && <option value={worker}>{worker} (not connected)</option>}
              </select>
            </label>
          </div>
          <label className="block text-[10.5px] text-text-subtle">Related files (comma separated)
            <input
              value={(task.files ?? []).join(', ')}
              onChange={(e) => onChange({ files: e.target.value.split(',').map((f) => f.trim()).filter(Boolean) })}
              placeholder="files this task reads or changes"
              className={`${field} mt-0.5 font-mono`}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[10.5px] text-text-subtle">Expected output
              <input value={task.expectedOutput ?? ''} onChange={(e) => onChange({ expectedOutput: e.target.value })} placeholder="What exists when it is done" aria-label={`Task ${index} expected output`} className={`${field} mt-0.5`} />
            </label>
            <label className="block text-[10.5px] text-text-subtle">How it is checked
              <input value={task.verification ?? ''} onChange={(e) => onChange({ verification: e.target.value })} placeholder="A file read back, a test passing…" aria-label={`Task ${index} verification`} className={`${field} mt-0.5`} />
            </label>
          </div>
          <label className="block text-[10.5px] text-text-subtle">Needs tools (ids, e.g. pnpm)
            <input value={(task.requires ?? []).join(', ')} onChange={(e) => onChange({ requires: parseTools(e.target.value) })} placeholder="tools this task needs on the machine" aria-label={`Task ${index} needs tools`} className={`${field} mt-0.5 font-mono`} />
          </label>
          {others.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-text-subtle">
              <span>Runs after:</span>
              {others.map((o) => {
                const on = (task.dependencies ?? []).includes(o.id);
                return (
                  <button
                    key={o.key}
                    onClick={() => onChange({ dependencies: on ? (task.dependencies ?? []).filter((d) => d !== o.id) : [...(task.dependencies ?? []), o.id] })}
                    title={o.title}
                    className={`rounded-full px-2 py-0.5 tabular-nums transition-colors ${on ? 'bg-accent/15 text-accent' : 'bg-surface-active text-text-muted hover:text-text'}`}
                  >
                    #{indexOf(o.id)} {o.title.slice(0, 28) || 'untitled'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-col">
          <button onClick={() => onMove(-1)} disabled={!canUp} aria-label={`Move task ${index} up`} title={canUp ? 'Move up' : 'Cannot move above a task it depends on (or that depends on it)'} className="rounded p-0.5 text-text-subtle transition-colors enabled:hover:text-text disabled:opacity-30"><Icon name="chevron-down" size={13} className="rotate-180" /></button>
          <button onClick={() => onMove(1)} disabled={!canDown} aria-label={`Move task ${index} down`} title={canDown ? 'Move down' : 'Cannot move below a task it depends on (or that depends on it)'} className="rounded p-0.5 text-text-subtle transition-colors enabled:hover:text-text disabled:opacity-30"><Icon name="chevron-down" size={13} /></button>
        </div>
        <button onClick={onRemove} aria-label={`Remove task ${index}`} className="rounded-md p-1 text-text-subtle transition-colors hover:bg-surface-active hover:text-danger">
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}
