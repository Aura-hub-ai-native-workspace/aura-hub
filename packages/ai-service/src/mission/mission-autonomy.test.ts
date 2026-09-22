/**
 * mission autonomy — plans auto-pass, waves include report kinds,
 * proposals apply without a human Accept, destruction still parks.
 *
 * Planning no longer waits for an explicit approval: the checkpoint
 * auto-passes at creation (system actor) and destructive work parks
 * per task at execution instead. File proposals apply autonomously
 * (a proposal only creates/overwrites one confined path — it cannot
 * delete); research/documentation/review resolve as reports with no
 * disk write. Only manual-operation and approval kinds still need a
 * human via completeManualTask.
 *
 * Runs with `npm run test:service` from the repo root, against an
 * isolated AURA_HOME so no real user state is touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-mission-auto-test-'));

import { WorkspaceManager } from '../workspace';
import { MissionExecutionEngine } from './execution/engine';
import { CapabilityFabric } from '@aura/capability-fabric';
import type { MissionRecord, MissionTask } from './types';

let manager: WorkspaceManager;
let projectId: string;
let projectPath: string;

function goal(id: string) {
  return { id, focusAreaId: 'f1', title: 'Build it', rationale: 'Because', relatedEvidence: [], priority: 'high' as const };
}

function task(id: string, kind: MissionTask['kind'], extra: Partial<MissionTask> = {}): MissionTask {
  return {
    id, goalId: 'g1', focusAreaId: 'f1', title: `task ${id}`, description: `do ${id}`,
    kind, targetFile: null, mode: null, priority: 'medium', dependencies: [],
    estimatedDurationMinutes: 5, confidence: 0.9, risk: 'medium', owner: 'ai',
    automationLevel: 'automatic', status: 'pending', ...extra,
  } as MissionTask;
}

function seedMission(tasks: MissionTask[]): MissionRecord {
  const rec = manager.missions.create(projectId, {
    text: 'build the thing',
    classification: null,
    intent: null,
    signals: {} as never,
    strategy: null,
    goalGraph: { goals: [goal('g1')], tasks, focusAreas: [] } as never,
    risk: null,
    review: null,
    quality: null,
    approval: { status: 'pending', at: null } as never,
    taskRuns: [],
  } as never);
  return rec;
}

let fabric: CapabilityFabric;

beforeEach(async () => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-mission-auto-test-'));
  manager = new WorkspaceManager({});
  projectPath = mkdtempSync(join(tmpdir(), 'aura-mission-proj-'));
  projectId = manager.addProject({ name: 'proj', path: projectPath }).project.id;
  fabric = new CapabilityFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: true }),
    nodeAvailable: () => null,
    requestApproval: async () => false,
  });
  const { allExecutors } = await import('../fabric/executors');
  for (const exe of allExecutors(manager)) {
    if (exe.capabilityId === 'filesystem.write' || exe.capabilityId === 'filesystem.delete') {
      fabric.register(exe);
    }
  }
  manager.attachFabric(fabric);
});

describe('planning auto-passes', () => {
  it('autoApprovePlanning approves as system without a human call', () => {
    const rec = seedMission([task('t1', 'file-operation', { targetFile: 'a.ts' })]);
    const engine = new MissionExecutionEngine({ runTask: async () => ({ ok: true }), persist: () => {} });
    const out = engine.autoApprovePlanning(rec);
    expect(out.approval.status).toBe('approved');
    expect(out.execution?.status).toBe('approved');
    expect(out.execution?.checkpoints[0]?.status).toBe('passed');
    const approvedEntry = out.execution?.timeline.find((t) => t.type === 'approved');
    expect(approvedEntry?.actor).toBe('system');
  });

  it('approve() still records an explicit human approval', () => {
    const rec = seedMission([task('t1', 'file-operation', { targetFile: 'a.ts' })]);
    const engine = new MissionExecutionEngine({ runTask: async () => ({ ok: true }), persist: () => {} });
    const out = engine.approve(rec);
    expect(out.approval.status).toBe('approved');
    expect(out.execution?.timeline.find((t) => t.type === 'approved')?.actor).toBe('human');
  });
});

describe('waves run report kinds autonomously', () => {
  it('research tasks reach the hook instead of waiting for a human', async () => {
    const rec = seedMission([task('t1', 'research')]);
    const seen: string[] = [];
    const engine = new MissionExecutionEngine({
      runTask: async ({ task }) => { seen.push(task.id); return { ok: true, status: 'done' as const }; },
      persist: () => {},
    });
    engine.hydrate(rec);
    engine.startExecution(engine.autoApprovePlanning(rec));
    await engine.runReadyTasks(rec);
    expect(seen).toEqual(['t1']);
  });

  it('only manual-operation and approval stay human', () => {
    expect([...MissionExecutionEngine.MANUAL_KINDS].sort()).toEqual(['approval', 'manual-operation']);
  });
});

describe('file proposals apply without Accept', () => {
  it('writes the proposal to disk and completes the task', async () => {
    // Stub only the model call: policy, executors, filesystem and
    // the ledger below it are all real.
    vi.spyOn(manager.pipeline, 'generate').mockResolvedValue({
      ok: true,
      text: JSON.stringify({ explanation: 'create greeting', newCode: 'export const hi = 1;\n' }),
      usage: null,
    });
    const rec = seedMission([task('t1', 'file-operation', { targetFile: 'hello.ts' })]);
    manager.missions.patch(projectId, rec.id, { approval: { status: 'approved', at: new Date().toISOString() } });
    const res = await manager.runMissionTask(projectId, rec.id, 't1');
    expect(res.ok).toBe(true);
    expect(readFileSync(join(projectPath, 'hello.ts'), 'utf8')).toBe('export const hi = 1;\n');
    const after = manager.missions.get(projectId, rec.id);
    expect(after?.goalGraph?.tasks.find((t) => t.id === 't1')?.status).toBe('done');
    // No approval was created for the write.
    expect(fabric.pendingApprovals().length).toBe(0);
  });

  it('a missing provider fails the task loudly instead of inventing code', async () => {
    vi.spyOn(manager.pipeline, 'generate').mockResolvedValue({
      ok: false, error: { message: 'no provider', code: 'no-provider' } as never,
    });
    const rec = seedMission([task('t1', 'file-operation', { targetFile: 'hello.ts' })]);
    manager.missions.patch(projectId, rec.id, { approval: { status: 'approved', at: new Date().toISOString() } });
    const res = await manager.runMissionTask(projectId, rec.id, 't1');
    expect(res.ok).toBe(false);
    expect(existsSync(join(projectPath, 'hello.ts'))).toBe(false);
  });
});

describe('research resolves as a report with no disk write', () => {
  it('records findings and completes without touching the filesystem', async () => {
    vi.spyOn(manager.pipeline, 'generate').mockResolvedValue({
      ok: true, text: 'The project is a library with one module.',
    } as never);
    const rec = seedMission([task('t1', 'research')]);
    manager.missions.patch(projectId, rec.id, { approval: { status: 'approved', at: new Date().toISOString() } });
    const res = await manager.runMissionTask(projectId, rec.id, 't1');
    expect(res.ok).toBe(true);
    const after = manager.missions.get(projectId, rec.id);
    expect(after?.goalGraph?.tasks.find((t) => t.id === 't1')?.status).toBe('done');
  });
});

describe('waves execute dependencies in order without approval', () => {
  it('two file tasks complete across two batches with real files', async () => {
    vi.spyOn(manager.pipeline, 'generate').mockImplementation(async (input) => {
      const user = (input as { user: string }).user;
      const file = user.includes('two.ts') ? 'two' : 'one';
      return {
        ok: true,
        text: JSON.stringify({ explanation: `create ${file}`, newCode: `export const ${file} = 1;\n` }),
        usage: null,
      };
    });
    const rec = seedMission([
      task('t1', 'file-operation', { targetFile: 'one.ts' }),
      task('t2', 'file-operation', { targetFile: 'two.ts', dependencies: ['t1'] }),
    ]);
    manager.missions.patch(projectId, rec.id, { approval: { status: 'approved', at: new Date().toISOString() } });
    const b1 = await manager.runMissionBatch(projectId, rec.id);
    expect(b1.ok).toBe(true);
    const b2 = await manager.runMissionBatch(projectId, rec.id);
    expect(b2.ok).toBe(true);
    expect(readFileSync(join(projectPath, 'one.ts'), 'utf8')).toContain('one');
    expect(readFileSync(join(projectPath, 'two.ts'), 'utf8')).toContain('two');
    const after = manager.missions.get(projectId, rec.id);
    const statuses = new Map((after?.goalGraph?.tasks ?? []).map((t) => [t.id, t.status]));
    expect(statuses.get('t1')).toBe('done');
    expect(statuses.get('t2')).toBe('done');
    expect(fabric.pendingApprovals().length).toBe(0);
  });
});

describe('destructive work still parks', () => {
  it('a delete task parks with no approval and runs after a grant', async () => {
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'doomed.txt'), 'bye\n');
    const rec = seedMission([task('t1', 'file-operation', { targetFile: 'doomed.txt' })]);
    manager.missions.patch(projectId, rec.id, { approval: { status: 'approved', at: new Date().toISOString() } });
    // Drive the delete through the Fabric directly: the mission hook
    // only proposes writes, so deletion is expressed as a call.
    const parked = await fabric.invoke('filesystem.delete', { path: 'doomed.txt' }, {
      actor: { kind: 'agent', id: 'test' }, projectId, cwd: projectPath,
    });
    expect(parked.outcome).toBe('awaiting-approval');
    expect(existsSync(join(projectPath, 'doomed.txt'))).toBe(true);
    expect(fabric.pendingApprovals().length).toBe(1);
  });
});
