/**
 * inspectors — per-window contextual inspector registry.
 * ------------------------------------------------------------------
 * Replaces the Workspace's use of the global right sidebar: whichever
 * window currently has focus owns this slot, showing only what's relevant
 * to it. Only the four kinds named in the Workspace V2 brief get one —
 * every other kind is absent (not empty chrome), the same "an empty
 * category is an honest signal" convention already used for Git/
 * Automation in toolCategories.ts.
 */
import { Suspense, lazy, type ComponentType } from 'react';
import type { PanelKind } from './layoutStore';

const ArchitectureInspector = lazy(() => import('./inspectors/ArchitectureInspector'));
const KnowledgeInspector = lazy(() => import('./inspectors/KnowledgeInspector'));
const MissionInspector = lazy(() => import('./inspectors/MissionInspector'));
const ConversationInspector = lazy(() => import('./inspectors/ConversationInspector'));

const INSPECTORS: Partial<Record<PanelKind, ComponentType>> = {
  architecture: ArchitectureInspector,
  knowledge: KnowledgeInspector,
  'mission-detail': MissionInspector,
  'ai-chat': ConversationInspector,
};

export function hasInspector(kind: PanelKind | null | undefined): boolean {
  return Boolean(kind && INSPECTORS[kind]);
}

export function InspectorContent({ kind }: { kind: PanelKind }) {
  const Component = INSPECTORS[kind];
  if (!Component) return null;
  return (
    <Suspense fallback={<div className="p-4 text-[12px] text-text-subtle">Loading…</div>}>
      <Component />
    </Suspense>
  );
}
