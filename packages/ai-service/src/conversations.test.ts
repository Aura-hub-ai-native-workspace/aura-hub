/**
 * Scoped conversation stores — the isolation contract.
 * ==================================================================
 * These tests treat the disk as the contract: a legacy project file with
 * unscoped records must migrate in place, stay readable through the
 * project routes, and stay INVISIBLE to the workspace routes. The store
 * that finds a foreign id must behave exactly as if the id never existed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home = '';
const realHome = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-conv-test-'));
  process.env.AURA_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = realHome;
});

const convFile = (pid: string) => path.join(home, 'conversations', `${pid}.json`);
/** Mirrors the service's Windows-safe encoding: `:` is illegal in a Windows file name. */
const wsFile = (wsId: string) =>
  path.join(home, 'conversations-workspace', `${wsId.replace(/%/g, '%25').replace(/:/g, '%3A')}.json`);

import { ProjectConversations, WorkspaceConversations } from './conversations';

describe('ProjectConversations (scope=project, kind=ask_aura)', () => {
  it('creates, lists and gets conversations stamped with the project scope', () => {
    const store = new ProjectConversations('p1');
    const c = store.create('Design review');
    expect(c.scope).toBe('project');
    expect(c.kind).toBe('ask_aura');
    expect(c.projectId).toBe('p1');
    expect(c.workspaceId).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].scope).toBe('project');
    expect(store.get(c.id)?.title).toBe('Design review');
  });

  it('appends messages and auto-titles from the first user turn', () => {
    const store = new ProjectConversations('p1');
    const c = store.create();
    store.append(c.id, { role: 'user', content: 'Why is the login failing?' });
    store.append(c.id, { role: 'assistant', content: 'Looking into it.' });
    const got = store.get(c.id);
    expect(got?.messages).toHaveLength(2);
    expect(got?.title).toBe('Why is the login failing?');
    expect(store.list()[0].preview).toBe('Why is the login failing?');
  });

  it('migrates a legacy unscoped file at read time, keeping the path and id', () => {
    const legacy = {
      id: 'conv_legacy1',
      title: 'Before scopes',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [{ id: 'm1', role: 'user', content: 'hello', at: '2026-01-01T00:00:00.000Z' }],
    };
    fs.mkdirSync(path.dirname(convFile('p1')), { recursive: true });
    fs.writeFileSync(convFile('p1'), JSON.stringify([legacy]));

    const store = new ProjectConversations('p1');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('conv_legacy1');
    expect(list[0].scope).toBe('project');

    // Re-open: migration was written back, and reading it again is stable.
    const again = new ProjectConversations('p1');
    expect(again.get('conv_legacy1')?.scope).toBe('project');
    expect(again.get('conv_legacy1')?.kind).toBe('ask_aura');
    expect(again.get('conv_legacy1')?.projectId).toBe('p1');

    const onDisk = JSON.parse(fs.readFileSync(convFile('p1'), 'utf8'));
    expect(onDisk[0].scope).toBe('project');
  });

  it('is idempotent: migrating an already-migrated file changes nothing', () => {
    const legacy = {
      id: 'conv_legacy2', title: 'T',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    fs.mkdirSync(path.dirname(convFile('p1')), { recursive: true });
    fs.writeFileSync(convFile('p1'), JSON.stringify([legacy]));
    new ProjectConversations('p1').list();
    const afterFirst = fs.readFileSync(convFile('p1'), 'utf8');
    new ProjectConversations('p1').list();
    expect(fs.readFileSync(convFile('p1'), 'utf8')).toBe(afterFirst);
  });

  it('drops corrupt records instead of failing the whole file', () => {
    fs.mkdirSync(path.dirname(convFile('p1')), { recursive: true });
    fs.writeFileSync(convFile('p1'), JSON.stringify([
      { garbage: true },
      { id: 'conv_ok', title: 'Keep me', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [] },
    ]));
    const store = new ProjectConversations('p1');
    expect(store.list().map((c) => c.id)).toEqual(['conv_ok']);
  });
});

describe('WorkspaceConversations (scope=workspace, kind=execution)', () => {
  it('stores execution threads in a separate file family with execution ids', () => {
    const ws = new WorkspaceConversations('workspace:p1');
    const c = ws.create('Execution thread');
    expect(c.scope).toBe('workspace');
    expect(c.kind).toBe('execution');
    expect(c.projectId).toBe('p1');
    expect(c.workspaceId).toBe('workspace:p1');
    expect(c.id.startsWith('wconv_')).toBe(true);
    expect(fs.existsSync(wsFile('workspace:p1'))).toBe(true);
    expect(fs.existsSync(convFile('p1'))).toBe(false);
  });

  it('encodes the workspace id into a Windows-safe file name', () => {
    // A colon is part of the id but illegal in a Windows file name; the
    // mapping must stay reversible so two workspaces never share a file.
    const ws = new WorkspaceConversations('workspace:p1');
    ws.create('Probe');
    expect(fs.readdirSync(path.join(home, 'conversations-workspace'))).toEqual(['workspace%3Ap1.json']);
    // And it reads back to exactly the workspace that wrote it.
    expect(new WorkspaceConversations('workspace:p1').list()).toHaveLength(1);
  });

  it('never exposes a project conversation, and the project store never exposes a workspace one', () => {
    const proj = new ProjectConversations('p1');
    const pc = proj.create('Discussion');

    const ws = new WorkspaceConversations('workspace:p1');
    const wc = ws.create('Execution');

    // Foreign ids are indistinguishable from nonexistent ones.
    expect(ws.get(pc.id)).toBeUndefined();
    expect(ws.list()).toHaveLength(1);
    expect(ws.list()[0].id).toBe(wc.id);

    expect(proj.get(wc.id)).toBeUndefined();

    // And the isolation holds through every mutating operation.
    expect(ws.append(pc.id, { role: 'user', content: 'x' })).toBeUndefined();
    expect(ws.rename(pc.id, 'hijack')).toBeUndefined();
    expect(ws.remove(pc.id)).toBe(false);
    expect(ws.removeLastAssistant(pc.id)).toBe(false);
    expect(proj.get(pc.id)?.title).toBe('Discussion');
  });

  it('refuses a workspace id / project id mismatch', () => {
    expect(() => new WorkspaceConversations('workspace:p1', 'p2')).toThrow('belongs to project "p1"');
  });

  it('supports the full CRUD surface a workspace route needs', () => {
    const ws = new WorkspaceConversations('workspace:p9');
    const a = ws.create('One');
    const b = ws.create('Two');
    expect(ws.rename(a.id, 'One renamed')?.title).toBe('One renamed');
    expect(ws.append(b.id, { role: 'assistant', content: 'done' })).toBeDefined();
    expect(ws.removeLastAssistant(b.id)).toBe(true);
    expect(ws.remove(a.id)).toBe(true);
    expect(ws.list().map((c) => c.id)).toEqual([b.id]);
  });
});
