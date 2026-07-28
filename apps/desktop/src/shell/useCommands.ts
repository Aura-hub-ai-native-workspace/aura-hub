import { useMemo } from 'react';
import { useAppStore, type Command } from '@aura/core';
import { useToast } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';

/**
 * Builds the command registry for the palette. This is the single place
 * the environment aggregates actions — future modules will contribute
 * their own commands by extending this list (a clean extension point).
 */
export function useCommands(): Command[] {
  const setNav = useAppStore((s) => s.setNav);
  const openProject = useAppStore((s) => s.openProject);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openWorkspace = useWorkspace((s) => s.open);
  const projectList = useWorkspace((s) => s.projects);
  const { push } = useToast();

  return useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'nav-home', title: 'Go to Home', section: 'Navigate', icon: 'home', run: () => setNav('home') },
      { id: 'nav-projects', title: 'Go to Projects', section: 'Navigate', icon: 'projects', run: () => setNav('projects') },
      { id: 'nav-knowledge', title: 'Go to Knowledge', section: 'Navigate', icon: 'knowledge', run: () => setNav('knowledge') },
      { id: 'nav-ai', title: 'Go to AI', section: 'Navigate', icon: 'spark', run: () => setNav('ai') },
      { id: 'nav-workflows', title: 'Go to Workflows', section: 'Navigate', icon: 'workflows', run: () => setNav('workflows') },
      { id: 'nav-marketplace', title: 'Go to Marketplace', section: 'Navigate', icon: 'marketplace', run: () => setNav('marketplace') },
      { id: 'nav-settings', title: 'Go to Settings', section: 'Navigate', icon: 'settings', run: () => setNav('settings') },
    ];

    const projects: Command[] = projectList.map((p) => ({
      id: `open-${p.id}`,
      title: `Open ${p.name}`,
      section: 'Projects',
      icon: 'folder',
      keywords: [p.type, p.language],
      run: () => { void openWorkspace(p.id); openProject(p.id); },
    }));

    const actions: Command[] = [
      {
        id: 'new-project',
        title: 'Add Project',
        section: 'Actions',
        icon: 'plus',
        shortcut: ['⌘', 'N'],
        run: () => setNav('projects'),
      },
      {
        id: 'toggle-theme',
        title: 'Toggle Light / Dark',
        section: 'Actions',
        icon: 'moon',
        run: toggleTheme,
      },
      {
        id: 'toggle-panel',
        title: 'Toggle Context Panel',
        section: 'View',
        icon: 'panel',
        shortcut: ['⌘', '.'],
        run: toggleRightPanel,
      },
      {
        id: 'toggle-sidebar',
        title: 'Toggle Sidebar',
        section: 'View',
        icon: 'sidebar',
        shortcut: ['⌘', 'B'],
        run: toggleSidebar,
      },
    ];

    return [...actions, ...nav, ...projects];
  }, [setNav, openProject, openWorkspace, projectList, toggleTheme, toggleRightPanel, toggleSidebar, push]);
}
