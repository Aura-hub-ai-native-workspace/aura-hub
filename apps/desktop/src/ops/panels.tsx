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

const MissionsPanel = lazy(() => import('./panels/MissionsPanel'));
const MissionDetailPanel = lazy(() => import('./panels/MissionDetailPanel'));
const SearchPanel = lazy(() => import('./panels/SearchPanel'));
const KnowledgePanel = lazy(() => import('./panels/KnowledgePanel'));
const DiagnosticsPanel = lazy(() => import('./panels/DiagnosticsPanel'));
const FilesPanel = lazy(() => import('./panels/FilesPanel'));
const DocsPanel = lazy(() => import('./panels/DocsPanel'));
const EngineeringMemoryPanel = lazy(() => import('./panels/EngineeringMemoryPanel'));
const EngineeringLearningPanel = lazy(() => import('./panels/EngineeringLearningPanel'));
const AgentPanel = lazy(() => import('./panels/AgentPanel'));
const AiChatPanel = lazy(() => import('./panels/AiChatPanel'));
const DashboardPanel = lazy(() => import('./panels/DashboardPanel'));
const TwinPanel = lazy(() => import('./panels/TwinPanel'));
const GovernancePanel = lazy(() => import('./panels/GovernancePanel'));

export const PANELS: Record<PanelKind, ComponentType> = {
  missions: MissionsPanel,
  'mission-detail': MissionDetailPanel,
  search: SearchPanel,
  knowledge: KnowledgePanel,
  diagnostics: DiagnosticsPanel,
  files: FilesPanel,
  docs: DocsPanel,
  'engineering-memory': EngineeringMemoryPanel,
  'engineering-learning': EngineeringLearningPanel,
  'engineering-agent': AgentPanel,
  'ai-chat': AiChatPanel,
  dashboard: DashboardPanel,
  twin: TwinPanel,
  governance: GovernancePanel,
};

export function PanelContent({ kind }: { kind: PanelKind }) {
  const Component = PANELS[kind];
  if (!Component) return <UnregisteredPanel />;
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <Component />
    </Suspense>
  );
}

function UnregisteredPanel() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-sm text-fg-muted">
      This panel type is no longer part of the workspace.
    </div>
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
