/**
 * Project lifecycle: creating a new project safely, and the first-open
 * decision that drives the opening animation.
 *
 *  · a created project gets a folder derived from its name, inside the
 *    chosen location, never an existing one, and no orphan on failure;
 *  · "first open" is true exactly once per project — new projects get the
 *    `new` message, added folders the `existing` one, and a project opened
 *    before this feature existed never replays it.
 *
 * Isolated AURA_HOME and temporary folders.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-life-test-'));

import { WorkspaceManager } from './workspace';

let parent = '';
let manager: WorkspaceManager;

beforeEach(() => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-life-test-'));
  parent = mkdtempSync(join(tmpdir(), 'aura-life-parent-'));
  manager = new WorkspaceManager();
});

describe('createProject', () => {
  it('creates a real folder inside the chosen location and registers it as created', () => {
    const { project } = manager.createProject({ name: 'Habit Tracker', parentPath: parent });
    expect(project.path).toBe(join(parent, 'habit-tracker'));
    expect(readFileSync(join(project.path, 'README.md'), 'utf8')).toBe('# Habit Tracker\n');
    expect(project.origin).toBe('created');
    expect(manager.listProjects().map((p) => p.id)).toContain(project.id);
  });

  it('AURA_PROJECTS_DIR moves where projects go, and an explicit location still wins', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'aura-life-dir-'));
    process.env.AURA_PROJECTS_DIR = elsewhere;
    try {
      expect(manager.createProject({ name: 'Moved' }).project.path).toBe(join(elsewhere, 'moved'));
      expect(manager.createProject({ name: 'Explicit', parentPath: parent }).project.path).toBe(join(parent, 'explicit'));
    } finally {
      delete process.env.AURA_PROJECTS_DIR;
    }
  });

  it('never reuses an existing folder: it takes the next free name', () => {
    mkdirSync(join(parent, 'notes'));
    writeFileSync(join(parent, 'notes', 'precious.txt'), 'keep me');
    const { project } = manager.createProject({ name: 'Notes', parentPath: parent });
    expect(project.path).toBe(join(parent, 'notes-2'));
    expect(readFileSync(join(parent, 'notes', 'precious.txt'), 'utf8')).toBe('keep me');
    expect(manager.createProject({ name: 'Notes', parentPath: parent }).project.path).toBe(join(parent, 'notes-3'));
  });

  it.each(['../escape', 'a/b', '..', '.', '', '   '])('refuses the name %j', (name) => {
    expect(() => manager.createProject({ name, parentPath: parent })).toThrow();
    expect(readdirSync(parent)).toEqual([]); // and made no folder
  });

  it('a hostile-looking but legal name still lands inside the location', () => {
    const { project } = manager.createProject({ name: 'rm -rf $HOME; echo "x"', parentPath: parent });
    expect(project.path.startsWith(parent + '/')).toBe(true);
    expect(project.path).toBe(join(parent, 'rm-rf-home-echo-x'));
  });

  it('leaves no orphan folder or registry entry when registration fails', () => {
    const real = (manager as unknown as { addProject: unknown }).addProject;
    (manager as unknown as { addProject: () => never }).addProject = () => { throw new Error('boom'); };
    expect(() => manager.createProject({ name: 'Doomed', parentPath: parent })).toThrow('boom');
    expect(existsSync(join(parent, 'doomed'))).toBe(false);
    expect(manager.listProjects()).toEqual([]);
    (manager as unknown as { addProject: unknown }).addProject = real;
  });
});

describe('first open', () => {
  it('a created project shows the `new` intro exactly once', () => {
    const { project } = manager.createProject({ name: 'Fresh', parentPath: parent });
    expect(manager.open(project.id).intro).toEqual({ firstOpen: true, kind: 'new' });
    expect(manager.open(project.id).intro.firstOpen).toBe(false);
    expect(manager.open(project.id).intro.firstOpen).toBe(false);
  });

  it('an added folder shows the `existing` intro exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-life-existing-'));
    writeFileSync(join(dir, 'a.txt'), 'x');
    const { project } = manager.addProject({ path: dir });
    expect(manager.open(project.id).intro).toEqual({ firstOpen: true, kind: 'existing' });
    expect(manager.open(project.id).intro.firstOpen).toBe(false);
  });

  it('a project opened before this existed never replays the intro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-life-legacy-'));
    const { project } = manager.addProject({ path: dir });
    // Simulate a registry written before introShown existed.
    const file = join(process.env.AURA_HOME as string, 'projects.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { id: string; lastOpenedAt: string | null; introShown?: boolean }[];
    for (const p of raw) { p.lastOpenedAt = '2026-01-01T00:00:00.000Z'; delete p.introShown; }
    writeFileSync(file, JSON.stringify(raw));
    const fresh = new WorkspaceManager();
    expect(fresh.open(project.id).intro.firstOpen).toBe(false);
  });

  it('the decision survives a restart', () => {
    const { project } = manager.createProject({ name: 'Persist', parentPath: parent });
    manager.open(project.id);
    expect(new WorkspaceManager().open(project.id).intro.firstOpen).toBe(false);
  });
});

describe('where a new project goes: one answer for preview, creation and display', () => {
  it('defaults to ~/AuraProjects when nothing overrides it', async () => {
    const { planNewProject } = await import('./workspace');
    const saved = process.env.AURA_PROJECTS_DIR;
    delete process.env.AURA_PROJECTS_DIR;
    try {
      const plan = planNewProject('zz-no-such-project-name-xyz');
      expect(plan.parent).toBe(path.resolve(os.homedir(), 'AuraProjects'));
      expect(plan.target).toBe(path.resolve(os.homedir(), 'AuraProjects', 'zz-no-such-project-name-xyz'));
      expect(plan.overridden).toBe(false);
      expect(fs.existsSync(plan.target)).toBe(false);               // planning never creates anything
    } finally { if (saved !== undefined) process.env.AURA_PROJECTS_DIR = saved; }
  });

  it('follows AURA_PROJECTS_DIR, and creation lands exactly where the preview said', async () => {
    const { planNewProject, WorkspaceManager } = await import('./workspace');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-projdir-'));
    const saved = process.env.AURA_PROJECTS_DIR;
    process.env.AURA_PROJECTS_DIR = dir;
    try {
      const preview = planNewProject('Greeting Check');
      expect(preview).toMatchObject({ parent: path.resolve(dir), dirName: 'greeting-check', overridden: true, renamed: false });
      const created = new WorkspaceManager().createProject({ name: 'Greeting Check' });
      expect(path.resolve(created.project.path)).toBe(preview.target);       // preview == result
      // the next preview accounts for the folder that now exists, and says it renamed
      const again = planNewProject('Greeting Check');
      expect(again).toMatchObject({ dirName: 'greeting-check-2', renamed: true });
    } finally {
      if (saved === undefined) delete process.env.AURA_PROJECTS_DIR; else process.env.AURA_PROJECTS_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses names that could leave the projects folder', async () => {
    const { planNewProject } = await import('./workspace');
    expect(() => planNewProject('../escape')).toThrow(/path separators/);
    expect(() => planNewProject('   ')).toThrow(/required/);
  });
});
