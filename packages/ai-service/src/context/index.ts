/**
 * AURA Context Fabric
 * ==================================================================
 * The exposure layer over Repository Intelligence.
 *
 *   Repository Intelligence (the authority for understanding)
 *        ↓
 *   Context Fabric facade  ← you are here
 *        ↓
 *   ContextView / context contract
 *        ↓
 *   Ask AURA · Workspace context surface · delegated agents
 *
 * This package-internal module owns no facts. It composes what the
 * existing authorities already computed, grades how much of it can be
 * trusted, and renders it in a stable shape. It is read-only: it never
 * writes, spawns, mounts, indexes or scans.
 */

export type {
  ContextView, ContextResult, ContextUnavailable, ContextSurface,
  ContextProject, ContextRepository, ContextChanges, ContextGit,
  ContextEnvironment, ContextTool, ContextCapability, CapabilityAvailability,
  ContextMission, ContextActivity, ContextConstraint,
  Freshness, Section, SectionMeta,
} from './types';

export { isUnavailable, SURFACE_INTENT } from './types';

export {
  composeContextView,
  type ContextSources,
  type ComposeOptions,
  type EnvironmentSnapshot,
} from './compose';

export {
  renderContextContract,
  renderContextHeader,
  usableCapabilities,
  type RenderOptions,
} from './contract';
