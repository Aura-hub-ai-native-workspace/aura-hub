/**
 * conversations — workspace and project threads never mix.
 *
 * Regression cover for the Workspace Chat / Project Ask AURA split:
 * the two scopes share one store class but must never share a file, a
 * thread, a message, or history. Every conversation carries exactly one
 * scope, and the scope is the file it lives in.
 *
 * Runs with `npm run test:service` from the repo root, against an
 * isolated AURA_HOME so no real user state is touched.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-conv-test-'));

import { ProjectConversations, WORKSPACE_SCOPE_ID } from './conversations';

const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

beforeEach(() => {
  // Fresh files per test: the constructor reads from disk, so a new
  // instance per scope per test starts empty under a fresh home.
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-conv-test-'));
});

describe('conversation scopes', () => {
  it('tags new threads with their scope', () => {
    const ws = new ProjectConversations(WORKSPACE_SCOPE_ID).create('ws thread');
    const pa = new ProjectConversations(PROJECT_A).create('a thread');

    expect(ws.scope).toBe('workspace');
    expect(pa.scope).toBe('project');
    expect(new ProjectConversations(PROJECT_B).scope).toBe('project');
  });

  it('keeps workspace and project threads in disjoint files', () => {
    const ws = new ProjectConversations(WORKSPACE_SCOPE_ID);
    const pa = new ProjectConversations(PROJECT_A);

    const wConv = ws.create('ws thread');
    const aConv = pa.create('a thread');
    ws.append(wConv.id, { role: 'user', content: 'workspace secret WIN-WS-1' });
    pa.append(aConv.id, { role: 'user', content: 'project secret PROJ-A-ONLY-739' });

    // Re-read from disk, like a restart would.
    const wsReread = new ProjectConversations(WORKSPACE_SCOPE_ID);
    const paReread = new ProjectConversations(PROJECT_A);

    expect(wsReread.list().map((c) => c.id)).toEqual([wConv.id]);
    expect(paReread.list().map((c) => c.id)).toEqual([aConv.id]);
    expect(wsReread.get(wConv.id)?.messages.map((m) => m.content))
      .toEqual(['workspace secret WIN-WS-1']);
    expect(paReread.get(aConv.id)?.messages.map((m) => m.content))
      .toEqual(['project secret PROJ-A-ONLY-739']);
  });

  it('keeps two projects disjoint (A → B has no leakage)', () => {
    const pa = new ProjectConversations(PROJECT_A);
    const pb = new ProjectConversations(PROJECT_B);

    const aConv = pa.create('a thread');
    pa.append(aConv.id, { role: 'user', content: 'My secret project identifier is PROJECT-A-ONLY-739.' });

    expect(pb.list()).toEqual([]);
    expect(pb.get(aConv.id)).toBeUndefined();
    expect(new ProjectConversations(WORKSPACE_SCOPE_ID).list()).toEqual([]);
  });

  it('reads pre-scope records as the scope of the file they live in', () => {
    const pa = new ProjectConversations(PROJECT_A);
    const conv = pa.create('legacy thread');
    // Simulate a record written before scopes existed.
    const raw = pa.get(conv.id);
    expect(raw).toBeDefined();
    delete (raw as { scope?: unknown }).scope;

    const reread = new ProjectConversations(PROJECT_A);
    const summaries = reread.list();
    expect(summaries[0].scope).toBe('project');
  });

  it('removing a thread in one scope touches nothing in the other', () => {
    const ws = new ProjectConversations(WORKSPACE_SCOPE_ID);
    const pa = new ProjectConversations(PROJECT_A);
    const wConv = ws.create('ws');
    const aConv = pa.create('a');

    expect(ws.remove(wConv.id)).toBe(true);
    expect(ws.list()).toEqual([]);
    expect(pa.list().map((c) => c.id)).toEqual([aConv.id]);
  });
});
