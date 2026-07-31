import { motion } from 'framer-motion';
import { pageVariants, enterSpaceVariants, useAppStore } from '@aura/core';
import { Home } from './Home';
import { Projects } from './Projects';
import { ProjectWorkspace } from './project/ProjectWorkspace';
import { PlaceholderScreen } from './PlaceholderScreen';
import { AiWorkspace } from './ai/AiWorkspace';
import { AiSettings } from './ai/AiSettings';
import { Workflows } from './workflows/Workflows';
import { MissionControl } from './missions/MissionControl';
import { EngineeringDashboard } from './EngineeringDashboard';
import { EngineeringGovernanceDashboard } from './governance/EngineeringGovernance';
import { WorkspaceScreen } from './WorkspaceScreen';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * ScreenRouter — a tiny in-memory router. AURA doesn't use URL routing
 * (it's an app environment, not a website); navigation is store state.
 *
 * Transition model (deliberate): a top-level route switch must NEVER
 * gate its content behind an exit animation. We therefore key a single
 * `motion.div` by route — when the route changes React unmounts the old
 * subtree and mounts the new one in the same commit, and the fresh
 * element plays its own enter/immersion animation on mount. The incoming
 * screen is thus *always* rendered synchronously.
 *
 * We intentionally do NOT wrap this in `<AnimatePresence mode="wait">`.
 * Doing so previously deferred mounting the next screen until the
 * outgoing one's exit completed — and because a Project workspace nests
 * its own `AnimatePresence mode="wait"` (its tab switcher), the outer
 * exit-complete never fired, leaving the workspace permanently blank.
 * Never nest `mode="wait"` presences. See docs/ARCHITECTURE.md §9.
 */
export function ScreenRouter() {
  const nav = useAppStore((s) => s.nav);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projectTab = useAppStore((s) => s.projectTab);

  const inProject = Boolean(activeProjectId);
  const key = inProject ? `project:${activeProjectId}` : nav;

  // The workflow editor and the Code Workspace are fixed-viewport canvases
  // (their own internal scrolling regions); every other screen scrolls the
  // page normally.
  const fixedViewport = (!inProject && (nav === 'workflows' || nav === 'workspace')) || (inProject && projectTab === 'code');

  return (
    <motion.div
      key={key}
      // Entering a project *immerses* (zoom-in); moving between sections
      // is a lighter page transition. Enter-only — no exit gate.
      variants={inProject ? enterSpaceVariants : pageVariants}
      initial="initial"
      animate="animate"
      className={fixedViewport ? 'h-full min-h-full' : 'min-h-full'}
    >
      {renderScreen(nav, inProject)}
    </motion.div>
  );
}

function renderScreen(nav: string, inProject: boolean) {
  if (inProject) return <ProjectWorkspace />;
  switch (nav) {
    case 'home':
      return <Home />;
    case 'projects':
      return <Projects />;
    case 'knowledge':
      return (
        <PlaceholderScreen
          navKey="knowledge"
          title="Your Knowledge Fabric is ready"
          hint="Documents, notes and indexes weave together here. The retrieval layer is a future module — the environment is already prepared for it."
        />
      );
    case 'ai':
      return <AiWorkspace />;
    case 'workflows':
      return <Workflows />;
    case 'missions':
      return <MissionControl />;
    case 'dashboard':
      return <EngineeringDashboard />;
    case 'governance':
      return <EngineeringGovernanceDashboard />;
    case 'workspace':
      return <WorkspaceScreen />;
    case 'marketplace':
      return (
        <PlaceholderScreen
          navKey="marketplace"
          title="Extend your environment"
          hint="Modules, models and templates install into the same design language and command surface you already use."
        />
      );
    case 'settings':
      return <ErrorBoundary><AiSettings /></ErrorBoundary>;
    default:
      return <Home />;
  }
}
