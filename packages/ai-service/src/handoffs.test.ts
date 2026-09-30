/**
 * Handoffs — the controlled bridge and its status machine.
 * ==================================================================
 * A handoff must prove its source when it can, move only along its
 * allowed transitions, and be listable in the shapes the routes serve:
 * by source project, by target workspace, by status.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home = '';
const realHome = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-handoff-test-'));
  process.env.AURA_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = realHome;
});

import { HandoffStore, type HandoffSourceReader } from './handoffs';

const baseInput = {
  projectId: 'p1',
  sourceConversationId: 'conv_src',
  sourceMessageIds: ['m1', 'm2'],
  title: 'Build the payment retry path',
  targetWorkspaceId: 'workspace:p1',
};

describe('HandoffStore', () => {
  it('creates a handoff in the created state, persisted under the source project', () => {
    const store = new HandoffStore('p1');
    const h = store.create(baseInput);
    expect(h.status).toBe('created');
    expect(h.projectId).toBe('p1');
    expect(h.targetWorkspaceId).toBe('workspace:p1');
    expect(fs.existsSync(path.join(home, 'handoffs', 'p1.json'))).toBe(true);
  });

  it('validates the source when a source reader is wired', () => {
    const reader: HandoffSourceReader = (pid, cid) =>
      pid === 'p1' && cid === 'conv_src'
        ? { messages: [{ id: 'm1' }, { id: 'm2' }] }
        : undefined;
    const store = new HandoffStore('p1', reader);

    expect(() => store.create({ ...baseInput, sourceConversationId: 'conv_missing' }))
      .toThrow('not found in project');
    expect(() => store.create({ ...baseInput, sourceMessageIds: ['m1', 'mX'] }))
      .toThrow('source message "mX" not found');
    expect(store.create(baseInput).status).toBe('created');
  });

  it('refuses an empty title, empty message list, and a non-workspace target', () => {
    const store = new HandoffStore('p1');
    expect(() => store.create({ ...baseInput, title: '   ' })).toThrow('task statement');
    expect(() => store.create({ ...baseInput, sourceMessageIds: [] })).toThrow('at least one source message');
    expect(() => store.create({ ...baseInput, targetWorkspaceId: 'p1' })).toThrow('not a workspace id');
  });

  it('moves along the allowed machine: created → accepted → completed', () => {
    const store = new HandoffStore('p1');
    const h = store.create(baseInput);
    const accepted = store.setStatus(h.id, 'accepted', { acceptedIntoConversationId: 'wconv_1' });
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.acceptedIntoConversationId).toBe('wconv_1');
    expect(accepted?.acceptedAt).toBeTruthy();
    const done = store.setStatus(h.id, 'completed');
    expect(done?.status).toBe('completed');
    expect(done?.completedAt).toBeTruthy();
  });

  it('allows cancelling from created or accepted, and forbids illegal transitions', () => {
    const store = new HandoffStore('p1');
    const a = store.create(baseInput);
    expect(store.setStatus(a.id, 'cancelled')?.cancelledAt).toBeTruthy();

    const b = store.create(baseInput);
    expect(() => store.setStatus(b.id, 'completed')).toThrow('cannot move from "created" to "completed"');

    // Terminal states accept nothing, not even themselves.
    const c = store.create(baseInput);
    store.setStatus(c.id, 'cancelled');
    expect(() => store.setStatus(c.id, 'accepted')).toThrow();
  });

  it('returns undefined for unknown ids instead of throwing', () => {
    const store = new HandoffStore('p1');
    expect(store.setStatus('hnd_nope', 'accepted')).toBeUndefined();
    expect(store.get('hnd_nope')).toBeUndefined();
  });

  it('lists by target workspace and by status', () => {
    const store = new HandoffStore('p1');
    const a = store.create(baseInput);
    store.create({ ...baseInput, targetWorkspaceId: 'workspace:p2' });
    const c = store.create(baseInput);
    store.setStatus(c.id, 'cancelled');

    // Newest first: c was created after a; b went to another workspace.
    const inWs = store.list({ targetWorkspaceId: 'workspace:p1' });
    expect(inWs.map((h) => h.id)).toEqual([c.id, a.id]);
    expect(inWs).toHaveLength(2);
    expect(store.list({ targetWorkspaceId: 'workspace:p2' })).toHaveLength(1);
    // a was offered and left alone (created), b went to another workspace
    // (created there), c was cancelled.
    expect(store.list({ status: 'created' })).toHaveLength(2);
    expect(store.list({ status: 'cancelled' }).map((h) => h.id)).toEqual([c.id]);
  });
});
