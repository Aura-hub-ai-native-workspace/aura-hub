import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_ITEMS, PROJECT_MODES, PROJECT_TABS, SETTINGS_TABS, useAppStore } from '@aura/core';

describe('navigation model', () => {
  it('the sidebar lists only Home and Automations, with Settings at the bottom', () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(['home', 'workflows', 'settings']);
    expect(NAV_ITEMS.filter((i) => i.group === 'system').map((i) => i.key)).toEqual(['settings']);
  });

  it('a project has exactly Overview and Workspace, and Overview has exactly four pages', () => {
    expect(PROJECT_MODES.map((m) => m.key)).toEqual(['overview', 'workspace']);
    expect(PROJECT_TABS.map((t) => t.key)).toEqual(['overview', 'context', 'architecture', 'code']);
  });

  it('Settings has exactly four tabs in order', () => {
    expect(SETTINGS_TABS.map((t) => t.key)).toEqual(['connections', 'tools', 'runtime', 'updates']);
  });
});

describe('project and settings navigation', () => {
  beforeEach(() => {
    useAppStore.setState({ nav: 'home', activeProjectId: null, inProjectView: false, projectMode: 'overview', projectTab: 'overview', settingsTab: 'connections', askAuraOpen: false });
  });

  it('opening a project lands on its Overview', () => {
    useAppStore.getState().setProjectMode('workspace');
    useAppStore.getState().openProject('p1');
    const s = useAppStore.getState();
    expect(s.inProjectView).toBe(true);
    expect(s.projectMode).toBe('overview');
    expect(s.projectTab).toBe('overview');
  });

  it('openWorkspace opens the given or active project on its Workspace', () => {
    useAppStore.getState().openWorkspace('p2');
    expect(useAppStore.getState()).toMatchObject({ activeProjectId: 'p2', inProjectView: true, projectMode: 'workspace' });
    useAppStore.getState().closeProject();
    useAppStore.getState().openWorkspace();
    expect(useAppStore.getState()).toMatchObject({ activeProjectId: 'p2', inProjectView: true, projectMode: 'workspace' });
  });

  it('the Workspace never opens without a project: it goes Home instead', () => {
    useAppStore.getState().openWorkspace();
    expect(useAppStore.getState()).toMatchObject({ nav: 'home', inProjectView: false, activeProjectId: null });
  });

  it('openSettings opens a tab, and keeps the last tab when none is named', () => {
    useAppStore.getState().openSettings('runtime');
    expect(useAppStore.getState()).toMatchObject({ nav: 'settings', settingsTab: 'runtime', inProjectView: false });
    useAppStore.getState().openSettings();
    expect(useAppStore.getState().settingsTab).toBe('runtime');
  });
});
