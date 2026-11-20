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
 * provider. Used by provider switching, connecting and startup repair so
 * "recover to something that actually works" is defined in exactly one
 * place. In order:
 *
 *   1. the request, when the provider lists it;
 *   2. the adapter's declared default, when the provider lists it —
 *      wherever it sits in the list, so a vendor's catalog order never
 *      outranks the model the adapter was written for;
 *   3. the first listed model (adapters that deliberately declare no
 *      default, e.g. key-scoped gateways and self-hosted servers, rely on
 *      this being the provider's own first entry);
 *
 * and when nothing has been discovered yet (empty list), there is no
 * evidence against anything — the same rule `isModelValidForProvider`
 * applies — so the request is kept, else the declared default, else ''.
 *
 * Whenever the list is non-empty the result is always one of its ids.
 */
export function resolveModel(providerId: string, requested: string | undefined, known: DiscoveredModel[]): string {
  const adapter = getAdapter(providerId);
  const declared = adapter?.metadata.defaultModel ?? '';
  if (known.length === 0) return requested || declared;
  if (requested && known.some((m) => m.id === requested)) return requested;
  if (declared && known.some((m) => m.id === declared)) return declared;
  return known[0].id;
}

/**
 * The model the user already had selected for `providerId`, if that
 * provider is the active one — what a reconnect (a rotated key, a moved
 * server) should try to keep before falling back to the default. A
 * different provider's selection never carries over.
 */
export function previousSelectionFor(providerId: string): string | undefined {
  const active = credentialStore.getActive();
  return active.providerId === providerId && active.model ? active.model : undefined;
}

export { cachedModelsFor };
