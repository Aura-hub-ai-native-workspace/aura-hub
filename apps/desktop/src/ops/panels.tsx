/**
 * panels — the panel registry for the multi-panel workspace.
 * ------------------------------------------------------------------
 * Maps each PanelKind to a lazily-loaded React component, so the heavy
 * screens (Mission Control, Mission Detail, Engineering Overview) only
 * ever load when their panel is actually opened. Panels receive no
 * props: they read their own data from the stores/APIs they need.
 */
import { Suspense, lazy, type ComponentType } from 'react';
import type { PanelKind } from './layoutStore';

const OverviewPanel = lazy(() => import('./panels/OverviewPanel'));
const MissionsPanel = lazy(() => import('./panels/MissionsPanel'));
const MissionDetailPanel = lazy(() => import('./panels/MissionDetailPanel'));
const SearchPanel = lazy(() => import('./panels/SearchPanel'));
const NotificationsPanel = lazy(() => import('./panels/NotificationsPanel'));
const FeedPanel = lazy(() => import('./panels/FeedPanel'));
const KnowledgePanel = lazy(() => import('./panels/KnowledgePanel'));
const MemoryPanel = lazy(() => import('./panels/MemoryPanel'));
const DiagnosticsPanel = lazy(() => import('./panels/DiagnosticsPanel'));
const FilesPanel = lazy(() => import('./panels/FilesPanel'));
const DocsPanel = lazy(() => import('./panels/DocsPanel'));

export const PANELS: Record<PanelKind, ComponentType> = {
  overview: OverviewPanel,
  missions: MissionsPanel,
  'mission-detail': MissionDetailPanel,
  search: SearchPanel,
  notifications: NotificationsPanel,
  feed: FeedPanel,
  knowledge: KnowledgePanel,
  memory: MemoryPanel,
  diagnostics: DiagnosticsPanel,
  files: FilesPanel,
  docs: DocsPanel,
};

export function PanelContent({ kind }: { kind: PanelKind }) {
  const Component = PANELS[kind];
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <Component />
    </Suspense>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2 p-3">
      <div className="h-6 w-40 animate-pulse rounded-lg bg-surface-active" />
      <div className="h-24 animate-pulse rounded-xl bg-surface-active" />
      <div className="h-24 animate-pulse rounded-xl bg-surface-active" />
    </div>
  );
}
