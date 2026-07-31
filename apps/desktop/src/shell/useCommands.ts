import { useMemo } from 'react';
import { useAppStore, type Command } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { useLayoutStore } from '../ops/layoutStore';

/**
 * Builds the command registry for the palette — the Global Command
 * Center (Part 1). Beyond the shell's own actions/navigation this now
 * contributes the workspace commands: open every engineering panel,
 * scoped universal search, Mission Control, Run Diagnosis and Create
 * Mission. Future modules extend this list; nothing about the shell
 * changes to accommodate them.
 */
export function useCommands(): Command[] {
  const setNav = useAppStore((s) => s.setNav);
  const openProject = useAppStore((s) => s.openProject);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openWorkspace = useWorkspace((s) => s.open);
  const projectList = useWorkspace((s) => s.projects);
  const setSearchScope = useLayoutStore((s) => s.setSearchScope);
  const openPanel = useLayoutStore((s) => s.openPanel);

  return useMemo<Command[]>(() => {
      const nav: Command[] = [
        { id: 'nav-home', title: 'Go to Home', section: 'Navigate', icon: 'home', run: () => setNav('home') },
        { id: 'nav-projects', title: 'Go to Projects', section: 'Navigate', icon: 'projects', run: () => setNav('projects') },
        { id: 'nav-knowledge', title: 'Go to Knowledge', section: 'Navigate', icon: 'knowledge', run: () => setNav('knowledge') },
        { id: 'nav-ai', title: 'Go to AI', section: 'Navigate', icon: 'spark', run: () => setNav('ai') },
        { id: 'nav-workflows', title: 'Go to Workflows', section: 'Navigate', icon: 'workflows', run: () => setNav('workflows') },
        { id: 'nav-missions', title: 'Go to Mission Control', section: 'Navigate', icon: 'deploy', run: () => setNav('missions') },
        { id: 'nav-dashboard', title: 'Go to Engineering Dashboard', section: 'Navigate', icon: 'activity', run: () => setNav('dashboard') },
        { id: 'nav-governance', title: 'Go to Governance', section: 'Navigate', icon: 'shield', run: () => setNav('governance') },
        { id: 'nav-workspace', title: 'Go to Workspace', section: 'Navigate', icon: 'layout', run: () => setNav('workspace') },
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

    const inWorkspace = (run: () => void) => () => { setNav('workspace'); run(); };

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
        id: 'ops-overview',
        title: 'Open Engineering Overview',
        section: 'Actions',
        icon: 'activity',
        run: inWorkspace(() => openPanel('overview')),
      },
      {
        id: 'ops-mission-control',
        title: 'Open Mission Control',
        section: 'Actions',
        icon: 'deploy',
        run: inWorkspace(() => openPanel('missions')),
      },
      {
        id: 'ops-create-mission',
        title: 'Create Mission',
        section: 'Actions',
        icon: 'plus',
        run: inWorkspace(() => openPanel('missions')),
      },
      {
        id: 'ops-run-diagnosis',
        title: 'Run Diagnosis',
        section: 'Actions',
        icon: 'bug',
        run: inWorkspace(() => openPanel('diagnostics')),
      },
      {
        id: 'ops-notifications',
        title: 'Notification Center',
        section: 'Actions',
        icon: 'bell',
        run: inWorkspace(() => openPanel('notifications')),
      },
      {
        id: 'ops-feed',
        title: 'Engineering Feed',
        section: 'Actions',
        icon: 'activity',
        run: inWorkspace(() => openPanel('feed')),
      },
      {
        id: 'ops-search',
        title: 'Search Everything',
        section: 'Actions',
        icon: 'search',
        shortcut: ['⌘', 'K'],
        run: inWorkspace(() => { setSearchScope('all'); openPanel('search'); }),
      },
      {
        id: 'ops-search-files',
        title: 'Search Files',
        section: 'Actions',
        icon: 'file',
        run: inWorkspace(() => { setSearchScope('files'); openPanel('search'); }),
      },
      {
        id: 'ops-search-symbols',
        title: 'Search Symbols',
        section: 'Actions',
        icon: 'code',
        run: inWorkspace(() => { setSearchScope('symbols'); openPanel('search'); }),
      },
      {
        id: 'ops-search-knowledge',
        title: 'Search Knowledge',
        section: 'Actions',
        icon: 'knowledge',
        run: inWorkspace(() => { setSearchScope('knowledge'); openPanel('search'); }),
      },
      {
        id: 'ops-search-missions',
        title: 'Search Missions',
        section: 'Actions',
        icon: 'deploy',
        run: inWorkspace(() => { setSearchScope('missions'); openPanel('search'); }),
      },
      {
        id: 'ops-search-diagnoses',
        title: 'Search Diagnoses',
        section: 'Actions',
        icon: 'bug',
        run: inWorkspace(() => { setSearchScope('diagnoses'); openPanel('search'); }),
      },
      {
        id: 'ops-search-documentation',
        title: 'Search Documentation',
        section: 'Actions',
        icon: 'doc',
        run: inWorkspace(() => { setSearchScope('documentation'); openPanel('search'); }),
      },
      {
        id: 'ops-search-architecture',
        title: 'Search Architecture',
        section: 'Actions',
        icon: 'architecture',
        run: inWorkspace(() => { setSearchScope('architecture'); openPanel('search'); }),
      },
      {
        id: 'ops-search-memory',
        title: 'Search Memory',
        section: 'Actions',
        icon: 'memory',
        run: inWorkspace(() => { setSearchScope('memory'); openPanel('search'); }),
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
  }, [setNav, openProject, openWorkspace, projectList, toggleTheme, toggleRightPanel, toggleSidebar, setSearchScope, openPanel]);
}
