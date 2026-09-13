/**
 * LeftControlPanel — where a tool is added from, and where it is not.
 *
 * The rail used to carry a standalone "Add Tool" button beneath the
 * composer, alongside "Add Worker". It has been removed. A tool belongs
 * to one of the graph's three slots, so the slot is the only place it is
 * added from: that button opened the same surface without saying which
 * slot it would fill, and on an empty workspace the words "Add Tool"
 * appeared four times in one rail.
 *
 * These tests hold that removal, and hold the things that must survive
 * it: Add Worker, the three slots, and the per-slot Add Tool affordance.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnvironmentNode, NodeStatus } from '@aura/connected-environment';

import type { WorkerDescriptor } from '../../../ai/workerClient';
import { deriveToolSlots, type ToolSlot } from '../../../workspace/toolSlots';
import { deriveWorkerSlots } from '../../../workspace/workerSlots';
import { LeftControlPanel } from './LeftControlPanel';

/* ── fixtures ────────────────────────────────────────────────────── */

function worker(id: string): WorkerDescriptor {
  return {
    id,
    name: id,
    installed: true,
    connected: false,
    governance: 'FULLY_GOVERNED',
    reason: '',
    detail: '',
  } as unknown as WorkerDescriptor;
}

function envNode(id: string, status: NodeStatus, connected = false): EnvironmentNode {
  return {
    id,
    entry: {
      id,
      name: id.toUpperCase(),
      category: 'development',
      capabilities: [],
      transport: 'local-process',
      auth: 'none',
      license: 'open-source',
      crossPlatform: true,
      maintained: true,
      summary: '',
      homepage: '',
    },
    health: { status, detail: '', checkedAt: '2026-09-11T00:00:00.000Z' },
    permissions: { read: true, write: false, execute: false, autonomous: false },
    activity: [],
    log: [],
    connected,
  };
}

const NODES = [
  envNode('git', 'connected', true),
  envNode('docker', 'available'),
  envNode('node', 'available'),
];

function slotsFor(...ids: string[]): ToolSlot[] {
  return deriveToolSlots(
    ids.map((nodeId) => ({ nodeId, x: 0.5, y: 0.5 })),
    NODES,
  );
}

const ROSTER = [worker('claude'), worker('opencode')];

function rail(toolSlots: ToolSlot[], workerIds: (string | null)[] = ['claude', 'opencode']) {
  return renderToStaticMarkup(
    <LeftControlPanel
      toolSlots={toolSlots}
      workerSlots={deriveWorkerSlots(workerIds, ROSTER)}
      scanning={false}
      projects={[]}
      projectId={null}
      onSelectProject={vi.fn()}
      phase="Ready when you are"
      onAddWorker={vi.fn()}
      onRemoveWorker={vi.fn()}
      onReplaceWorker={vi.fn()}
      onAddTool={vi.fn()}
      onRemoveTool={vi.fn()}
      onReplaceTool={vi.fn()}
      onRelayout={vi.fn()}
      onInspect={vi.fn()}
      workers={ROSTER}
      workersConnecting={[]}
      workersError={null}
      workerActivity={new Map()}
      onRefreshWorkers={vi.fn()}
      onConnectWorker={vi.fn()}
      onDisconnectWorker={vi.fn()}
      agentBusy={false}
    />,
  );
}

/** How many times a `data-testid` appears in the rendered markup. */
function count(markup: string, testid: string): number {
  return markup.split(`data-testid="${testid}"`).length - 1;
}

/* ── the removal ─────────────────────────────────────────────────── */

describe('LeftControlPanel — the bottom Add Tool button is gone', () => {
  it('renders no standalone Add Tool control, on an empty workspace', () => {
    const markup = rail(slotsFor());
    expect(count(markup, 'add-tool-open')).toBe(0);
  });

  it('renders no standalone Add Tool control, on a full workspace', () => {
    const markup = rail(slotsFor('git', 'docker', 'node'));
    expect(count(markup, 'add-tool-open')).toBe(0);
  });

  it('says "Add Tool" only as many times as there are empty slots', () => {
    expect(rail(slotsFor()).split('Add Tool').length - 1).toBe(3);
    expect(rail(slotsFor('git')).split('Add Tool').length - 1).toBe(2);
    expect(rail(slotsFor('git', 'docker')).split('Add Tool').length - 1).toBe(1);
    expect(rail(slotsFor('git', 'docker', 'node')).split('Add Tool').length - 1).toBe(0);
  });

  it('adds no replacement control in its place', () => {
    const markup = rail(slotsFor('git', 'docker', 'node'));
    for (const gone of ['add-tool-open', 'add-tool', 'rescan', 'rearrange', 'tool-settings']) {
      expect(markup).not.toContain(`data-testid="${gone}"`);
    }
    expect(markup).not.toContain('Extend the environment');
  });
});

/* ── what must survive it ────────────────────────────────────────── */

describe('LeftControlPanel — what the removal must not take with it', () => {
  it('keeps Add Worker', () => {
    const markup = rail(slotsFor('git', 'docker', 'node'));
    expect(count(markup, 'add-worker-open')).toBe(1);
    expect(markup).toContain('Add Worker');
  });

  it('keeps exactly six worker slots, filled or not', () => {
    expect(count(rail(slotsFor('git'), []), 'worker-slot')).toBe(6);
    expect(count(rail(slotsFor('git'), ['claude']), 'worker-slot')).toBe(6);
    expect(
      count(rail(slotsFor('git'), ['a', 'b', 'c', 'd', 'e', 'f']), 'worker-slot'),
    ).toBe(6);
  });

  it('keeps exactly three tool slots, filled or not', () => {
    expect(count(rail(slotsFor()), 'tool-slot')).toBe(3);
    expect(count(rail(slotsFor('git')), 'tool-slot')).toBe(3);
    expect(count(rail(slotsFor('git', 'docker', 'node')), 'tool-slot')).toBe(3);
  });

  it('keeps the Add Tool affordance on every empty slot', () => {
    expect(count(rail(slotsFor()), 'tool-slot-add')).toBe(3);
    expect(count(rail(slotsFor('git')), 'tool-slot-add')).toBe(2);
    expect(count(rail(slotsFor('git', 'docker', 'node')), 'tool-slot-add')).toBe(0);
  });

  it('keeps a way out of a full workspace: every filled slot can be freed', () => {
    const markup = rail(slotsFor('git', 'docker', 'node'));
    expect(count(markup, 'tool-slot-remove')).toBe(3);
    expect(markup).toContain('Nothing is uninstalled');
  });

  it('reaches the surface at capacity through Replace, not a rail button', () => {
    const markup = rail(slotsFor('git', 'docker', 'node'));
    expect(count(markup, 'add-tool-open')).toBe(0);
    expect(count(markup, 'tool-slot-add')).toBe(0);
    expect(count(markup, 'tool-slot-replace')).toBe(3);
  });

  it('offers Replace on filled slots only', () => {
    expect(count(rail(slotsFor()), 'tool-slot-replace')).toBe(0);
    expect(count(rail(slotsFor('git')), 'tool-slot-replace')).toBe(1);
    expect(count(rail(slotsFor('git', 'docker')), 'tool-slot-replace')).toBe(2);
  });

  it('keeps the single AURA Agent node', () => {
    const markup = rail(slotsFor('git'));
    expect(count(markup, 'hub-aura-node')).toBe(1);
    expect(markup).toContain('AURA Agent');
  });

  it('holds no composer of its own — the conversation owns the only one', () => {
    const markup = rail(slotsFor('git'));
    expect(count(markup, 'agent-composer')).toBe(0);
    expect(count(markup, 'agent-submit')).toBe(0);
    expect(markup).not.toContain('<textarea');
  });
});
