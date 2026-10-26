/**
 * providerCheck — what the boot-time provider gate concludes from one check.
 *
 * "Can the app use a model" has three answers, not two. A service that has
 * not answered yet is UNKNOWN: it is still starting, and treating that as
 * "setup needed" sends a configured person through first-run setup on every
 * launch that races the service. Only a definitive answer — the services
 * answered and no working provider is configured — means setup is needed.
 */
export type ProviderCheckResult = 'ready' | 'needs-setup' | 'retry';

export interface ProviderCheckInput {
  /** null when the providers request failed or did not answer. */
  providers: { active: string | null; activeModel: string } | null;
  /** null when the health request failed or did not answer. */
  healthOk: boolean | null;
}

export function decideProviderCheck(input: ProviderCheckInput): ProviderCheckResult {
  if (input.providers === null || input.healthOk === null) return 'retry';
  const { active, activeModel } = input.providers;
  return active && activeModel && input.healthOk ? 'ready' : 'needs-setup';
}

/** Boot checks retry this many times, this far apart, before concluding. */
export const PROVIDER_CHECK_ATTEMPTS = 20;
export const PROVIDER_CHECK_INTERVAL_MS = 1500;
