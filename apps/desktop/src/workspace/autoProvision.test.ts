import { describe, expect, it } from 'vitest';
import type { EnvironmentNode } from '@aura/connected-environment';
import type { WorkerDescriptor } from '../ai/workerClient';
import { planAutoProvision } from './autoProvision';

const worker = (id: string, over: Partial<WorkerDescriptor> = {}) => ({ id, installed: true, invocable: true, connected: false, ...over }) as WorkerDescriptor;
const node = (id: string, status: string, connected = false, transport = 'local-process') =>
  ({ id, connected, health: { status }, entry: { transport } }) as unknown as EnvironmentNode;
const base = { workerIds: [null, null, null, null, null, null], freeWorkerSlots: 6, nodes: [], placedTools: [], freeToolSlots: 3, attempted: new Set<string>(), busy: false };

describe('planAutoProvision', () => {
  it('places installed, drivable workers and connects the first one', () => {
    const plan = planAutoProvision({ ...base, workers: [worker('claude-code'), worker('codex'), worker('gemini', { installed: false })] });
    expect(plan.placeWorkers).toEqual(['claude-code', 'codex']);
    expect(plan.connectWorker).toBe('claude-code');
  });

  it('never places more than the free slots, and never twice', () => {
    const plan = planAutoProvision({ ...base, workers: [worker('a'), worker('b'), worker('c')], workerIds: ['a', null, null, null, null, null], freeWorkerSlots: 1 });
    expect(plan.placeWorkers).toEqual(['b']);
  });

  it('connects one at a time and does not retry what was already attempted', () => {
    const w = [worker('a'), worker('b')];
    expect(planAutoProvision({ ...base, workers: w, busy: true }).connectWorker).toBeNull();
    expect(planAutoProvision({ ...base, workers: w, attempted: new Set(['worker:a']) }).connectWorker).toBe('b');
  });

  it('never connects a worker that is waiting for the owner\'s approval', () => {
    const plan = planAutoProvision({ ...base, workers: [worker('a', { reason: 'BILLING_POLICY' }), worker('b')] });
    expect(plan.connectWorker).toBe('b');
  });

  it('leaves a connected worker alone', () => {
    expect(planAutoProvision({ ...base, workers: [worker('a', { connected: true })] }).connectWorker).toBeNull();
  });

  it('fills tool slots from the preferred list with tools actually present, up to three', () => {
    const nodes = [node('git', 'available'), node('docker', 'not-installed'), node('node', 'available'), node('python', 'available'), node('pnpm', 'available')];
    const plan = planAutoProvision({ ...base, workers: [], nodes });
    expect(plan.placeTools).toEqual(['git', 'node', 'python']);
    expect(plan.connectTool).toBe('git');
  });

  it('does not connect a tool that is not a local process or is already connected', () => {
    const nodes = [node('git', 'connected', true), node('node', 'available', false, 'http')];
    const plan = planAutoProvision({ ...base, workers: [], nodes, placedTools: ['git'] });
    expect(plan.placeTools).toEqual([]);
    expect(plan.connectTool).toBeNull();
  });
});
