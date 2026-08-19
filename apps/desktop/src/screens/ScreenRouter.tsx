import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { pageVariants, enterSpaceVariants, useAppStore } from '@aura/core';
import { Skeleton } from '@aura/ui';
import { Home } from './Home';
import { ProjectWorkspace } from './project/ProjectWorkspace';
import { ErrorBoundary } from './ErrorBoundary';

const AiSettings = lazy(() => import('./ai/AiSettings').then((m) => ({ default: m.AiSettings })));
const Workflows = lazy(() => import('./workflows/Workflows').then((m) => ({ default: m.Workflows })));
const WorkspaceScreen = lazy(() => import('./WorkspaceScreen').then((m) => ({ default: m.WorkspaceScreen })));
const ConnectedEnvironment = lazy(() =>
  import('../environment/ConnectedEnvironment').then((m) => ({ default: m.ConnectedEnvironment })),
);

/** Content-shaped placeholder — screens lazy-load on first visit. */
function ScreenLoading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-8 py-10">
      <Skeleton variant="line" className="w-48" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}

const lazyScreen = (el: ReactNode) => <Suspense fallback={<ScreenLoading />}>{el}</Suspense>;

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
 *
 * Heavy screens (settings, workspace, workflows) are `React.lazy`-loaded:
 * the first visit streams the chunk behind a
 * spinner, after which the module is cached and navigation back into
 * the screen stays synchronous — preserving the instant-commit model
 * for repeat visits without paying their bundle cost at startup.
 */
export function ScreenRouter() {
  const nav = useAppStore((s) => s.nav);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const inProjectView = useAppStore((s) => s.inProjectView);
  const projectTab = useAppStore((s) => s.projectTab);
  const askAuraOpen = useAppStore((s) => s.askAuraOpen);

  /* Routing asks "is the project screen showing?", which is `inProjectView`
     — NOT "is a project active?". Those are now different questions: a
     project stays active while the user is on Home or the Hub. The
     `activeProjectId` guard covers the one incoherent combination (in the
     project view with no project), which the pruning in `useActiveProject`
     can produce for a frame. */
  const inProject = inProjectView && Boolean(activeProjectId);
  const key = inProject ? `project:${activeProjectId}` : nav;

  // The workflow editor, the Code Workspace and Ask AURA are fixed-viewport
  // canvases (their own internal scrolling regions); every other screen
  // scrolls the page normally.
  const fixedViewport =
    (!inProject && (nav === 'workflows' || nav === 'workspace' || nav === 'environment')) ||
    (inProject && (projectTab === 'code' || askAuraOpen));

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
    case 'workflows':
      return lazyScreen(<Workflows />);
    case 'workspace':
      return lazyScreen(<WorkspaceScreen />);
    case 'environment':
      return (
        <ErrorBoundary title="Unable to load the Connected Environment">
          {lazyScreen(<ConnectedEnvironment />)}
        </ErrorBoundary>
      );
    case 'settings':
      return (
        <ErrorBoundary title="Unable to load AI Settings">
          {lazyScreen(<AiSettings />)}
        </ErrorBoundary>
      );
    default:
      return <Home />;
  }
}
