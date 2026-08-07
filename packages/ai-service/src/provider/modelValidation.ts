/**
 * modelValidation — the one shared "is this provider/model pair real"
 * check, used everywhere a model gets chosen or a request is about to be
 * sent: switching providers, restoring persisted state at startup, and
 * immediately before every AI request (pipeline.ts's ask/generate/
 * streamEvents). Nothing duplicates this logic — every call site is a
 * one-line guard against these two functions.
 */
import { getAdapter } from './registry';
import * as credentialStore from './credentialStore';
import type { DiscoveredModel } from './types';

function cachedModelsFor(providerId: string): DiscoveredModel[] {
  return credentialStore.getAllProviderStores().find((s) => s.id === providerId)?.models ?? [];
}

/**
 * Whether `model` is known to belong to `providerId`, based on the models
 * already discovered and cached for it. An empty cache means there's no
 * data to invalidate against yet (a connected-but-not-yet-discovered
 * provider is "unknown," not "invalid") — treating that as invalid would
 * be a false positive, not real hardening, so it passes.
 */
export function isModelValidForProvider(providerId: string | null, model: string): boolean {
  if (!providerId || !model) return false;
  const known = cachedModelsFor(providerId);
  if (known.length === 0) return true;
  return known.some((m) => m.id === model);
}

/**
 * Resolves a requested model against what's actually known for the
 * provider: the request if it's valid, else the provider's declared
 * default if that's in the known list, else the first known model, else
 * '' (nothing to fall back to — e.g. discovery hasn't produced anything
 * yet). Used by both provider switching and startup repair so "recover to
 * something that actually works" is defined in exactly one place.
 */
export function resolveModel(providerId: string, requested: string | undefined, known: DiscoveredModel[]): string {
  if (requested && known.some((m) => m.id === requested)) return requested;
  const adapter = getAdapter(providerId);
  if (adapter && known.some((m) => m.id === adapter.metadata.defaultModel)) return adapter.metadata.defaultModel;
  if (known.length > 0) return known[0].id;
  return adapter?.metadata.defaultModel ?? '';
}

export { cachedModelsFor };
