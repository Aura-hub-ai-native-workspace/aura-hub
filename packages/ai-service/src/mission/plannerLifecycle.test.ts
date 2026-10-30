/**
 * The Planner end to end on a real WorkspaceManager (no model): plan a simple
 * goal, edit it, keep its history, refuse a stale edit, hand it off with the
 * actual tasks / acceptance / tool needs, and reopen it after a restart.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-planlife-'));

import { WorkspaceManager } from '../workspace';
import type { MissionEvent } from './types';

let manager: WorkspaceManager;
let projectId = '';

beforeEach(() => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-planlife-'));
  const dir = mkdtempSync(join(tmpdir(), 'aura-planlife-proj-'));
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  manager = new WorkspaceManager();
  projectId = manager.addProject({ name: 'demo', path: dir }).project.id;
});

async function plan(text = 'Add a short NOTES.md file') {
  const events: MissionEvent[] = [];
  const record = await manager.runMissionCreation(projectId, text, (e) => events.push(e));
  return { record, events };
}

describe('Planner lifecycle', () => {
  it('plans a simple goal without a model and shows its real stages', async () => {
    const { record, events } = await plan();
    expect(record.planning?.path).toBe('deterministic');
    expect(record.goalGraph?.tasks).toHaveLength(1);
    const task = record.goalGraph!.tasks[0];
    expect(task).toMatchObject({ targetFile: 'NOTES.md', worker: 'aura' });
    expect(task.expectedOutput).toContain('NOTES.md');
    expect(task.verification).toContain('NOTES.md');
    expect(record.acceptance).toEqual([task.expectedOutput]);
    const stages = events.filter((e) => e.type === 'stage').map((e) => (e as { stage: string; status: string }).stage + ':' + (e as { status: string }).status);
    expect(stages).toEqual(['context:start', 'context:done', 'plan:start', 'plan:done', 'check:start', 'check:done']);
  });

  it('keeps identity and history across edits, and refuses a stale editor', async () => {
    const { record } = await plan();
    const taskId = record.goalGraph!.tasks[0].id;
    const saved = manager.savePlan(projectId, record.id, 1, [
      { id: taskId, title: 'Write NOTES.md', description: 'Project notes.', targetFile: 'NOTES.md', expectedOutput: 'NOTES.md has a heading' },
      { title: 'Install pnpm', description: 'tool', targetFile: null, worker: 'claude-code', requires: ['pnpm', 'Bad Id; rm -rf'], dependencies: [taskId] },
    ], ['NOTES.md exists', '  ', 'pnpm is available']);
    expect(saved.ok).toBe(true);
    const m = saved.mission!;
    expect(m.id).toBe(record.id);
    expect(m.revision).toBe(2);
    expect(m.goalGraph!.tasks[0].id).toBe(taskId); // identity kept
    expect(m.goalGraph!.tasks[1].requires).toEqual(['pnpm']); // the unsafe id was dropped
    expect(m.acceptance).toEqual(['NOTES.md exists', 'pnpm is available']);
    expect(m.history).toHaveLength(1);
    expect(m.history![0]).toMatchObject({ revision: 1, tasks: [{ id: taskId, title: 'Create NOTES.md' }] });
    // an editor that started from revision 1 must not overwrite revision 2
    const stale = manager.savePlan(projectId, record.id, 1, [{ id: taskId, title: 'Stale' }]);
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect(manager.getMission(projectId, record.id)!.goalGraph!.tasks[0].title).toBe('Write NOTES.md');
  });

  it('hands off the actual plan, once per revision, and reopens after a restart', async () => {
    const { record } = await plan();
    const taskId = record.goalGraph!.tasks[0].id;
    manager.savePlan(projectId, record.id, 1, [
      { id: taskId, title: 'Write NOTES.md', targetFile: 'NOTES.md', requires: ['pnpm'], verification: 'read back' },
    ], ['NOTES.md exists']);
    const first = manager.reserveHandoff(projectId, record.id, 2);
    expect(first.ok && !first.duplicate).toBe(true);
    expect(first.plan).toMatchObject({
      source: 'planner', planId: record.id, revision: 2, goal: 'Add a short NOTES.md file', acceptance: ['NOTES.md exists'],
      tasks: [{ id: taskId, title: 'Write NOTES.md', targetFile: 'NOTES.md', requires: ['pnpm'], verification: 'read back', worker: null }],
    });
    const again = manager.reserveHandoff(projectId, record.id, 2);
    expect(again.duplicate).toBe(true);
    expect(again.handoff!.sessionId).toBe(first.handoff!.sessionId);
    expect(manager.reserveHandoff(projectId, record.id, 1)).toMatchObject({ ok: false, status: 409 });
    // a failure leaves the plan intact and retryable with the same session
    manager.settleHandoff(projectId, record.id, first.handoff!.id, 'failed', 'Workspace was busy');
    const retry = manager.reserveHandoff(projectId, record.id, 2);
    expect(retry.duplicate).toBe(false);
    expect(retry.handoff!.sessionId).toBe(first.handoff!.sessionId);
    manager.settleHandoff(projectId, record.id, retry.handoff!.id, 'started');
    manager.settleHandoff(projectId, record.id, retry.handoff!.id, 'failed', 'late report'); // cannot unsay "started"
    // restart
    const reopened = new WorkspaceManager().getMission(projectId, record.id)!;
    expect(reopened.goalGraph!.tasks[0].title).toBe('Write NOTES.md');
    expect(reopened.handoffs!.find((h) => h.id === retry.handoff!.id)!.status).toBe('started');
    expect(new WorkspaceManager().reserveHandoff(projectId, record.id, 2).duplicate).toBe(true);
  });

  it('hands off a task with no target file: an agent is selected for it when it runs', async () => {
    const { record } = await plan();
    manager.savePlan(projectId, record.id, 1, [{ id: record.goalGraph!.tasks[0].id, title: 'Build the audio engine', targetFile: null }]);
    const out = manager.reserveHandoff(projectId, record.id, 2);
    expect(out.ok).toBe(true);
  });
});
